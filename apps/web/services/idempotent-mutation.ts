export interface IdempotencyStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

export interface IdempotentMutationRunner {
  readonly run: <A>(
    scope: string,
    payload: unknown,
    operation: (idempotencyKey: string) => Promise<A>,
  ) => Promise<A>
}

const canonicalize = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`
}

const digest = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

export const createMemoryIdempotencyStorage = (): IdempotencyStorage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

const fallbackStorage = createMemoryIdempotencyStorage()

export const browserIdempotencyStorage = (): IdempotencyStorage => {
  try {
    if (globalThis.sessionStorage !== undefined) return globalThis.sessionStorage
  } catch {
    // A locked-down browser can deny storage. Keep retry safety for this page lifetime.
  }
  return fallbackStorage
}

export const createIdempotentMutationRunner = (options: {
  readonly storage: IdempotencyStorage
  readonly createKey?: () => string
  readonly isAmbiguous: (error: unknown) => boolean
}): IdempotentMutationRunner => {
  const activeMutations = new Map<
    string,
    {
      readonly key: Promise<{ readonly id: string; readonly key: string }>
      users: number
      clear: boolean
    }
  >()
  const createKey = options.createKey ?? (() => crypto.randomUUID())

  const keyFor = async (scope: string, payload: unknown): Promise<{ id: string; key: string }> => {
    const id = `gridora.idempotency.v1.${await digest(`${scope}:${canonicalize(payload)}`)}`
    const stored = options.storage.getItem(id)
    if (stored !== null) return { id, key: stored }
    const key = createKey()
    options.storage.setItem(id, key)
    return { id, key }
  }

  return {
    run: async (scope, payload, operation) => {
      const fingerprint = `${scope}:${canonicalize(payload)}`
      let active = activeMutations.get(fingerprint)
      if (active === undefined) {
        active = { key: keyFor(scope, payload), users: 0, clear: false }
        activeMutations.set(fingerprint, active)
      }
      active.users += 1
      const { id, key } = await active.key
      try {
        const result = await operation(key)
        active.clear = true
        return result
      } catch (error) {
        if (!options.isAmbiguous(error)) active.clear = true
        throw error
      } finally {
        active.users -= 1
        if (active.users === 0) {
          if (active.clear) options.storage.removeItem(id)
          activeMutations.delete(fingerprint)
        }
      }
    },
  }
}
