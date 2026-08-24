import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalAgentUpdateManifest,
  canonicalCommandPayload,
  canonicalJson,
  type AgentCommand,
  type AgentSelfUpdatePayload,
  type AgentUpdateManifest,
} from '@gridora/agent-protocol'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRootAgentUpdateHelper,
  type AgentUpdateCommandRunner,
  type RootAgentUpdateOptions,
  type RootAgentUpdatePaths,
} from '../src/agent-update-helper.js'
import { AgentError } from '../src/errors.js'
import { handleCommand } from '../src/processor.js'
import {
  AgentClock,
  CommandExecutor,
  Ed25519SignatureVerifier,
  MemoryCommandState,
} from '../src/services.js'
import { type AgentUpdateStageOptions, stageAgentUpdate } from '../src/self-update.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const uid = process.getuid?.()
const gid = process.getgid?.()
if (uid === undefined || gid === undefined)
  throw new Error('self-update tests need POSIX ownership')

const releaseKeys = generateKeyPairSync('ed25519')
const commandKeys = generateKeyPairSync('ed25519')
const releasePublicKey = releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const commandPublicKey = commandKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

interface Harness {
  readonly root: string
  readonly paths: RootAgentUpdatePaths
  readonly stageOptions: AgentUpdateStageOptions
  readonly rootOptions: RootAgentUpdateOptions
  readonly advance: (milliseconds: number) => void
  readonly restarts: () => number
  readonly activeChecks: () => number
}

const makeManifest = (
  bytes: Uint8Array,
  version: string,
  releaseSequence: number,
  securityEpoch = 1,
  issuedAt = '2026-08-23T10:00:00.000Z',
): AgentUpdateManifest => {
  const unsigned = {
    apiVersion: 'agent-update.gridora.dev/v1alpha1' as const,
    version,
    releaseSequence,
    securityEpoch,
    architecture: 'amd64' as const,
    source: {
      url: `https://releases.gridora.test/agents/${version}`,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sizeBytes: bytes.byteLength,
    },
    compatibility: {
      commandApiVersion: 'agent.gridora.dev/v1alpha1' as const,
      minimumControlPlaneApiVersion: 'agent.gridora.dev/v1alpha1' as const,
      maximumControlPlaneApiVersion: 'agent.gridora.dev/v1alpha1' as const,
    },
    issuedAt,
  }
  const unsignedManifest = { ...unsigned, signature: 'x'.repeat(88) } as AgentUpdateManifest
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalAgentUpdateManifest(unsignedManifest), 'utf8'),
      releaseKeys.privateKey,
    ).toString('base64'),
  }
}

const createHarness = async (input?: { readonly candidateHealthy?: boolean }): Promise<Harness> => {
  const root = await mkdtemp(join(process.cwd(), '.self-update-'))
  temporary.push(root)
  const configuration = join(root, 'etc')
  const parent = join(root, 'var', 'lib', 'gridora')
  await mkdir(configuration, { recursive: true, mode: 0o700 })
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = join(parent, 'agent-updates')
  const paths: RootAgentUpdatePaths = {
    directory,
    releaseDirectory: join(directory, 'releases'),
    currentLink: join(directory, 'current'),
    statePath: join(directory, 'root-state.json'),
    stagingDirectory: join(directory, 'staged'),
    healthPath: join(directory, 'health', 'receipt.json'),
    policyPath: join(configuration, 'agent-update-policy.json'),
    releaseSigningPublicKeyPath: join(configuration, 'agent-release-signing-public.pem'),
    socketPath: join(root, 'agent-update.sock'),
  }
  await writeFile(
    paths.policyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      allowedArtifactHosts: ['releases.gridora.test'],
      maximumArtifactBytes: 1024 * 1024,
      commandApiVersion: 'agent.gridora.dev/v1alpha1',
      controlPlaneApiVersion: 'agent.gridora.dev/v1alpha1',
    })}\n`,
    { mode: 0o600 },
  )
  await writeFile(paths.releaseSigningPublicKeyPath, releasePublicKey, { mode: 0o600 })
  await chmod(paths.policyPath, 0o600)
  await chmod(paths.releaseSigningPublicKeyPath, 0o600)
  let milliseconds = Date.parse('2026-08-23T10:00:00.000Z')
  let restartCount = 0
  let activeCount = 0
  const runner: AgentUpdateCommandRunner = {
    run: async (_command, args) => {
      if (args[0] === 'restart') restartCount += 1
      else activeCount += 1
    },
  }
  const rootOptions: RootAgentUpdateOptions = {
    paths,
    rootUid: uid,
    rootGid: gid,
    agentUid: uid,
    agentGid: gid,
    architecture: 'amd64',
    commandRunner: runner,
    now: () => new Date(milliseconds),
    sleep: async (amount) => {
      milliseconds += amount
    },
    probationMilliseconds: 1_000,
    healthProbe: {
      healthy: async (release) =>
        input?.candidateHealthy === false ? release.releaseSequence === 1 : true,
    },
  }
  const helper = createRootAgentUpdateHelper(rootOptions)
  await helper.setup()
  const stageOptions: AgentUpdateStageOptions = {
    paths,
    trustedUid: uid,
    agentUid: uid,
    agentGid: gid,
    architecture: 'amd64',
    now: () => new Date(milliseconds),
  }
  return {
    root,
    paths,
    stageOptions,
    rootOptions,
    advance: (amount) => {
      milliseconds += amount
    },
    restarts: () => restartCount,
    activeChecks: () => activeCount,
  }
}

const seedRelease = async (
  harness: Harness,
  manifest: AgentUpdateManifest,
  artifact: Uint8Array,
): Promise<void> => {
  const suffix = manifest.source.sha256.slice('sha256:'.length)
  const directory = join(harness.paths.releaseDirectory, suffix)
  await mkdir(directory, { mode: 0o755 })
  await writeFile(join(directory, 'gridora-agent'), artifact, { mode: 0o755 })
  await writeFile(join(directory, 'release.json'), `${canonicalJson(manifest)}\n`, { mode: 0o644 })
  await chmod(join(directory, 'gridora-agent'), 0o755)
  await chmod(join(directory, 'release.json'), 0o644)
  await symlink(`releases/${suffix}`, harness.paths.currentLink)
  await writeFile(
    harness.paths.statePath,
    `${canonicalJson({
      version: 1,
      phase: 'active',
      active: {
        version: manifest.version,
        digest: manifest.source.sha256,
        releaseSequence: manifest.releaseSequence,
        securityEpoch: manifest.securityEpoch,
      },
      previous: null,
      activation: null,
      outcomes: [],
      highestReleaseSequence: manifest.releaseSequence,
      minimumSecurityEpoch: manifest.securityEpoch,
    })}\n`,
    { mode: 0o600 },
  )
  await chmod(harness.paths.statePath, 0o600)
}

const stage = async (
  manifest: AgentUpdateManifest,
  artifact: Uint8Array,
  options: AgentUpdateStageOptions,
) =>
  stageAgentUpdate(manifest, {
    ...options,
    download: async () => artifact,
  })

const requestFor = (manifest: AgentUpdateManifest, commandId: string) => ({
  apiVersion: 'agent-update.gridora.dev/v1alpha1' as const,
  action: 'activate' as const,
  digest: manifest.source.sha256,
  version: manifest.version,
  architecture: manifest.architecture,
  commandId,
  operationId: `operation-${commandId}`,
})

describe('signed agent self-update boundary', () => {
  it('stages a first signed HTTPS release with no-follow/uid/mode evidence and rejects a hostile symlink collision', async () => {
    const harness = await createHarness()
    const artifact = Buffer.from('agent-version-two')
    const manifest = makeManifest(artifact, '2.0.0', 2)
    const staged = await stage(manifest, artifact, harness.stageOptions)
    expect(await readFile(staged.artifactPath)).toEqual(artifact)
    expect((await lstat(staged.artifactPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(staged.manifestPath)).uid).toBe(uid)

    const hostile = makeManifest(Buffer.from('another-agent'), '3.0.0', 3)
    const hostilePath = join(
      harness.paths.stagingDirectory,
      `${hostile.source.sha256.slice('sha256:'.length)}.artifact`,
    )
    await symlink('/etc/passwd', hostilePath)
    await expect(
      stage(hostile, Buffer.from('another-agent'), harness.stageOptions),
    ).rejects.toMatchObject({
      code: 'unsafe-filesystem',
    })
  })

  it('commits only after systemd-backed probation, serializes duplicate activation, retains two releases, and refuses a signed downgrade', async () => {
    const harness = await createHarness()
    const baselineArtifact = Buffer.from('agent-version-one')
    const baseline = makeManifest(baselineArtifact, '1.0.0', 1)
    await seedRelease(harness, baseline, baselineArtifact)
    const helper = createRootAgentUpdateHelper(harness.rootOptions)
    const updateArtifact = Buffer.from('agent-version-two')
    const update = makeManifest(updateArtifact, '2.0.0', 2)
    await stage(update, updateArtifact, harness.stageOptions)
    const request = requestFor(update, 'command-update-2')
    const [first, replay] = await Promise.all([helper.execute(request), helper.execute(request)])
    expect(first.status).toBe('active')
    expect(replay.status).toBe('active')
    expect(
      [first.duplicate, replay.duplicate].sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true])
    expect(harness.restarts()).toBe(1)
    expect(harness.activeChecks()).toBeGreaterThanOrEqual(3)
    expect(first.retainedReleaseCount).toBe(2)

    const oldManifest = makeManifest(Buffer.from('known-old-agent'), '0.9.0', 1)
    await stage(oldManifest, Buffer.from('known-old-agent'), harness.stageOptions)
    await expect(
      helper.execute(requestFor(oldManifest, 'command-downgrade')),
    ).rejects.toMatchObject({
      code: 'helper-rejected',
    })
    expect(harness.restarts()).toBe(1)
  })

  it('rolls back exactly to the previous release after failed probation and records the terminal rollback proof', async () => {
    const harness = await createHarness({ candidateHealthy: false })
    const baselineArtifact = Buffer.from('agent-version-one')
    const baseline = makeManifest(baselineArtifact, '1.0.0', 1)
    await seedRelease(harness, baseline, baselineArtifact)
    const helper = createRootAgentUpdateHelper(harness.rootOptions)
    const candidateArtifact = Buffer.from('agent-version-two')
    const candidate = makeManifest(candidateArtifact, '2.0.0', 2)
    await stage(candidate, candidateArtifact, harness.stageOptions)
    const result = await helper.execute(requestFor(candidate, 'command-failed-probation'))
    expect(result).toMatchObject({ status: 'rolled-back', digest: candidate.source.sha256 })
    const current = await lstat(harness.paths.currentLink)
    expect(current.isSymbolicLink()).toBe(true)
    const state = JSON.parse(await readFile(harness.paths.statePath, 'utf8')) as {
      active: { digest: string }
      outcomes: readonly { status: string }[]
    }
    expect(state.active.digest).toBe(baseline.source.sha256)
    expect(state.outcomes.at(-1)?.status).toBe('rolled-back')
    expect(harness.restarts()).toBe(2)
  })

  it('garbage-collects only verified non-retained release directories after a durable third activation', async () => {
    const harness = await createHarness()
    const baselineArtifact = Buffer.from('agent-version-one')
    const baseline = makeManifest(baselineArtifact, '1.0.0', 1)
    await seedRelease(harness, baseline, baselineArtifact)
    const helper = createRootAgentUpdateHelper(harness.rootOptions)
    const secondArtifact = Buffer.from('agent-version-two')
    const second = makeManifest(secondArtifact, '2.0.0', 2)
    await stage(second, secondArtifact, harness.stageOptions)
    await helper.execute(requestFor(second, 'command-retain-two'))
    const thirdArtifact = Buffer.from('agent-version-three')
    const third = makeManifest(thirdArtifact, '3.0.0', 3)
    await stage(third, thirdArtifact, harness.stageOptions)
    await expect(helper.execute(requestFor(third, 'command-gc-old'))).resolves.toMatchObject({
      status: 'active',
      retainedReleaseCount: 2,
    })
    const releases = await Promise.all(
      [baseline, second, third].map(async (manifest) => ({
        digest: manifest.source.sha256,
        exists: await lstat(
          join(harness.paths.releaseDirectory, manifest.source.sha256.slice('sha256:'.length)),
        )
          .then(() => true)
          .catch(() => false),
      })),
    )
    expect(releases).toEqual([
      { digest: baseline.source.sha256, exists: false },
      { digest: second.source.sha256, exists: true },
      { digest: third.source.sha256, exists: true },
    ])
  })

  it('adopts an exact post-restart health receipt after a crash before completion instead of restarting the signed release', async () => {
    const harness = await createHarness()
    const baselineArtifact = Buffer.from('agent-version-one')
    const baseline = makeManifest(baselineArtifact, '1.0.0', 1)
    await seedRelease(harness, baseline, baselineArtifact)
    const helper = createRootAgentUpdateHelper(harness.rootOptions)
    const candidateArtifact = Buffer.from('agent-version-two')
    const candidate = makeManifest(candidateArtifact, '2.0.0', 2)
    await stage(candidate, candidateArtifact, harness.stageOptions)
    const request = requestFor(candidate, 'command-crash-adopt')
    await helper.execute(request)
    const beforeRecoveryRestarts = harness.restarts()
    await writeFile(
      harness.paths.statePath,
      `${canonicalJson({
        version: 1,
        phase: 'activating',
        active: {
          version: baseline.version,
          digest: baseline.source.sha256,
          releaseSequence: baseline.releaseSequence,
          securityEpoch: baseline.securityEpoch,
        },
        previous: null,
        activation: {
          commandId: request.commandId,
          operationId: request.operationId,
          candidate: {
            version: candidate.version,
            digest: candidate.source.sha256,
            releaseSequence: candidate.releaseSequence,
            securityEpoch: candidate.securityEpoch,
          },
          previous: {
            version: baseline.version,
            digest: baseline.source.sha256,
            releaseSequence: baseline.releaseSequence,
            securityEpoch: baseline.securityEpoch,
          },
          startedAt: '2026-08-23T10:00:00.000Z',
        },
        outcomes: [],
        highestReleaseSequence: 2,
        minimumSecurityEpoch: 1,
      })}\n`,
      { mode: 0o600 },
    )
    await chmod(harness.paths.statePath, 0o600)
    await expect(helper.execute(request)).resolves.toMatchObject({
      status: 'active',
      duplicate: true,
    })
    expect(harness.restarts()).toBe(beforeRecoveryRestarts)
  })

  it('treats a crash with no exact health receipt as unknown and rolls back without a second candidate activation', async () => {
    const harness = await createHarness({ candidateHealthy: false })
    const baselineArtifact = Buffer.from('agent-version-one')
    const baseline = makeManifest(baselineArtifact, '1.0.0', 1)
    await seedRelease(harness, baseline, baselineArtifact)
    const candidateArtifact = Buffer.from('agent-version-two')
    const candidate = makeManifest(candidateArtifact, '2.0.0', 2)
    await stage(candidate, candidateArtifact, harness.stageOptions)
    // Materialize the candidate via a healthy helper, then model the crash
    // window by restoring a persisted activating state and switching the
    // observer to unknown before any completion receipt exists.
    const healthyHarness = harness as Harness
    const materializer = createRootAgentUpdateHelper({
      ...healthyHarness.rootOptions,
      healthProbe: { healthy: async () => true },
    })
    const request = requestFor(candidate, 'command-crash-unknown')
    await materializer.execute(request)
    const restartsBeforeRecovery = harness.restarts()
    await writeFile(
      harness.paths.statePath,
      `${canonicalJson({
        version: 1,
        phase: 'activating',
        active: {
          version: baseline.version,
          digest: baseline.source.sha256,
          releaseSequence: baseline.releaseSequence,
          securityEpoch: baseline.securityEpoch,
        },
        previous: null,
        activation: {
          commandId: request.commandId,
          operationId: request.operationId,
          candidate: {
            version: candidate.version,
            digest: candidate.source.sha256,
            releaseSequence: candidate.releaseSequence,
            securityEpoch: candidate.securityEpoch,
          },
          previous: {
            version: baseline.version,
            digest: baseline.source.sha256,
            releaseSequence: baseline.releaseSequence,
            securityEpoch: baseline.securityEpoch,
          },
          startedAt: '2026-08-23T10:00:00.000Z',
        },
        outcomes: [],
        highestReleaseSequence: 2,
        minimumSecurityEpoch: 1,
      })}\n`,
      { mode: 0o600 },
    )
    await chmod(harness.paths.statePath, 0o600)
    const unknownRecovery = createRootAgentUpdateHelper(harness.rootOptions)
    await expect(unknownRecovery.execute(request)).resolves.toMatchObject({ status: 'rolled-back' })
    expect(harness.restarts() - restartsBeforeRecovery).toBe(1)
  })

  it('leaves a response-loss update lease pending and safely replays after expiry instead of recording a false failure', async () => {
    const payloadManifest = makeManifest(Buffer.from('agent-version-two'), '2.0.0', 2)
    const payload: AgentSelfUpdatePayload = {
      apiVersion: 'agent-update.gridora.dev/v1alpha1',
      action: 'activate',
      deliveryId: 'response-loss-command',
      organizationId: 'org-1',
      nodeId: 'node-1',
      operationId: 'response-loss-operation',
      manifest: payloadManifest,
    }
    const command: AgentCommand = {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: payload.deliveryId,
      operationId: payload.operationId,
      organizationId: payload.organizationId,
      nodeId: payload.nodeId,
      resourceId: payload.nodeId,
      type: 'agent.self-update',
      payloadSchemaVersion: 1,
      issuedAt: '2026-08-23T09:00:00Z',
      expiresAt: '2026-08-24T11:00:00Z',
      idempotencyKey: payload.deliveryId,
      expectedPriorRevision: 0,
      payload,
      signature: 'pending',
    }
    const signed: AgentCommand = {
      ...command,
      signature: sign(
        null,
        Buffer.from(canonicalCommandPayload(command), 'utf8'),
        commandKeys.privateKey,
      ).toString('base64'),
    }
    let now = new Date('2026-08-23T10:00:00Z')
    let executions = 0
    const layer = Layer.mergeAll(
      Layer.succeed(AgentClock, { now: Effect.sync(() => now) }),
      Ed25519SignatureVerifier(commandPublicKey),
      MemoryCommandState(),
      Layer.succeed(CommandExecutor, {
        execute: () => {
          executions += 1
          return executions === 1
            ? Effect.fail(
                new AgentError({
                  code: 'update-response-pending',
                  message: 'helper receipt was lost',
                }),
              )
            : Effect.succeed({
                revision: 1,
                code: 'agent-update-active',
                message: 'exact helper receipt adopted',
              })
        },
      }),
    )
    const run = () =>
      Effect.runPromise(
        handleCommand(signed, { organizationId: 'org-1', nodeId: 'node-1' }).pipe(
          Effect.provide(layer),
        ),
      )
    await expect(run()).resolves.toBeUndefined()
    now = new Date('2026-08-23T10:06:00Z')
    await expect(run()).resolves.toMatchObject({ status: 'succeeded', revision: 1 })
    expect(executions).toBe(2)
  })
})
