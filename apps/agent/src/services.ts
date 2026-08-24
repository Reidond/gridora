import { createPublicKey, verify } from 'node:crypto'
import {
  canonicalCommandPayload,
  type AgentCommand,
  type CommandResult,
} from '@gridora/agent-protocol'
import { Context, Effect, Layer } from 'effect'
import type { AgentError } from './errors.js'

export type CommandClaim =
  | { readonly status: 'claimed'; readonly token: string }
  | { readonly status: 'busy' }
  | { readonly status: 'payload-mismatch' }
  | { readonly status: 'completed'; readonly result: CommandResult }

export interface ExecutionResult {
  readonly revision: number | null
  readonly code: string
  readonly message: string
  readonly evidence?: CommandResult['evidence']
}

export class BackupArchiveUploader extends Context.Service<
  BackupArchiveUploader,
  {
    readonly upload: (input: {
      readonly organizationId: string
      readonly nodeId: string
      readonly operationId: string
      readonly serverId: string
      readonly backupId: string
      readonly archivePath: string
      readonly bytes: number
      readonly sha256: string
      readonly includes: ReadonlyArray<'config' | 'data' | 'mods' | 'state'>
      readonly createdAt: string
    }) => Effect.Effect<NonNullable<CommandResult['evidence']>, AgentError>
    readonly download: (input: {
      readonly organizationId: string
      readonly nodeId: string
      readonly operationId: string
      readonly sourceServerId: string
      readonly targetServerId: string
      readonly backupId: string
      readonly archivePath: string
      readonly maximumBytes: number
      readonly expectedSha256: string
    }) => Effect.Effect<void, AgentError>
  }
>()('gridora/agent/BackupArchiveUploader') {}

export class SignatureVerifier extends Context.Service<
  SignatureVerifier,
  {
    readonly verify: (command: AgentCommand) => Effect.Effect<boolean, AgentError>
  }
>()('gridora/agent/SignatureVerifier') {}

export class CommandState extends Context.Service<
  CommandState,
  {
    readonly claim: (
      commandId: string,
      fingerprint: string,
      nowMs: number,
      leaseMs: number,
    ) => Effect.Effect<CommandClaim, AgentError>
    readonly complete: (
      resourceId: string,
      fingerprint: string,
      token: string,
      result: CommandResult,
      expectedPriorRevision: number | null,
    ) => Effect.Effect<void, AgentError>
    readonly renew: (
      commandId: string,
      fingerprint: string,
      token: string,
      nowMs: number,
      leaseMs: number,
    ) => Effect.Effect<void, AgentError>
    readonly revision: (resourceId: string) => Effect.Effect<number, AgentError>
  }
>()('gridora/agent/CommandState') {}

export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    readonly execute: (command: AgentCommand) => Effect.Effect<ExecutionResult, AgentError>
  }
>()('gridora/agent/CommandExecutor') {}

export interface AgentSelfUpdateProof {
  readonly version: string
  readonly digest: string
  readonly duplicate: boolean
  readonly observedAt: string
}

/**
 * The unprivileged side of the agent update boundary. Its implementation may
 * stage a verified release and ask the root-only helper to activate it, but it
 * never receives a filesystem path that the helper will execute.
 */
export class AgentSelfUpdate extends Context.Service<
  AgentSelfUpdate,
  {
    readonly apply: (command: AgentCommand) => Effect.Effect<AgentSelfUpdateProof, AgentError>
  }
>()('gridora/agent/AgentSelfUpdate') {}

export class AgentClock extends Context.Service<
  AgentClock,
  { readonly now: Effect.Effect<Date> }
>()('gridora/agent/Clock') {}

export const MemoryCommandState = () => {
  const results = new Map<
    string,
    { fingerprint: string; leaseUntil: number; token: string; result?: CommandResult }
  >()
  const revisions = new Map<string, number>()
  let tokenSequence = 0
  return Layer.succeed(CommandState, {
    claim: (id, fingerprint, nowMs, leaseMs) =>
      Effect.sync(() => {
        const current = results.get(id)
        if (current === undefined) {
          const token = `memory-claim-${(tokenSequence += 1)}`
          results.set(id, { fingerprint, leaseUntil: nowMs + leaseMs, token })
          return { status: 'claimed' as const, token }
        }
        if (current.fingerprint !== fingerprint) return { status: 'payload-mismatch' as const }
        if (current.result !== undefined)
          return { status: 'completed' as const, result: current.result }
        if (current.leaseUntil <= nowMs) {
          const token = `memory-claim-${(tokenSequence += 1)}`
          results.set(id, { fingerprint, leaseUntil: nowMs + leaseMs, token })
          return { status: 'claimed' as const, token }
        }
        return { status: 'busy' as const }
      }),
    complete: (resourceId, fingerprint, token, result, expectedPriorRevision) =>
      Effect.sync(() => {
        const current = results.get(result.commandId)
        if (current?.fingerprint !== fingerprint || current.token !== token)
          throw new Error('stale command claim')
        const currentRevision = revisions.get(resourceId) ?? 0
        if (
          result.status === 'succeeded' &&
          result.revision !== null &&
          (expectedPriorRevision === null ||
            expectedPriorRevision !== currentRevision ||
            result.revision <= currentRevision)
        )
          throw new Error('non-monotonic resource revision')
        results.set(result.commandId, { fingerprint, leaseUntil: 0, result, token })
        if (result.status === 'succeeded' && result.revision !== null)
          revisions.set(resourceId, result.revision)
      }),
    renew: (commandId, fingerprint, token, nowMs, leaseMs) =>
      Effect.sync(() => {
        const current = results.get(commandId)
        if (
          current?.fingerprint !== fingerprint ||
          current.token !== token ||
          current.result !== undefined
        )
          throw new Error('stale command claim')
        results.set(commandId, { ...current, leaseUntil: nowMs + leaseMs })
      }),
    revision: (resourceId) => Effect.succeed(revisions.get(resourceId) ?? 0),
  })
}

export const FixedAgentClock = (date: Date) =>
  Layer.succeed(AgentClock, { now: Effect.succeed(date) })

export const SystemAgentClock = Layer.succeed(AgentClock, { now: Effect.sync(() => new Date()) })

export const Ed25519SignatureVerifier = (publicKeyPem: string) => {
  const key = createPublicKey(publicKeyPem)
  return Layer.succeed(SignatureVerifier, {
    verify: (command) =>
      Effect.sync(() => {
        try {
          return verify(
            null,
            Buffer.from(canonicalCommandPayload(command), 'utf8'),
            key,
            Buffer.from(command.signature, 'base64'),
          )
        } catch {
          return false
        }
      }),
  })
}
