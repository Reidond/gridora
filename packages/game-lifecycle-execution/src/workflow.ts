import { Effect, Schema } from 'effect'
import type { CloudflareApiShape } from '@gridora/cloudflare-control'
import {
  endpointIntent,
  GameWorkflowStepNames,
  makeAgentCommandSpec,
  publishGameDns,
  teardownGameDns,
  verifyGameObservation,
  type GameObservation,
  type GameWorkflowPayload,
  type GameWorkflowStepName,
} from './index.js'

export interface GameWorkflowStepDependencies {
  /** Queue and await/adopt the exact signed command's terminal result. */
  readonly dispatch: (
    payload: GameWorkflowPayload,
    step: GameWorkflowStepName,
    command: { readonly type: string; readonly payload: unknown },
  ) => Effect.Effect<
    {
      readonly commandId: string
      readonly operationId: string
      readonly step: GameWorkflowStepName
      readonly status: 'succeeded' | 'failed' | 'rejected'
      /** `adopted` is the durable command-delivery replay path after response loss. */
      readonly delivery: 'executed' | 'adopted'
      readonly revision: number | null
    },
    GameWorkflowStepError
  >
  /** Capacity/lease/backup coordinator evidence must be persisted and fenced. */
  readonly coordinate?: (
    payload: GameWorkflowPayload,
    step: Extract<
      GameWorkflowStepName,
      | 'reserve'
      | 'release-ports'
      | 'backup-if-required'
      | 'authorize-force-cleanup'
      | 'stop'
      | 'remove'
      | 'verify-observation'
    >,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
  /** Move-specific backup/restore/cutover evidence.  These steps must be
   * backed by the native backup Workflow and a transactional D1 cutover. */
  readonly move?: (
    payload: GameWorkflowPayload,
    step: GameWorkflowStepName,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
  /** Read the authoritative tenant/server/operation reduction from D1. */
  readonly readObservation: (
    payload: GameWorkflowPayload,
  ) => Effect.Effect<GameObservation, GameWorkflowStepError>
  readonly cloudflare?: CloudflareApiShape
  readonly dns?: {
    readonly zoneId: string
    readonly target?: string
    readonly type: 'A' | 'AAAA'
    readonly providerRecordId?: string
  }
  /** Persist the exact provider result before acknowledging publication/teardown. */
  readonly recordDns?: (
    payload: GameWorkflowPayload,
    step: Extract<GameWorkflowStepName, 'publish-endpoint' | 'delete-dns'>,
    providerResult: unknown,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
  /** D1 evidence that no DNS row is expected when the request omitted a domain. */
  readonly verifyNoDns?: (
    payload: GameWorkflowPayload,
  ) => Effect.Effect<
    { readonly organizationId: string; readonly serverId: string; readonly operationId: string },
    GameWorkflowStepError
  >
  /** Persist/adopt the operation-bound terminal audit and completion receipt. */
  readonly complete: (
    payload: GameWorkflowPayload,
    step: GameWorkflowStepName,
    evidence: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<
    {
      readonly organizationId: string
      readonly serverId: string
      readonly operationId: string
      readonly step: string
      readonly revision: number
    },
    GameWorkflowStepError
  >
}

export class GameWorkflowStepError extends Schema.TaggedError<GameWorkflowStepError>()(
  'GameWorkflowStepError',
  { code: Schema.String, message: Schema.String },
) {}

export const GameWorkflowStepResult = Schema.Struct({
  status: Schema.Literals(['verified', 'completed']),
  step: Schema.String,
  commandId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
})
export type GameWorkflowStepResult = typeof GameWorkflowStepResult.Type

type CoordinatorStep =
  | 'reserve'
  | 'release-ports'
  | 'backup-if-required'
  | 'authorize-force-cleanup'
const coordinatorSteps: ReadonlySet<CoordinatorStep> = new Set<CoordinatorStep>([
  'reserve',
  'release-ports',
  'backup-if-required',
  'authorize-force-cleanup',
])
const isCoordinatorStep = (step: GameWorkflowStepName): step is CoordinatorStep =>
  coordinatorSteps.has(step as CoordinatorStep)

type ForcedCleanupCoordinatorStep = Extract<
  GameWorkflowStepName,
  'stop' | 'remove' | 'verify-observation'
>
const forcedCleanupCoordinatorSteps: ReadonlySet<ForcedCleanupCoordinatorStep> = new Set([
  'stop',
  'remove',
  'verify-observation',
])
const isForcedCleanupCoordinatorStep = (
  payload: GameWorkflowPayload,
  step: GameWorkflowStepName,
): boolean =>
  payload.forcedCleanup === true &&
  forcedCleanupCoordinatorSteps.has(step as ForcedCleanupCoordinatorStep)

type MoveCoordinatorStep = Exclude<GameWorkflowStepName, 'stop-source' | CoordinatorStep>
const moveCoordinatorSteps: ReadonlySet<MoveCoordinatorStep> = new Set<MoveCoordinatorStep>([
  'reserve-target',
  'backup-source',
  'restore-target',
  'verify-target',
  'cutover-endpoint',
  'release-source',
  'rollback-if-required',
])
const isMoveCoordinatorStep = (step: GameWorkflowStepName): step is MoveCoordinatorStep =>
  moveCoordinatorSteps.has(step as MoveCoordinatorStep)

// Once `stop-source` has completed, any restore/validation/cutover/release
// failure has changed the source-side lifecycle.  The Workflow must drive the
// durable rollback step immediately instead of relying on a later scheduled
// `rollback-if-required` turn that will never be reached after a failed step.
const moveCompensationSteps: ReadonlySet<GameWorkflowStepName> = new Set([
  // The source command may have completed before the D1 phase/evidence write
  // fails. Treat that as a physical source-side change and drive the same
  // rollback path that recreates/restarts the source from immutable evidence.
  'stop-source',
  'restore-target',
  'verify-target',
  'cutover-endpoint',
  'release-source',
])

const isFinalStep = (payload: GameWorkflowPayload, step: GameWorkflowStepName): boolean =>
  GameWorkflowStepNames[payload.action].at(-1) === step

const finish = (
  payload: GameWorkflowPayload,
  step: GameWorkflowStepName,
  result: GameWorkflowStepResult,
  dependencies: GameWorkflowStepDependencies,
  evidence: Readonly<Record<string, unknown>>,
): Effect.Effect<GameWorkflowStepResult, GameWorkflowStepError> => {
  if (!isFinalStep(payload, step)) return Effect.succeed(result)
  return dependencies.complete(payload, step, evidence).pipe(
    Effect.flatMap((completion) =>
      completion.organizationId === payload.organizationId &&
      completion.serverId === payload.serverId &&
      completion.operationId === payload.operationId &&
      completion.step === step &&
      Number.isInteger(completion.revision) &&
      completion.revision > 0
        ? Effect.succeed(result)
        : Effect.fail(
            new GameWorkflowStepError({
              code: 'completion-evidence-mismatch',
              message: 'Terminal completion evidence is not bound to this operation step',
            }),
          ),
    ),
  )
}

/**
 * Internal Workflow-step composition. Agent commands intentionally return
 * a terminal result; only `verify-observation` can return `verified`, and it reads
 * the append-only tenant-scoped reduction before the durable Workflow can
 * finish. DNS publication is ownership-checked and DNS-only.
 */
export const executeGameWorkflowStep = (
  payload: GameWorkflowPayload,
  step: GameWorkflowStepName,
  dependencies: GameWorkflowStepDependencies,
): Effect.Effect<GameWorkflowStepResult, GameWorkflowStepError> => {
  const run = (): Effect.Effect<GameWorkflowStepResult, GameWorkflowStepError> => {
    if (isForcedCleanupCoordinatorStep(payload, step)) {
      if (dependencies.coordinate === undefined)
        return Effect.fail(
          new GameWorkflowStepError({
            code: 'forced-cleanup-evidence-missing',
            message: `Forced cleanup step ${step} requires persisted failed-node evidence`,
          }),
        )
      const forcedStep = step as ForcedCleanupCoordinatorStep
      return dependencies.coordinate(payload, forcedStep).pipe(
        Effect.flatMap((evidence) =>
          evidence.organizationId === payload.organizationId &&
          evidence.serverId === payload.serverId &&
          evidence.operationId === payload.operationId &&
          evidence.step === forcedStep
            ? finish(
                payload,
                forcedStep,
                {
                  status:
                    forcedStep === 'verify-observation'
                      ? ('verified' as const)
                      : ('completed' as const),
                  step: forcedStep,
                  revision: evidence.revision,
                },
                dependencies,
                { forcedCleanupReceiptRevision: evidence.revision },
              )
            : Effect.fail(
                new GameWorkflowStepError({
                  code: 'forced-cleanup-evidence-mismatch',
                  message: `Forced cleanup step ${forcedStep} evidence is not bound to this operation`,
                }),
              ),
        ),
      )
    }
    if (step === 'verify-observation')
      return dependencies.readObservation(payload).pipe(
        Effect.flatMap((observation) =>
          verifyGameObservation(payload, payload.expectedPriorRevision ?? 0, observation).pipe(
            Effect.mapError(
              (error) => new GameWorkflowStepError({ code: error.code, message: error.message }),
            ),
            Effect.flatMap((verified) =>
              finish(
                payload,
                step,
                { status: 'verified' as const, step, revision: verified.revision },
                dependencies,
                { observationRevision: verified.revision, observedState: observation.state },
              ),
            ),
          ),
        ),
      )
    if (step === 'publish-endpoint') {
      if (payload.domain === undefined) {
        if (dependencies.verifyNoDns === undefined)
          return Effect.fail(
            new GameWorkflowStepError({
              code: 'dns-evidence-missing',
              message: 'A no-domain endpoint step requires tenant-scoped absence evidence',
            }),
          )
        return dependencies.verifyNoDns(payload).pipe(
          Effect.flatMap((evidence) =>
            evidence.organizationId === payload.organizationId &&
            evidence.serverId === payload.serverId &&
            evidence.operationId === payload.operationId
              ? finish(payload, step, { status: 'completed' as const, step }, dependencies, {
                  dns: 'absent',
                })
              : Effect.fail(
                  new GameWorkflowStepError({
                    code: 'dns-evidence-mismatch',
                    message: 'No-domain evidence is not bound to this operation',
                  }),
                ),
          ),
        )
      }
      const dns = dependencies.dns
      const cloudflare = dependencies.cloudflare
      const target = dns?.target
      if (cloudflare === undefined || dns === undefined || target === undefined)
        return Effect.fail(
          new GameWorkflowStepError({
            code: 'dns-adapter-missing',
            message:
              'DNS publication requires the Cloudflare control adapter and an authoritative target',
          }),
        )
      return endpointIntent(payload, target).pipe(
        Effect.mapError(
          (error) => new GameWorkflowStepError({ code: error.code, message: error.message }),
        ),
        Effect.flatMap((intent) =>
          publishGameDns(cloudflare, {
            zoneId: dns.zoneId,
            organizationId: intent.organizationId,
            serverId: intent.serverId,
            hostname: intent.hostname,
            target,
          }),
        ),
        Effect.mapError(
          (error) => new GameWorkflowStepError({ code: error.code, message: error.message }),
        ),
        Effect.flatMap((providerResult) =>
          dependencies.recordDns === undefined
            ? Effect.fail(
                new GameWorkflowStepError({
                  code: 'dns-receipt-missing',
                  message: 'DNS publication requires a durable D1 receipt',
                }),
              )
            : dependencies
                .recordDns(payload, step, providerResult)
                .pipe(
                  Effect.flatMap((evidence) =>
                    finish(
                      payload,
                      step,
                      { status: 'completed' as const, step, revision: evidence.revision },
                      dependencies,
                      { dnsReceiptRevision: evidence.revision },
                    ),
                  ),
                ),
        ),
      )
    }
    if (step === 'delete-dns') {
      if (payload.domain === undefined) {
        if (dependencies.verifyNoDns === undefined)
          return Effect.fail(
            new GameWorkflowStepError({
              code: 'dns-evidence-missing',
              message: 'A no-domain teardown requires tenant-scoped absence evidence',
            }),
          )
        return dependencies.verifyNoDns(payload).pipe(
          Effect.flatMap((evidence) =>
            evidence.organizationId === payload.organizationId &&
            evidence.serverId === payload.serverId &&
            evidence.operationId === payload.operationId
              ? finish(payload, step, { status: 'completed' as const, step }, dependencies, {
                  dns: 'absent',
                })
              : Effect.fail(
                  new GameWorkflowStepError({
                    code: 'dns-evidence-mismatch',
                    message: 'No-domain evidence is not bound to this operation',
                  }),
                ),
          ),
        )
      }
      const dns = dependencies.dns
      const cloudflare = dependencies.cloudflare
      if (
        cloudflare === undefined ||
        dns === undefined ||
        dns.target === undefined ||
        dns.providerRecordId === undefined
      )
        return Effect.fail(
          new GameWorkflowStepError({
            code: 'dns-adapter-missing',
            message:
              'DNS teardown requires the Cloudflare control adapter, hostname, and authoritative record type',
          }),
        )
      return teardownGameDns(cloudflare, {
        zoneId: dns.zoneId,
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        hostname: payload.domain,
        type: dns.type,
        target: dns.target,
        providerRecordId: dns.providerRecordId,
      }).pipe(
        Effect.mapError(
          (error) => new GameWorkflowStepError({ code: error.code, message: error.message }),
        ),
        Effect.flatMap((providerResult) =>
          dependencies.recordDns === undefined
            ? Effect.fail(
                new GameWorkflowStepError({
                  code: 'dns-receipt-missing',
                  message: 'DNS teardown requires a durable D1 receipt',
                }),
              )
            : dependencies
                .recordDns(payload, step, providerResult)
                .pipe(
                  Effect.flatMap((evidence) =>
                    finish(
                      payload,
                      step,
                      { status: 'completed' as const, step, revision: evidence.revision },
                      dependencies,
                      { dnsReceiptRevision: evidence.revision },
                    ),
                  ),
                ),
        ),
      )
    }
    if (isCoordinatorStep(step)) {
      if (dependencies.coordinate === undefined)
        return Effect.fail(
          new GameWorkflowStepError({
            code: 'coordinator-evidence-missing',
            message: `Step ${step} requires persisted coordinator evidence`,
          }),
        )
      return dependencies.coordinate(payload, step).pipe(
        Effect.flatMap((evidence) =>
          evidence.organizationId === payload.organizationId &&
          evidence.serverId === payload.serverId &&
          evidence.operationId === payload.operationId &&
          evidence.step === step
            ? finish(
                payload,
                step,
                { status: 'completed' as const, step, revision: evidence.revision },
                dependencies,
                { coordinatorRevision: evidence.revision },
              )
            : Effect.fail(
                new GameWorkflowStepError({
                  code: 'coordinator-evidence-mismatch',
                  message: `Step ${step} evidence is not bound to this operation`,
                }),
              ),
        ),
      )
    }
    if (isMoveCoordinatorStep(step)) {
      if (payload.action !== 'move' || dependencies.move === undefined)
        return Effect.fail(
          new GameWorkflowStepError({
            code: 'move-adapter-missing',
            message: `Move step ${step} requires the native backup/cutover adapter`,
          }),
        )
      return dependencies.move(payload, step).pipe(
        Effect.flatMap((evidence) =>
          evidence.organizationId === payload.organizationId &&
          evidence.serverId === payload.serverId &&
          evidence.operationId === payload.operationId &&
          evidence.step === step
            ? finish(
                payload,
                step,
                { status: 'completed' as const, step, revision: evidence.revision },
                dependencies,
                { coordinatorRevision: evidence.revision },
              )
            : Effect.fail(
                new GameWorkflowStepError({
                  code: 'move-evidence-mismatch',
                  message: `Move step ${step} evidence is not bound to this operation`,
                }),
              ),
        ),
      )
    }
    return makeAgentCommandSpec(payload, step).pipe(
      Effect.mapError(
        (error) => new GameWorkflowStepError({ code: error.code, message: error.message }),
      ),
      Effect.flatMap((command) => dependencies.dispatch(payload, step, command)),
      Effect.flatMap((result) =>
        result.status !== 'succeeded'
          ? Effect.fail(
              new GameWorkflowStepError({
                code: `command-${result.status}`,
                message: `Command ${result.commandId} did not complete successfully`,
              }),
            )
          : result.operationId !== payload.operationId ||
              result.step !== step ||
              result.commandId.length === 0 ||
              (result.delivery !== 'executed' && result.delivery !== 'adopted')
            ? Effect.fail(
                new GameWorkflowStepError({
                  code: 'command-evidence-mismatch',
                  message: 'Command terminal result is not bound to this operation step',
                }),
              )
            : payload.action === 'move' && step === 'stop-source' && dependencies.move !== undefined
              ? dependencies.move(payload, step).pipe(
                  Effect.flatMap((evidence) =>
                    evidence.organizationId === payload.organizationId &&
                    evidence.serverId === payload.serverId &&
                    evidence.operationId === payload.operationId &&
                    evidence.step === step
                      ? finish(
                          payload,
                          step,
                          {
                            status: 'completed' as const,
                            step,
                            commandId: result.commandId,
                            revision: evidence.revision,
                          },
                          dependencies,
                          { commandId: result.commandId, commandRevision: evidence.revision },
                        )
                      : Effect.fail(
                          new GameWorkflowStepError({
                            code: 'move-evidence-mismatch',
                            message: 'Move stop evidence is not bound to this operation',
                          }),
                        ),
                  ),
                )
              : finish(
                  payload,
                  step,
                  {
                    status: 'completed' as const,
                    step,
                    commandId: result.commandId,
                    ...(result.revision === null ? {} : { revision: result.revision }),
                  },
                  dependencies,
                  {
                    commandId: result.commandId,
                    ...(result.revision === null ? {} : { commandRevision: result.revision }),
                  },
                ),
      ),
    )
  }
  return run().pipe(
    Effect.catch((originalError) => {
      if (
        payload.action !== 'move' ||
        !moveCompensationSteps.has(step) ||
        dependencies.move === undefined
      )
        return Effect.fail(originalError)
      return Effect.result(dependencies.move(payload, 'rollback-if-required')).pipe(
        Effect.flatMap((result) => {
          if (result._tag === 'Failure')
            return Effect.fail(
              new GameWorkflowStepError({
                code: 'move-compensation-failed',
                message: `Move ${step} failed (${originalError.code}) and immutable rollback did not complete: ${String(result.failure)}`,
              }),
            )
          const evidence = result.success
          if (
            evidence.organizationId !== payload.organizationId ||
            evidence.serverId !== payload.serverId ||
            evidence.operationId !== payload.operationId ||
            evidence.step !== 'rollback-if-required' ||
            !Number.isInteger(evidence.revision) ||
            evidence.revision < 1
          )
            return Effect.fail(
              new GameWorkflowStepError({
                code: 'move-compensation-evidence-mismatch',
                message: `Move ${step} failed and rollback returned foreign or incomplete evidence`,
              }),
            )
          // The original failure remains the workflow failure; rollback has
          // already durably restored the effect and should not turn a failed
          // move into a false successful step.
          return Effect.fail(originalError)
        }),
      )
    }),
  )
}
