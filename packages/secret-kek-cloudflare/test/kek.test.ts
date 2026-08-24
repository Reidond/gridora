import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeCloudflareSecretsStoreKekPort } from '../src/index.js'

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const binding = (byte: number) => ({
  get: async () => encodeBase64Url(new Uint8Array(32).fill(byte)),
})
const aad = new TextEncoder().encode('org:scope:record')
const dataKey = new Uint8Array(32).fill(17)

describe('Cloudflare Secrets Store KEK port', () => {
  it('wraps with the active key and keeps old versions available for rotation overlap', async () => {
    const keyring = { activeVersion: 2, keys: { 1: binding(1), 2: binding(2) } }
    const port = makeCloudflareSecretsStoreKekPort(keyring)
    expect(await Effect.runPromise(port.activeKeyVersion)).toBe(2)
    const current = await Effect.runPromise(port.wrap(2, dataKey, aad))
    const previous = await Effect.runPromise(port.wrap(1, dataKey, aad))
    await expect(Effect.runPromise(port.unwrap(2, current, aad))).resolves.toEqual(dataKey)
    await expect(Effect.runPromise(port.unwrap(1, previous, aad))).resolves.toEqual(dataKey)
  })

  it('uses a fresh authenticated IV for every wrap', async () => {
    const port = makeCloudflareSecretsStoreKekPort({ activeVersion: 1, keys: { 1: binding(1) } })
    const first = await Effect.runPromise(port.wrap(1, dataKey, aad))
    const second = await Effect.runPromise(port.wrap(1, dataKey, aad))
    expect(first).not.toEqual(second)
  })

  it('rejects wrong authenticated data, unavailable versions, and malformed bindings safely', async () => {
    const port = makeCloudflareSecretsStoreKekPort({
      activeVersion: 1,
      keys: { 1: binding(1), 2: { get: async () => 'not-a-key' } },
    })
    const wrapped = await Effect.runPromise(port.wrap(1, dataKey, aad))
    const wrongAad = new TextEncoder().encode('other-org:scope:record')
    await expect(Effect.runPromise(port.unwrap(1, wrapped, wrongAad))).rejects.toMatchObject({
      _tag: 'SecretKekError',
      message: 'key encryption operation failed',
    })
    await expect(Effect.runPromise(port.unwrap(3, wrapped, aad))).rejects.toMatchObject({
      _tag: 'SecretKekError',
    })
    await expect(Effect.runPromise(port.wrap(2, dataKey, aad))).rejects.toMatchObject({
      _tag: 'SecretKekError',
    })
  })
})
