import { createHash } from 'node:crypto'
import {
  canonicalCommandPayload,
  decodeAgentCommand,
  type CommandResult,
} from '@gridora/agent-protocol'
import { Effect } from 'effect'
import { AgentError } from './errors.js'
import {
  AgentClock,
  CommandExecutor,
  CommandState,
  type ExecutionResult,
  SignatureVerifier,
} from './services.js'
import {
  type AgentIdentity,
  validateCommandEnvelope,
  validateCommandPayload,
} from './validation.js'

export const handleCommand = (
  input: unknown,
  identity: AgentIdentity,
): Effect.Effect<
  CommandResult | undefined,
  AgentError,
  AgentClock | CommandExecutor | CommandState | SignatureVerifier
> =>
  Effect.gen(function* () {
    const command = yield* decodeAgentCommand(input).pipe(
      Effect.mapError(
        (cause) => new AgentError({ code: 'invalid-command', message: String(cause) }),
      ),
    )
    const verifier = yield* SignatureVerifier
    if (!(yield* verifier.verify(command)))
      return yield* Effect.fail(
        new AgentError({ code: 'invalid-signature', message: 'command signature is invalid' }),
      )
    const clock = yield* AgentClock
    const now = yield* clock.now
    yield* validateCommandEnvelope(command, identity, now)
    const state = yield* CommandState
    const fingerprint = createHash('sha256').update(canonicalCommandPayload(command)).digest('hex')
    const claim = yield* state.claim(command.commandId, fingerprint, now.getTime(), 5 * 60_000)
    if (claim.status === 'completed') return { ...claim.result, duplicate: true }
    if (claim.status === 'busy') return undefined
    if (claim.status === 'payload-mismatch')
      return yield* Effect.fail(
        new AgentError({
          code: 'payload-mismatch',
          message: 'command ID was replayed with a different signed payload',
        }),
      )
    const terminal = (
      status: 'failed' | 'rejected',
      error: AgentError,
      revision: number | null,
    ): CommandResult => ({
      commandId: command.commandId,
      operationId: command.operationId,
      status,
      revision,
      code: error.code,
      message: error.message,
      duplicate: false,
      completedAt: now.toISOString(),
    })
    const currentRevision = yield* state.revision(command.resourceId)
    const validation = yield* validateCommandPayload(command, identity, now).pipe(
      Effect.map((): AgentError | undefined => undefined),
      Effect.catch((error) => Effect.succeed(error)),
    )
    if (validation !== undefined) {
      const result = terminal('rejected', validation, currentRevision)
      yield* state.complete(
        command.resourceId,
        fingerprint,
        claim.token,
        result,
        command.expectedPriorRevision,
      )
      return result
    }
    if (
      command.expectedPriorRevision !== null &&
      command.expectedPriorRevision !== currentRevision
    ) {
      const result = terminal(
        'rejected',
        new AgentError({
          code: 'revision-conflict',
          message: `expected revision ${command.expectedPriorRevision}, observed ${currentRevision}`,
        }),
        currentRevision,
      )
      yield* state.complete(
        command.resourceId,
        fingerprint,
        claim.token,
        result,
        command.expectedPriorRevision,
      )
      return result
    }
    const executor = yield* CommandExecutor
    const renewal = Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep('60 seconds')
        const renewalNow = yield* clock.now
        yield* state.renew(
          command.commandId,
          fingerprint,
          claim.token,
          renewalNow.getTime(),
          5 * 60_000,
        )
      }),
    )
    const executed = yield* Effect.raceFirst(executor.execute(command), renewal).pipe(
      Effect.map((value): ExecutionResult | AgentError => value),
      Effect.catch((error) => Effect.succeed(error)),
    )
    if (executed instanceof AgentError) {
      // A separate root helper may have restarted this process after committing
      // the exact activation receipt. Do not turn a missing socket response
      // into a durable failed command: leave the leased claim for a later
      // replay, which the helper will adopt by command ID and release digest.
      if (executed.code === 'update-response-pending') return undefined
      const result = terminal('failed', executed, currentRevision)
      yield* state.complete(
        command.resourceId,
        fingerprint,
        claim.token,
        result,
        command.expectedPriorRevision,
      )
      return result
    }
    const result: CommandResult = {
      commandId: command.commandId,
      operationId: command.operationId,
      status: 'succeeded',
      revision: executed.revision,
      code: executed.code,
      message: executed.message,
      ...(executed.evidence === undefined ? {} : { evidence: executed.evidence }),
      duplicate: false,
      completedAt: now.toISOString(),
    }
    yield* state.complete(
      command.resourceId,
      fingerprint,
      claim.token,
      result,
      command.expectedPriorRevision,
    )
    return result
  })
