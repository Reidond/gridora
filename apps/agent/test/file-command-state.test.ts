import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCommandState } from '../src/file-command-state.js'
import { CommandState } from '../src/services.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const database = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridora-state-'))
  temporary.push(directory)
  return join(directory, 'commands.sqlite')
}
const result = (commandId: string, revision: number) => ({
  commandId,
  operationId: `operation-${commandId}`,
  status: 'succeeded' as const,
  revision,
  code: 'applied',
  message: 'applied',
  duplicate: false,
  completedAt: '2026-08-23T10:00:00Z',
})
const withState = <A, E>(path: string, effect: Effect.Effect<A, E, CommandState>) =>
  Effect.runPromise(effect.pipe(Effect.provide(FileCommandState(path))))

describe('FileCommandState SQLite transactions', () => {
  it('atomically claims a concurrent duplicate once', async () => {
    const path = await database()
    const claims = await Promise.all([
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).claim('c1', 'fp', 100, 1000)
        }),
      ),
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).claim('c1', 'fp', 100, 1000)
        }),
      ),
    ])
    expect(claims.map((claim) => claim.status).sort()).toEqual(['busy', 'claimed'])
  })
  it('does not lose concurrent distinct command completions', async () => {
    const path = await database()
    await Promise.all(
      ['c1', 'c2'].map((id) =>
        withState(
          path,
          Effect.gen(function* () {
            const state = yield* CommandState
            const claim = yield* state.claim(id, `fp-${id}`, 100, 1000)
            if (claim.status !== 'claimed') throw new Error('expected claim')
            yield* state.complete(
              `server-${id}`,
              `fp-${id}`,
              claim.token,
              result(id, id === 'c1' ? 1 : 2),
              0,
            )
          }),
        ),
      ),
    )
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).revision('server-c1')
        }),
      ),
    ).resolves.toBe(1)
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).revision('server-c2')
        }),
      ),
    ).resolves.toBe(2)
  })
  it('rejects a command ID replayed with a different fingerprint', async () => {
    const path = await database()
    await withState(
      path,
      Effect.gen(function* () {
        yield* (yield* CommandState).claim('c1', 'original', 100, 1000)
      }),
    )
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).claim('c1', 'changed', 100, 1000)
        }),
      ),
    ).resolves.toEqual({ status: 'payload-mismatch' })
  })
  it('restores a completed result after restart', async () => {
    const path = await database()
    await withState(
      path,
      Effect.gen(function* () {
        const state = yield* CommandState
        const claim = yield* state.claim('c1', 'fp', 100, 1000)
        if (claim.status !== 'claimed') throw new Error('expected claim')
        yield* state.complete('server', 'fp', claim.token, result('c1', 4), 0)
      }),
    )
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).claim('c1', 'fp', 200, 1000)
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed', result: { revision: 4 } })
  })
  it('atomically refuses revision rollback and a stale successful transition', async () => {
    const path = await database()
    await withState(
      path,
      Effect.gen(function* () {
        const state = yield* CommandState
        const first = yield* state.claim('advance', 'fp-advance', 100, 1000)
        if (first.status !== 'claimed') throw new Error('expected claim')
        yield* state.complete('server', 'fp-advance', first.token, result('advance', 5), 0)

        const malformed = yield* state.claim('malformed', 'fp-malformed', 100, 1000)
        if (malformed.status !== 'claimed') throw new Error('expected claim')
        yield* state.complete(
          'server',
          'fp-malformed',
          malformed.token,
          { ...result('malformed', 1), status: 'rejected' },
          1,
        )
      }),
    )
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).revision('server')
        }),
      ),
    ).resolves.toBe(5)
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          const state = yield* CommandState
          const stale = yield* state.claim('stale', 'fp-stale', 100, 1000)
          if (stale.status !== 'claimed') throw new Error('expected claim')
          yield* state.complete('server', 'fp-stale', stale.token, result('stale', 6), 1)
        }),
      ),
    ).rejects.toBeDefined()
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).revision('server')
        }),
      ),
    ).resolves.toBe(5)
  })
  it('renews beyond the initial lease and fences a stale completer', async () => {
    const path = await database()
    const first = await withState(
      path,
      Effect.gen(function* () {
        return yield* (yield* CommandState).claim('c1', 'fp', 100, 10)
      }),
    )
    if (first.status !== 'claimed') throw new Error('expected first claim')
    await withState(
      path,
      Effect.gen(function* () {
        yield* (yield* CommandState).renew('c1', 'fp', first.token, 108, 10)
      }),
    )
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          return yield* (yield* CommandState).claim('c1', 'fp', 112, 10)
        }),
      ),
    ).resolves.toEqual({ status: 'busy' })
    const replacement = await withState(
      path,
      Effect.gen(function* () {
        return yield* (yield* CommandState).claim('c1', 'fp', 119, 10)
      }),
    )
    if (replacement.status !== 'claimed') throw new Error('expected replacement claim')
    await expect(
      withState(
        path,
        Effect.gen(function* () {
          yield* (yield* CommandState).complete('server', 'fp', first.token, result('c1', 1), 0)
        }),
      ),
    ).rejects.toBeDefined()
  })
})
