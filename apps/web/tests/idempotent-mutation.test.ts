import { describe, expect, it } from 'vitest'
import {
  createIdempotentMutationRunner,
  createMemoryIdempotencyStorage,
} from '../services/idempotent-mutation'

const runner = (storage = createMemoryIdempotencyStorage()) => {
  let sequence = 0
  return {
    storage,
    value: createIdempotentMutationRunner({
      storage,
      createKey: () => `key-${++sequence}`,
      isAmbiguous: (error) => error instanceof Error && error.message === 'ambiguous',
    }),
  }
}

describe('idempotent mutation runner', () => {
  it('keeps one key after an ambiguous response and across a new runner', async () => {
    const first = runner()
    let observed = ''
    await expect(
      first.value.run('organization.create', { slug: 'night-watch' }, async (key) => {
        observed = key
        throw new Error('ambiguous')
      }),
    ).rejects.toThrow('ambiguous')

    const second = runner(first.storage)
    await second.value.run('organization.create', { slug: 'night-watch' }, async (key) => {
      expect(key).toBe(observed)
    })
  })

  it('rotates the key after success or a definitive rejection', async () => {
    const subject = runner()
    const keys: string[] = []
    await subject.value.run('server.restart', { id: 'server-1' }, async (key) => {
      keys.push(key)
    })
    await expect(
      subject.value.run('server.restart', { id: 'server-1' }, async (key) => {
        keys.push(key)
        throw new Error('definitive')
      }),
    ).rejects.toThrow('definitive')
    await subject.value.run('server.restart', { id: 'server-1' }, async (key) => {
      keys.push(key)
    })
    expect(new Set(keys).size).toBe(3)
  })

  it('uses one key for concurrent copies of one logical submission', async () => {
    const subject = runner()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: (() => void) | undefined
    const bothEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const keys: string[] = []
    const submit = () =>
      subject.value.run('invitation.create', { email: 'ops@example.com' }, async (key) => {
        keys.push(key)
        if (keys.length === 2) entered?.()
        await gate
      })
    const pending = [submit(), submit()]
    await bothEntered
    release?.()
    await Promise.all(pending)
    expect(keys).toEqual(['key-1', 'key-1'])
  })
})
