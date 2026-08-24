import { Effect, ManagedRuntime } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessJwtVerifier, assertionFromRequest, makeAccessJwtVerifier } from '../src/index.js'

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const jsonPart = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)))

const signingKey = async (kid: string) => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { kid, pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } }
}

const jwt = async (
  key: Awaited<ReturnType<typeof signingKey>>,
  claims: Record<string, unknown>,
): Promise<string> => {
  const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid: key.kid })
  const payload = jsonPart(claims)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
}

afterEach(() => vi.unstubAllGlobals())

describe('Cloudflare Access JWT verifier', () => {
  it('accepts only the assertion injected by Access, not an origin Bearer token', async () => {
    const bearerOnly = new Request('https://api.gridora.test', {
      headers: { authorization: 'Bearer oauth:opaque' },
    })
    await expect(Effect.runPromise(assertionFromRequest(bearerOnly))).rejects.toBeDefined()
    await expect(
      Effect.runPromise(
        assertionFromRequest(
          new Request('https://api.gridora.test', {
            headers: { 'cf-access-jwt-assertion': 'signed.jwt.assertion' },
          }),
        ),
      ),
    ).resolves.toBe('signed.jwt.assertion')
  })

  it('caches keys, refreshes once for rotation, and retains the previous key', async () => {
    const first = await signingKey('key-1')
    const rotated = await signingKey('key-2')
    let requests = 0
    vi.stubGlobal('fetch', async () => {
      requests += 1
      return Response.json({ keys: requests === 1 ? [first.jwk] : [rotated.jwk] })
    })
    const runtime = ManagedRuntime.make(
      makeAccessJwtVerifier({
        issuer: 'https://team.cloudflareaccess.com',
        audience: 'audience-1',
        jwksCacheTtlMilliseconds: 60_000,
      }),
    )
    const claims = {
      iss: 'https://team.cloudflareaccess.com',
      aud: ['audience-1'],
      sub: 'access-subject',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1_000) + 300,
    }
    const firstToken = await jwt(first, claims)
    const rotatedToken = await jwt(rotated, claims)
    const verify = (token: string) =>
      AccessJwtVerifier.pipe(Effect.flatMap((service) => service.verify(token)))
    await runtime.runPromise(verify(firstToken))
    await runtime.runPromise(verify(firstToken))
    expect(requests).toBe(1)
    await runtime.runPromise(verify(rotatedToken))
    expect(requests).toBe(2)
    await runtime.runPromise(verify(firstToken))
    expect(requests).toBe(2)
    await runtime.dispose()
  })
})
