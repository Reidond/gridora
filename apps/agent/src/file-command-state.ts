import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CommandResult } from '@gridora/agent-protocol'
import { Effect, Layer } from 'effect'
import { AgentError } from './errors.js'
import { CommandState, type CommandClaim } from './services.js'

const stateFailure = (message: string) => new AgentError({ code: 'state-failed', message })

const initialize = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
      lease_until INTEGER NOT NULL,
      claim_token TEXT NOT NULL,
      result_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS revisions (
      resource_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT;
  `)
  return database
}

export const FileCommandState = (path: string) => {
  const database = initialize(path)
  return Layer.succeed(CommandState, {
    claim: (commandId, fingerprint, nowMs, leaseMs) =>
      Effect.try({
        try: (): CommandClaim => {
          database.exec('BEGIN IMMEDIATE')
          try {
            const row = database
              .prepare(
                'SELECT fingerprint, state, lease_until, claim_token, result_json FROM commands WHERE command_id = ?',
              )
              .get(commandId) as
              | {
                  fingerprint: string
                  state: 'in_progress' | 'completed'
                  lease_until: number
                  claim_token: string
                  result_json: string | null
                }
              | undefined
            let claim: CommandClaim
            if (row === undefined) {
              const token = randomUUID()
              database
                .prepare(
                  "INSERT INTO commands(command_id, fingerprint, state, lease_until, claim_token) VALUES (?, ?, 'in_progress', ?, ?)",
                )
                .run(commandId, fingerprint, nowMs + leaseMs, token)
              claim = { status: 'claimed', token }
            } else if (row.fingerprint !== fingerprint) claim = { status: 'payload-mismatch' }
            else if (row.state === 'completed' && row.result_json !== null)
              claim = { status: 'completed', result: JSON.parse(row.result_json) as CommandResult }
            else if (row.lease_until > nowMs) claim = { status: 'busy' }
            else {
              const token = randomUUID()
              database
                .prepare(
                  "UPDATE commands SET lease_until = ?, claim_token = ? WHERE command_id = ? AND state = 'in_progress'",
                )
                .run(nowMs + leaseMs, token, commandId)
              claim = { status: 'claimed', token }
            }
            database.exec('COMMIT')
            return claim
          } catch (cause) {
            database.exec('ROLLBACK')
            throw cause
          }
        },
        catch: (cause) => stateFailure(`could not claim command: ${String(cause)}`),
      }),
    complete: (resourceId, fingerprint, token, result, expectedPriorRevision) =>
      Effect.try({
        try: () => {
          database.exec('BEGIN IMMEDIATE')
          try {
            const updated = database
              .prepare(
                "UPDATE commands SET state = 'completed', lease_until = 0, result_json = ? WHERE command_id = ? AND fingerprint = ? AND claim_token = ? AND state = 'in_progress'",
              )
              .run(JSON.stringify(result), result.commandId, fingerprint, token)
            if (updated.changes !== 1) throw new Error('command claim was lost or mismatched')
            if (result.status === 'succeeded' && result.revision !== null) {
              const currentRevision =
                (
                  database
                    .prepare('SELECT revision FROM revisions WHERE resource_id = ?')
                    .get(resourceId) as { revision: number } | undefined
                )?.revision ?? 0
              if (
                expectedPriorRevision === null ||
                currentRevision !== expectedPriorRevision ||
                result.revision <= currentRevision
              )
                throw new Error('non-monotonic resource revision')
              database
                .prepare(
                  'INSERT INTO revisions(resource_id, revision) VALUES (?, ?) ON CONFLICT(resource_id) DO UPDATE SET revision = excluded.revision WHERE revisions.revision = ?',
                )
                .run(resourceId, result.revision, currentRevision)
            }
            database.exec('COMMIT')
          } catch (cause) {
            database.exec('ROLLBACK')
            throw cause
          }
        },
        catch: (cause) => stateFailure(`could not complete command: ${String(cause)}`),
      }),
    renew: (commandId, fingerprint, token, nowMs, leaseMs) =>
      Effect.try({
        try: () => {
          const updated = database
            .prepare(
              "UPDATE commands SET lease_until = ? WHERE command_id = ? AND fingerprint = ? AND claim_token = ? AND state = 'in_progress'",
            )
            .run(nowMs + leaseMs, commandId, fingerprint, token)
          if (updated.changes !== 1) throw new Error('stale command claim')
        },
        catch: (cause) => stateFailure(`could not renew command claim: ${String(cause)}`),
      }),
    revision: (resourceId) =>
      Effect.try({
        try: () => {
          const row = database
            .prepare('SELECT revision FROM revisions WHERE resource_id = ?')
            .get(resourceId) as { revision: number } | undefined
          return row?.revision ?? 0
        },
        catch: (cause) => stateFailure(`could not read command revision: ${String(cause)}`),
      }),
  })
}
