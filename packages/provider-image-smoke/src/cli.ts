import { appendFile } from 'node:fs/promises'
import { Effect, Exit, Fiber, Layer } from 'effect'
import type { ProviderId } from '@gridora/provider-sdk'
import {
  AgentHealthObserver,
  ProviderImageSmokeDriver,
  ProviderImageSmokeError,
  assertNoSecretValues,
  runProviderImageSmoke,
  type AgentHealthObserverShape,
  type ProviderImageSmokeDriverShape,
  type ProviderImageSmokeInput,
} from './index.js'
import {
  SMOKE_CREDENTIAL_ENVIRONMENT,
  makeLiveSmokeDriver,
  resolveSmokeCredentials,
  smokeSecretValues,
  unavailableAgentHealthObserver,
  type SmokeCredentials,
  type SmokeEnvironment,
} from './live.js'

/** Workflow provider names map to canonical provider identifiers. `simulated` never reaches this CLI. */
const providers: Readonly<Record<string, ProviderId>> = { ovh: 'ovhcloud', contabo: 'contabo' }

export interface SmokeCliRequest {
  readonly input: ProviderImageSmokeInput
  readonly workflowProvider: string
}

const gate = (stage: 'live-gate' | 'input', code: string, message: string) =>
  new ProviderImageSmokeError({ stage, code, message })

/**
 * Parses only environment inputs. The live-test gate is checked first, so a
 * disabled or missing flag fails before credentials are read or any provider
 * request is possible.
 */
export const parseSmokeEnvironment = (
  environment: SmokeEnvironment,
): Effect.Effect<SmokeCliRequest, ProviderImageSmokeError> => {
  if (environment.GRIDORA_LIVE_TEST !== 'true')
    return Effect.fail(
      gate('live-gate', 'live-test-disabled', 'Paid provider smoke requires live_test=true'),
    )
  const workflowProvider = environment.GRIDORA_SMOKE_PROVIDER ?? ''
  const provider = providers[workflowProvider]
  if (provider === undefined)
    return Effect.fail(gate('input', 'provider-invalid', 'Smoke provider must be ovh or contabo'))
  const ttl = environment.GRIDORA_SMOKE_TTL_MINUTES ?? ''
  if (!/^[0-9]{1,2}$/.test(ttl))
    return Effect.fail(gate('input', 'ttl-invalid', 'Smoke TTL must be 1 to 60 minutes'))
  const required = (name: string) => environment[name] ?? ''
  return Effect.succeed({
    workflowProvider,
    input: {
      provider,
      providerAccountId: `platform-smoke-${workflowProvider}`,
      region: required('GRIDORA_SMOKE_REGION'),
      plan: required('GRIDORA_SMOKE_PLAN'),
      ttlMinutes: Number(ttl),
      runId: required('GRIDORA_SMOKE_RUN_ID'),
      sourceCommit: required('GRIDORA_SOURCE_COMMIT'),
      artifactDigest: required('GRIDORA_ARTIFACT_DIGEST'),
      imageVersion: required('GRIDORA_IMAGE_VERSION'),
      artifactUrl: required('GRIDORA_SMOKE_ARTIFACT_URL'),
    },
  })
}

export interface SmokeCliDependencies {
  readonly driver: (
    credentials: SmokeCredentials,
    region: string,
  ) => Effect.Effect<ProviderImageSmokeDriverShape, ProviderImageSmokeError>
  readonly observer: AgentHealthObserverShape
  readonly write: (report: string) => Effect.Effect<void>
}

const summary = (title: string, serialized: string) =>
  [`### ${title}`, '', '```json', JSON.stringify(JSON.parse(serialized), null, 2), '```', ''].join(
    '\n',
  )

/** Every configured credential value and the artifact locator; none may appear in a report. */
const environmentSecrets = (environment: SmokeEnvironment): readonly string[] =>
  [
    ...SMOKE_CREDENTIAL_ENVIRONMENT.ovhcloud,
    ...SMOKE_CREDENTIAL_ENVIRONMENT.contabo,
    'GRIDORA_SMOKE_ARTIFACT_URL',
  ]
    .map((name) => (environment[name] ?? '').trim())
    .filter((value) => value.length > 0)

/** Runs one smoke and returns the process exit code. Only a passed smoke with confirmed cleanup returns 0. */
export const runSmokeCli = (
  environment: SmokeEnvironment,
  dependencies: SmokeCliDependencies,
): Effect.Effect<number> => {
  const secrets = environmentSecrets(environment)
  const run = Effect.gen(function* () {
    const request = yield* parseSmokeEnvironment(environment)
    const credentials = yield* resolveSmokeCredentials(request.input.provider, environment)
    const driver = yield* dependencies.driver(credentials, request.input.region)
    const evidence = yield* runProviderImageSmoke(request.input).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderImageSmokeDriver, driver),
          Layer.succeed(AgentHealthObserver, dependencies.observer),
        ),
      ),
    )
    const serialized = yield* assertNoSecretValues(evidence, [
      ...secrets,
      ...smokeSecretValues(credentials),
    ])
    yield* dependencies.write(summary('Paid provider image smoke passed', serialized))
    return 0
  })
  return run.pipe(
    Effect.catchTag('ProviderImageSmokeError', (error) =>
      assertNoSecretValues(
        {
          schemaVersion: 1,
          result: 'failed',
          provider: environment.GRIDORA_SMOKE_PROVIDER ?? null,
          region: environment.GRIDORA_SMOKE_REGION ?? null,
          plan: environment.GRIDORA_SMOKE_PLAN ?? null,
          runId: environment.GRIDORA_SMOKE_RUN_ID ?? null,
          stage: error.stage,
          code: error.code,
          message: error.message,
          ...(error.cleanup === undefined ? {} : { cleanup: error.cleanup }),
        },
        secrets,
      ).pipe(
        Effect.flatMap((serialized) =>
          dependencies.write(summary('Paid provider image smoke failed', serialized)),
        ),
        Effect.catchTag('ProviderImageSmokeError', () =>
          dependencies.write('### Paid provider image smoke failed\n\nThe report was withheld.\n'),
        ),
        Effect.as(1),
      ),
    ),
  )
}

const defaultWrite =
  (environment: SmokeEnvironment) =>
  (report: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      process.stdout.write(report)
      const path = environment.GITHUB_STEP_SUMMARY
      if (path !== undefined && path.length > 0) await appendFile(path, report)
    })

/** Process entry point. SIGINT and SIGTERM interrupt the run; cleanup still executes. */
export const main = async (environment: SmokeEnvironment): Promise<number> => {
  const program = runSmokeCli(environment, {
    driver: (credentials, region) => makeLiveSmokeDriver(credentials, region),
    observer: unavailableAgentHealthObserver,
    write: defaultWrite(environment),
  })
  const fiber = Effect.runFork(program)
  const interrupt = () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const exit = await Effect.runPromise(Fiber.await(fiber))
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  if (Exit.isSuccess(exit)) return exit.value
  process.stderr.write('Paid provider image smoke was interrupted.\n')
  return 1
}
