import { describe, expect, it } from 'vitest'
import {
  assertPluginNetwork,
  isolatedJobCreateBody,
  isAdoptableIsolatedJob,
  type IsolatedJobSpec,
} from '../src/index.js'

const image = `sha256:${'a'.repeat(64)}`
const spec: IsolatedJobSpec = {
  jobId: 'operation-a',
  serverId: 'server-a',
  image,
  executable: 'steamcmd',
  arguments: ['+quit'],
  workingDirectory: '/work/game',
  environment: { HOME: '/work/state/steam', LANG: 'C.UTF-8' },
  timeoutSeconds: 30,
}

describe('isolated plugin job admission', () => {
  it('creates a fixed no-host-control container shape', () => {
    const body = isolatedJobCreateBody(spec)
    const host = body.HostConfig as Record<string, unknown>
    expect(body.User).toBe('10001:10001')
    expect(body.Image).toBe(image)
    expect(host.Privileged).toBe(false)
    expect(host.ReadonlyRootfs).toBe(true)
    expect(host.NetworkMode).toBe('gridora-plugin-egress')
    expect(host.CapDrop).toEqual(['ALL'])
    expect(host.Binds).toEqual([
      '/var/lib/gridora/servers/server-a/game:/work/game:rw',
      '/var/lib/gridora/servers/server-a/config:/work/config:ro',
      '/var/lib/gridora/servers/server-a/data:/work/data:rw',
      '/var/lib/gridora/servers/server-a/mods:/work/mods:rw',
      '/var/lib/gridora/servers/server-a/staging:/work/staging:ro',
      '/var/lib/gridora/servers/server-a/backups:/work/backups:rw',
      '/var/lib/gridora/servers/server-a/state:/work/state:rw',
    ])
    expect(JSON.stringify(body)).not.toContain('docker.sock')
    expect(JSON.stringify(body)).not.toMatch(/provider|agent[_-]?secret|credential/i)
  })

  it('rejects secret-like environment values and caller-controlled host paths', () => {
    expect(() =>
      isolatedJobCreateBody({
        ...spec,
        environment: { HOME: '/work/state', STEAM_RUNTIME: 'password=unsafe' },
      }),
    ).toThrow(/secret|unsupported/i)
    expect(() =>
      isolatedJobCreateBody({
        ...spec,
        workingDirectory: '/var/lib/gridora/servers/server-a/game',
      }),
    ).toThrow(/work|outside/i)
  })

  it('admits only an operation-bound read-only restore staging mount with a pinned image', () => {
    const restoreSpec: IsolatedJobSpec = {
      ...spec,
      jobId: 'restore-operation-a',
      image: `sha256:${'b'.repeat(64)}`,
      executable: 'gridora-game-query',
      arguments: ['validate-restore', '--root', '/work/staging/restore-restore-operation-a'],
      workingDirectory: '/work/staging/restore-restore-operation-a',
      restoreValidationBackupId: 'backup-a',
    }
    const body = isolatedJobCreateBody(restoreSpec)
    const host = body.HostConfig as Record<string, unknown>
    expect(host.Binds).toContain(
      '/var/lib/gridora/servers/.gridora-restore-server-a-backup-a:/work/staging/restore-restore-operation-a:ro',
    )
    expect(body.Image).toBe(`sha256:${'b'.repeat(64)}`)
    expect(() =>
      isolatedJobCreateBody({
        ...restoreSpec,
        restoreValidationBackupId: '../backup-a',
      } as IsolatedJobSpec),
    ).toThrow(/unsafe/i)
    expect(() =>
      isolatedJobCreateBody({
        ...restoreSpec,
        image: 'restore-validator:latest',
      } as IsolatedJobSpec),
    ).toThrow(/digest pinned/i)
    expect(() => isolatedJobCreateBody({ ...restoreSpec, workingDirectory: '/work/data' })).toThrow(
      /staging identity/i,
    )
  })

  it('does not adopt a hostile same-name container with extra host access or changed identity', () => {
    const body = isolatedJobCreateBody(spec)
    const config = {
      Image: body.Image,
      Entrypoint: body.Entrypoint,
      Cmd: body.Cmd,
      WorkingDir: body.WorkingDir,
      User: body.User,
      Env: body.Env,
      Labels: body.Labels,
    }
    const inspected = () => JSON.stringify({ Config: config, HostConfig: body.HostConfig })
    expect(isAdoptableIsolatedJob(inspected(), spec)).toBe(true)

    const host = body.HostConfig as Record<string, unknown>
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: config,
          HostConfig: {
            ...host,
            Devices: [
              { PathOnHost: '/dev/null', PathInContainer: '/dev/null', CgroupPermissions: 'r' },
            ],
          },
        }),
        spec,
      ),
    ).toBe(false)
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: config,
          HostConfig: {
            ...host,
            Mounts: [
              {
                Type: 'bind',
                Source: '/var/run/docker.sock',
                Target: '/var/run/docker.sock',
                ReadOnly: false,
              },
            ],
          },
        }),
        spec,
      ),
    ).toBe(false)
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: config,
          HostConfig: { ...host, DeviceCgroupRules: ['c 1:3 rwm'] },
        }),
        spec,
      ),
    ).toBe(false)
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: config,
          HostConfig: {
            ...host,
            PortBindings: { '2375/tcp': [{ HostIp: '0.0.0.0', HostPort: '2375' }] },
          },
        }),
        spec,
      ),
    ).toBe(false)
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: config,
          HostConfig: { ...host, RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } },
        }),
        spec,
      ),
    ).toBe(false)
    expect(
      isAdoptableIsolatedJob(
        JSON.stringify({
          Config: {
            ...config,
            Labels: {
              ...(body.Labels as Record<string, string>),
              'dev.gridora.server': 'other-server',
            },
          },
          HostConfig: host,
        }),
        spec,
      ),
    ).toBe(false)
  })

  it('requires the root-provisioned egress policy label before accepting a network', () => {
    const valid = {
      Name: 'gridora-plugin-egress',
      Labels: {
        'dev.gridora.network': 'plugin-egress',
        'dev.gridora.network-policy': 'gridora-plugin-egress-v1',
      },
      Options: { 'com.docker.network.bridge.name': 'gridora-egress0' },
      Internal: false,
      Attachable: false,
    }
    expect(() => assertPluginNetwork(JSON.stringify(valid))).not.toThrow()
    expect(() =>
      assertPluginNetwork(
        JSON.stringify({ ...valid, Labels: { 'dev.gridora.network': 'plugin-egress' } }),
      ),
    ).toThrow(/foreign|bounded/i)
  })
})

// A real Docker smoke is intentionally opt-in because it requires a prepared
// quota tree and a reviewed digest-pinned plugin image. CI runs the fixed-body
// contract above; release evidence must set GRIDORA_LIVE_DOCKER_TEST=1 and
// supply the node's prepared runtime image before enabling paid/live checks.
describe.skipIf(process.env.GRIDORA_LIVE_DOCKER_TEST !== '1')('live isolated plugin job', () => {
  it('is enabled only with an explicitly prepared Docker fixture', () => {
    expect(process.env.GRIDORA_ISOLATION_TEST_IMAGE).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})
