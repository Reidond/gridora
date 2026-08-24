import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
let database: DatabaseSync

describe('agent machine audit receipt migration', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
  })
  afterEach(() => database.close())

  it('registers the immutable machine receipt fence after the strict v1 audit schema', () => {
    expect(migrations.find((migration) => migration.id === 47)).toEqual({
      id: 47,
      name: 'agent_machine_audit_receipts',
      file: '0047_agent_machine_audit_receipts.sql',
    })
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
          AND name = 'agent_machine_audit_receipts'`)
        .get(),
    ).toEqual({ name: 'agent_machine_audit_receipts' })
    expect(
      database
        .prepare(`SELECT name FROM pragma_table_info('node_registration_tokens')
          WHERE name = 'machine_revocation_operation_id'`)
        .get(),
    ).toEqual({ name: 'machine_revocation_operation_id' })
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
          AND name IN (
            'agent_machine_audit_receipt_evidence_guard',
            'agent_machine_audit_operation_immutable_update',
            'agent_machine_audit_receipt_immutable_update',
            'agent_machine_audit_receipt_immutable_delete',
            'node_registration_tokens_machine_revocation_link_guard'
          ) ORDER BY name`)
        .all(),
    ).toEqual([
      { name: 'agent_machine_audit_operation_immutable_update' },
      { name: 'agent_machine_audit_receipt_evidence_guard' },
      { name: 'agent_machine_audit_receipt_immutable_delete' },
      { name: 'agent_machine_audit_receipt_immutable_update' },
      { name: 'node_registration_tokens_machine_revocation_link_guard' },
    ])
  })

  it('rejects an unrecognized machine mutation kind before it can become a receipt', () => {
    expect(() =>
      database
        .prepare(`INSERT INTO agent_machine_audit_receipts
          (organization_id, kind, idempotency_key, request_fingerprint, effect_key,
           node_id, credential_id, credential_version, session_version, machine_identity_id,
           parent_operation_id, operation_id, audit_event_id, target_type, target_id, result,
           observation_sequence, observation_revision, result_json, accepted_at, created_at)
          VALUES ('org-a', 'unknown-machine-mutation', 'key', '${'a'.repeat(64)}', 'effect',
           'node-a', 'credential-a', 1, 1, 'machine-a', NULL, 'operation-a', 'audit-a',
           'node', 'node-a', 'succeeded', NULL, NULL, '{}',
           '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z')`)
        .run(),
    ).toThrow(/agent machine audit receipt evidence fence failed|CHECK constraint failed/)
  })
})
