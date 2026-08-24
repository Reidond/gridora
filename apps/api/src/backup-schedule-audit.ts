import type { AuditRequestContextValue } from '@gridora/audit-contracts'

/**
 * The signed internal HTTP hop is transport, not the originating authority.
 * Scheduled backups therefore retain scheduler provenance and cannot invent
 * Cloudflare request-IP or Access evidence.
 */
export const scheduledBackupAuditRequest = (
  correlationDigest: string,
  correlationId: string,
): AuditRequestContextValue => ({
  origin: 'scheduler',
  requestId: `scheduled-backup-${correlationDigest}`,
  correlationId,
  source: {
    ip: {
      state: 'not-available',
      reason: 'scheduled-backup-dispatch-has-no-request-source',
    },
    access: {
      state: 'not-available',
      reason: 'scheduled-backup-dispatch-has-no-access-assertion',
    },
  },
})
