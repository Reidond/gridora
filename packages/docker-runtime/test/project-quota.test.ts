import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createProjectQuotaHelper,
  createProjectQuotaHttpServer,
  makeProjectQuotaClient,
  prepareProjectQuotaFilesystem,
  PROJECT_QUOTA_API_VERSION,
  type ProjectQuotaProof,
  type QuotaCommandRunner,
} from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const quotaHeader =
  'Project,BlockStatus,FileStatus,BlockUsed,BlockSoftLimit,BlockHardLimit,BlockGrace,FileUsed,FileSoftLimit,FileHardLimit,FileGrace'

const fixture = async (readback: 'exact' | 'wrong-project' | 'weaker' | 'missing' = 'exact') => {
  const logicalDirectory = await mkdtemp(join(tmpdir(), 'gridora-quota-'))
  temporaryDirectories.push(logicalDirectory)
  const directory = await realpath(logicalDirectory)
  const serversRoot = join(directory, 'servers')
  const backingFile = join(directory, 'gridora-servers.ext4')
  await mkdir(serversRoot, { mode: 0o750 })
  const calls: Array<{ command: string; args: readonly string[] }> = []
  let lastProjectId = ''
  let lastHardKiB = ''
  const commandRunner: QuotaCommandRunner = {
    async run(command, args) {
      calls.push({ command, args: [...args] })
      if (command === '/usr/bin/findmnt')
        return JSON.stringify({
          filesystems: [
            {
              target: serversRoot,
              source: '/dev/loop7',
              fstype: 'ext4',
              options: 'rw,prjquota',
            },
          ],
        })
      if (command === '/usr/sbin/losetup')
        return JSON.stringify({
          loopdevices: [{ name: '/dev/loop7', 'back-file': backingFile }],
        })
      if (command === '/usr/sbin/setquota') {
        lastProjectId = args[1] ?? ''
        lastHardKiB = args[3] ?? ''
      }
      if (command === '/usr/sbin/repquota') {
        if (readback === 'missing') return `${quotaHeader}\n`
        const projectId =
          readback === 'wrong-project' ? String(Number(lastProjectId) + 1) : lastProjectId
        const hardKiB =
          readback === 'weaker' ? String(Math.max(1, Number(lastHardKiB) / 2)) : lastHardKiB
        return `${quotaHeader}\n#${projectId},ok,ok,0,${hardKiB},${hardKiB},,0,0,0,\n`
      }
      if (command === '/usr/bin/lsattr')
        return `${lastProjectId} --------------e----P-- ${args.at(-1) ?? ''}\n`
      return ''
    },
  }
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const helper = createProjectQuotaHelper({
    serversRoot,
    backingFile,
    statePath: join(directory, 'quota', 'projects.json'),
    commandRunner,
    rootUid: uid,
    trustedGid: gid,
    dataUid: uid,
    dataGid: gid,
  })
  return { directory, serversRoot, helper, calls, uid, gid }
}

const request = (serversRoot: string, serverId = 'server-1', requestedBytes = 1024 * 1024) => ({
  apiVersion: PROJECT_QUOTA_API_VERSION,
  action: 'ensure' as const,
  serverId,
  requestedBytes,
  mountSources: [join(serversRoot, serverId, 'data'), join(serversRoot, serverId, 'mods')],
})

describe('root project quota helper', () => {
  it('creates non-replaceable roots and invokes only the fixed project-quota commands', async () => {
    const { directory, serversRoot, helper, calls, uid, gid } = await fixture()
    const proof = await helper.ensure(request(serversRoot))

    expect(proof).toEqual({
      apiVersion: PROJECT_QUOTA_API_VERSION,
      enforced: true,
      method: 'ext4-project-quota',
      serverId: 'server-1',
      projectId: 1_000_000_000,
      hardBytes: 1024 * 1024,
      root: join(serversRoot, 'server-1'),
    })
    const rootMetadata = await lstat(proof.root)
    const leafMetadata = await lstat(join(proof.root, 'data'))
    expect(rootMetadata.uid).toBe(uid)
    expect(rootMetadata.gid).toBe(gid)
    expect(rootMetadata.mode & 0o777).toBe(0o750)
    expect(leafMetadata.mode & 0o777).toBe(0o770)
    expect(calls.map(({ command }) => command)).toEqual([
      '/usr/bin/findmnt',
      '/usr/sbin/losetup',
      '/usr/bin/chattr',
      '/usr/bin/find',
      '/usr/sbin/setquota',
      '/usr/sbin/repquota',
      '/usr/bin/lsattr',
    ])
    expect(calls.find(({ command }) => command === '/usr/sbin/setquota')?.args).toEqual([
      '-P',
      '1000000000',
      '1024',
      '1024',
      '0',
      '0',
      serversRoot,
    ])
    expect(JSON.parse(await readFile(join(directory, 'quota', 'projects.json'), 'utf8'))).toEqual({
      version: 1,
      nextProjectId: 1_000_000_001,
      servers: { 'server-1': { projectId: 1_000_000_000, requestedBytes: 1024 * 1024 } },
    })
  })

  it('serializes allocations and keeps a stable, collision-free project ID', async () => {
    const { serversRoot, helper } = await fixture()
    const [first, second] = await Promise.all([
      helper.ensure(request(serversRoot, 'server-1')),
      helper.ensure(request(serversRoot, 'server-2')),
    ])
    const replay = await helper.ensure(request(serversRoot, 'server-1', 2 * 1024 * 1024))

    expect(first.projectId).toBe(1_000_000_000)
    expect(second.projectId).toBe(1_000_000_001)
    expect(replay.projectId).toBe(first.projectId)
    expect(replay.hardBytes).toBe(2 * 1024 * 1024)
  })

  it('rejects symlink mount sources before allocating a project ID', async () => {
    const { directory, serversRoot, helper } = await fixture()
    const serverRoot = join(serversRoot, 'server-1')
    const outside = join(directory, 'outside')
    await mkdir(serverRoot, { mode: 0o750 })
    await mkdir(outside)
    await symlink(outside, join(serverRoot, 'data'))

    await expect(helper.ensure(request(serversRoot))).rejects.toMatchObject({
      code: 'unsafe_path',
    })
  })

  it('fails closed unless ext4 project quotas are active on the mount', async () => {
    const { directory, serversRoot, uid, gid } = await fixture()
    const helper = createProjectQuotaHelper({
      serversRoot,
      statePath: join(directory, 'quota-disabled', 'projects.json'),
      commandRunner: {
        async run() {
          return JSON.stringify({
            filesystems: [
              {
                target: serversRoot,
                source: '/dev/loop7',
                fstype: 'ext4',
                options: 'rw,relatime',
              },
            ],
          })
        },
      },
      backingFile: join(directory, 'gridora-servers.ext4'),
      rootUid: uid,
      trustedGid: gid,
      dataUid: uid,
      dataGid: gid,
    })

    await expect(helper.ensure(request(serversRoot))).rejects.toMatchObject({
      code: 'unsupported_filesystem',
    })
  })

  it.each(['wrong-project', 'weaker', 'missing'] as const)(
    'does not claim enforcement for a %s quota readback',
    async (readback) => {
      const { serversRoot, helper } = await fixture(readback)
      await expect(helper.ensure(request(serversRoot))).rejects.toMatchObject({
        code: 'command_failed',
      })
    },
  )

  it('rejects nested or traversal-controlled bind roots', async () => {
    const { serversRoot, helper } = await fixture()
    await expect(
      helper.ensure({
        ...request(serversRoot),
        mountSources: [join(serversRoot, 'server-1', 'nested', 'data')],
      }),
    ).rejects.toMatchObject({ code: 'unsafe_path' })
  })
})

describe('project quota filesystem setup', () => {
  it('formats offline, mounts the dedicated file, and secures the shared root', async () => {
    const logicalDirectory = await mkdtemp(join(tmpdir(), 'gridora-quota-filesystem-'))
    temporaryDirectories.push(logicalDirectory)
    const directory = await realpath(logicalDirectory)
    const serversRoot = join(directory, 'servers')
    const backingFile = join(directory, 'gridora-servers.ext4')
    await mkdir(serversRoot)
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    let formatted = false
    let mounted = false
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const commandRunner: QuotaCommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] })
        if (command === '/usr/bin/findmnt')
          return JSON.stringify({
            filesystems: [
              mounted
                ? {
                    target: serversRoot,
                    source: '/dev/loop7',
                    fstype: 'ext4',
                    options: 'rw,nodev,nosuid,prjquota',
                  }
                : {
                    target: directory,
                    source: '/dev/disk7',
                    fstype: 'apfs',
                    options: 'rw',
                  },
            ],
          })
        if (command === '/usr/bin/fallocate') {
          await truncate(backingFile, Number(args[1]))
          return ''
        }
        if (command === '/usr/sbin/mkfs.ext4') {
          formatted = true
          return ''
        }
        if (command === '/usr/sbin/blkid') return formatted ? 'ext4\n' : ''
        if (command === '/usr/sbin/tune2fs')
          return 'Filesystem features: has_journal quota project metadata_csum\n'
        if (command === '/usr/bin/mount') {
          mounted = true
          return ''
        }
        if (command === '/usr/sbin/losetup')
          return JSON.stringify({
            loopdevices: [{ name: '/dev/loop7', 'back-file': backingFile }],
          })
        return ''
      },
    }

    await prepareProjectQuotaFilesystem({
      serversRoot,
      backingFile,
      commandRunner,
      rootUid: uid,
      trustedGid: gid,
    })
    await prepareProjectQuotaFilesystem({
      serversRoot,
      backingFile,
      commandRunner,
      rootUid: uid,
      trustedGid: gid,
    })

    expect(formatted).toBe(true)
    expect(mounted).toBe(true)
    expect(calls.filter(({ command }) => command === '/usr/sbin/mkfs.ext4')).toHaveLength(1)
    expect(calls.filter(({ command }) => command === '/usr/bin/mount')).toHaveLength(1)
    expect(calls.find(({ command }) => command === '/usr/sbin/mkfs.ext4')?.args).toEqual([
      '-q',
      '-F',
      '-O',
      'quota,project',
      '-E',
      'nodiscard,quotatype=prjquota',
      backingFile,
    ])
    expect(calls.find(({ command }) => command === '/usr/bin/mount')?.args).toEqual([
      '-o',
      'loop,nodev,nosuid,prjquota',
      backingFile,
      serversRoot,
    ])
    expect(calls.findIndex(({ command }) => command === '/usr/sbin/e2fsck')).toBeLessThan(
      calls.findIndex(({ command }) => command === '/usr/bin/mount'),
    )
    const rootMetadata = await lstat(serversRoot)
    expect(rootMetadata.uid).toBe(uid)
    expect(rootMetadata.gid).toBe(gid)
    expect(rootMetadata.mode & 0o7777).toBe(0o750)
  })
})

describe('project quota Unix-socket protocol', () => {
  it('round-trips a strict request and enforcement proof', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-quota-socket-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'quota.sock')
    const serversRoot = '/var/lib/gridora/servers'
    const expectedRequest = request(serversRoot)
    const proof: ProjectQuotaProof = {
      apiVersion: PROJECT_QUOTA_API_VERSION,
      enforced: true,
      method: 'ext4-project-quota',
      serverId: 'server-1',
      projectId: 1_000_000_000,
      hardBytes: 1024 * 1024,
      root: '/var/lib/gridora/servers/server-1',
    }
    const server = createProjectQuotaHttpServer({
      async ensure(received) {
        expect(received).toEqual(expectedRequest)
        return proof
      },
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, resolveListen)
    })
    try {
      await expect(makeProjectQuotaClient(socketPath).ensure(expectedRequest)).resolves.toEqual(
        proof,
      )
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })

  it('rejects a response with fields outside the proof contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridora-quota-socket-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'quota.sock')
    const serversRoot = '/var/lib/gridora/servers'
    const server = createProjectQuotaHttpServer({
      async ensure() {
        return {
          apiVersion: PROJECT_QUOTA_API_VERSION,
          enforced: true,
          method: 'ext4-project-quota',
          serverId: 'server-1',
          projectId: 1_000_000_000,
          hardBytes: 1024 * 1024,
          root: '/var/lib/gridora/servers/server-1',
          ignored: true,
        } as ProjectQuotaProof
      },
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socketPath, resolveListen)
    })
    try {
      await expect(
        makeProjectQuotaClient(socketPath).ensure(request(serversRoot)),
      ).rejects.toMatchObject({ code: 'invalid_response' })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})
