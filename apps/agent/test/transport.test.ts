import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { processNextCommand, runAgentIterations } from '../src/runtime.js'
import { decodeAgentConfiguration } from '../src/config.js'
import { AgentError } from '../src/errors.js'
import {
  AgentClock,
  CommandExecutor,
  MemoryCommandState,
  SignatureVerifier,
} from '../src/services.js'
import {
  acquireNodeCredential,
  acquireNodeAuthentication,
  AgentTransport,
  FetchAgentTransport,
  nodeCredentialPath,
  registrationCompletePath,
  validateControlPlaneUrl,
} from '../src/transport.js'

const temporary: string[] = []
const installerPublicKey = `rsa-oaep-spki-v1.${'A'.repeat(600)}`
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent transport integration boundary', () => {
  it('sends the root installer RSA-OAEP public key in the registration contract', async () => {
    const originalFetch = globalThis.fetch
    let body: unknown
    globalThis.fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('registration body must be JSON text')
      body = JSON.parse(init.body) as unknown
      return new Response(
        JSON.stringify({
          nodeCredential: 'n'.repeat(64),
          credentialId: 'credential-1',
          credentialVersion: 1,
          sessionVersion: 1,
          registrationTokenConsumed: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* AgentTransport
          return yield* transport.register({
            organizationId: 'org-1',
            nodeId: 'node-1',
            providerInstanceId: 'instance-1',
            agentVersion: '1.0.0',
            installerPublicKey,
            registrationToken: 'r'.repeat(64),
          })
        }).pipe(Effect.provide(FetchAgentTransport('https://api.gridora.dev', 'api.gridora.dev'))),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(body).toEqual({
      organizationId: 'org-1',
      nodeId: 'node-1',
      providerInstanceId: 'instance-1',
      agentVersion: '1.0.0',
      installerPublicKey,
      registrationToken: 'r'.repeat(64),
    })
  })
  it('keeps the canonical image unit aligned with the packaged executable', async () => {
    const unit = await readFile(
      new URL('../../../infra/images/systemd/gridora-agent.service', import.meta.url),
      'utf8',
    )
    expect(unit).toContain(
      'ExecStart=/usr/local/libexec/gridora/gridora-agent-current serve --config /etc/gridora/agent.json',
    )
    expect(unit).toContain('Requires=')
    expect(unit).toContain('gridora-agent-update.socket')
    expect(unit).not.toContain('/opt/gridora/agent/dist')
    expect(unit).not.toContain('Type=notify')
  })
  it('exchanges once, persists 0600, and revokes a stale token on reboot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-transport-'))
    temporary.push(directory)
    const stateDirectory = join(directory, 'state')
    const registrationTokenFile = join(directory, 'registration-token')
    await mkdir(stateDirectory)
    await writeFile(registrationTokenFile, 'r'.repeat(64), { mode: 0o600 })
    let registrations = 0
    let revocations = 0
    const transport = Layer.succeed(AgentTransport, {
      register: (request) =>
        Effect.sync(() => {
          registrations += 1
          expect(request).toMatchObject({
            organizationId: 'org-1',
            nodeId: 'node-1',
            providerInstanceId: 'instance-1',
            installerPublicKey,
          })
          return {
            nodeCredential: 'n'.repeat(64),
            credentialId: 'credential-1',
            credentialVersion: 1,
            sessionVersion: 1,
            registrationTokenConsumed: true as const,
          }
        }),
      poll: () => Effect.succeed(undefined),
      acknowledge: () => Effect.void,
      revokeRegistrationToken: () =>
        Effect.sync(() => {
          revocations += 1
        }),
    })
    const config = {
      organizationId: 'org-1',
      nodeId: 'node-1',
      providerInstanceId: 'instance-1',
      agentVersion: '1.0.0',
      installerPublicKey,
      stateDirectory,
      registrationTokenFile,
    }
    await Effect.runPromise(acquireNodeCredential(config).pipe(Effect.provide(transport)))
    expect((await stat(nodeCredentialPath(stateDirectory))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(nodeCredentialPath(stateDirectory), 'utf8'))).toEqual({
      schemaVersion: 1,
      organizationId: 'org-1',
      nodeId: 'node-1',
      nodeCredential: 'n'.repeat(64),
      credentialId: 'credential-1',
      credentialVersion: 1,
      sessionVersion: 1,
    })
    expect(JSON.parse(await readFile(registrationCompletePath(stateDirectory), 'utf8'))).toEqual({
      schemaVersion: 1,
      organizationId: 'org-1',
      nodeId: 'node-1',
      credentialId: 'credential-1',
      credentialVersion: 1,
      sessionVersion: 1,
    })
    await writeFile(registrationTokenFile, 's'.repeat(64), { mode: 0o600 })
    await Effect.runPromise(acquireNodeCredential(config).pipe(Effect.provide(transport)))
    await Effect.runPromise(acquireNodeCredential(config).pipe(Effect.provide(transport)))
    expect(registrations).toBe(1)
    expect(revocations).toBe(1)
    await expect(readFile(registrationTokenFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(registrationCompletePath(stateDirectory))
    await Effect.runPromise(acquireNodeCredential(config).pipe(Effect.provide(transport)))
    await expect(readFile(registrationCompletePath(stateDirectory), 'utf8')).resolves.toContain(
      'credential-1',
    )
    await writeFile(
      registrationCompletePath(stateDirectory),
      JSON.stringify({
        schemaVersion: 1,
        organizationId: 'org-1',
        nodeId: 'node-1',
        credentialId: 'different-credential',
        credentialVersion: 1,
        sessionVersion: 1,
      }),
    )
    await expect(
      Effect.runPromise(acquireNodeAuthentication(config).pipe(Effect.provide(transport))),
    ).rejects.toMatchObject({ message: 'registration completion could not be validated' })
  })
  it('recognizes a legacy credential without inventing session metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-transport-'))
    temporary.push(directory)
    const stateDirectory = join(directory, 'state')
    await mkdir(stateDirectory)
    await writeFile(nodeCredentialPath(stateDirectory), `${'l'.repeat(64)}\n`, { mode: 0o600 })
    const result = await Effect.runPromise(
      acquireNodeAuthentication({
        organizationId: 'org-1',
        nodeId: 'node-1',
        providerInstanceId: 'instance-1',
        agentVersion: '1.0.0',
        installerPublicKey,
        stateDirectory,
        registrationTokenFile: join(directory, 'missing-registration-token'),
      }).pipe(
        Effect.provide(
          Layer.succeed(AgentTransport, {
            register: () => Effect.die('must not register'),
            poll: () => Effect.die('unused'),
            acknowledge: () => Effect.die('unused'),
            revokeRegistrationToken: () => Effect.die('must not revoke'),
          }),
        ),
      ),
    )
    expect(result).toEqual({ kind: 'legacy', nodeCredential: 'l'.repeat(64) })
  })
  it('preserves the one-time token on ambiguous response loss and removes it after exact replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-transport-'))
    temporary.push(directory)
    const stateDirectory = join(directory, 'state')
    const registrationTokenFile = join(directory, 'registration-token')
    const token = 'r'.repeat(64)
    await mkdir(stateDirectory)
    await writeFile(registrationTokenFile, token, { mode: 0o600 })
    let exchanges = 0
    const transport = Layer.succeed(AgentTransport, {
      register: () =>
        Effect.gen(function* () {
          exchanges += 1
          if (exchanges === 1)
            return yield* new AgentError({
              code: 'execution-failed',
              message: 'registration response was lost',
            })
          return {
            nodeCredential: 'n'.repeat(64),
            credentialId: 'credential-1',
            credentialVersion: 1,
            sessionVersion: 1,
            registrationTokenConsumed: true as const,
          }
        }),
      poll: () => Effect.die('unused'),
      acknowledge: () => Effect.die('unused'),
      revokeRegistrationToken: () => Effect.die('unused'),
    })
    const config = {
      organizationId: 'org-1',
      nodeId: 'node-1',
      providerInstanceId: 'instance-1',
      agentVersion: '1.0.0',
      installerPublicKey,
      stateDirectory,
      registrationTokenFile,
    }
    await expect(
      Effect.runPromise(acquireNodeAuthentication(config).pipe(Effect.provide(transport))),
    ).rejects.toMatchObject({ message: 'registration response was lost' })
    expect(await readFile(registrationTokenFile, 'utf8')).toBe(token)
    await expect(readFile(nodeCredentialPath(stateDirectory), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(registrationCompletePath(stateDirectory), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await expect(
      Effect.runPromise(acquireNodeAuthentication(config).pipe(Effect.provide(transport))),
    ).resolves.toMatchObject({
      kind: 'current',
      authentication: { credentialId: 'credential-1', sessionVersion: 1 },
    })
    expect(exchanges).toBe(2)
    await expect(readFile(registrationTokenFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(nodeCredentialPath(stateDirectory), 'utf8'))).toMatchObject({
      organizationId: 'org-1',
      nodeId: 'node-1',
      credentialId: 'credential-1',
      sessionVersion: 1,
    })
    expect(JSON.parse(await readFile(registrationCompletePath(stateDirectory), 'utf8'))).toEqual({
      schemaVersion: 1,
      organizationId: 'org-1',
      nodeId: 'node-1',
      credentialId: 'credential-1',
      credentialVersion: 1,
      sessionVersion: 1,
    })
  })
  it('polls, validates/processes, and acknowledges a result', async () => {
    const acknowledgements: unknown[] = []
    const input = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: 'c1',
      operationId: 'o1',
      organizationId: 'org-1',
      nodeId: 'node-1',
      resourceId: 'node-1',
      type: 'health.inspect',
      payloadSchemaVersion: 1,
      issuedAt: '2026-08-23T09:00:00Z',
      expiresAt: '2026-08-23T11:00:00Z',
      idempotencyKey: 'i1',
      expectedPriorRevision: null,
      payload: {},
      signature: 's'.repeat(64),
    } as const
    const layers = Layer.mergeAll(
      Layer.succeed(AgentTransport, {
        register: () => Effect.die('unused'),
        poll: () => Effect.succeed(input),
        acknowledge: (_credential, identity, result) =>
          Effect.sync(() => {
            expect(identity).toEqual({ organizationId: 'org-1', nodeId: 'node-1' })
            acknowledgements.push(result)
          }),
        revokeRegistrationToken: () => Effect.void,
      }),
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, {
        execute: () => Effect.succeed({ revision: null, code: 'healthy', message: 'healthy' }),
      }),
      MemoryCommandState(),
    )
    await Effect.runPromise(
      processNextCommand({ organizationId: 'org-1', nodeId: 'node-1' }, 'n'.repeat(64), 1).pipe(
        Effect.provide(layers),
      ),
    )
    expect(acknowledgements).toHaveLength(1)
  })
  it('does not acknowledge a terminal failure for a busy duplicate delivery', async () => {
    const acknowledgements: unknown[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: 'busy-command',
      operationId: 'operation',
      organizationId: 'org-1',
      nodeId: 'node-1',
      resourceId: 'node-1',
      type: 'health.inspect',
      payloadSchemaVersion: 1,
      issuedAt: '2026-08-23T09:00:00Z',
      expiresAt: '2026-08-23T11:00:00Z',
      idempotencyKey: 'busy',
      expectedPriorRevision: null,
      payload: {},
      signature: 's'.repeat(64),
    } as const
    const layers = Layer.mergeAll(
      Layer.succeed(AgentTransport, {
        register: () => Effect.die('unused'),
        poll: () => Effect.succeed(input),
        acknowledge: (_credential, _identity, result) =>
          Effect.sync(() => {
            acknowledgements.push(result)
          }),
        revokeRegistrationToken: () => Effect.die('unused'),
      }),
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, {
        execute: () =>
          Effect.promise(() => gate).pipe(Effect.as({ revision: null, code: 'ok', message: 'ok' })),
      }),
      MemoryCommandState(),
    )
    const run = () =>
      Effect.runPromise(
        processNextCommand({ organizationId: 'org-1', nodeId: 'node-1' }, 'n'.repeat(64), 1).pipe(
          Effect.provide(layers),
        ),
      )
    const executing = run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(run()).resolves.toBeUndefined()
    expect(acknowledgements).toHaveLength(0)
    release?.()
    await expect(executing).resolves.toMatchObject({ status: 'succeeded' })
    expect(acknowledgements).toHaveLength(1)
  })
  it('backs off boundedly instead of storming after empty long polls', async () => {
    let polls = 0
    const delays: number[] = []
    const layers = Layer.mergeAll(
      Layer.succeed(AgentTransport, {
        register: () => Effect.die('unused'),
        poll: () =>
          Effect.sync(() => {
            polls += 1
            return undefined
          }),
        acknowledge: () => Effect.die('unused'),
        revokeRegistrationToken: () => Effect.die('unused'),
      }),
      Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T10:00:00Z')) }),
      Layer.succeed(SignatureVerifier, { verify: () => Effect.succeed(true) }),
      Layer.succeed(CommandExecutor, { execute: () => Effect.die('unused') }),
      MemoryCommandState(),
    )
    await Effect.runPromise(
      runAgentIterations(
        { organizationId: 'org-1', nodeId: 'node-1' },
        'n'.repeat(64),
        30,
        7,
        (milliseconds) =>
          Effect.sync(() => {
            delays.push(milliseconds)
          }),
        () => 0,
      ).pipe(Effect.provide(layers)),
    )
    expect(polls).toBe(7)
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(60_000)
  })
  it('rejects HTTP and foreign control-plane hosts', () => {
    expect(() =>
      validateControlPlaneUrl('http://api.gridora.dev', 'api.gridora.dev', false),
    ).toThrow(/HTTPS/)
    expect(() => validateControlPlaneUrl('https://evil.example', 'api.gridora.dev', false)).toThrow(
      /host/,
    )
    expect(validateControlPlaneUrl('http://127.0.0.1:8787', '127.0.0.1', true).origin).toBe(
      'http://127.0.0.1:8787',
    )
  })
  it('rejects arbitrary state and registration credential paths', async () => {
    const base = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      organizationId: 'org',
      nodeId: 'node',
      providerInstanceId: 'instance',
      controlPlaneUrl: 'https://api.gridora.dev',
      expectedControlPlaneHost: 'api.gridora.dev',
      allowLoopbackHttp: false,
      stateDirectory: '/tmp/agent',
      registrationTokenFile: '/tmp/token',
      signingPublicKeyFile: '/etc/gridora/command-signing-public.pem',
      dockerSocket: '/var/run/docker.sock',
      agentVersion: '1.0.0',
      pollWaitSeconds: 30,
    }
    await expect(Effect.runPromise(decodeAgentConfiguration(base))).rejects.toBeDefined()
  })
  it('accepts the exact cloud-init/systemd production config paths', async () => {
    await expect(
      Effect.runPromise(
        decodeAgentConfiguration({
          apiVersion: 'agent.gridora.dev/v1alpha1',
          organizationId: 'org',
          nodeId: 'node',
          providerInstanceId: 'instance',
          controlPlaneUrl: 'https://api.gridora.dev',
          expectedControlPlaneHost: 'api.gridora.dev',
          allowLoopbackHttp: false,
          stateDirectory: '/var/lib/gridora/agent',
          registrationTokenFile: '/var/lib/gridora/bootstrap/registration-token',
          signingPublicKeyFile: '/etc/gridora/command-signing-public.pem',
          dockerSocket: '/var/run/docker.sock',
          agentVersion: '1.0.0',
          pollWaitSeconds: 30,
        }),
      ),
    ).resolves.toMatchObject({
      stateDirectory: '/var/lib/gridora/agent',
      registrationTokenFile: '/var/lib/gridora/bootstrap/registration-token',
    })
  })
})
