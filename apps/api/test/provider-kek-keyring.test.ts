import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeCloudflareSecretsStoreKekPort } from '@gridora/secret-kek-cloudflare'
import { buildProviderKekKeyring } from '../src/index.js'

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const v1 = { get: async () => base64Url(new Uint8Array(32).fill(11)) }
const v2 = { get: async () => base64Url(new Uint8Array(32).fill(22)) }

describe('provider KEK overlap keyring', () => {
  it('wraps with active v2 while retaining v1 for old envelope recovery', async () => {
    const dataKey = new Uint8Array(32).fill(33)
    const aad = new TextEncoder().encode('org-a:provider-a')
    const oldPort = makeCloudflareSecretsStoreKekPort(
      buildProviderKekKeyring({
        PROVIDER_KEK_ACTIVE_VERSION: '1',
        PROVIDER_KEK_V1: v1,
      }),
    )
    const oldWrapped = await Effect.runPromise(oldPort.wrap(1, dataKey, aad))

    const overlap = makeCloudflareSecretsStoreKekPort(
      buildProviderKekKeyring({
        PROVIDER_KEK_ACTIVE_VERSION: '2',
        PROVIDER_KEK_V1: v1,
        PROVIDER_KEK_V2: v2,
      }),
    )
    await expect(Effect.runPromise(overlap.activeKeyVersion)).resolves.toBe(2)
    await expect(Effect.runPromise(overlap.unwrap(1, oldWrapped, aad))).resolves.toEqual(dataKey)
    const newWrapped = await Effect.runPromise(overlap.wrap(2, dataKey, aad))
    await expect(Effect.runPromise(overlap.unwrap(2, newWrapped, aad))).resolves.toEqual(dataKey)
    await expect(Effect.runPromise(oldPort.unwrap(1, newWrapped, aad))).rejects.toBeDefined()
  })

  it('fails closed for malformed, unsupported, or absent active versions', () => {
    expect(() =>
      buildProviderKekKeyring({ PROVIDER_KEK_ACTIVE_VERSION: '01', PROVIDER_KEK_V1: v1 }),
    ).toThrow()
    expect(() =>
      buildProviderKekKeyring({ PROVIDER_KEK_ACTIVE_VERSION: '3', PROVIDER_KEK_V1: v1 }),
    ).toThrow()
    expect(() =>
      buildProviderKekKeyring({ PROVIDER_KEK_ACTIVE_VERSION: '2', PROVIDER_KEK_V1: v1 }),
    ).toThrow()
  })
})
