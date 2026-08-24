import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { assertIdempotentReplay } from '../src/index.js'

describe('idempotency replay guard', () => {
  it('accepts an identical request fingerprint', async () => {
    await expect(Effect.runPromise(assertIdempotentReplay('same', 'same'))).resolves.toBeUndefined()
  })

  it('rejects reuse of a key for different input', async () => {
    const result = await Effect.runPromise(
      Effect.result(assertIdempotentReplay('first', 'different')),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.code).toBe('idempotency_key_reused')
  })
})
