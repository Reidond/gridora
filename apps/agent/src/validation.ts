import type { AgentCommand, DeploymentSpec } from '@gridora/agent-protocol'
import {
  BackupCreatePayload,
  BackupRestorePayload,
  AgentSelfUpdatePayload,
  ConfigApplyPayload,
  decodeDeploymentSpec,
  DeploymentRemovePayload,
  HealthInspectPayload,
  ModSyncPayload,
  ServerActionPayload,
  ServerUpdatePayload,
  TunnelCredentialInstallPayload,
  TunnelCredentialRevokePayload,
} from '@gridora/agent-protocol'
import { Effect, Schema } from 'effect'
import { AgentError } from './errors.js'

export interface AgentIdentity {
  readonly organizationId: string
  readonly nodeId: string
}

export const validateCommandEnvelope = (
  command: AgentCommand,
  identity: AgentIdentity,
  now: Date,
): Effect.Effect<void, AgentError> => {
  if (command.organizationId !== identity.organizationId)
    return Effect.fail(
      new AgentError({
        code: 'wrong-organization',
        message: 'command organization does not match agent identity',
      }),
    )
  if (command.nodeId !== identity.nodeId)
    return Effect.fail(
      new AgentError({ code: 'wrong-node', message: 'command target does not match this node' }),
    )
  const issuedAt = Date.parse(command.issuedAt)
  const expiresAt = Date.parse(command.expiresAt)
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > expiresAt ||
    now.getTime() > expiresAt
  ) {
    return Effect.fail(
      new AgentError({
        code: 'expired-command',
        message: 'command is expired or has an invalid validity interval',
      }),
    )
  }
  return Effect.void
}

export const validateDeploymentForCommand = (
  command: AgentCommand,
  identity: AgentIdentity,
  now: Date,
): Effect.Effect<DeploymentSpec, AgentError> =>
  decodeDeploymentSpec(command.payload).pipe(
    Effect.mapError(
      (cause) =>
        new AgentError({
          code: 'invalid-command',
          message: `invalid DeploymentSpec: ${String(cause)}`,
        }),
    ),
    Effect.flatMap((spec) => {
      if (
        spec.organizationId !== identity.organizationId ||
        spec.nodeId !== identity.nodeId ||
        spec.serverId !== command.resourceId ||
        spec.operationId !== command.operationId
      ) {
        return Effect.fail(
          new AgentError({
            code: 'invalid-command',
            message: 'DeploymentSpec is not bound to the command target',
          }),
        )
      }
      if (Date.parse(spec.expiresAt) < now.getTime())
        return Effect.fail(
          new AgentError({ code: 'expired-command', message: 'DeploymentSpec has expired' }),
        )
      return Effect.succeed(spec)
    }),
  )

const decodePayload = <A>(schema: Schema.Decoder<A, never>, payload: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(payload).pipe(
    Effect.mapError(
      (cause) =>
        new AgentError({
          code: 'invalid-command',
          message: `invalid command payload: ${String(cause)}`,
        }),
    ),
  )

const validateTunnelBinding = (
  command: AgentCommand,
  payload: typeof TunnelCredentialInstallPayload.Type | typeof TunnelCredentialRevokePayload.Type,
  action: 'install' | 'revoke',
): Effect.Effect<void, AgentError> => {
  if (
    payload.action !== action ||
    payload.deliveryId !== command.commandId ||
    payload.organizationId !== command.organizationId ||
    payload.nodeId !== command.nodeId ||
    payload.tunnelId !== command.resourceId ||
    payload.operationId !== command.operationId ||
    command.expectedPriorRevision === null ||
    payload.expectedPriorRevision !== command.expectedPriorRevision ||
    payload.expiresAt !== command.expiresAt
  )
    return Effect.fail(
      new AgentError({
        code: 'invalid-command',
        message: 'tunnel credential payload is not bound to the signed command',
      }),
    )
  return Effect.void
}

const validatePluginPayloadBinding = (
  command: AgentCommand,
  payload: {
    readonly operationId: string
    readonly serverId: string
    readonly deploymentId: string
    readonly pluginId: string
    readonly pluginVersion: string
  },
): Effect.Effect<void, AgentError> => {
  if (
    command.plugin === undefined ||
    payload.operationId !== command.operationId ||
    payload.serverId !== command.resourceId ||
    payload.deploymentId.length === 0 ||
    payload.pluginId !== command.plugin.id ||
    payload.pluginVersion !== command.plugin.version
  )
    return Effect.fail(
      new AgentError({
        code: 'invalid-command',
        message: 'game command plugin and deployment are not bound to the signed command',
      }),
    )
  return Effect.void
}

const validateSelfUpdateBinding = (
  command: AgentCommand,
  payload: typeof AgentSelfUpdatePayload.Type,
): Effect.Effect<void, AgentError> => {
  if (
    command.resourceId !== command.nodeId ||
    command.expectedPriorRevision === null ||
    payload.action !== 'activate' ||
    payload.deliveryId !== command.commandId ||
    payload.organizationId !== command.organizationId ||
    payload.nodeId !== command.nodeId ||
    payload.operationId !== command.operationId
  )
    return Effect.fail(
      new AgentError({
        code: 'invalid-command',
        message: 'agent update payload is not bound to the signed node command',
      }),
    )
  return Effect.void
}

export const validateCommandPayload = (
  command: AgentCommand,
  identity: AgentIdentity,
  now: Date,
): Effect.Effect<void, AgentError> => {
  switch (command.type) {
    case 'deployment.apply':
      return validateDeploymentForCommand(command, identity, now).pipe(Effect.asVoid)
    case 'deployment.remove':
      return decodePayload(DeploymentRemovePayload, command.payload).pipe(Effect.asVoid)
    case 'server.start':
    case 'server.stop':
    case 'server.restart':
      return decodePayload(ServerActionPayload, command.payload).pipe(Effect.asVoid)
    case 'server.update':
      return decodePayload(ServerUpdatePayload, command.payload).pipe(
        Effect.flatMap((payload) => validatePluginPayloadBinding(command, payload)),
      )
    case 'config.apply':
      return decodePayload(ConfigApplyPayload, command.payload).pipe(
        Effect.flatMap((payload) => validatePluginPayloadBinding(command, payload)),
      )
    case 'mods.sync':
      return decodePayload(ModSyncPayload, command.payload).pipe(
        Effect.flatMap((payload) => validatePluginPayloadBinding(command, payload)),
      )
    case 'backup.create':
      return decodePayload(BackupCreatePayload, command.payload).pipe(Effect.asVoid)
    case 'backup.restore':
      return decodePayload(BackupRestorePayload, command.payload).pipe(
        Effect.flatMap((payload) =>
          payload.manifest.organizationId !== identity.organizationId ||
          payload.targetServerId !== command.resourceId
            ? Effect.fail(
                new AgentError({
                  code: 'invalid-command',
                  message: 'backup restore payload is not bound to the command target',
                }),
              )
            : Effect.void,
        ),
      )
    case 'health.inspect':
      return decodePayload(HealthInspectPayload, command.payload).pipe(Effect.asVoid)
    case 'tunnel.credential.install':
      return decodePayload(TunnelCredentialInstallPayload, command.payload).pipe(
        Effect.flatMap((payload) => validateTunnelBinding(command, payload, 'install')),
      )
    case 'tunnel.credential.revoke':
      return decodePayload(TunnelCredentialRevokePayload, command.payload).pipe(
        Effect.flatMap((payload) => validateTunnelBinding(command, payload, 'revoke')),
      )
    case 'agent.self-update':
      return decodePayload(AgentSelfUpdatePayload, command.payload).pipe(
        Effect.flatMap((payload) => validateSelfUpdateBinding(command, payload)),
      )
  }
}
