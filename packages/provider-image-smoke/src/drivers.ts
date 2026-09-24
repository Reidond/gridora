import { Effect } from 'effect'
import {
  normalizeContaboError,
  type ContaboApi,
  type ContaboApiError,
  type ContaboCustomImage,
} from '@gridora/provider-contabo'
import type { RemoteProviderImage } from '@gridora/provider-image-registration'
import {
  normalizeOvhError,
  type OvhApiError,
  type OvhCustomImage,
  type OvhOpenStackApi,
} from '@gridora/provider-ovh-public-cloud'
import {
  ProviderTemporaryError,
  ProviderUnsupportedCapabilityError,
  ProviderValidationError,
  managedMetadata,
  type CreateNodeInput,
  type ProviderError,
  type ProviderId,
} from '@gridora/provider-sdk'
import type {
  ProviderImageObservation,
  ProviderImageSmokeDriverShape,
  ProviderNodeObservation,
} from './index.js'

const nodeMetadata = (input: CreateNodeInput): Readonly<Record<string, string>> => {
  const value = managedMetadata(input)
  return {
    'managed-by': value.managedBy,
    'organization-id': value.organizationId,
    'node-id': value.nodeId,
    'operation-id': value.operationId,
    'image-version': value.imageVersion,
  }
}

const unsupported = (provider: ProviderId, operation: string) =>
  Effect.fail(
    new ProviderUnsupportedCapabilityError({
      provider,
      operation,
      capability: 'customImages',
      message: 'Provider adapter has no custom-image operation',
    }),
  )

/**
 * A definite 4xx rejection means the provider did not accept the create. Any
 * other failure after the paid POST may hide an accepted create, so it becomes
 * retryable and `createOrAdopt` stabilizes by metadata instead of posting again.
 * A 404 is not definite: the adapters read the created resource back after the
 * POST, and that read can miss an accepted create.
 */
const createFailure =
  <E extends { readonly status?: number }>(
    provider: ProviderId,
    normalize: (error: E, operation: string) => ProviderError,
  ) =>
  (error: E): ProviderError =>
    error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 404
      ? normalize(error, 'createNode')
      : new ProviderTemporaryError({
          provider,
          operation: 'createNode',
          message: 'Provider create response was lost or failed after submission',
        })

const absentOnNotFound = <A>(
  effect: Effect.Effect<A, ProviderError>,
  absent: A,
): Effect.Effect<A, ProviderError> =>
  Effect.catchTag(effect, 'ProviderNotFoundError', () => Effect.succeed(absent))

const ovhImage = (image: OvhCustomImage, region: string): RemoteProviderImage => ({
  id: image.id,
  name: image.name,
  region,
  architecture: image.architecture,
  metadata: image.properties,
})

const ovhImageObservation = (image: OvhCustomImage): ProviderImageObservation =>
  image.status === 'active'
    ? 'ready'
    : image.status === 'failed'
      ? 'failed'
      : image.status === 'deleted'
        ? 'absent'
        : 'pending'

/** Translates `OvhOpenStackApi` into the smoke port. Glance images are regional, so the region is echoed. */
export const makeOvhImageSmokeDriver = (
  api: OvhOpenStackApi,
  region: string,
): ProviderImageSmokeDriverShape => {
  const map = <A>(operation: string, effect: Effect.Effect<A, OvhApiError>) =>
    Effect.mapError(effect, (error) => normalizeOvhError(error, operation))
  return {
    provider: 'ovhcloud',
    nodeDisposal: 'delete',
    images: {
      list: (input) =>
        api.customImages === undefined
          ? unsupported('ovhcloud', 'listImages')
          : Effect.map(map('listImages', api.customImages(input.expectedName)), (images) =>
              images
                .filter((image) => image.name === input.expectedName)
                .map((image) => ovhImage(image, region)),
            ),
      create: (input) =>
        api.importImage === undefined
          ? unsupported('ovhcloud', 'importImage')
          : Effect.map(
              map(
                'importImage',
                api.importImage({
                  name: input.name,
                  architecture: input.architecture,
                  sourceUrl: input.artifactUrl,
                  properties: input.metadata,
                }),
              ),
              (image) => ovhImage(image, input.region),
            ),
    },
    observeImage: (id) =>
      api.getImage === undefined
        ? unsupported('ovhcloud', 'getImage')
        : absentOnNotFound(
            Effect.map(map('getImage', api.getImage(id)), ovhImageObservation),
            'absent',
          ),
    deleteImage: (id) =>
      api.deleteImage === undefined
        ? unsupported('ovhcloud', 'deleteImage')
        : map('deleteImage', api.deleteImage(id)),
    listNodes: (input) =>
      map(
        'listNodes',
        api.servers({
          'managed-by': 'gridora',
          'organization-id': input.organizationId,
          'operation-id': input.operationId,
        }),
      ),
    createNode: (input) =>
      Effect.mapError(
        api.createServer(input, nodeMetadata(input)),
        createFailure('ovhcloud', normalizeOvhError),
      ),
    observeNode: (id) =>
      absentOnNotFound<ProviderNodeObservation>(
        Effect.map(map('getNode', api.getServer(id)), (node) => ({
          kind: 'present',
          node,
        })),
        { kind: 'absent' },
      ),
    disposeNode: (id) => map('deleteNode', api.deleteServer(id)),
    nodeDisposed: (observation) =>
      observation.kind === 'absent' || observation.node.state === 'retired',
  }
}

const contaboDescriptionPrefix = 'gridora-image-v1'
const contaboDescriptionKeys = [
  'managed-by',
  'gridora-image-id',
  'gridora-image-version',
  'gridora-source-commit',
  'gridora-artifact-digest',
  'gridora-registration-id',
] as const
const contaboDescriptionLimit = 255

/** Contabo images carry no metadata map, so ownership is encoded in the bounded description. */
export const encodeContaboImageDescription = (
  metadata: Readonly<Record<string, string>>,
): string | undefined => {
  if (
    Object.keys(metadata).length !== contaboDescriptionKeys.length ||
    contaboDescriptionKeys.some((key) => metadata[key] === undefined)
  )
    return undefined
  const value = [
    contaboDescriptionPrefix,
    ...contaboDescriptionKeys.map((key) => encodeURIComponent(metadata[key]!)),
  ].join('|')
  return value.length <= contaboDescriptionLimit ? value : undefined
}

export const decodeContaboImageDescription = (
  description: string,
): Readonly<Record<string, string>> => {
  const parts = description.split('|')
  if (parts.length !== contaboDescriptionKeys.length + 1 || parts[0] !== contaboDescriptionPrefix)
    return {}
  try {
    return Object.fromEntries(
      contaboDescriptionKeys.map((key, index) => [key, decodeURIComponent(parts[index + 1]!)]),
    )
  } catch {
    return {}
  }
}

const contaboImage = (image: ContaboCustomImage, region: string): RemoteProviderImage => ({
  id: image.id,
  name: image.name,
  region,
  architecture: 'amd64',
  metadata: decodeContaboImageDescription(image.description),
})

const contaboImageObservation = (image: ContaboCustomImage): ProviderImageObservation =>
  image.status === 'downloaded' ? 'ready' : image.status === 'error' ? 'failed' : 'pending'

/**
 * Translates `ContaboApi` into the smoke port. Contabo has no immediate
 * delete, so node disposal is a contract cancellation that must be read back.
 * Custom images are account-wide, so the requested region is echoed.
 */
export const makeContaboImageSmokeDriver = (
  api: ContaboApi,
  region: string,
): ProviderImageSmokeDriverShape => {
  const map = <A>(operation: string, effect: Effect.Effect<A, ContaboApiError>) =>
    Effect.mapError(effect, (error) => normalizeContaboError(error, operation))
  return {
    provider: 'contabo',
    nodeDisposal: 'cancel_contract',
    images: {
      list: (input) =>
        api.customImages === undefined
          ? unsupported('contabo', 'listImages')
          : Effect.map(map('listImages', api.customImages()), (images) =>
              images
                .filter((image) => image.name === input.expectedName)
                .map((image) => contaboImage(image, region)),
            ),
      create: (input) => {
        if (api.importImage === undefined) return unsupported('contabo', 'importImage')
        const description = encodeContaboImageDescription(input.metadata)
        if (description === undefined)
          return Effect.fail(
            new ProviderValidationError({
              provider: 'contabo',
              operation: 'importImage',
              field: 'description',
              message: 'Gridora image ownership does not fit the Contabo description',
            }),
          )
        return Effect.map(
          map(
            'importImage',
            api.importImage({
              name: input.name,
              description,
              url: input.artifactUrl,
              version: input.metadata['gridora-image-version'] ?? 'unknown',
            }),
          ),
          (image) => contaboImage(image, input.region),
        )
      },
    },
    observeImage: (id) =>
      api.getImage === undefined
        ? unsupported('contabo', 'getImage')
        : absentOnNotFound(
            Effect.map(map('getImage', api.getImage(id)), contaboImageObservation),
            'absent',
          ),
    deleteImage: (id) =>
      api.deleteImage === undefined
        ? unsupported('contabo', 'deleteImage')
        : map('deleteImage', api.deleteImage(id)),
    listNodes: (input) =>
      map(
        'listNodes',
        api.instances({
          'managed-by': 'gridora',
          'organization-id': input.organizationId,
          'operation-id': input.operationId,
        }),
      ),
    createNode: (input) =>
      Effect.mapError(
        api.createInstance(input, nodeMetadata(input)),
        createFailure('contabo', normalizeContaboError),
      ),
    observeNode: (id) =>
      absentOnNotFound<ProviderNodeObservation>(
        Effect.map(map('getNode', api.getInstance(id)), (node) => ({
          kind: 'present',
          node,
        })),
        { kind: 'absent' },
      ),
    disposeNode: (id) => Effect.asVoid(map('cancelNode', api.scheduleCancellation(id))),
    nodeDisposed: (observation) =>
      observation.kind === 'absent' ||
      observation.node.state === 'retired' ||
      observation.node.contract?.cancellationDate !== undefined,
  }
}
