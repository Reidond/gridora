import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { ContaboApi } from '@gridora/provider-contabo'
import type { OvhOpenStackApi } from '@gridora/provider-ovh-public-cloud'
import type { CreateNodeInput, ProviderNode } from '@gridora/provider-sdk'
import {
  decodeContaboImageDescription,
  encodeContaboImageDescription,
  makeContaboImageSmokeDriver,
  makeOvhImageSmokeDriver,
} from '../src/drivers.js'

const metadata = {
  'managed-by': 'gridora',
  'gridora-image-id': 'gridora-node',
  'gridora-image-version': '4242.1',
  'gridora-source-commit': 'a'.repeat(40),
  'gridora-artifact-digest': `sha256:${'b'.repeat(64)}`,
  'gridora-registration-id': `smoke-image-${'c'.repeat(32)}`,
}
const node: ProviderNode = {
  id: 'server-1',
  name: 'gridora-smoke-1',
  state: 'active',
  regionId: 'GRA11',
  planId: 'b3-8',
  addresses: [],
  metadata: {
    managedBy: 'gridora',
    organizationId: 'platform-image-smoke',
    nodeId: 'smoke-node-1',
    operationId: 'smoke-1',
    imageVersion: '4242.1',
  },
}
const createInput: CreateNodeInput = {
  organizationId: 'platform-image-smoke',
  operationId: 'smoke-1',
  nodeId: 'smoke-node-1',
  name: 'gridora-smoke-1',
  regionId: 'GRA11',
  planId: 'b3-8',
  imageId: 'image-1',
  imageVersion: '4242.1',
}
const notUsed = () => Effect.die('not used in smoke')

const ovhApi = (overrides: Partial<OvhOpenStackApi> = {}): OvhOpenStackApi => ({
  regions: notUsed,
  flavors: notUsed,
  images: notUsed,
  servers: vi.fn(() => Effect.succeed([node])),
  createServer: vi.fn(() => Effect.succeed(node)),
  getServer: () => Effect.succeed(node),
  action: notUsed,
  deleteServer: vi.fn(() => Effect.void),
  createSnapshot: notUsed,
  getSnapshot: notUsed,
  deleteSnapshot: notUsed,
  replaceSecurityGroupRules: notUsed,
  customImages: () =>
    Effect.succeed([
      {
        id: 'image-1',
        name: 'wanted',
        status: 'active',
        architecture: 'amd64',
        properties: metadata,
      },
      {
        id: 'image-2',
        name: 'other',
        status: 'active',
        architecture: 'amd64',
        properties: {},
      },
    ]),
  importImage: vi.fn((input) =>
    Effect.succeed({
      id: 'image-3',
      name: input.name,
      status: 'queued' as const,
      architecture: 'amd64' as const,
      properties: input.properties,
    }),
  ),
  getImage: () =>
    Effect.succeed({
      id: 'image-1',
      name: 'wanted',
      status: 'importing',
      architecture: 'amd64',
      properties: metadata,
    }),
  deleteImage: vi.fn(() => Effect.void),
  ...overrides,
})

describe('OVHcloud smoke driver', () => {
  it('translates Glance images to registration records bound to the exact name', async () => {
    const driver = makeOvhImageSmokeDriver(ovhApi(), 'GRA11')
    const listed = await Effect.runPromise(
      driver.images.list({ providerAccountId: 'a', region: 'GRA11', expectedName: 'wanted' }),
    )
    expect(listed).toEqual([
      { id: 'image-1', name: 'wanted', region: 'GRA11', architecture: 'amd64', metadata },
    ])
    expect(await Effect.runPromise(driver.observeImage('image-1'))).toBe('pending')
  })

  it('imports with the short-lived locator and ownership properties', async () => {
    const api = ovhApi()
    const driver = makeOvhImageSmokeDriver(api, 'GRA11')
    const created = await Effect.runPromise(
      driver.images.create({
        providerAccountId: 'a',
        region: 'GRA11',
        name: 'wanted',
        architecture: 'amd64',
        artifactUrl: 'https://artifacts.example.test/x',
        metadata,
      }),
    )
    expect(created.metadata).toEqual(metadata)
    expect(api.importImage).toHaveBeenCalledWith({
      name: 'wanted',
      architecture: 'amd64',
      sourceUrl: 'https://artifacts.example.test/x',
      properties: metadata,
    })
  })

  it('fails closed when the adapter has no image endpoint', async () => {
    const api = ovhApi()
    const {
      customImages: _list,
      importImage: _import,
      getImage: _get,
      deleteImage: _delete,
      ...bare
    } = api
    const driver = makeOvhImageSmokeDriver(bare, 'GRA11')
    const result = await Effect.runPromise(
      Effect.result(
        driver.images.list({ providerAccountId: 'a', region: 'GRA11', expectedName: 'x' }),
      ),
    )
    expect(result._tag === 'Failure' && result.failure._tag).toBe(
      'ProviderUnsupportedCapabilityError',
    )
    const deleted = await Effect.runPromise(Effect.result(driver.deleteImage('image-1')))
    expect(deleted._tag).toBe('Failure')
  })

  it('treats a lost create response as retryable and a definite rejection as final', async () => {
    const lost = makeOvhImageSmokeDriver(
      ovhApi({ createServer: () => Effect.fail({ message: 'socket closed' }) }),
      'GRA11',
    )
    const lostResult = await Effect.runPromise(Effect.result(lost.createNode(createInput)))
    expect(lostResult._tag === 'Failure' && lostResult.failure._tag).toBe('ProviderTemporaryError')
    const rejected = makeOvhImageSmokeDriver(
      ovhApi({ createServer: () => Effect.fail({ status: 422, message: 'bad flavor' }) }),
      'GRA11',
    )
    const rejectedResult = await Effect.runPromise(Effect.result(rejected.createNode(createInput)))
    expect(rejectedResult._tag === 'Failure' && rejectedResult.failure._tag).toBe(
      'ProviderValidationError',
    )
    const unreadable = makeOvhImageSmokeDriver(
      ovhApi({ createServer: () => Effect.fail({ status: 404, message: 'not yet visible' }) }),
      'GRA11',
    )
    const unreadableResult = await Effect.runPromise(
      Effect.result(unreadable.createNode(createInput)),
    )
    expect(unreadableResult._tag === 'Failure' && unreadableResult.failure._tag).toBe(
      'ProviderTemporaryError',
    )
  })

  it('lists nodes by exact smoke ownership metadata and reports deletion by absence', async () => {
    const api = ovhApi({ getServer: () => Effect.fail({ status: 404, message: 'gone' }) })
    const driver = makeOvhImageSmokeDriver(api, 'GRA11')
    await Effect.runPromise(
      driver.listNodes({ organizationId: 'platform-image-smoke', operationId: 'smoke-1' }),
    )
    expect(api.servers).toHaveBeenCalledWith({
      'managed-by': 'gridora',
      'organization-id': 'platform-image-smoke',
      'operation-id': 'smoke-1',
    })
    const observation = await Effect.runPromise(driver.observeNode('server-1'))
    expect(observation).toEqual({ kind: 'absent' })
    expect(driver.nodeDisposed(observation)).toBe(true)
    expect(driver.nodeDisposed({ kind: 'present', node })).toBe(false)
    expect(driver.nodeDisposal).toBe('delete')
  })
})

const contaboApi = (overrides: Partial<ContaboApi> = {}): ContaboApi => ({
  regions: notUsed,
  products: notUsed,
  images: notUsed,
  instances: vi.fn(() => Effect.succeed([node])),
  createInstance: vi.fn(() => Effect.succeed(node)),
  getInstance: () => Effect.succeed(node),
  action: notUsed,
  scheduleCancellation: vi.fn(() =>
    Effect.succeed({ cancellationDate: '2026-10-24', billingStopsAt: '2026-10-24' }),
  ),
  secureWipeAndStop: notUsed,
  createSnapshot: notUsed,
  deleteSnapshot: notUsed,
  replaceFirewall: notUsed,
  customImages: () =>
    Effect.succeed([
      {
        id: 'c-1',
        name: 'wanted',
        description: encodeContaboImageDescription(metadata)!,
        status: 'downloaded',
      },
    ]),
  importImage: vi.fn((input) =>
    Effect.succeed({
      id: 'c-2',
      name: input.name,
      description: input.description,
      status: 'downloading' as const,
    }),
  ),
  getImage: () =>
    Effect.succeed({ id: 'c-1', name: 'wanted', description: '', status: 'error' as const }),
  deleteImage: vi.fn(() => Effect.void),
  ...overrides,
})

describe('Contabo smoke driver', () => {
  it('round-trips ownership through the bounded image description', () => {
    const encoded = encodeContaboImageDescription(metadata)
    expect(encoded).toBeDefined()
    expect(encoded!.length).toBeLessThanOrEqual(255)
    expect(decodeContaboImageDescription(encoded!)).toEqual(metadata)
    expect(decodeContaboImageDescription('human image')).toEqual({})
    expect(encodeContaboImageDescription({ ...metadata, extra: 'x' })).toBeUndefined()
    expect(
      encodeContaboImageDescription({ ...metadata, 'gridora-image-id': 'x'.repeat(200) }),
    ).toBeUndefined()
  })

  it('imports and lists custom images with decoded ownership', async () => {
    const api = contaboApi()
    const driver = makeContaboImageSmokeDriver(api, 'EU')
    const listed = await Effect.runPromise(
      driver.images.list({ providerAccountId: 'a', region: 'EU', expectedName: 'wanted' }),
    )
    expect(listed[0]).toMatchObject({ id: 'c-1', region: 'EU', metadata })
    const created = await Effect.runPromise(
      driver.images.create({
        providerAccountId: 'a',
        region: 'EU',
        name: 'wanted',
        architecture: 'amd64',
        artifactUrl: 'https://artifacts.example.test/x',
        metadata,
      }),
    )
    expect(created.metadata).toEqual(metadata)
    expect(await Effect.runPromise(driver.observeImage('c-1'))).toBe('failed')
  })

  it('rejects ownership that does not fit the provider description before any request', async () => {
    const api = contaboApi()
    const driver = makeContaboImageSmokeDriver(api, 'EU')
    const result = await Effect.runPromise(
      Effect.result(
        driver.images.create({
          providerAccountId: 'a',
          region: 'EU',
          name: 'wanted',
          architecture: 'amd64',
          artifactUrl: 'https://artifacts.example.test/x',
          metadata: { ...metadata, 'gridora-image-id': 'x'.repeat(240) },
        }),
      ),
    )
    expect(result._tag === 'Failure' && result.failure._tag).toBe('ProviderValidationError')
    expect(api.importImage).not.toHaveBeenCalled()
  })

  it('disposes a node by cancellation and requires the cancellation readback', async () => {
    const api = contaboApi()
    const driver = makeContaboImageSmokeDriver(api, 'EU')
    await Effect.runPromise(driver.disposeNode('server-1'))
    expect(api.scheduleCancellation).toHaveBeenCalledWith('server-1')
    expect(driver.nodeDisposal).toBe('cancel_contract')
    expect(driver.nodeDisposed({ kind: 'present', node })).toBe(false)
    expect(
      driver.nodeDisposed({
        kind: 'present',
        node: { ...node, contract: { periodEndsAt: '2026-10-24', cancellationDate: '2026-10-24' } },
      }),
    ).toBe(true)
  })
})
