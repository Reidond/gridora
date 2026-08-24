import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  canAdoptContainer,
  canAdoptNetwork,
  createContainerPlan,
  DOCKER_API_VERSION,
  DockerEngine,
  dockerCreateBody,
  dockerNetworkCreateBody,
  NodeDockerEngine,
  ProjectQuotaError,
  type ProjectQuotaRequest,
  validateBindSources,
  validateDiskPolicy,
} from '../src/index.js'

const base = {
  apiVersion: 'agent.gridora.dev/v1alpha1',
  organizationId: 'org-1',
  nodeId: 'node-1',
  serverId: 'server-1',
  deploymentId: 'deploy-1',
  operationId: 'op-1',
  revision: 1,
  plugin: { id: 'arma-reforger', version: '1.0.0', apiVersion: 'gridora.plugin/v1alpha1' },
  image: { installer: `sha256:${'a'.repeat(64)}`, runtime: `sha256:${'b'.repeat(64)}` },
  ports: [{ host: 2001, container: 2001, protocol: 'udp' }],
  mounts: [
    { source: '/var/lib/gridora/servers/server-1/data', target: '/game/data', readOnly: false },
  ],
  resources: { cpu: 2, memoryMiB: 2048, pids: 256, diskGiB: 20 },
  expiresAt: '2026-08-24T00:00:00Z',
} as const

describe('createContainerPlan', () => {
  it('uses the Docker API floor checked by the Ubuntu node image', () => {
    expect(DOCKER_API_VERSION).toBe('v1.43')
  })
  it('always applies the workload sandbox', () => {
    const plan = createContainerPlan(base)
    expect(plan).toMatchObject({
      privileged: false,
      user: '10001:10001',
      capabilities: { drop: ['ALL'] },
    })
    expect(JSON.stringify(plan)).not.toContain('docker.sock')
    expect(dockerCreateBody(plan)).toMatchObject({
      ExposedPorts: { '2001/udp': {} },
      HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'] },
    })
    expect(dockerNetworkCreateBody(plan)).toMatchObject({
      Internal: false,
      Attachable: false,
    })
  })
  it('rejects cross-server mounts', () => {
    expect(() =>
      createContainerPlan({
        ...base,
        mounts: [{ ...base.mounts[0], source: '/var/lib/gridora/servers/other/data' }],
      }),
    ).toThrow(/outside/)
  })
  it('accepts only an exact project-quota enforcement proof', () => {
    const plan = createContainerPlan(base)
    const proof = {
      apiVersion: 'quota.gridora.dev/v1alpha1',
      enforced: true,
      method: 'ext4-project-quota',
      serverId: base.serverId,
      projectId: 1_000_000_000,
      hardBytes: base.resources.diskGiB * 1024 * 1024 * 1024,
      root: `/var/lib/gridora/servers/${base.serverId}`,
    } as const
    expect(() => validateDiskPolicy(plan, proof)).not.toThrow()
    expect(() => validateDiskPolicy(plan, { ...proof, hardBytes: proof.hardBytes + 1024 })).toThrow(
      /not enforced/,
    )
  })
  it('asks the quota helper before any Docker operation and fails closed on refusal', async () => {
    const received: ProjectQuotaRequest[] = []
    const plan = createContainerPlan(base)
    const program = Effect.gen(function* () {
      const docker = yield* DockerEngine
      yield* docker.apply(plan)
    }).pipe(
      Effect.provide(
        NodeDockerEngine('/run/docker.sock', {
          async ensure(quotaRequest) {
            received.push(quotaRequest)
            throw new ProjectQuotaError('unsupported_filesystem', 'project quotas inactive')
          },
        }),
      ),
    )

    await expect(Effect.runPromise(program)).rejects.toBeDefined()
    expect(received).toEqual([
      {
        apiVersion: 'quota.gridora.dev/v1alpha1',
        action: 'ensure',
        serverId: base.serverId,
        requestedBytes: base.resources.diskGiB * 1024 * 1024 * 1024,
        mountSources: base.mounts.map((mount) => mount.source),
      },
    ])
  })
  it('rejects lexical traversal in source and target paths', () => {
    expect(() =>
      createContainerPlan({
        ...base,
        mounts: [
          {
            ...base.mounts[0],
            source: '/var/lib/gridora/servers/server-1/game/../../other/data',
          },
        ],
      }),
    ).toThrow(/non-canonical/)
    expect(() =>
      createContainerPlan({
        ...base,
        mounts: [{ ...base.mounts[0], target: '/game/../var/run/docker.sock' }],
      }),
    ).toThrow(/non-canonical/)
  })
  it('rejects an actual bind-source symlink escape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-docker-'))
    try {
      const root = join(directory, 'server')
      const outside = join(directory, 'outside')
      await mkdir(root)
      await mkdir(outside)
      await symlink(outside, join(root, 'data'))
      const canonicalRoot = await realpath(root)
      const plan = createContainerPlan(base)
      await expect(
        validateBindSources(
          {
            ...plan,
            mounts: [
              { source: join(canonicalRoot, 'data'), target: '/game/data', readOnly: false },
            ],
          },
          canonicalRoot,
          [process.getuid?.() ?? 0],
        ),
      ).rejects.toThrow(/escapes|symlink/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('rejects a bind source whose parent can be swapped after validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-docker-race-'))
    try {
      const logicalRoot = join(directory, 'server')
      await mkdir(logicalRoot)
      const root = await realpath(logicalRoot)
      const parent = join(root, 'writable-parent')
      const source = join(parent, 'data')
      await mkdir(source, { recursive: true })
      await chmod(parent, 0o777)
      const plan = createContainerPlan(base)
      await expect(
        validateBindSources(
          {
            ...plan,
            mounts: [{ source, target: '/game/data', readOnly: false }],
          },
          root,
          [process.getuid?.() ?? 0],
          [],
        ),
      ).rejects.toThrow(/replaced/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('adopts only a lost-create container with exact signed labels and image', () => {
    const plan = createContainerPlan(base)
    const body = dockerCreateBody(plan)
    expect(
      canAdoptContainer(
        {
          Config: {
            Image: plan.image,
            User: plan.user,
            Labels: plan.labels,
            ExposedPorts: body.ExposedPorts,
          },
          HostConfig: body.HostConfig,
        },
        plan,
      ),
    ).toBe(true)
    expect(
      canAdoptContainer(
        {
          Config: {
            Image: plan.image,
            User: plan.user,
            Labels: { ...plan.labels, 'dev.gridora.server': 'foreign' },
            ExposedPorts: body.ExposedPorts,
          },
          HostConfig: body.HostConfig,
        },
        plan,
      ),
    ).toBe(false)
    expect(
      canAdoptContainer(
        {
          Config: {
            Image: plan.image,
            User: plan.user,
            Labels: plan.labels,
            ExposedPorts: body.ExposedPorts,
          },
          HostConfig: {
            ...(body.HostConfig as Record<string, unknown>),
            LogConfig: { Type: 'json-file', Config: {} },
          },
        },
        plan,
      ),
    ).toBe(false)
    expect(
      canAdoptContainer(
        {
          Config: { Image: plan.image, User: plan.user, Labels: plan.labels, ExposedPorts: {} },
          HostConfig: body.HostConfig,
        },
        plan,
      ),
    ).toBe(false)
    expect(canAdoptNetwork({ Internal: false, Attachable: false, Labels: plan.labels }, plan)).toBe(
      true,
    )
    expect(canAdoptNetwork({ Internal: true, Attachable: false, Labels: plan.labels }, plan)).toBe(
      false,
    )
    expect(
      canAdoptNetwork(
        {
          Internal: false,
          Attachable: false,
          Labels: { ...plan.labels, 'dev.gridora.organization': 'foreign' },
        },
        plan,
      ),
    ).toBe(false)
  })
})
