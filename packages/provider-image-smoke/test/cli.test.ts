import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { parseSmokeEnvironment, runSmokeCli, type SmokeCliDependencies } from '../src/cli.js'
import {
  SMOKE_CREDENTIAL_ENVIRONMENT,
  makeLiveSmokeDriver,
  resolveSmokeCredentials,
  unavailableAgentHealthObserver,
} from '../src/live.js'
import { ProviderImageSmokeError } from '../src/index.js'
import { advanceVirtual, artifactUrl, makeFakeProvider, observer } from './fakes.js'

const secret = 'ovh-application-secret-value'
const liveEnvironment = (overrides: Record<string, string | undefined> = {}) => ({
  GRIDORA_LIVE_TEST: 'true',
  GRIDORA_SMOKE_PROVIDER: 'ovh',
  GRIDORA_SMOKE_REGION: 'GRA11',
  GRIDORA_SMOKE_PLAN: 'b3-8',
  GRIDORA_SMOKE_TTL_MINUTES: '30',
  GRIDORA_SMOKE_RUN_ID: '4242.1',
  GRIDORA_SOURCE_COMMIT: 'a'.repeat(40),
  GRIDORA_ARTIFACT_DIGEST: `sha256:${'b'.repeat(64)}`,
  GRIDORA_IMAGE_VERSION: '4242.1',
  GRIDORA_SMOKE_ARTIFACT_URL: artifactUrl,
  GRIDORA_SMOKE_OVH_PROJECT_ID: 'project-1',
  GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_ID: 'ovh-application-id-value',
  GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET: secret,
  ...overrides,
})

const dependencies = (
  write: (report: string) => void,
  driver: SmokeCliDependencies['driver'] = vi.fn(() => Effect.die('no provider in this test')),
): SmokeCliDependencies => ({
  driver,
  observer: unavailableAgentHealthObserver,
  write: (report) => Effect.sync(() => write(report)),
})

describe('paid provider smoke CLI gate', () => {
  it.each([undefined, 'false', 'TRUE', '1'])(
    'fails before credentials or any provider call when live_test is %s',
    async (flag) => {
      const reports: string[] = []
      const driver = vi.fn(() => Effect.die('must not run'))
      const code = await Effect.runPromise(
        runSmokeCli(
          liveEnvironment({ GRIDORA_LIVE_TEST: flag }),
          dependencies((r) => reports.push(r), driver),
        ),
      )
      expect(code).toBe(1)
      expect(driver).not.toHaveBeenCalled()
      expect(reports.join('')).toContain('"code": "live-test-disabled"')
      expect(reports.join('')).not.toContain(secret)
    },
  )

  it('rejects the simulated provider and unknown providers', async () => {
    for (const provider of ['simulated', 'hetzner', ''])
      expect(
        (
          await Effect.runPromise(
            Effect.result(
              parseSmokeEnvironment(liveEnvironment({ GRIDORA_SMOKE_PROVIDER: provider })),
            ),
          )
        )._tag,
      ).toBe('Failure')
  })

  it('fails with credential-absent before building a provider driver', async () => {
    const reports: string[] = []
    const driver = vi.fn(() => Effect.die('must not run'))
    const code = await Effect.runPromise(
      runSmokeCli(
        liveEnvironment({ GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET: '' }),
        dependencies((r) => reports.push(r), driver),
      ),
    )
    expect(code).toBe(1)
    expect(driver).not.toHaveBeenCalled()
    expect(reports.join('')).toContain('"code": "credential-absent"')
    expect(reports.join('')).toContain('GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET')
  })

  it('names only fixed secret identifiers for each provider', async () => {
    expect(SMOKE_CREDENTIAL_ENVIRONMENT).toEqual({
      ovhcloud: [
        'GRIDORA_SMOKE_OVH_PROJECT_ID',
        'GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_ID',
        'GRIDORA_SMOKE_OVH_APPLICATION_CREDENTIAL_SECRET',
      ],
      contabo: [
        'GRIDORA_SMOKE_CONTABO_CLIENT_ID',
        'GRIDORA_SMOKE_CONTABO_CLIENT_SECRET',
        'GRIDORA_SMOKE_CONTABO_API_USER',
        'GRIDORA_SMOKE_CONTABO_API_PASSWORD',
      ],
    })
    const contabo = await Effect.runPromise(
      Effect.result(resolveSmokeCredentials('contabo', liveEnvironment())),
    )
    expect(contabo._tag === 'Failure' && contabo.failure.code).toBe('credential-absent')
  })

  it('prints a redacted failure report with cleanup receipts and exits non-zero', async () => {
    const reports: string[] = []
    const fake = makeFakeProvider({ imageCreate: 'reject' })
    const code = await Effect.runPromise(
      runSmokeCli(
        liveEnvironment(),
        dependencies(
          (r) => reports.push(r),
          () => Effect.succeed(fake.driver),
        ),
      ),
    )
    const report = reports.join('')
    expect(code).toBe(1)
    expect(report).toContain('Paid provider image smoke failed')
    expect(report).toContain('"stage": "image-import"')
    expect(report).toContain('"cleanup"')
    expect(report).not.toContain(secret)
    expect(report).not.toContain('locator-secret')
  })

  it('withholds a report that would contain a secret', async () => {
    const reports: string[] = []
    const code = await Effect.runPromise(
      runSmokeCli(
        liveEnvironment({ GRIDORA_SMOKE_REGION: secret }),
        dependencies(
          (r) => reports.push(r),
          () =>
            Effect.fail(
              new ProviderImageSmokeError({ stage: 'credentials', code: 'x', message: 'x' }),
            ),
        ),
      ),
    )
    expect(code).toBe(1)
    expect(reports.join('')).toContain('The report was withheld.')
    expect(reports.join('')).not.toContain(secret)
  })

  it('fails closed on agent health when no live agent source is composed', async () => {
    const reports: string[] = []
    const fake = makeFakeProvider()
    const exit = await advanceVirtual(
      runSmokeCli(
        liveEnvironment({ GRIDORA_SMOKE_TTL_MINUTES: '5' }),
        dependencies(
          (r) => reports.push(r),
          () => Effect.succeed(fake.driver),
        ),
      ),
    )
    if (exit._tag !== 'Success') throw new Error('CLI run failed')
    const code = exit.value
    expect(code).toBe(1)
    expect(reports.join('')).toContain('"code": "agent-health-source-unavailable"')
    expect(fake.calls.nodeDisposals).toEqual(['node-1'])
    expect(fake.calls.imageDeletes).toEqual(['image-1'])
  })

  it('exits zero only for a passed smoke with confirmed cleanup', async () => {
    const reports: string[] = []
    const fake = makeFakeProvider()
    const exit = await advanceVirtual(
      runSmokeCli(liveEnvironment(), {
        ...dependencies(
          (r) => reports.push(r),
          () => Effect.succeed(fake.driver),
        ),
        observer: observer('healthy', 1),
      }),
    )
    if (exit._tag !== 'Success') throw new Error('CLI run failed')
    const code = exit.value
    expect(code).toBe(0)
    expect(reports.join('')).toContain('"result": "passed"')
    expect(reports.join('')).not.toContain(secret)
  })
})

describe('live smoke driver composition', () => {
  const credentials = {
    provider: 'ovhcloud' as const,
    projectId: 'project-1',
    applicationCredentialId: 'ovh-application-id-value',
    applicationCredentialSecret: secret,
  }

  it('fails with a credential error when OVHcloud sign-in is rejected', async () => {
    const fetch = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response('{"error":"denied"}', { status: 401 }),
    )
    const result = await Effect.runPromise(
      Effect.result(makeLiveSmokeDriver(credentials, 'GRA11', { fetch })),
    )
    expect(result._tag === 'Failure' && result.failure).toMatchObject({
      stage: 'credentials',
      code: 'provider-authentication-failed',
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe('https://auth.cloud.ovh.net/v3/auth/tokens')
  })

  const catalog = (services: readonly { type: string; url: string; region?: string }[]) =>
    new Response(
      JSON.stringify({
        token: {
          catalog: services.map((service) => ({
            type: service.type,
            endpoints: [
              { interface: 'public', region: service.region ?? 'GRA11', url: service.url },
            ],
          })),
        },
      }),
      { status: 201, headers: { 'x-subject-token': 'keystone-token-value-123' } },
    )

  it('requires exactly one allow-listed regional endpoint per service', async () => {
    const fetch = vi.fn(async () =>
      catalog([
        { type: 'compute', url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-1' },
        { type: 'network', url: 'https://network.compute.gra11.cloud.ovh.net/' },
        { type: 'image', url: 'https://image.evil.example/' },
      ]),
    )
    const result = await Effect.runPromise(
      Effect.result(makeLiveSmokeDriver(credentials, 'GRA11', { fetch })),
    )
    expect(result._tag === 'Failure' && result.failure.code).toBe('provider-catalog-invalid')
  })

  it('rejects a compute endpoint for another project', async () => {
    const fetch = vi.fn(async () =>
      catalog([
        { type: 'compute', url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-2' },
        { type: 'network', url: 'https://network.compute.gra11.cloud.ovh.net/' },
        { type: 'image', url: 'https://image.compute.gra11.cloud.ovh.net/' },
      ]),
    )
    const result = await Effect.runPromise(
      Effect.result(makeLiveSmokeDriver(credentials, 'GRA11', { fetch })),
    )
    expect(result._tag === 'Failure' && result.failure.code).toBe('provider-project-mismatch')
  })

  it('roots Glance and Nova requests at their catalog endpoints with the Keystone token', async () => {
    const requests: { url: string; token: string | null }[] = []
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (target.endsWith('/v3/auth/tokens'))
        return catalog([
          { type: 'compute', url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-1' },
          { type: 'network', url: 'https://network.compute.gra11.cloud.ovh.net/' },
          { type: 'image', url: 'https://image.compute.gra11.cloud.ovh.net/' },
        ])
      requests.push({ url: target, token: new Headers(init?.headers).get('x-auth-token') })
      return new Response(JSON.stringify({ images: [], servers: [] }), { status: 200 })
    })
    const driver = await Effect.runPromise(makeLiveSmokeDriver(credentials, 'GRA11', { fetch }))
    await Effect.runPromise(
      driver.images.list({ providerAccountId: 'a', region: 'GRA11', expectedName: 'img' }),
    )
    await Effect.runPromise(
      driver.listNodes({ organizationId: 'platform-image-smoke', operationId: 'smoke-1' }),
    )
    expect(requests).toEqual([
      {
        url: 'https://image.compute.gra11.cloud.ovh.net/v2/images?name=img&limit=25',
        token: 'keystone-token-value-123',
      },
      {
        url: 'https://compute.gra11.cloud.ovh.net/v2.1/project-1/servers/detail',
        token: 'keystone-token-value-123',
      },
    ])
  })
})
