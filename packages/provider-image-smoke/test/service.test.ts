import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  SMOKE_ORGANIZATION_ID,
  assertNoSecretValues,
  deriveSmokeIdentity,
  runProviderImageSmoke,
  type ProviderImageSmokeError,
  type ProviderImageSmokeEvidence,
} from '../src/index.js'
import { artifactUrl, makeFakeProvider, observer, runVirtual, smokeInput } from './fakes.js'

const failure = <A>(exit: Exit.Exit<A, ProviderImageSmokeError>): ProviderImageSmokeError => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error('expected failure')
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag !== 'Some') throw new Error(`unexpected cause ${Cause.pretty(exit.cause)}`)
  return error.value
}
const success = <A>(exit: Exit.Exit<A, ProviderImageSmokeError>): A => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

describe('paid provider image smoke service', () => {
  it('registers, boots, observes agent health, and confirms cleanup of node and image', async () => {
    const fake = makeFakeProvider()
    const agent = observer('healthy')
    const evidence: ProviderImageSmokeEvidence = success(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, agent),
    )
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      result: 'passed',
      provider: 'ovhcloud',
      region: 'GRA11',
      plan: 'b3-8',
      providerImageId: 'image-1',
      imageRegistration: 'registered',
      providerNodeId: 'node-1',
      agentHealth: { outcome: 'healthy', docker: 'healthy', firewall: 'ready' },
      cleanup: {
        node: { disposition: 'deleted', confirmed: true, providerResourceIds: ['node-1'] },
        image: { disposition: 'deleted', confirmed: true, providerResourceIds: ['image-1'] },
      },
    })
    expect(evidence.idempotencyKey).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(evidence.bootDurationMs).toBeGreaterThanOrEqual(0)
    expect(fake.calls.imageCreates).toBe(1)
    expect(fake.calls.nodeCreates).toBe(1)
    // The node is disposed before its image.
    expect(fake.calls.requests.indexOf('nodes.dispose')).toBeLessThan(
      fake.calls.requests.indexOf('images.delete'),
    )
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain(artifactUrl)
    expect(serialized).not.toContain('locator-secret')
  })

  it('derives a stable idempotency identity from commit, digest, provider, region, and run', async () => {
    const base = {
      sourceCommit: 'a'.repeat(40),
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      provider: 'ovhcloud' as const,
      region: 'GRA11',
      runId: '4242.1',
    }
    const first = await Effect.runPromise(deriveSmokeIdentity(base))
    expect(await Effect.runPromise(deriveSmokeIdentity(base))).toEqual(first)
    for (const change of [
      { sourceCommit: 'c'.repeat(40) },
      { artifactDigest: `sha256:${'d'.repeat(64)}` },
      { provider: 'contabo' as const },
      { region: 'SBG5' },
      { runId: '4242.2' },
    ])
      expect(
        (await Effect.runPromise(deriveSmokeIdentity({ ...base, ...change }))).operationId,
      ).not.toBe(first.operationId)
  })

  it('fails on image import rejection without creating a node', async () => {
    const fake = makeFakeProvider({ imageCreate: 'reject' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'image-import', code: 'ProviderValidationError' })
    expect(fake.calls.nodeCreates).toBe(0)
    expect(error.cleanup).toMatchObject({
      node: { disposition: 'absent', confirmed: true },
      image: { disposition: 'absent', confirmed: true },
    })
  })

  it('fails when the imported image never becomes usable and deletes it', async () => {
    const fake = makeFakeProvider({ imageReady: 'failed' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'image-ready', code: 'image-failed' })
    expect(fake.calls.nodeCreates).toBe(0)
    expect(fake.calls.imageDeletes).toEqual(['image-1'])
  })

  it('adopts an image whose import response was lost instead of importing again', async () => {
    const fake = makeFakeProvider({ imageCreate: 'lost' })
    const evidence = success(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(evidence.imageRegistration).toBe('adopted')
    expect(fake.calls.imageCreates).toBe(1)
  })

  it('adopts an in-flight node create after response loss instead of creating a second node', async () => {
    const fake = makeFakeProvider({ nodeCreate: 'lost' })
    const evidence = success(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(evidence.providerNodeId).toBe('node-1')
    expect(fake.calls.nodeCreates).toBe(1)
    expect(evidence.cleanup.node).toMatchObject({
      confirmed: true,
      providerResourceIds: ['node-1'],
    })
  })

  it('keeps an uncertain create adopt-only and never sends a second paid create', async () => {
    const fake = makeFakeProvider({ nodeCreate: 'lost-invisible' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'node-create', code: 'node-create-uncertain' })
    expect(fake.calls.nodeCreates).toBe(1)
    expect(error.cleanup?.image).toMatchObject({ disposition: 'deleted', confirmed: true })
  })

  it('prevents duplicate provider creates when a retried run finds its earlier resources', async () => {
    const input = smokeInput()
    const identity = await Effect.runPromise(deriveSmokeIdentity(input))
    const fake = makeFakeProvider()
    fake.seedImage({
      id: 'image-earlier',
      name: `gridora-gridora-node-${input.artifactDigest.slice(7, 23)}`,
      region: input.region,
      architecture: 'amd64',
      metadata: {
        'managed-by': 'gridora',
        'gridora-image-id': 'gridora-node',
        'gridora-image-version': input.imageVersion,
        'gridora-source-commit': input.sourceCommit,
        'gridora-artifact-digest': input.artifactDigest,
        'gridora-registration-id': identity.registrationId,
      },
    })
    fake.seedNode({
      id: 'node-earlier',
      name: identity.nodeName,
      state: 'active',
      regionId: input.region,
      planId: input.plan,
      addresses: [],
      metadata: {
        managedBy: 'gridora',
        organizationId: SMOKE_ORGANIZATION_ID,
        nodeId: identity.nodeId,
        operationId: identity.operationId,
        imageVersion: input.imageVersion,
      },
    })
    const evidence = success(
      await runVirtual(runProviderImageSmoke(input), fake.driver, observer()),
    )
    expect(evidence).toMatchObject({
      providerImageId: 'image-earlier',
      imageRegistration: 'adopted',
      providerNodeId: 'node-earlier',
    })
    expect(fake.calls.imageCreates).toBe(0)
    expect(fake.calls.nodeCreates).toBe(0)
  })

  it('fails a definite node create rejection and still deletes the image', async () => {
    const fake = makeFakeProvider({ nodeCreate: 'reject' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'node-create', code: 'ProviderValidationError' })
    expect(fake.calls.nodeCreates).toBe(1)
    expect(fake.calls.imageDeletes).toEqual(['image-1'])
  })

  it('fails on boot timeout and deletes the node and image', async () => {
    const fake = makeFakeProvider({ boot: 'never' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'boot', code: 'boot-timeout' })
    expect(fake.calls.nodeDisposals).toEqual(['node-1'])
    expect(fake.calls.imageDeletes).toEqual(['image-1'])
    expect(error.cleanup?.node.confirmed).toBe(true)
  })

  it('fails when the agent never reports and cleans up', async () => {
    const fake = makeFakeProvider()
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer('never')),
    )
    expect(error).toMatchObject({ stage: 'agent-health', code: 'agent-never-healthy' })
    expect(error.cleanup?.node).toMatchObject({ disposition: 'deleted', confirmed: true })
  })

  it('does not accept a degraded agent as healthy', async () => {
    const fake = makeFakeProvider()
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer('degraded')),
    )
    expect(error).toMatchObject({ stage: 'agent-health', code: 'agent-never-healthy' })
  })

  it('rejects an agent health sample for another node', async () => {
    const fake = makeFakeProvider()
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer('foreign')),
    )
    expect(error).toMatchObject({ stage: 'agent-health', code: 'agent-health-scope-mismatch' })
    expect(fake.calls.nodeDisposals).toEqual(['node-1'])
  })

  it('fails closed when the agent health source is unavailable', async () => {
    const fake = makeFakeProvider()
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer('error')),
    )
    expect(error).toMatchObject({ stage: 'agent-health', code: 'source-down' })
    expect(error.cleanup?.image.confirmed).toBe(true)
  })

  it('surfaces a node cleanup failure as an operator-visible error after a passing smoke', async () => {
    const fake = makeFakeProvider({ nodeDispose: 'fail' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'cleanup', code: 'ProviderTemporaryError' })
    expect(error.cleanup?.node).toMatchObject({
      disposition: 'unconfirmed',
      confirmed: false,
      providerResourceIds: ['node-1'],
    })
    // The image is still reconciled after the node failure.
    expect(error.cleanup?.image).toMatchObject({ disposition: 'deleted', confirmed: true })
  })

  it('surfaces an image cleanup failure with an unconfirmed receipt', async () => {
    const fake = makeFakeProvider({ imageDelete: 'fail' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'cleanup' })
    expect(error.cleanup?.image).toMatchObject({ disposition: 'unconfirmed', confirmed: false })
  })

  it('keeps the original failure stage and reports unconfirmed cleanup when both fail', async () => {
    const fake = makeFakeProvider({ boot: 'never', nodeDispose: 'fail' })
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput()), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'boot', code: 'boot-timeout' })
    expect(error.cleanup?.node.confirmed).toBe(false)
  })

  it('enforces the hard TTL inside the service, then cleans up and fails', async () => {
    const fake = makeFakeProvider({ imageReady: 'never' })
    const error = failure(
      await runVirtual(
        runProviderImageSmoke(smokeInput({ ttlMinutes: 1 })),
        fake.driver,
        observer(),
      ),
    )
    expect(error).toMatchObject({ stage: 'ttl', code: 'ttl-expired' })
    expect(fake.calls.nodeCreates).toBe(0)
    expect(fake.calls.imageDeletes).toEqual(['image-1'])
    expect(error.cleanup?.image).toMatchObject({ disposition: 'deleted', confirmed: true })
  })

  it('records a confirmed contract cancellation for Contabo nodes', async () => {
    const fake = makeFakeProvider({ provider: 'contabo' })
    const evidence = success(
      await runVirtual(
        runProviderImageSmoke(
          smokeInput({ provider: 'contabo', region: 'EU', plan: 'V45', providerAccountId: 'c' }),
        ),
        fake.driver,
        observer(),
      ),
    )
    expect(evidence.cleanup.node).toMatchObject({
      disposition: 'cancellation-scheduled',
      confirmed: true,
    })
  })

  it.each([
    [{ ttlMinutes: 0 }, 'ttl-invalid'],
    [{ ttlMinutes: 61 }, 'ttl-invalid'],
    [{ ttlMinutes: 1.5 }, 'ttl-invalid'],
    [{ sourceCommit: 'main' }, 'commit-invalid'],
    [{ artifactDigest: 'sha256:abc' }, 'digest-invalid'],
    [{ artifactUrl: 'http://artifacts.example.test/image.qcow2' }, 'artifact-url-invalid'],
    [{ region: 'gra 11' }, 'region-invalid'],
    [{ runId: 'latest' }, 'run-invalid'],
    [{ provider: 'contabo' as const }, 'driver-mismatch'],
  ])('rejects invalid input %j before any provider request', async (overrides, code) => {
    const fake = makeFakeProvider()
    const error = failure(
      await runVirtual(runProviderImageSmoke(smokeInput(overrides)), fake.driver, observer()),
    )
    expect(error).toMatchObject({ stage: 'input', code })
    expect(fake.calls.requests).toEqual([])
  })

  it('refuses to serialize a report that contains a secret value', async () => {
    const result = await Effect.runPromise(
      Effect.result(assertNoSecretValues({ note: 'token-value-1234' }, ['token-value-1234'])),
    )
    expect(result._tag).toBe('Failure')
    expect(
      await Effect.runPromise(assertNoSecretValues({ note: 'clean' }, ['token-value-1234'])),
    ).toBe('{"note":"clean"}')
  })
})
