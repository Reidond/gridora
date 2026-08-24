import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { ProviderTemporaryError, type ProviderError } from '@gridora/provider-sdk'
import {
  makeContaboImageRegistrationTransport,
  makeOvhImageRegistrationTransport,
  makeProviderImageRegistrationTransport,
  stockUbuntuCloudInitFallback,
  type ProviderImageRegistrationRemoteShape,
  type ProviderImageRegistrationRequest,
  type RemoteProviderImage,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const request: ProviderImageRegistrationRequest = {
  registrationId: 'image-registration-operation-1',
  providerAccountId: 'platform-ovh',
  provider: 'ovhcloud',
  region: 'GRA11',
  imageId: 'node-image-20260823',
  version: '2026.08.23.1',
  sourceCommit: 'a'.repeat(40),
  architecture: 'amd64',
  artifactDigest: digest('a'),
  artifactUrl: 'https://private-r2.gridora.internal/node-images/node-image-20260823.qcow2',
  createMode: 'create_or_adopt',
  adoptionAttempt: 0,
  adoptionDeadlineAtEpochMs: 1_000_000,
}

const imageName = `gridora-${request.imageId}-${request.artifactDigest.slice(7, 23)}`
const imageMetadata = {
  'managed-by': 'gridora',
  'gridora-image-id': request.imageId,
  'gridora-image-version': request.version,
  'gridora-source-commit': request.sourceCommit,
  'gridora-artifact-digest': request.artifactDigest,
  'gridora-registration-id': request.registrationId,
} as const
const ownedImage = (overrides: Partial<RemoteProviderImage> = {}): RemoteProviderImage => ({
  id: 'provider-image-1',
  name: imageName,
  region: request.region,
  architecture: request.architecture,
  metadata: imageMetadata,
  requestId: 'provider-request-1',
  ...overrides,
})

describe('provider image registration transport', () => {
  it('switches a response-loss registration to metadata-bound adopt-only discovery without another create', async () => {
    let creates = 0
    let visible = false
    const remote: ProviderImageRegistrationRemoteShape = {
      list: () => Effect.succeed(visible ? [ownedImage()] : []),
      create: () => {
        creates += 1
        return Effect.fail(
          new ProviderTemporaryError({
            provider: request.provider,
            operation: 'provider.create-image',
            message: 'response lost after provider acceptance',
          }),
        )
      },
    }
    const transport = makeProviderImageRegistrationTransport(remote, { now: () => 1000 })
    const uncertain = await Effect.runPromise(Effect.flip(transport.registerOrAdopt(request)))
    expect(uncertain).toMatchObject({
      _tag: 'ProviderCreateUncertainError',
      retryMode: 'adopt_only',
      nextAttemptNumber: 1,
    })
    visible = true
    await expect(
      Effect.runPromise(
        transport.registerOrAdopt({
          ...request,
          createMode: 'adopt_only',
          adoptionAttempt: 1,
        }),
      ),
    ).resolves.toEqual({
      kind: 'adopted',
      providerImageId: 'provider-image-1',
      providerRequestId: 'provider-request-1',
    })
    expect(creates).toBe(1)
  })

  it('rejects a provider response that is not bound to exact immutable registration metadata', async () => {
    const remote: ProviderImageRegistrationRemoteShape = {
      list: () => Effect.succeed([]),
      create: () =>
        Effect.succeed(
          ownedImage({
            metadata: { ...imageMetadata, 'gridora-source-commit': 'b'.repeat(40) },
          }),
        ),
    }
    const failure = await Effect.runPromise(
      Effect.flip(makeProviderImageRegistrationTransport(remote).registerOrAdopt(request)),
    )
    expect(failure).toMatchObject({ _tag: 'ProviderConflictError' })
  })

  it('exposes both OVHcloud and Contabo as bounded transport seams without a live provider call', async () => {
    const remote: ProviderImageRegistrationRemoteShape = {
      list: () => Effect.succeed([ownedImage()]),
      create: () => Effect.die('adoption must not create'),
    }
    await expect(
      Effect.runPromise(makeOvhImageRegistrationTransport(remote).registerOrAdopt(request)),
    ).resolves.toMatchObject({
      kind: 'adopted',
    })
    await expect(
      Effect.runPromise(
        makeContaboImageRegistrationTransport(remote).registerOrAdopt({
          ...request,
          provider: 'contabo',
          providerAccountId: 'platform-contabo',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'adopted' })
  })

  it('records stock Ubuntu plus fixed cloud-init only as policy-authorized degraded fallback', async () => {
    await expect(
      Effect.runPromise(
        stockUbuntuCloudInitFallback({
          policyAllowsFallback: true,
          stockImageId: 'ubuntu-2404',
          cloudInitTemplateDigest: digest('c'),
        }),
      ),
    ).resolves.toEqual({
      state: 'degraded',
      providerImageId: 'ubuntu-2404',
      degradedReason: 'stock-ubuntu-cloud-init',
    })
    const denied: ProviderError = await Effect.runPromise(
      Effect.flip(
        stockUbuntuCloudInitFallback({
          policyAllowsFallback: false,
          stockImageId: 'ubuntu-2404',
          cloudInitTemplateDigest: digest('c'),
        }),
      ),
    )
    expect(denied).toMatchObject({ _tag: 'ProviderValidationError' })
  })
})
