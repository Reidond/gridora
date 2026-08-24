#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { BackupExecutorLive } from '@gridora/backup-runtime'
import { AtomicCredentialInstallerLayer } from '@gridora/tunnel-credential'
import {
  makeTunnelInstallerClient,
  serveProductionTunnelInstallerOnFd,
} from '@gridora/tunnel-installer'
import {
  NodeDockerEngine,
  prepareProjectQuotaFilesystem,
  serveProjectQuotaHelperOnFd,
} from '@gridora/docker-runtime'
import { Effect, Layer } from 'effect'
import { decodeAgentConfiguration } from './config.js'
import { NodeBackupArchive } from './backup-archive.js'
import { FetchBackupArchiveUploader } from './backup-http-upload.js'
import {
  serveProductionAgentUpdateHelperOnFd,
  setupProductionAgentUpdate,
} from './agent-update-helper.js'
import { CommandExecutorLive } from './executor.js'
import { FileCommandState } from './file-command-state.js'
import { NodeHealthProbeLive, redact } from './health.js'
import {
  FetchAgentObservationTransport,
  FileAgentObservationState,
  makeAgentObservationPublisher,
} from './observation.js'
import { NodeAgentObservationFacts } from './observation-node.js'
import { runAgentLoop, runObservedAgentLoop } from './runtime.js'
import { Ed25519SignatureVerifier, SystemAgentClock } from './services.js'
import { AgentSelfUpdateLive, productionAgentUpdatePaths } from './self-update.js'
import { markAgentUpdateHealthy } from './self-update-health.js'
import { makeProductionTelemetryPublisher } from './telemetry.js'
import {
  acquireNodeAuthentication,
  FetchAgentTransport,
  validateControlPlaneUrl,
} from './transport.js'

const usage =
  'gridora-agent serve --config <path>\ngridora-agent quota-filesystem-setup\ngridora-agent quota-helper --listen-fd 3\ngridora-agent tunnel-installer --listen-fd 3\ngridora-agent agent-update-helper --listen-fd 3\ngridora-agent agent-update-helper --setup\n'

const serve = (path: string) =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise(() => readFile(path, 'utf8'))
    const parsed = yield* Effect.try(() => JSON.parse(source) as unknown)
    const config = yield* decodeAgentConfiguration(parsed)
    const publicKey = yield* Effect.tryPromise(() => readFile(config.signingPublicKeyFile, 'utf8'))
    const transport = FetchAgentTransport(
      config.controlPlaneUrl,
      config.expectedControlPlaneHost,
      config.allowLoopbackHttp,
    )
    const tunnelInstallerClient = makeTunnelInstallerClient()
    const installerPublicKey = yield* Effect.tryPromise(() => tunnelInstallerClient.publicKey())
    const authentication = yield* acquireNodeAuthentication({
      ...config,
      installerPublicKey,
    }).pipe(Effect.provide(transport))
    yield* Effect.logInfo(
      'gridora-agent started',
      redact({
        organizationId: config.organizationId,
        nodeId: config.nodeId,
        controlPlaneUrl: config.controlPlaneUrl,
      }),
    )
    const backupExecutor = BackupExecutorLive.pipe(Layer.provide(NodeBackupArchive()))
    const nodeCredential =
      authentication.kind === 'current'
        ? authentication.authentication.nodeCredential
        : authentication.nodeCredential
    const backupUploader = FetchBackupArchiveUploader({
      controlPlaneOrigin: validateControlPlaneUrl(
        config.controlPlaneUrl,
        config.expectedControlPlaneHost,
        config.allowLoopbackHttp,
      ),
      nodeCredential,
    })
    const tunnelInstaller = AtomicCredentialInstallerLayer(tunnelInstallerClient)
    const architecture =
      process.arch === 'arm64'
        ? ('arm64' as const)
        : process.arch === 'x64'
          ? ('amd64' as const)
          : undefined
    if (architecture === undefined) return yield* Effect.die('unsupported agent architecture')
    const agentUid = process.getuid?.()
    const agentGid = process.getgid?.()
    if (agentUid === undefined || agentGid === undefined)
      return yield* Effect.die('agent identity is unavailable')
    const selfUpdate = AgentSelfUpdateLive({
      paths: productionAgentUpdatePaths,
      trustedUid: 0,
      agentUid,
      agentGid,
      architecture,
    })
    const executor = CommandExecutorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeDockerEngine(config.dockerSocket),
          backupExecutor,
          backupUploader,
          tunnelInstaller,
          NodeHealthProbeLive({
            version: config.agentVersion,
            organizationId: config.organizationId,
            nodeId: config.nodeId,
            dockerSocket: config.dockerSocket,
          }),
          selfUpdate,
        ),
      ),
    )
    const runtime = Layer.mergeAll(
      transport,
      FileCommandState(`${config.stateDirectory}/command-state.sqlite`),
      Ed25519SignatureVerifier(publicKey),
      SystemAgentClock,
      executor,
    )
    // A missing release pointer means this is an image that predates the
    // updater. It remains operational, but cannot satisfy update probation.
    yield* Effect.promise(() => markAgentUpdateHealthy())
    if (authentication.kind === 'legacy') {
      yield* Effect.logWarning(
        'legacy node credential has no authoritative session metadata; observation publication is disabled',
      )
      yield* runAgentLoop(config, authentication.nodeCredential, config.pollWaitSeconds).pipe(
        Effect.provide(runtime),
      )
    } else {
      const telemetryPublisher = makeProductionTelemetryPublisher(config)
      const observationLayers = Layer.mergeAll(
        FetchAgentObservationTransport(
          config.controlPlaneUrl,
          config.expectedControlPlaneHost,
          config.allowLoopbackHttp,
        ),
        FileAgentObservationState(`${config.stateDirectory}/observation-state.json`),
        NodeAgentObservationFacts({
          version: config.agentVersion,
          dockerSocket: config.dockerSocket,
        }),
      )
      yield* Effect.gen(function* () {
        const publisher = yield* makeAgentObservationPublisher
        yield* runObservedAgentLoop(
          config,
          authentication.authentication,
          config.pollWaitSeconds,
          () =>
            Effect.gen(function* () {
              // Telemetry has its own durable retry state. A temporary telemetry
              // outage must not suppress the separate readiness observation or
              // command loop, and the next iteration reuses its exact payload.
              yield* telemetryPublisher.publishOnce(authentication.authentication).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    'agent telemetry publication failed; durable retry remains pending',
                    {
                      code: error instanceof Error && 'code' in error ? error.code : 'unknown',
                    },
                  ),
                ),
              )
              return yield* publisher.publishOnce(authentication.authentication, config)
            }),
        )
      }).pipe(Effect.provide(observationLayers), Effect.provide(runtime))
    }
  })

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.length === 0) process.stdout.write(usage)
else if (
  argv.length === 3 &&
  argv[0] === 'quota-helper' &&
  argv[1] === '--listen-fd' &&
  argv[2] === '3'
) {
  serveProjectQuotaHelperOnFd(3).catch((cause: unknown) => {
    process.stderr.write(`gridora quota helper failed: ${String(cause)}\n`)
    process.exitCode = 1
  })
} else if (
  argv.length === 3 &&
  argv[0] === 'tunnel-installer' &&
  argv[1] === '--listen-fd' &&
  argv[2] === '3'
) {
  serveProductionTunnelInstallerOnFd(3).catch(() => {
    process.stderr.write('gridora tunnel installer failed\n')
    process.exitCode = 1
  })
} else if (
  argv.length === 3 &&
  argv[0] === 'agent-update-helper' &&
  argv[1] === '--listen-fd' &&
  argv[2] === '3'
) {
  serveProductionAgentUpdateHelperOnFd(3).catch(() => {
    process.stderr.write('gridora agent update helper failed\n')
    process.exitCode = 1
  })
} else if (argv.length === 2 && argv[0] === 'agent-update-helper' && argv[1] === '--setup') {
  setupProductionAgentUpdate().catch(() => {
    process.stderr.write('gridora agent update setup failed\n')
    process.exitCode = 1
  })
} else if (argv.length === 1 && argv[0] === 'quota-filesystem-setup') {
  prepareProjectQuotaFilesystem().catch((cause: unknown) => {
    process.stderr.write(`gridora quota filesystem setup failed: ${String(cause)}\n`)
    process.exitCode = 1
  })
} else {
  const configIndex = argv.indexOf('--config')
  const configPath = configIndex < 0 ? undefined : argv[configIndex + 1]
  if (argv[0] !== 'serve' || configPath === undefined) {
    process.stderr.write(usage)
    process.exitCode = 2
  } else {
    Effect.runPromise(serve(configPath)).catch((cause: unknown) => {
      process.stderr.write(`gridora-agent configuration/startup failed: ${String(cause)}\n`)
      process.exitCode = 1
    })
  }
}
