import type { CommandResult } from '@gridora/agent-protocol'
import { Effect } from 'effect'
import { handleCommand } from './processor.js'
import { AgentClock, CommandExecutor, CommandState, SignatureVerifier } from './services.js'
import { AgentTransport, rejectedResult } from './transport.js'
import type { AgentIdentity } from './validation.js'
import type { NodeAuthentication } from './transport.js'
import type { AgentObservationReceipt } from '@gridora/agent-observation-control'
import type { AgentError } from './errors.js'

export const processNextCommand = (
  identity: AgentIdentity,
  credential: string,
  waitSeconds: number,
): Effect.Effect<
  CommandResult | undefined,
  never,
  AgentClock | AgentTransport | CommandExecutor | CommandState | SignatureVerifier
> =>
  Effect.gen(function* () {
    const transport = yield* AgentTransport
    const input = yield* transport.poll(credential, identity, waitSeconds)
    if (input === undefined) return undefined
    const clock = yield* AgentClock
    const result = yield* handleCommand(input, identity).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const now = yield* clock.now
          return yield* rejectedResult(input, error, now.toISOString())
        }),
      ),
    )
    if (result !== undefined) yield* transport.acknowledge(credential, identity, result)
    return result
  }).pipe(
    Effect.catch((error) =>
      Effect.logError('agent poll/process failed', error).pipe(Effect.as(undefined)),
    ),
  )

export const emptyPollBackoffMs = (attempt: number, jitter: number): number => {
  const boundedAttempt = Math.max(0, Math.min(attempt, 10))
  const base = Math.min(30_000, 1_000 * 2 ** boundedAttempt)
  const boundedJitter = Math.max(0, Math.min(jitter, 1))
  return Math.round(base * (1 + boundedJitter * 0.25))
}

export const runAgentIterations = (
  identity: AgentIdentity,
  credential: string,
  waitSeconds: number,
  iterations: number,
  sleep: (milliseconds: number) => Effect.Effect<void> = (milliseconds) =>
    Effect.sleep(`${milliseconds} millis`),
  random: () => number = Math.random,
): Effect.Effect<
  void,
  never,
  AgentClock | AgentTransport | CommandExecutor | CommandState | SignatureVerifier
> => {
  const loop = (attempt: number, remaining: number): ReturnType<typeof runAgentIterations> =>
    Effect.gen(function* () {
      if (remaining <= 0) return
      const result = yield* processNextCommand(identity, credential, waitSeconds)
      const nextAttempt = result === undefined ? attempt + 1 : 0
      if (result === undefined) yield* sleep(emptyPollBackoffMs(attempt, random()))
      yield* Effect.suspend(() => loop(nextAttempt, remaining - 1))
    })
  return loop(0, iterations)
}

export const runAgentLoop = (
  identity: AgentIdentity,
  credential: string,
  waitSeconds: number,
): Effect.Effect<
  void,
  never,
  AgentClock | AgentTransport | CommandExecutor | CommandState | SignatureVerifier
> => runAgentIterations(identity, credential, waitSeconds, Number.POSITIVE_INFINITY)

export const runObservedAgentLoop = (
  identity: AgentIdentity,
  authentication: NodeAuthentication,
  waitSeconds: number,
  publish: () => Effect.Effect<AgentObservationReceipt, AgentError>,
): Effect.Effect<
  void,
  never,
  AgentClock | AgentTransport | CommandExecutor | CommandState | SignatureVerifier
> => {
  const loop = (attempt: number): ReturnType<typeof runObservedAgentLoop> =>
    Effect.gen(function* () {
      yield* publish().pipe(
        Effect.catch(() =>
          Effect.logWarning('agent observation publication failed; readiness remains closed'),
        ),
      )
      const result = yield* processNextCommand(identity, authentication.nodeCredential, waitSeconds)
      const nextAttempt = result === undefined ? attempt + 1 : 0
      if (result === undefined)
        yield* Effect.sleep(`${emptyPollBackoffMs(attempt, Math.random())} millis`)
      yield* Effect.suspend(() => loop(nextAttempt))
    })
  return loop(0)
}
