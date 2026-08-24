import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeArmaControl } from './index.js'
import {
  ARMA_REFORGER_MOD_METADATA_ORIGIN,
  ARMA_REFORGER_MOD_METADATA_PROVIDER,
  makeArmaReforgerModMetadataResolver,
  offlineArmaReforgerModMetadata,
  type ArmaMetadataFetch,
} from './mod-metadata.js'

const root = '5A54BB9103829754'
const framework = '5965550F24A0C152'
const core = '65F551D028D59363'

const detail = (
  id: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly version?: string
    readonly obsolete?: boolean
    readonly private?: boolean
    readonly unlisted?: boolean
  } = {},
) =>
  Response.json(
    {
      status: 'success',
      mod: {
        id,
        version: options.version ?? '1.2.3',
        workshopUrl: `https://reforger.armaplatform.com/workshop/${id}-fixture`,
        private: options.private ?? false,
        obsolete: options.obsolete ?? false,
        unlisted: options.unlisted ?? false,
        dependencies: (options.dependencies ?? []).map((dependency) => ({
          id: dependency,
          version: '1.0.0',
          private: false,
          published: true,
          workshopUrl: `https://reforger.armaplatform.com/workshop/${dependency}-dependency`,
        })),
      },
    },
    { headers: { etag: `W/"${id}"`, 'x-cache': 'MISS', 'x-workshop-source': 'memory-cache' } },
  )

const requested = (id = root, requestedVersion?: string) => [
  {
    source: 'reforger.armaplatform.com',
    id,
    loadOrder: 10,
    ...(requestedVersion === undefined ? {} : { requestedVersion }),
  },
]

const config = {
  name: 'Metadata fixture',
  scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
  maxPlayers: 32,
  visible: true,
  crossPlatform: true,
}

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input

describe('Arma Reforger third-party metadata adapter', () => {
  it('uses only the fixed V2 detail endpoint, resolves dependencies, and retains exact provenance', async () => {
    const calls: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit }> = []
    const bodies = new Map([
      [root, detail(root, { dependencies: [framework] })],
      [framework, detail(framework, { dependencies: [core] })],
      [core, detail(core)],
    ])
    const fetch: ArmaMetadataFetch = async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) })
      const id = requestUrl(input).split('/').at(-1)!
      return bodies.get(id) ?? new Response(null, { status: 404 })
    }
    const resolver = makeArmaReforgerModMetadataResolver({ fetch, pause: () => Effect.void })
    const metadata = await Effect.runPromise(resolver.resolve(requested(root.toLowerCase())))
    const plan = await Effect.runPromise(
      makeArmaControl(resolver).planDeployment(config, requested(root.toLowerCase()), {
        modMetadata: metadata,
      }),
    )

    expect(calls.map((call) => requestUrl(call.input))).toEqual([
      `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${root}`,
      `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${framework}`,
      `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${core}`,
    ])
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get('x-api-client')).toBe('gridora/0.1.0')
      expect(headers.get('x-reforgermods-client')).toBe('gridora')
      expect(headers.get('authorization')).toBeNull()
      expect(call.init?.credentials).toBe('omit')
      expect(call.init?.redirect).toBe('error')
    }
    expect(metadata).toMatchObject({ state: 'resolved' })
    expect(metadata.provenance).toHaveLength(3)
    expect(metadata.provenance[0]).toMatchObject({
      provider: ARMA_REFORGER_MOD_METADATA_PROVIDER,
      endpoint: `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${root}`,
      cache: 'upstream',
    })
    expect(metadata.provenance.every((entry) => /^[a-f0-9]{64}$/.test(entry.bodySha256))).toBe(true)
    expect(plan.mods.map((mod) => mod.id)).toEqual([core, framework, root])
    expect(plan.mods.map((mod) => mod.resolvedVersion)).toEqual(['1.2.3', '1.2.3', '1.2.3'])
    expect(plan.modMetadata?.provenance).toEqual(metadata.provenance)
  })

  it('uses a bounded same-origin 202 poll and never follows a supplied job URL', async () => {
    const urls: string[] = []
    const pauses: number[] = []
    let call = 0
    const resolver = makeArmaReforgerModMetadataResolver({
      fetch: async (input) => {
        urls.push(requestUrl(input))
        call += 1
        return call === 1
          ? Response.json(
              { resource_url: 'https://metadata-attacker.example/steal', status: 'queued' },
              { status: 202, headers: { 'retry-after': '0' } },
            )
          : detail(root)
      },
      pause: (milliseconds) => {
        pauses.push(milliseconds)
        return Effect.void
      },
    })

    await expect(Effect.runPromise(resolver.resolve(requested()))).resolves.toMatchObject({
      state: 'resolved',
    })
    expect(urls).toEqual([
      `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${root}`,
      `${ARMA_REFORGER_MOD_METADATA_ORIGIN}/v2/mods/${root}`,
    ])
    expect(pauses).toEqual([0])
  })

  it('adopts a fresh memory result, conditionally revalidates stale data, and records cache provenance', async () => {
    let now = 1_000
    const headers: Headers[] = []
    let calls = 0
    const resolver = makeArmaReforgerModMetadataResolver({
      now: () => now,
      cacheTtlMs: 1,
      fetch: async (_input, init) => {
        calls += 1
        headers.push(new Headers(init?.headers))
        return calls === 1
          ? detail(root)
          : new Response(null, {
              status: 304,
              headers: { etag: `W/"${root}"`, 'x-cache': 'HIT' },
            })
      },
      pause: () => Effect.void,
    })

    const first = await Effect.runPromise(resolver.resolve(requested()))
    const second = await Effect.runPromise(resolver.resolve(requested()))
    now += 2
    const third = await Effect.runPromise(resolver.resolve(requested()))

    expect(calls).toBe(2)
    expect(headers[0]?.get('if-none-match')).toBeNull()
    expect(headers[1]?.get('if-none-match')).toBe(`W/"${root}"`)
    expect(first.provenance[0]?.cache).toBe('upstream')
    expect(second.provenance[0]?.cache).toBe('memory')
    expect(third.provenance[0]?.cache).toBe('revalidated')
  })

  it('maps quota, upstream, malformed, oversized, unsupported-source, and timeout failures without a fallback scrape', async () => {
    const expectCode = async (
      resolver: ReturnType<typeof makeArmaReforgerModMetadataResolver>,
      code: string,
      input = requested(),
    ) => expect(Effect.runPromise(resolver.resolve(input))).rejects.toMatchObject({ code })

    await expectCode(
      makeArmaReforgerModMetadataResolver({
        fetch: async () =>
          Response.json(
            { error: { code: 'DAILY_QUOTA_EXCEEDED', message: 'quota' } },
            { status: 429, headers: { 'retry-after': '7' } },
          ),
      }),
      'metadata-quota-exhausted',
    )
    await expectCode(
      makeArmaReforgerModMetadataResolver({
        fetch: async () => new Response(null, { status: 503, headers: { 'retry-after': '0' } }),
        pause: () => Effect.void,
      }),
      'metadata-upstream-unavailable',
    )
    await expectCode(
      makeArmaReforgerModMetadataResolver({
        fetch: async () => Response.json({ status: 'wrong' }),
      }),
      'metadata-response-invalid',
    )
    await expectCode(
      makeArmaReforgerModMetadataResolver({
        maxResponseBytes: 32,
        fetch: async () =>
          new Response(JSON.stringify({ status: 'success', mod: {} }), {
            headers: { 'content-type': 'application/json', 'content-length': '999' },
          }),
      }),
      'metadata-response-too-large',
    )
    const unsupportedFetch = vi.fn<ArmaMetadataFetch>()
    await expectCode(
      makeArmaReforgerModMetadataResolver({ fetch: unsupportedFetch }),
      'metadata-source-unsupported',
      [{ source: 'steamcommunity.com', id: '123456', loadOrder: 1 }],
    )
    expect(unsupportedFetch).not.toHaveBeenCalled()
    await expectCode(
      makeArmaReforgerModMetadataResolver({
        timeoutMs: 1,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('abort')), {
              once: true,
            })
          }),
      }),
      'metadata-timeout',
    )
  })

  it('fails a stale requested version, preserves compatibility warnings, and keeps offline planning deterministic', async () => {
    const resolver = makeArmaReforgerModMetadataResolver({
      fetch: async () => detail(root, { version: '1.2.3', obsolete: true, unlisted: true }),
    })
    await expect(
      Effect.runPromise(resolver.resolve(requested(root, '2.0.0'))),
    ).rejects.toMatchObject({
      code: 'metadata-incompatible',
    })
    const metadata = await Effect.runPromise(resolver.resolve(requested()))
    const livePlan = await Effect.runPromise(
      makeArmaControl(resolver).planDeployment(config, requested(), { modMetadata: metadata }),
    )
    expect(livePlan.mods[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Metadata marks this mod obsolete',
        'Metadata marks this mod unlisted',
      ]),
    )

    const offlineOne = offlineArmaReforgerModMetadata()
    const offlineTwo = offlineArmaReforgerModMetadata()
    const offlinePlan = await Effect.runPromise(
      makeArmaControl(resolver).planDeployment(config, requested()),
    )
    expect(offlineOne).toEqual(offlineTwo)
    expect(offlinePlan.modMetadata).toEqual(offlineOne)
    expect(offlinePlan.mods[0]?.warnings).toEqual(
      expect.arrayContaining([
        'External mod metadata was not fetched; dependency resolution is intentionally offline',
      ]),
    )
  })
})
