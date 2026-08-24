import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { signInternalRequest, verifyInternalRequest } from '@gridora/auth-cloudflare-access'
import type { BackupArtifact, BackupJob } from '@gridora/backup-control'
import { ConflictError } from '@gridora/contracts'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import type { SignedBackupWorkflowStep } from '@gridora/backup-workflow'
import { registerBackupWorkflowRoutes } from '../src/backup-workflow-routes.js'

type TestEnv = { Bindings: Record<string, never> }
const runtime = makeWorkerEffectRuntime(Layer.empty)
const secret = 'backup-workflow-route-test-secret'
const path = '/v1/internal/workflow-steps/execute'
const usedNonces = new Set<string>()
let authenticationCalls = 0
let loadCalls = 0

const job: BackupJob = {
  organizationId: 'org-a',
  id: 'job-a',
  operationId: 'op-a',
  mode: 'restore',
  trigger: 'manual',
  backupId: 'backup-a',
  sourceServerId: 'server-a',
  targetServerId: 'server-a',
  sourceNodeId: 'node-a',
  targetNodeId: 'node-b',
  idempotencyKey: 'restore-a',
  fingerprint: 'a'.repeat(64),
  completionFingerprint: null,
  state: 'running',
  revision: 1,
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
  cancelledAt: null,
}
const artifact: BackupArtifact = {
  organizationId: 'org-a',
  id: 'backup-a',
  serverId: 'server-a',
  r2Key: 'organizations/org-a/servers/server-a/backups/backup-a',
  checksum: `sha256:${'b'.repeat(64)}`,
  encryptionVersion: 1,
  metadata: {
    pluginId: 'arma-reforger',
    pluginVersion: '1.0.0',
    gameBuild: 'build-1',
    configRevision: 1,
    modSetRevision: 0,
    desiredRevision: 1,
    nodeId: 'node-a',
    consistency: 'crash-consistent',
    includes: ['config'],
    containsGameBinaries: false,
  },
  state: 'available',
  revision: 1,
  createdAt: '2026-08-23T10:00:00.000Z',
  expiresAt: null,
}
const workflowStep: SignedBackupWorkflowStep = {
  apiVersion: 'backup.workflow.gridora.dev/v1alpha1',
  organizationId: 'org-a',
  operationId: 'op-a',
  jobId: 'job-a',
  step: 'complete',
  ordinal: 4,
  issuedAt: '2026-08-23T10:00:00.000Z',
  expiresAt: '2026-08-23T11:00:00.000Z',
  payload: {},
  signature: 's'.repeat(32),
}

let app: Hono<TestEnv>

describe('backup Workflow internal route boundary', () => {
  beforeEach(() => {
    usedNonces.clear()
    authenticationCalls = 0
    loadCalls = 0
    app = new Hono<TestEnv>()
    registerBackupWorkflowRoutes(app, {
      runtimeFor: () => runtime,
      authenticate: (request, rawBody) => {
        const copy = new Uint8Array(rawBody.byteLength)
        copy.set(rawBody)
        return verifyInternalRequest(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: copy.buffer,
          }),
          secret,
          Date.parse('2026-08-23T10:00:01.000Z'),
        ).pipe(
          Effect.flatMap((verified) =>
            Effect.gen(function* () {
              authenticationCalls += 1
              if (usedNonces.has(verified.nonce))
                return yield* new ConflictError({
                  code: 'internal_request_replayed',
                  message: 'The internal request nonce was already used',
                })
              usedNonces.add(verified.nonce)
            }),
          ),
        )
      },
      load: () => {
        loadCalls += 1
        return Effect.succeed({ job, artifact })
      },
      executor: () => Effect.succeed({ execute: () => Effect.succeed({ job, artifact }) }),
      now: () => Effect.succeed('2026-08-23T10:00:01.000Z'),
    })
  })

  afterAll(() => runtime.dispose())

  it('authenticates the exact raw bytes before decode and rejects nonce replay', async () => {
    const body = JSON.stringify(workflowStep)
    const signedHeaders = await Effect.runPromise(
      signInternalRequest(
        body,
        secret,
        Date.parse('2026-08-23T10:00:00.000Z'),
        'nonce-backup-workflow-a',
        { method: 'POST', path },
      ),
    )
    const send = () =>
      app.request(`https://api.gridora.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeaders,
        },
        body,
      })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(409)
    expect(authenticationCalls).toBe(2)
    expect(loadCalls).toBe(1)
  })

  it('rejects a chunked oversized body before authentication or JSON parsing', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_000))
        controller.enqueue(new Uint8Array(1_000))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await app.request(`https://api.gridora.test${path}`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(400)
    expect(cancelled).toBe(true)
    expect(authenticationCalls).toBe(0)
    expect(loadCalls).toBe(0)
  })
})
