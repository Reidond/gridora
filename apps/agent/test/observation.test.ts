import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentObservationEvent,
  AgentObservationReceipt,
} from '@gridora/agent-observation-control'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentError } from '../src/errors.js'
import {
  AgentObservationFactsProbe,
  AgentObservationRefreshRequiredError,
  AgentObservationTransport,
  FileAgentObservationState,
  FetchAgentObservationTransport,
  makeAgentObservationPublisher,
} from '../src/observation.js'
import type { NodeAuthentication } from '../src/transport.js'
import { AgentClock } from '../src/services.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const authentication: NodeAuthentication = {
  nodeCredential: 'node-secret-that-must-never-be-persisted-or-logged'.repeat(2),
  credentialId: 'credential-1',
  credentialVersion: 1,
  sessionVersion: 1,
}

const facts: AgentObservationEvent['facts'] = {
  agent: { version: '0.1.0', ready: true },
  image: {
    imageId: 'image-a',
    imageVersion: '2026.08.23',
    checksum: `sha256:${'a'.repeat(64)}`,
    signatureVerified: true,
    buildIdentityManifestSha256: `sha256:${'b'.repeat(64)}`,
    buildIdentitySignatureSha256: `sha256:${'c'.repeat(64)}`,
    buildIdentityPublicKeySha256: `sha256:${'d'.repeat(64)}`,
    ready: true,
  },
  tunnel: { state: 'connected', ready: true },
  docker: {
    engineVersion: '28.0.0',
    storageDriver: 'overlay2',
    projectQuotaReady: true,
    privilegedContainers: 0,
    dockerSocketMounted: false,
    ready: true,
  },
  firewall: { defaultDeny: true, allowedTcpPorts: [22], allowedUdpPorts: [2001], ready: true },
  capacity: {
    architecture: 'amd64',
    cpuMillis: 4_000,
    ramBytes: 8_000_000_000,
    diskBytes: 80_000_000_000,
    cpuUsedMillis: 100,
    ramUsedBytes: 1_000_000_000,
    diskUsedBytes: 2_000_000_000,
  },
  metrics: {
    loadPermille: 25,
    networkReceiveBytes: 100,
    networkTransmitBytes: 200,
    containerRestarts: 0,
  },
}

const receipt = (event: AgentObservationEvent): AgentObservationReceipt => ({
  organizationId: event.organizationId,
  nodeId: event.nodeId,
  sequence: event.sequence,
  observedRevision: event.observedRevision,
  observedState: 'ready',
  capacityPublished: true,
  acceptedAt: '2026-08-23T12:00:00.000Z',
})

const publisherEffect = (
  statePath: string,
  transport: Layer.Layer<AgentObservationTransport>,
  inspectedFacts: AgentObservationEvent['facts'] = facts,
) =>
  makeAgentObservationPublisher.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileAgentObservationState(statePath),
        transport,
        Layer.succeed(AgentObservationFactsProbe, { inspect: Effect.succeed(inspectedFacts) }),
        Layer.succeed(AgentClock, { now: Effect.succeed(new Date('2026-08-23T12:00:00.000Z')) }),
      ),
    ),
  )

describe('crash-safe agent observation publication', () => {
  it('recognizes only the exact uppercase not-committed HTTP Problem code', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: 409,
          code: 'AGENT_OBSERVATION_NOT_COMMITTED',
          detail: 'safe fixed detail',
        }),
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      )
    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const transport = yield* AgentObservationTransport
            return yield* transport.publish(authentication.nodeCredential, {
              apiVersion: 'agent.gridora.dev/v1alpha1',
              organizationId: 'org-a',
              nodeId: 'node-a',
              sessionVersion: 1,
              sequence: 1,
              observedRevision: 1,
              issuedAt: '2026-08-23T12:00:00.000Z',
              facts,
            })
          }).pipe(
            Effect.provide(
              FetchAgentObservationTransport('https://api.gridora.dev', 'api.gridora.dev', false),
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(AgentObservationRefreshRequiredError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries the byte-equivalent pending event after response loss and advances once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    let committed: AgentObservationEvent | undefined
    const deliveries: AgentObservationEvent[] = []
    const responseLoss = Layer.succeed(AgentObservationTransport, {
      publish: (_credential, event) =>
        Effect.gen(function* () {
          deliveries.push(event)
          committed = event
          return yield* new AgentError({ code: 'execution-failed', message: 'response lost' })
        }),
    })
    const first = await Effect.runPromise(publisherEffect(statePath, responseLoss))
    await expect(
      Effect.runPromise(
        first.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ).rejects.toMatchObject({ code: 'execution-failed' })

    const replay = Layer.succeed(AgentObservationTransport, {
      publish: (_credential, event) =>
        Effect.sync(() => {
          deliveries.push(event)
          if (event.sequence === 1) expect(event).toEqual(committed)
          return receipt(event)
        }),
    })
    const restarted = await Effect.runPromise(publisherEffect(statePath, replay))
    await expect(
      Effect.runPromise(
        restarted.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ).resolves.toMatchObject({ sequence: 1, observedRevision: 1 })
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]).toEqual(deliveries[0])

    await expect(
      Effect.runPromise(
        restarted.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ).resolves.toMatchObject({ sequence: 2, observedRevision: 2 })
  })

  it('serializes concurrent publishes into distinct monotonic observations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    const delivered: AgentObservationEvent[] = []
    const transport = Layer.succeed(AgentObservationTransport, {
      publish: (_credential, event) =>
        Effect.sleep('5 millis').pipe(
          Effect.andThen(
            Effect.sync(() => {
              delivered.push(event)
              return receipt(event)
            }),
          ),
        ),
    })
    const publisher = await Effect.runPromise(publisherEffect(statePath, transport))
    await Promise.all([
      Effect.runPromise(
        publisher.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
      Effect.runPromise(
        publisher.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ])
    expect(delivered.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(delivered.map(({ observedRevision }) => observedRevision)).toEqual([1, 2])
  })

  it('refreshes the same cursor only after an authoritative not-committed response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    const delivered: AgentObservationEvent[] = []
    let calls = 0
    const transport = Layer.succeed(AgentObservationTransport, {
      publish: (_credential, event) =>
        Effect.gen(function* () {
          delivered.push(event)
          calls += 1
          if (calls === 1)
            return yield* new AgentObservationRefreshRequiredError({
              code: 'agent_observation_not_committed',
            })
          return receipt(event)
        }),
    })
    let probes = 0
    const publisher = await Effect.runPromise(
      makeAgentObservationPublisher.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileAgentObservationState(statePath),
            transport,
            Layer.succeed(AgentObservationFactsProbe, {
              inspect: Effect.sync(() => ({
                ...facts,
                metrics: { ...facts.metrics, networkReceiveBytes: (probes += 1) },
              })),
            }),
            Layer.succeed(AgentClock, {
              now: Effect.succeed(new Date('2026-08-23T12:00:00.000Z')),
            }),
          ),
        ),
      ),
    )
    await expect(
      Effect.runPromise(
        publisher.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ).resolves.toMatchObject({ sequence: 1, observedRevision: 1 })
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ sequence: 1, observedRevision: 1 })
    expect(delivered[1]?.facts.metrics.networkReceiveBytes).toBe(2)
  })

  it('resets sequence on an authoritative session rollover without reusing revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    const delivered: AgentObservationEvent[] = []
    const transport = Layer.succeed(AgentObservationTransport, {
      publish: (_credential, event) =>
        Effect.sync(() => {
          delivered.push(event)
          return receipt(event)
        }),
    })
    const first = await Effect.runPromise(publisherEffect(statePath, transport))
    await Effect.runPromise(
      first.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
    )
    const nextAuthentication = {
      ...authentication,
      credentialId: 'credential-2',
      credentialVersion: 2,
      sessionVersion: 2,
    }
    const restarted = await Effect.runPromise(publisherEffect(statePath, transport))
    await Effect.runPromise(
      restarted.publishOnce(nextAuthentication, { organizationId: 'org-a', nodeId: 'node-a' }),
    )
    expect(delivered[1]).toMatchObject({ sessionVersion: 2, sequence: 1, observedRevision: 2 })
  })

  it('keeps unproven facts and credentials out of state and transport diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    const canary = 'super-secret-canary'
    const transport = Layer.succeed(AgentObservationTransport, {
      publish: () =>
        Effect.fail(
          new AgentError({ code: 'execution-failed', message: 'observation delivery failed' }),
        ),
    })
    const publisher = await Effect.runPromise(publisherEffect(statePath, transport))
    await expect(
      Effect.runPromise(
        publisher.publishOnce(
          { ...authentication, nodeCredential: canary.repeat(4) },
          { organizationId: 'org-a', nodeId: 'node-a' },
        ),
      ),
    ).rejects.toMatchObject({ message: 'observation delivery failed' })
    const source = await readFile(statePath, 'utf8')
    expect(source).not.toContain(canary)
    expect(source).not.toContain('nodeCredential')
  })

  it('does not allocate a cursor when authoritative facts cannot be proved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-observation-'))
    temporary.push(directory)
    const statePath = join(directory, 'state.json')
    const publisher = await Effect.runPromise(
      makeAgentObservationPublisher.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileAgentObservationState(statePath),
            Layer.succeed(AgentObservationTransport, {
              publish: () => Effect.die('must not publish'),
            }),
            Layer.succeed(AgentObservationFactsProbe, {
              inspect: Effect.fail(
                new AgentError({
                  code: 'execution-failed',
                  message: 'authoritative image observation is unavailable',
                }),
              ),
            }),
            Layer.succeed(AgentClock, {
              now: Effect.succeed(new Date('2026-08-23T12:00:00.000Z')),
            }),
          ),
        ),
      ),
    )
    await expect(
      Effect.runPromise(
        publisher.publishOnce(authentication, { organizationId: 'org-a', nodeId: 'node-a' }),
      ),
    ).rejects.toMatchObject({ message: 'authoritative image observation is unavailable' })
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
