import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrganizationContext } from '@gridora/domain'
import {
  KekPortLayer,
  makeRedactedSecretLogSink,
  SecretEnvelopeService,
  SecretEnvelopeServiceLive,
  SecretKekError,
  type KekPortShape,
} from '@gridora/secret-envelope'
import {
  makeSecretEnvelopeRepositoryD1Layer,
  type SecretD1Database,
  type SecretD1Statement,
} from '../src/index.js'

let database: DatabaseSync
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
].map((name) => fileURLToPath(new URL(`../../migrations/sql/${name}`, import.meta.url)))
const now = '2026-08-23T12:00:00Z'
const later = '2026-08-23T13:00:00Z'
const text = new TextEncoder()
const decodeText = new TextDecoder()
const source = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

class SqliteStatement implements SecretD1Statement {
  constructor(
    private readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): SecretD1Statement {
    return new SqliteStatement(this.sql, values)
  }
  async first(): Promise<unknown> {
    return database.prepare(this.sql).get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const result = database.prepare(this.sql).run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}
const d1: SecretD1Database = { prepare: (sql) => new SqliteStatement(sql) }
const failedInsertD1: SecretD1Database = {
  prepare: (sql) => {
    const statement = new SqliteStatement(sql)
    if (!sql.includes('INSERT INTO secret_envelopes')) return statement
    return {
      bind: () => ({
        bind: () => {
          throw new Error('unexpected second bind')
        },
        first: () => Promise.resolve(null),
        run: () => Promise.resolve({ success: false, meta: { changes: 0 } }),
      }),
      first: () => statement.first(),
      run: () => Promise.resolve({ success: false, meta: { changes: 0 } }),
    }
  },
}

/** Local raw KEKs exist only in this test; production must supply a KMS/Secrets Store port. */
const localKek = (keys: Map<number, Uint8Array>, active: { version: number }): KekPortShape => {
  const key = (version: number, usages: KeyUsage[]) => {
    const bytes = keys.get(version)
    return bytes === undefined
      ? Effect.fail(
          new SecretKekError({ operation: 'kek.lookup', message: 'key version unavailable' }),
        )
      : Effect.tryPromise({
          try: () => crypto.subtle.importKey('raw', source(bytes), 'AES-GCM', false, usages),
          catch: () =>
            new SecretKekError({ operation: 'kek.import', message: 'key operation failed' }),
        })
  }
  return {
    activeKeyVersion: Effect.sync(() => active.version),
    wrap: (version, dataKey, aad) =>
      Effect.gen(function* () {
        const wrappingKey = yield* key(version, ['encrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const wrapped = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: source(iv), additionalData: source(aad) },
              wrappingKey,
              source(dataKey),
            ),
          catch: () =>
            new SecretKekError({ operation: 'kek.wrap', message: 'key operation failed' }),
        })
        const output = new Uint8Array(iv.byteLength + wrapped.byteLength)
        output.set(iv)
        output.set(new Uint8Array(wrapped), iv.byteLength)
        return output
      }),
    unwrap: (version, wrapped, aad) =>
      Effect.gen(function* () {
        if (wrapped.byteLength <= 12)
          return yield* new SecretKekError({
            operation: 'kek.unwrap',
            message: 'key operation failed',
          })
        const wrappingKey = yield* key(version, ['decrypt'])
        return yield* Effect.tryPromise({
          try: async () =>
            new Uint8Array(
              await crypto.subtle.decrypt(
                {
                  name: 'AES-GCM',
                  iv: source(wrapped.slice(0, 12)),
                  additionalData: source(aad),
                },
                wrappingKey,
                source(wrapped.slice(12)),
              ),
            ),
          catch: () =>
            new SecretKekError({ operation: 'kek.unwrap', message: 'key operation failed' }),
        })
      }),
  }
}

const active = { version: 1 }
const keys = new Map<number, Uint8Array>()
const serviceLayer = () =>
  SecretEnvelopeServiceLive.pipe(
    Layer.provide(makeSecretEnvelopeRepositoryD1Layer(d1)),
    Layer.provide(KekPortLayer(localKek(keys, active))),
  )
const failedInsertServiceLayer = () =>
  SecretEnvelopeServiceLive.pipe(
    Layer.provide(makeSecretEnvelopeRepositoryD1Layer(failedInsertD1)),
    Layer.provide(KekPortLayer(localKek(keys, active))),
  )
const context = (organizationId: string) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'organization-a' : 'organization-b',
    identityId: organizationId === 'org-a' ? 'owner-a' : 'owner-b',
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })
const locator = { id: 'secret-a', scopeType: 'provider', scopeId: 'account-a' }
const run = <A, E>(effect: Effect.Effect<A, E, SecretEnvelopeService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(serviceLayer())))

describe('secret envelope D1 and WebCrypto boundary', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations) database.exec(readFileSync(migration, 'utf8'))
    database
      .prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at) VALUES
      ('owner-a', 'access-a', 'a@example.com', 'A', 'active', ?, ?),
      ('owner-b', 'access-b', 'b@example.com', 'B', 'active', ?, ?)`)
      .run(now, now, now, now)
    database
      .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at) VALUES
      ('org-a', 'A', 'organization-a', 'active', 'UTC', 'eu', 'complete', 1, 1, ?),
      ('org-b', 'B', 'organization-b', 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
      .run(now, now)
    active.version = 1
    keys.clear()
    keys.set(1, crypto.getRandomValues(new Uint8Array(32)))
  })
  afterEach(() => database.close())

  it('roundtrips plaintext while storing ciphertext only', async () => {
    const canary = 'CANARY-plaintext-never-store'
    const record = await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), { ...locator, plaintext: text.encode(canary), now })
        return yield* secrets.open(context('org-a'), locator)
      }),
    )
    expect(decodeText.decode(record)).toBe(canary)
    const stored = database.prepare('SELECT * FROM secret_envelopes').get()
    expect(JSON.stringify(stored)).not.toContain(canary)
    expect(stored).not.toHaveProperty('plaintext')
  })

  it('does not report a failed D1 insert as a stored envelope', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        return yield* Effect.result(
          secrets.seal(context('org-a'), {
            ...locator,
            plaintext: text.encode('must-not-be-reported-stored'),
            now,
          }),
        )
      }).pipe(Effect.provide(failedInsertServiceLayer())),
    )
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SecretPersistenceError', operation: 'secretEnvelope.create' },
    })
    expect(database.prepare('SELECT count(*) AS count FROM secret_envelopes').get()).toMatchObject({
      count: 0,
    })
  })

  it('denies wrong organization and scope without attempting disclosure', async () => {
    await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), { ...locator, plaintext: text.encode('hidden'), now })
      }),
    )
    for (const [ctx, scoped] of [
      [context('org-b'), locator],
      [context('org-a'), { ...locator, scopeId: 'account-other' }],
    ] as const) {
      const result = await run(
        Effect.gen(function* () {
          const secrets = yield* SecretEnvelopeService
          return yield* Effect.result(secrets.open(ctx, scoped))
        }),
      )
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SecretNotFoundError' } })
    }
  })

  it('rejects authenticated ciphertext tampering', async () => {
    await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), { ...locator, plaintext: text.encode('hidden'), now })
      }),
    )
    database.prepare("UPDATE secret_envelopes SET ciphertext = ciphertext || 'A'").run()
    const result = await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        return yield* Effect.result(secrets.open(context('org-a'), locator))
      }),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SecretIntegrityError' } })
  })

  it('scopes deletion by organization and revision', async () => {
    await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), { ...locator, plaintext: text.encode('hidden'), now })
      }),
    )
    const foreign = await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        return yield* Effect.result(
          secrets.delete(context('org-b'), { ...locator, expectedRevision: 1 }),
        )
      }),
    )
    expect(foreign).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SecretNotFoundError' },
    })
    const plaintext = await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        return yield* secrets.open(context('org-a'), locator)
      }),
    )
    expect(decodeText.decode(plaintext)).toBe('hidden')
  })

  it('rotates to the active KEK and preserves the secret', async () => {
    keys.set(2, crypto.getRandomValues(new Uint8Array(32)))
    const result = await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), {
          ...locator,
          plaintext: text.encode('rotated'),
          now,
        })
        active.version = 2
        const rotated = yield* secrets.rotate(context('org-a'), {
          ...locator,
          expectedRevision: 1,
          now: later,
        })
        const plaintext = yield* secrets.open(context('org-a'), locator)
        return { rotated, plaintext }
      }),
    )
    expect(result.rotated).toMatchObject({ keyVersion: 2, revision: 2, rotatedAt: later })
    expect(decodeText.decode(result.plaintext)).toBe('rotated')
  })

  it('fences concurrent rotations and recursively redacts log/error canaries', async () => {
    const canary = 'CANARY-must-never-log'
    await run(
      Effect.gen(function* () {
        const secrets = yield* SecretEnvelopeService
        yield* secrets.seal(context('org-a'), { ...locator, plaintext: text.encode(canary), now })
      }),
    )
    const rotate = () =>
      run(
        Effect.gen(function* () {
          const secrets = yield* SecretEnvelopeService
          return yield* Effect.result(
            secrets.rotate(context('org-a'), { ...locator, expectedRevision: 1, now: later }),
          )
        }),
      )
    const rotations = await Promise.all([rotate(), rotate()])
    expect(rotations.filter(({ _tag }) => _tag === 'Success')).toHaveLength(1)
    expect(rotations.filter(({ _tag }) => _tag === 'Failure')).toHaveLength(1)
    expect(rotations.find(({ _tag }) => _tag === 'Failure')).toMatchObject({
      failure: { _tag: 'SecretRevisionConflictError' },
    })

    const captured: unknown[] = []
    const sink = makeRedactedSecretLogSink({
      write: (_event, fields) => Effect.sync(() => void captured.push(fields)),
    })
    await Effect.runPromise(
      sink.write('secret.failure', {
        plaintext: canary,
        nested: { token: canary, dataKey: text.encode(canary) },
        error: new Error(canary),
      }),
    )
    expect(JSON.stringify(captured)).not.toContain(canary)
    expect(JSON.stringify(rotations)).not.toContain(canary)
  })
})
