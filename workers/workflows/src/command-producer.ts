import {
  AgentCommand,
  BackupCreatePayload,
  BackupRestorePayload,
  canonicalCommandPayload,
  canonicalJson,
  DeploymentRemovePayload,
  DeploymentSpec,
  HealthInspectPayload,
  ServerActionPayload,
  type AgentCommand as AgentCommandType,
} from '@gridora/agent-protocol'
import { Effect, Schema } from 'effect'

export type LifecycleCommandSpec =
  | { readonly type: 'deployment.apply'; readonly payload: typeof DeploymentSpec.Type }
  | { readonly type: 'deployment.remove'; readonly payload: typeof DeploymentRemovePayload.Type }
  | {
      readonly type: 'server.start' | 'server.stop'
      readonly payload: typeof ServerActionPayload.Type
    }
  | { readonly type: 'backup.create'; readonly payload: typeof BackupCreatePayload.Type }
  | { readonly type: 'backup.restore'; readonly payload: typeof BackupRestorePayload.Type }
  | { readonly type: 'health.inspect'; readonly payload: typeof HealthInspectPayload.Type }

export interface LifecycleCommandEnvelope {
  readonly operationId: string
  readonly organizationId: string
  readonly nodeId: string
  readonly resourceId: string
  readonly stepId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly expectedPriorRevision: number | null
  readonly plugin?: { readonly id: string; readonly version: string } | undefined
}

export type CommandSigner = (canonicalPayload: string) => Promise<string>

const payloadSchema = (spec: LifecycleCommandSpec) => {
  switch (spec.type) {
    case 'deployment.apply':
      return DeploymentSpec
    case 'deployment.remove':
      return DeploymentRemovePayload
    case 'server.start':
    case 'server.stop':
      return ServerActionPayload
    case 'backup.create':
      return BackupCreatePayload
    case 'backup.restore':
      return BackupRestorePayload
    case 'health.inspect':
      return HealthInspectPayload
  }
}

const hexDigest = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

const commandIdentity = (
  envelope: LifecycleCommandEnvelope,
  type: LifecycleCommandSpec['type'],
): string =>
  canonicalJson({
    operationId: envelope.operationId,
    organizationId: envelope.organizationId,
    nodeId: envelope.nodeId,
    resourceId: envelope.resourceId,
    stepId: envelope.stepId,
    type,
  })

const validateBinding = (
  envelope: LifecycleCommandEnvelope,
  spec: LifecycleCommandSpec,
  payload: unknown,
): void => {
  if (spec.type === 'deployment.apply') {
    const deployment = payload as typeof DeploymentSpec.Type
    if (
      deployment.organizationId !== envelope.organizationId ||
      deployment.nodeId !== envelope.nodeId ||
      deployment.serverId !== envelope.resourceId ||
      deployment.operationId !== envelope.operationId
    )
      throw new Error('Deployment command payload is not bound to the workflow target')
  }
  if (spec.type === 'backup.restore') {
    const restore = payload as typeof BackupRestorePayload.Type
    if (
      restore.manifest.organizationId !== envelope.organizationId ||
      restore.targetServerId !== envelope.resourceId
    )
      throw new Error('Backup restore payload is not bound to the workflow target')
  }
  if (spec.type === 'backup.create') {
    const backup = payload as typeof BackupCreatePayload.Type
    if (envelope.plugin === undefined)
      throw new Error('Backup command requires a workflow plugin binding')
    if (
      backup.pluginId !== envelope.plugin.id ||
      backup.pluginVersion !== envelope.plugin.version
    ) {
      throw new Error('Backup command plugin is not bound to the workflow target')
    }
  }
  if (spec.type === 'backup.restore') {
    const restore = payload as typeof BackupRestorePayload.Type
    if (envelope.plugin === undefined)
      throw new Error('Backup restore command requires a workflow plugin binding')
    if (
      restore.manifest.pluginId !== envelope.plugin.id ||
      restore.manifest.pluginVersion !== envelope.plugin.version
    )
      throw new Error('Backup restore plugin is not bound to the workflow target')
  }
}

export const produceSignedAgentCommand = async (
  envelope: LifecycleCommandEnvelope,
  spec: LifecycleCommandSpec,
  signer: CommandSigner,
): Promise<AgentCommandType> => {
  const payload = await Effect.runPromise(
    Schema.decodeUnknownEffect(payloadSchema(spec))(spec.payload),
  )
  validateBinding(envelope, spec, payload)
  const issuedAt = Date.parse(envelope.issuedAt)
  const expiresAt = Date.parse(envelope.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > expiresAt) {
    throw new Error('Agent command validity interval is invalid')
  }
  const identityDigest = await hexDigest(commandIdentity(envelope, spec.type))
  const unsigned = await Effect.runPromise(
    Schema.decodeUnknownEffect(AgentCommand)({
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: `cmd-${identityDigest.slice(0, 48)}`,
      operationId: envelope.operationId,
      organizationId: envelope.organizationId,
      nodeId: envelope.nodeId,
      resourceId: envelope.resourceId,
      type: spec.type,
      payloadSchemaVersion: 1,
      ...(envelope.plugin === undefined ? {} : { plugin: envelope.plugin }),
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      idempotencyKey: `workflow-${identityDigest.slice(0, 48)}`,
      expectedPriorRevision: envelope.expectedPriorRevision,
      payload,
      signature: 'unsigned-command-placeholder-00000000',
    }),
  )
  const signature = await signer(canonicalCommandPayload(unsigned))
  return Effect.runPromise(Schema.decodeUnknownEffect(AgentCommand)({ ...unsigned, signature }))
}

const pemBody = (pem: string): ArrayBuffer => {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  if (encoded.length === 0) throw new Error('Agent command signing key is malformed')
  try {
    const decoded = atob(encoded)
    const bytes = new Uint8Array(new ArrayBuffer(decoded.length))
    for (const [index, character] of Array.from(decoded).entries())
      bytes[index] = character.charCodeAt(0)
    return bytes.buffer
  } catch {
    throw new Error('Agent command signing key is malformed')
  }
}

export const ed25519CommandSigner = async (privateKeyPem: string): Promise<CommandSigner> => {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(privateKeyPem),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  return async (canonicalPayload) => {
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      key,
      new TextEncoder().encode(canonicalPayload),
    )
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
}
