import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import type { AgentCredentialPrincipal } from '@gridora/db-contracts'
import {
  AgentObservationAuthenticationError,
  AgentObservationClockLayer,
  AgentObservationNotCommittedError,
  AgentObservationRepositoryLayer,
  canonicalObservationPayload,
  decodeAgentObservationEvent,
  makeAgentObservationControl,
  type AgentObservationEvent,
  type AuthenticatedAgentPrincipal,
} from '../src/index.js'

const now = '2026-08-23T15:00:00.000Z'
const principal: AuthenticatedAgentPrincipal = {
  organizationId: 'org-a',
  nodeId: 'node-a',
  credentialId: 'credential-a',
  version: 1,
  sessionVersion: 1,
}
const event: AgentObservationEvent = {
  apiVersion: 'agent.gridora.dev/v1alpha1',
  organizationId: 'org-a',
  nodeId: 'node-a',
  sessionVersion: 1,
  sequence: 1,
  observedRevision: 1,
  issuedAt: now,
  facts: {
    agent: { version: '0.1.0', ready: true },
    image: {
      imageId: 'image-a',
      imageVersion: '1.0.0',
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
      cpuMillis: 4000,
      ramBytes: 8000,
      diskBytes: 16000,
      cpuUsedMillis: 100,
      ramUsedBytes: 1000,
      diskUsedBytes: 2000,
    },
    metrics: {
      loadPermille: 100,
      networkReceiveBytes: 10,
      networkTransmitBytes: 20,
      containerRestarts: 0,
    },
  },
}

const acceptRegisteredPrincipal = (
  registered: AgentCredentialPrincipal,
): AuthenticatedAgentPrincipal => registered

const service = () =>
  Effect.runPromise(
    makeAgentObservationControl.pipe(
      Effect.provide(
        Layer.mergeAll(
          AgentObservationClockLayer({ nowEpochMilliseconds: () => Date.parse(now) }),
          AgentObservationRepositoryLayer({
            findReplay: () => Effect.succeed(null),
            probeNotCommitted: () => Effect.void,
            ingestAtomic: ({ event: accepted, acceptedAt }) =>
              Effect.succeed({
                organizationId: accepted.organizationId,
                nodeId: accepted.nodeId,
                sequence: accepted.sequence,
                observedRevision: accepted.observedRevision,
                observedState: 'ready' as const,
                capacityPublished: true,
                acceptedAt,
              }),
          }),
        ),
      ),
    ),
  )

describe('agent observation control', () => {
  it('accepts the existing registered agent principal without a route-only session ID', () => {
    expect(acceptRegisteredPrincipal).toBeTypeOf('function')
  })
  it('strictly decodes and canonicalizes a bounded signed snapshot', async () => {
    const decoded = await Effect.runPromise(decodeAgentObservationEvent(event))
    expect(canonicalObservationPayload(decoded)).toContain('"organizationId":"org-a"')
    await expect(
      Effect.runPromise((await service()).ingest(principal, event)),
    ).resolves.toMatchObject({ sequence: 1 })
    await expect(
      Effect.runPromise(decodeAgentObservationEvent({ ...event, secret: 'no' })),
    ).rejects.toBeDefined()
    const { buildIdentityManifestSha256: _missing, ...legacyImage } = event.facts.image
    await expect(
      Effect.runPromise(
        decodeAgentObservationEvent({
          ...event,
          facts: { ...event.facts, image: legacyImage },
        }),
      ),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(
        decodeAgentObservationEvent({
          ...event,
          facts: {
            ...event.facts,
            image: {
              ...event.facts.image,
              buildIdentityPublicKeySha256: `sha256:${'A'.repeat(64)}`,
            },
          },
        }),
      ),
    ).rejects.toBeDefined()
  })
  it('rejects foreign coordinates before persistence', async () => {
    await expect(
      Effect.runPromise((await service()).ingest({ ...principal, nodeId: 'node-b' }, event)),
    ).rejects.toBeInstanceOf(AgentObservationAuthenticationError)
  })
  it('returns a typed not-committed result for a stale event only after the cursor probe', async () => {
    await expect(
      Effect.runPromise(
        (await service()).ingest(principal, { ...event, issuedAt: '2026-08-23T14:00:00.000Z' }),
      ),
    ).rejects.toBeInstanceOf(AgentObservationNotCommittedError)
  })
})
