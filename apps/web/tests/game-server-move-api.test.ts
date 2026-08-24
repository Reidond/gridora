import { createGridoraClient, GridoraClientError } from '@gridora/generated-client'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { createGameServerMoveActions, type GameServerMoveRequest } from '../services/gridora-api'
import {
  createIdempotentMutationRunner,
  type IdempotencyStorage,
} from '../services/idempotent-mutation'

const memoryStorage = () => {
  const values = new Map<string, string>()
  const storage: IdempotencyStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  return { storage, values }
}

describe('game server move web action', () => {
  it('replays one typed target-node move body with the same key after response loss', async () => {
    const requests: Request[] = []
    let attempts = 0
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        attempts += 1
        if (attempts === 1) throw new TypeError('connection closed after submit')
        return Response.json(
          {
            operationId: 'move-operation-a',
            resourceId: 'server-a',
            status: 'queued',
            links: { operation: '/v1/organizations/night-watch/operations/move-operation-a' },
          },
          { status: 202 },
        )
      },
    })
    const { storage, values } = memoryStorage()
    const actions = createGameServerMoveActions({
      client,
      run: <A>(effect: Effect.Effect<A, GridoraClientError>) => Effect.runPromise(effect),
      mutations: createIdempotentMutationRunner({
        storage,
        createKey: () => 'move-idempotency-1',
        isAmbiguous: (error) => error instanceof GridoraClientError && error.retryable,
      }),
    })
    const input: GameServerMoveRequest = {
      expectedRevision: 4,
      action: 'move',
      targetNodeId: 'node-b',
      backupPolicy: 'required',
    }

    await expect(actions.moveGameServer('night-watch', 'server-a', input)).rejects.toBeInstanceOf(
      GridoraClientError,
    )
    expect([...values.values()]).toHaveLength(1)
    await expect(actions.moveGameServer('night-watch', 'server-a', input)).resolves.toMatchObject({
      operationId: 'move-operation-a',
      resourceId: 'server-a',
    })

    expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
      'move-idempotency-1',
      'move-idempotency-1',
    ])
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'POST /v1/organizations/night-watch/game-servers/server-a/actions/move',
        'POST /v1/organizations/night-watch/game-servers/server-a/actions/move',
      ],
    )
    await expect(requests[1]!.json()).resolves.toEqual(input)
    expect([...values.entries()]).toEqual([])
  })
})
