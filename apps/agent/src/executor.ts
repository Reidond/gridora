import {
  BackupCreatePayload,
  BackupRestorePayload,
  AgentSelfUpdatePayload,
  ConfigApplyPayload,
  decodeDeploymentSpec,
  DeploymentRemovePayload,
  ModSyncPayload,
  ServerActionPayload,
  ServerUpdatePayload,
  TunnelCredentialInstallPayload,
  TunnelCredentialRevokePayload,
} from '@gridora/agent-protocol'
import {
  BackupExecutor,
  createBackupPlan,
  createRestorePlan,
  type BackupManifest,
} from '@gridora/backup-runtime'
import { createContainerPlan, DockerEngine } from '@gridora/docker-runtime'
import { AtomicCredentialInstaller } from '@gridora/tunnel-credential'
import { Effect, Layer, Schema } from 'effect'
import { AgentError } from './errors.js'
import { NodeHealthProbe } from './health.js'
import {
  AgentSelfUpdate,
  BackupArchiveUploader,
  CommandExecutor,
  type ExecutionResult,
} from './services.js'
import { NodeGameRuntime } from './game-runtime.js'

const executionFailure = (cause: unknown) =>
  new AgentError({ code: 'execution-failed', message: String(cause) })
const nextRevision = (prior: number | null): number => (prior ?? 0) + 1
const gameRuntime = NodeGameRuntime()

export const CommandExecutorLive = Layer.effect(
  CommandExecutor,
  Effect.gen(function* () {
    const docker = yield* DockerEngine
    const backups = yield* BackupExecutor
    const backupUploader = yield* BackupArchiveUploader
    const tunnelInstaller = yield* AtomicCredentialInstaller
    const healthProbe = yield* NodeHealthProbe
    const selfUpdate = yield* AgentSelfUpdate
    return {
      execute: (command): Effect.Effect<ExecutionResult, AgentError> => {
        switch (command.type) {
          case 'deployment.apply':
            return decodeDeploymentSpec(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((spec) =>
                gameRuntime.install(spec).pipe(
                  Effect.andThen(docker.apply(createContainerPlan(spec))),
                  Effect.mapError(executionFailure),
                  Effect.as({
                    revision: spec.revision,
                    code: 'deployment-applied',
                    message: 'plugin installed and the digest-pinned deployment was applied',
                  }),
                ),
              ),
            )
          case 'deployment.remove':
            return Schema.decodeUnknownEffect(DeploymentRemovePayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                docker.remove({
                  organizationId: command.organizationId,
                  serverId: command.resourceId,
                  deploymentId: payload.deploymentId,
                }),
              ),
              Effect.mapError(executionFailure),
              Effect.as({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'deployment-removed',
                message: 'deployment removed',
              }),
            )
          case 'server.start':
            return Schema.decodeUnknownEffect(ServerActionPayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                docker.start({
                  organizationId: command.organizationId,
                  serverId: command.resourceId,
                  deploymentId: payload.deploymentId,
                }),
              ),
              Effect.mapError(executionFailure),
              Effect.as({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'server-started',
                message: 'server started',
              }),
            )
          case 'server.stop':
            return Schema.decodeUnknownEffect(ServerActionPayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                docker.stop({
                  organizationId: command.organizationId,
                  serverId: command.resourceId,
                  deploymentId: payload.deploymentId,
                }),
              ),
              Effect.mapError(executionFailure),
              Effect.as({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'server-stopped',
                message: 'server stopped',
              }),
            )
          case 'server.restart':
            return Schema.decodeUnknownEffect(ServerActionPayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                docker
                  .stop({
                    organizationId: command.organizationId,
                    serverId: command.resourceId,
                    deploymentId: payload.deploymentId,
                  })
                  .pipe(
                    Effect.andThen(
                      docker.start({
                        organizationId: command.organizationId,
                        serverId: command.resourceId,
                        deploymentId: payload.deploymentId,
                      }),
                    ),
                  ),
              ),
              Effect.mapError(executionFailure),
              Effect.as({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'server-restarted',
                message: 'server restart requested; observation is required for activation',
              }),
            )
          case 'server.update':
            return Schema.decodeUnknownEffect(ServerUpdatePayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) => gameRuntime.update(command.resourceId, payload)),
              Effect.mapError(executionFailure),
              Effect.map((result) => ({
                revision: nextRevision(command.expectedPriorRevision),
                code: result.code,
                message: result.message,
              })),
            )
          case 'config.apply':
            return Schema.decodeUnknownEffect(ConfigApplyPayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) => gameRuntime.applyConfig(command.resourceId, payload)),
              Effect.mapError(executionFailure),
              Effect.map((result) => ({
                revision: nextRevision(command.expectedPriorRevision),
                code: result.code,
                message: result.message,
              })),
            )
          case 'mods.sync':
            return Schema.decodeUnknownEffect(ModSyncPayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) => gameRuntime.syncMods(command.resourceId, payload)),
              Effect.mapError(executionFailure),
              Effect.map((result) => ({
                revision: nextRevision(command.expectedPriorRevision),
                code: result.code,
                message: result.message,
              })),
            )
          case 'backup.create':
            return Schema.decodeUnknownEffect(BackupCreatePayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                backups
                  .create(
                    createBackupPlan({
                      apiVersion: 'backup.gridora.dev/v1alpha1',
                      backupId: payload.backupId,
                      organizationId: command.organizationId,
                      serverId: command.resourceId,
                      pluginId: payload.pluginId,
                      pluginVersion: payload.pluginVersion,
                      consistency: payload.consistency,
                      createdAt: command.issuedAt,
                      files: payload.files,
                      diskBytes: payload.diskBytes,
                    }),
                  )
                  .pipe(
                    Effect.flatMap((archive) =>
                      backupUploader
                        .upload({
                          organizationId: command.organizationId,
                          nodeId: command.nodeId,
                          operationId: command.operationId,
                          serverId: command.resourceId,
                          backupId: payload.backupId,
                          archivePath: archive.archivePath,
                          bytes: archive.bytes,
                          sha256: archive.sha256,
                          includes: payload.files,
                          createdAt: command.issuedAt,
                        })
                        .pipe(Effect.map((evidence) => ({ archive, evidence }))),
                    ),
                  ),
              ),
              Effect.mapError(executionFailure),
              Effect.map(({ archive, evidence }) => ({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'backup-created',
                message: `backup created and uploaded (${archive.sha256})`,
                evidence,
              })),
            )
          case 'backup.restore':
            return Schema.decodeUnknownEffect(BackupRestorePayload)(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) => {
                const manifest: BackupManifest = payload.manifest
                const plan = createRestorePlan(manifest, {
                  organizationId: command.organizationId,
                  sourceServerId: manifest.serverId,
                  targetServerId: payload.targetServerId,
                })
                switch (payload.phase) {
                  case 'stage':
                    return backupUploader
                      .download({
                        organizationId: command.organizationId,
                        nodeId: command.nodeId,
                        operationId: command.operationId,
                        sourceServerId: manifest.serverId,
                        targetServerId: payload.targetServerId,
                        backupId: manifest.backupId,
                        archivePath: plan.archivePath,
                        maximumBytes: manifest.diskBytes,
                        expectedSha256: manifest.sha256,
                      })
                      .pipe(Effect.andThen(backups.stageRestore(plan)))
                  case 'validate':
                    return gameRuntime.validateRestore(
                      payload.targetServerId,
                      manifest.pluginId,
                      manifest.pluginVersion,
                      command.operationId,
                      manifest.backupId,
                      plan.stagingDirectory,
                    )
                  case 'commit':
                    return backups.commitRestore(plan)
                  case 'rollback':
                    return backups.rollbackRestore(plan)
                  case 'finalize':
                    return backups.finalizeRestore(plan)
                }
              }),
              Effect.mapError(executionFailure),
              Effect.as({
                revision: nextRevision(command.expectedPriorRevision),
                code: 'backup-restore-phase-complete',
                message: 'backup restore phase completed',
              }),
            )
          case 'health.inspect':
            return command.plugin === undefined
              ? healthProbe.inspect.pipe(
                  Effect.map((health) => ({
                    revision: null,
                    code: `agent-responsive-node-${health.status}`,
                    message: `agent is responsive; node health is ${health.status}; game health was not inspected`,
                  })),
                )
              : gameRuntime
                  .inspectHealth(
                    command.resourceId,
                    command.plugin.id,
                    command.plugin.version,
                    command.operationId,
                  )
                  .pipe(
                    Effect.map((health) => ({
                      revision: null,
                      code: `game-health-${health.status}`,
                      message: `plugin-level game health is ${health.status}; process=${health.process}; protocol=${health.protocol}${health.build === undefined ? '' : `; build=${health.build}`}`,
                    })),
                  )
          case 'tunnel.credential.install':
            return Schema.decodeUnknownEffect(TunnelCredentialInstallPayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) => tunnelInstaller.install(payload)),
              Effect.mapError(executionFailure),
              Effect.map((proof) => ({
                revision: proof.revision,
                code: 'tunnel-credential-installed',
                message: 'tunnel credential installed and connector is ready',
              })),
            )
          case 'tunnel.credential.revoke':
            return Schema.decodeUnknownEffect(TunnelCredentialRevokePayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap((payload) =>
                tunnelInstaller.revoke(payload).pipe(
                  Effect.as({
                    revision: payload.revision,
                    code: 'tunnel-credential-revoked',
                    message: 'tunnel credential revoked and connector stopped',
                  }),
                ),
              ),
              Effect.mapError(executionFailure),
            )
          case 'agent.self-update':
            return Schema.decodeUnknownEffect(AgentSelfUpdatePayload, {
              onExcessProperty: 'error',
            })(command.payload).pipe(
              Effect.mapError(executionFailure),
              Effect.flatMap(() => selfUpdate.apply(command)),
              Effect.map((proof) => ({
                revision: nextRevision(command.expectedPriorRevision),
                code: proof.duplicate ? 'agent-update-already-active' : 'agent-update-active',
                message: `agent update ${proof.version} is active (${proof.digest})`,
              })),
            )
          default:
            return Effect.fail(executionFailure('unsupported signed game command'))
        }
      },
    }
  }),
)
