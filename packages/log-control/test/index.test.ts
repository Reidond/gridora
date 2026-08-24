import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  LogValidationError,
  encodeLogCursor,
  decodeLogCursor,
  makeLogBatch,
  publicLogArchive,
  redactSecrets,
  sanitizeLogEntry,
} from '../src/index.js'

const entry = (sequence: number, overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  component: 'game',
  level: 'info',
  timestamp: `2026-08-23T12:00:0${sequence}.000Z`,
  sequence,
  message: `line ${sequence}`,
  ...overrides,
})

describe('log control security boundary', () => {
  it('redacts secret fields and common bearer/key canaries before persistence', () => {
    const canary = 'Bearer canary-secret-value'
    const value = redactSecrets({
      authorization: canary,
      nested: { password: 'pw-canary' },
      message: `${canary} api_key=api-canary-value`,
    })
    expect(JSON.stringify(value)).not.toContain('canary-secret-value')
    expect(JSON.stringify(value)).not.toContain('pw-canary')
    expect(JSON.stringify(value)).not.toContain('api-canary-value')
  })

  it('redacts nested compound, camelCase, and Unicode-normalized secret keys without leaking canaries', () => {
    const canaries = [
      'gridora-client-secret-canary',
      'gridora-steam-guard-canary',
      'gridora-rcon-canary',
      'gridora-session-key-canary',
    ]
    const value = redactSecrets({
      plugin: {
        clientSecret: canaries[0],
        Steam_GuardCode: canaries[1],
        entries: [{ RconPassword: canaries[2] }],
      },
      ＳｅｓｓｉｏｎＫｅｙ: canaries[3],
      message: `clientSecret=${canaries[0]} steamGuardCode=${canaries[1]}`,
    })
    const persisted = JSON.stringify(value)
    for (const canary of canaries) expect(persisted).not.toContain(canary)
    expect(value).toMatchObject({
      plugin: {
        clientSecret: '[REDACTED]',
        Steam_GuardCode: '[REDACTED]',
        entries: [{ RconPassword: '[REDACTED]' }],
      },
      ＳｅｓｓｉｏｎＫｅｙ: '[REDACTED]',
      message: 'clientSecret=[REDACTED] steamGuardCode=[REDACTED]',
    })
  })

  it('accepts only contiguous ordered entries in one tenant/node batch', async () => {
    await expect(
      Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(2)])),
    ).resolves.toMatchObject({ firstSequence: 1, lastSequence: 2 })
    await expect(
      Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(2), entry(1)])),
    ).rejects.toMatchObject({ code: 'invalid-entry' })
    await expect(
      Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(1)])),
    ).rejects.toMatchObject({ code: 'invalid-entry' })
    await expect(
      Effect.runPromise(makeLogBatch('org-a', 'node-a', [entry(1), entry(3)])),
    ).rejects.toMatchObject({ code: 'invalid-entry' })
    await expect(
      Effect.runPromise(makeLogBatch('org-a', 'node-b', [entry(1)])),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })

  it('sanitizes entry fields and rejects excess/unbounded input', async () => {
    const sanitized = await Effect.runPromise(
      sanitizeLogEntry(
        entry(1, {
          fields: { token: 'canary-token', safe: 'ok' },
          message: 'Bearer canary-bearer',
        }),
      ),
    )
    expect(sanitized.fields).toEqual({ token: '[REDACTED]', safe: 'ok' })
    expect(sanitized.message).toBe('Bearer [REDACTED]')
    await expect(
      Effect.runPromise(sanitizeLogEntry({ ...entry(1), unexpected: true })),
    ).rejects.toBeInstanceOf(LogValidationError)
  })

  it('signs cursors to the exact tenant/server and rejects tampering or expiry', async () => {
    const now = Date.parse('2026-08-23T12:00:00.000Z')
    const cursor = await Effect.runPromise(
      encodeLogCursor(
        { organizationId: 'org-a', serverId: 'server-a' },
        { lastTimestamp: '2026-08-23T11:00:00.000Z', id: 'archive-a' },
        'cursor-secret',
        now,
      ),
    )
    await expect(
      Effect.runPromise(
        decodeLogCursor(
          cursor,
          { organizationId: 'org-a', serverId: 'server-a' },
          'cursor-secret',
          now + 1,
        ),
      ),
    ).resolves.toEqual({ lastTimestamp: '2026-08-23T11:00:00.000Z', lastId: 'archive-a' })
    await expect(
      Effect.runPromise(
        decodeLogCursor(
          cursor,
          { organizationId: 'org-b', serverId: 'server-a' },
          'cursor-secret',
          now + 1,
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-cursor' })
    await expect(
      Effect.runPromise(
        decodeLogCursor(
          `${cursor}x`,
          { organizationId: 'org-a', serverId: 'server-a' },
          'cursor-secret',
          now + 1,
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-cursor' })
    await expect(
      Effect.runPromise(
        decodeLogCursor(
          cursor,
          { organizationId: 'org-a', serverId: 'server-a' },
          'cursor-secret',
          now + 86_400_001,
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-cursor' })
  })

  it('does not expose the internal R2 key in public archive metadata', () => {
    const metadata = {
      organizationId: 'org-a',
      id: 'archive-a',
      serverId: 'server-a',
      nodeId: 'node-a',
      r2Key: 'organizations/org-a/logs/server-a/2026-08-23/archive-a.ndjson.gz',
      compression: 'gzip' as const,
      firstTimestamp: '2026-08-23T12:00:00.000Z',
      lastTimestamp: '2026-08-23T12:00:01.000Z',
      entryCount: 2,
      uncompressedBytes: 100,
      compressedBytes: 80,
      sha256: `sha256:${'a'.repeat(64)}`,
      state: 'available' as const,
      createdAt: '2026-08-23T12:00:00.000Z',
      expiresAt: null,
    }
    expect(publicLogArchive(metadata)).not.toHaveProperty('r2Key')
  })
})
