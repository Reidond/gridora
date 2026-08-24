import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  AgentObservationEvent as AgentObservationEventSchema,
  type AgentObservationEvent,
  type AgentObservationReceipt,
} from '@gridora/agent-observation-control'
import { Context, Effect, Layer, Schema, Semaphore } from 'effect'
import { AgentError } from './errors.js'
import { AgentClock } from './services.js'
import type { NodeAuthentication } from './transport.js'
import type { AgentIdentity } from './validation.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const AgentObservationReceiptSchema = Schema.Struct({
  organizationId: Identifier,
  nodeId: Identifier,
  sequence: PositiveInteger,
  observedRevision: PositiveInteger,
  observedState: Schema.Literals(['bootstrapping', 'ready', 'degraded']),
  capacityPublished: Schema.Boolean,
  acceptedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
})

const ObservationPublisherState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  credentialId: Identifier,
  credentialVersion: PositiveInteger,
  sessionVersion: PositiveInteger,
  lastAcceptedSequence: NonNegativeInteger,
  lastObservedRevision: NonNegativeInteger,
  pendingEvent: Schema.NullOr(AgentObservationEventSchema),
})
type ObservationPublisherState = typeof ObservationPublisherState.Type

const failure = (code: 'execution-failed' | 'state-failed', message: string) =>
  new AgentError({ code, message })

export class AgentObservationTransport extends Context.Service<
  AgentObservationTransport,
  {
    readonly publish: (
      credential: string,
      event: AgentObservationEvent,
    ) => Effect.Effect<AgentObservationReceipt, AgentError | AgentObservationRefreshRequiredError>
  }
>()('gridora/agent/ObservationTransport') {}

export class AgentObservationRefreshRequiredError extends Schema.TaggedError<AgentObservationRefreshRequiredError>()(
  'AgentObservationRefreshRequiredError',
  { code: Schema.Literal('agent_observation_not_committed') },
) {}

export class AgentObservationFactsProbe extends Context.Service<
  AgentObservationFactsProbe,
  {
    readonly inspect: Effect.Effect<AgentObservationEvent['facts'], AgentError>
  }
>()('gridora/agent/ObservationFactsProbe') {}

export class AgentObservationState extends Context.Service<
  AgentObservationState,
  {
    readonly prepare: (
      authentication: NodeAuthentication,
      identity: AgentIdentity,
      issuedAt: string,
      facts: AgentObservationEvent['facts'],
    ) => Effect.Effect<AgentObservationEvent, AgentError>
    readonly pending: (
      authentication: NodeAuthentication,
    ) => Effect.Effect<AgentObservationEvent | null, AgentError>
    readonly accept: (
      authentication: NodeAuthentication,
      receipt: AgentObservationReceipt,
    ) => Effect.Effect<void, AgentError>
    readonly refresh: (
      authentication: NodeAuthentication,
      issuedAt: string,
      facts: AgentObservationEvent['facts'],
    ) => Effect.Effect<AgentObservationEvent, AgentError>
  }
>()('gridora/agent/ObservationState') {}

const readBoundedJson = (response: Response): Effect.Effect<unknown, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('missing response body')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 16 * 1024) {
          await reader.cancel()
          throw new Error('response is too large')
        }
        chunks.push(next.value)
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder().decode(body)) as unknown
    },
    catch: () => failure('execution-failed', 'observation response was invalid'),
  })

export const FetchAgentObservationTransport = (
  controlPlaneUrl: string,
  expectedHost: string,
  allowLoopbackHttp: boolean,
) => {
  const origin = new URL(controlPlaneUrl)
  const loopback =
    origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '::1'
  if (origin.hostname !== expectedHost) throw new Error('observation endpoint host is invalid')
  if (
    origin.protocol !== 'https:' &&
    !(allowLoopbackHttp && loopback && origin.protocol === 'http:')
  )
    throw new Error('observation endpoint must use HTTPS')
  if (origin.username !== '' || origin.password !== '')
    throw new Error('observation endpoint must not contain credentials')
  return Layer.succeed(AgentObservationTransport, {
    publish: (credential, event) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(new URL('/v1/agent/events', origin), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${credential}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(event),
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: () => failure('execution-failed', 'observation delivery failed'),
      }).pipe(
        Effect.flatMap(
          (response): Effect.Effect<unknown, AgentError | AgentObservationRefreshRequiredError> =>
            Effect.gen(function* () {
              const body = yield* readBoundedJson(response)
              if (response.ok) return body
              const problem =
                typeof body === 'object' && body !== null
                  ? (body as Readonly<Record<string, unknown>>)
                  : undefined
              if (response.status === 409 && problem?.code === 'AGENT_OBSERVATION_NOT_COMMITTED')
                return yield* new AgentObservationRefreshRequiredError({
                  code: 'agent_observation_not_committed',
                })
              return yield* failure(
                'execution-failed',
                `observation endpoint rejected the event with status ${response.status}`,
              )
            }),
        ),
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(AgentObservationReceiptSchema, {
            onExcessProperty: 'error',
          })(body),
        ),
        Effect.mapError((cause) =>
          cause instanceof AgentError || cause instanceof AgentObservationRefreshRequiredError
            ? cause
            : failure('execution-failed', 'observation receipt failed validation'),
        ),
      ),
  })
}

const initialState = (authentication: NodeAuthentication): ObservationPublisherState => ({
  schemaVersion: 1,
  credentialId: authentication.credentialId,
  credentialVersion: authentication.credentialVersion,
  sessionVersion: authentication.sessionVersion,
  lastAcceptedSequence: 0,
  lastObservedRevision: 0,
  pendingEvent: null,
})

const sameAuthentication = (
  state: ObservationPublisherState,
  authentication: NodeAuthentication,
): boolean =>
  state.credentialId === authentication.credentialId &&
  state.credentialVersion === authentication.credentialVersion &&
  state.sessionVersion === authentication.sessionVersion

export const FileAgentObservationState = (path: string) => {
  const persist = (state: ObservationPublisherState): Effect.Effect<void, AgentError> =>
    Effect.tryPromise({
      try: async () => {
        const directory = dirname(path)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, path)
          const parent = await open(directory, 'r')
          try {
            await parent.sync()
          } finally {
            await parent.close()
          }
        } catch (cause) {
          await rm(temporary, { force: true })
          throw cause
        }
      },
      catch: () => failure('state-failed', 'observation state could not be persisted'),
    })
  const load = (authentication: NodeAuthentication) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const metadata = await stat(path)
          if ((metadata.mode & 0o077) !== 0)
            throw new Error('observation state permissions are unsafe')
          if (process.getuid !== undefined && metadata.uid !== process.getuid())
            throw new Error('observation state owner is unsafe')
          const source = await readFile(path, 'utf8')
          return await Schema.decodeUnknownPromise(ObservationPublisherState, {
            onExcessProperty: 'error',
          })(JSON.parse(source) as unknown)
        } catch (cause) {
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'ENOENT'
          )
            return initialState(authentication)
          throw cause
        }
      },
      catch: () => failure('state-failed', 'observation state could not be read'),
    }).pipe(
      Effect.flatMap((state) => {
        if (sameAuthentication(state, authentication)) return Effect.succeed(state)
        if (authentication.sessionVersion <= state.sessionVersion)
          return Effect.fail(failure('state-failed', 'observation authentication moved backwards'))
        return Effect.succeed({
          ...initialState(authentication),
          lastObservedRevision: state.lastObservedRevision,
        })
      }),
    )
  return Layer.effect(
    AgentObservationState,
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      const exclusive = <A>(effect: Effect.Effect<A, AgentError>) => semaphore.withPermit(effect)
      return AgentObservationState.of({
        pending: (authentication) =>
          exclusive(load(authentication).pipe(Effect.map((state) => state.pendingEvent))),
        prepare: (authentication, identity, issuedAt, facts) =>
          exclusive(
            load(authentication).pipe(
              Effect.flatMap((state) => {
                if (state.pendingEvent !== null) return Effect.succeed(state.pendingEvent)
                const event: AgentObservationEvent = {
                  apiVersion: 'agent.gridora.dev/v1alpha1',
                  organizationId: identity.organizationId,
                  nodeId: identity.nodeId,
                  sessionVersion: authentication.sessionVersion,
                  sequence: state.lastAcceptedSequence + 1,
                  observedRevision: state.lastObservedRevision + 1,
                  issuedAt,
                  facts,
                }
                return persist({ ...state, pendingEvent: event }).pipe(Effect.as(event))
              }),
            ),
          ),
        accept: (authentication, receipt) =>
          exclusive(
            load(authentication).pipe(
              Effect.flatMap((state) => {
                const pending = state.pendingEvent
                if (
                  pending === null ||
                  receipt.organizationId !== pending.organizationId ||
                  receipt.nodeId !== pending.nodeId ||
                  receipt.sequence !== pending.sequence ||
                  receipt.observedRevision !== pending.observedRevision
                )
                  return Effect.fail(failure('state-failed', 'observation receipt does not match'))
                return persist({
                  ...state,
                  lastAcceptedSequence: pending.sequence,
                  lastObservedRevision: pending.observedRevision,
                  pendingEvent: null,
                })
              }),
            ),
          ),
        refresh: (authentication, issuedAt, facts) =>
          exclusive(
            load(authentication).pipe(
              Effect.flatMap((state) => {
                if (state.pendingEvent === null)
                  return Effect.fail(
                    failure('state-failed', 'observation refresh has no pending event'),
                  )
                const refreshed: AgentObservationEvent = {
                  ...state.pendingEvent,
                  issuedAt,
                  facts,
                }
                return persist({ ...state, pendingEvent: refreshed }).pipe(Effect.as(refreshed))
              }),
            ),
          ),
      })
    }),
  )
}

export const makeAgentObservationPublisher = Effect.gen(function* () {
  const transport = yield* AgentObservationTransport
  const factsProbe = yield* AgentObservationFactsProbe
  const state = yield* AgentObservationState
  const clock = yield* AgentClock
  const semaphore = yield* Semaphore.make(1)
  return {
    publishOnce: (
      authentication: NodeAuthentication,
      identity: AgentIdentity,
    ): Effect.Effect<AgentObservationReceipt, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const existing = yield* state.pending(authentication)
          const now = yield* clock.now
          const event =
            existing ??
            (yield* state.prepare(
              authentication,
              identity,
              now.toISOString(),
              yield* factsProbe.inspect,
            ))
          const receipt = yield* transport.publish(authentication.nodeCredential, event).pipe(
            Effect.catch((error) =>
              error instanceof AgentObservationRefreshRequiredError
                ? Effect.gen(function* () {
                    const refreshed = yield* state.refresh(
                      authentication,
                      (yield* clock.now).toISOString(),
                      yield* factsProbe.inspect,
                    )
                    return yield* transport
                      .publish(authentication.nodeCredential, refreshed)
                      .pipe(
                        Effect.mapError((nextError) =>
                          nextError instanceof AgentObservationRefreshRequiredError
                            ? failure(
                                'execution-failed',
                                'observation refresh was rejected repeatedly',
                              )
                            : nextError,
                        ),
                      )
                  })
                : Effect.fail(error),
            ),
          )
          yield* state.accept(authentication, receipt)
          return receipt
        }),
      ),
  } as const
})
