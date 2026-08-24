import { Effect, Schema } from 'effect'
import { AuditRequestContextValue } from '@gridora/audit-contracts'
import { describe, expect, it } from 'vitest'
import { scheduledBackupAuditRequest } from '../src/backup-schedule-audit.js'

describe('scheduled backup audit provenance', () => {
  it('retains scheduler origin across the signed internal HTTP hop', async () => {
    const digest = 'a'.repeat(64)
    const request = scheduledBackupAuditRequest(digest, `scheduled-backup-${digest}`)
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(AuditRequestContextValue)(request)),
    ).resolves.toEqual(request)
    expect(request).toMatchObject({
      origin: 'scheduler',
      source: {
        ip: { state: 'not-available' },
        access: { state: 'not-available' },
      },
    })
  })
})
