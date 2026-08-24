import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  BackupArchive,
  BackupExecutor,
  BackupExecutorLive,
  type BackupPlan,
} from '@gridora/backup-runtime'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeBackupArchive } from '../src/backup-archive.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const createPlans = async () => {
  const trustedRoot = await mkdtemp(join(tmpdir(), 'gridora-backup-'))
  temporary.push(trustedRoot)
  const sourceRoot = join(trustedRoot, 'source')
  const targetRoot = join(trustedRoot, 'target')
  const archivePath = join(sourceRoot, 'backups', 'backup-1.tar.zst')
  await mkdir(join(sourceRoot, 'config'), { recursive: true })
  await mkdir(join(sourceRoot, 'data'), { recursive: true })
  await writeFile(join(sourceRoot, 'config', 'server.json'), '{"name":"Gridora"}\n')
  await writeFile(join(sourceRoot, 'data', 'world.db'), 'world-state')
  const create: BackupPlan = {
    mode: 'create',
    serverRoot: sourceRoot,
    stagingDirectory: join(sourceRoot, 'backups', 'backup-1.partial'),
    archivePath,
    includes: [join(sourceRoot, 'config'), join(sourceRoot, 'data')],
    diskBytes: 1024 * 1024,
  }
  return { trustedRoot, sourceRoot, targetRoot, archivePath, create }
}

const checksum = async (path: string) =>
  `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`

const restorePlan = (
  trustedRoot: string,
  targetRoot: string,
  archivePath: string,
  expectedSha256: string,
): BackupPlan => ({
  mode: 'restore',
  serverRoot: targetRoot,
  stagingDirectory: join(trustedRoot, '.gridora-restore-target-backup-1'),
  archivePath,
  includes: ['config', 'data'],
  expectedSha256,
  atomicTarget: targetRoot,
  diskBytes: 1024 * 1024,
})

const runCreate = (trustedRoot: string, plan: BackupPlan) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* BackupExecutor).create(plan)).sha256
    }).pipe(Effect.provide(BackupExecutorLive.pipe(Layer.provide(NodeBackupArchive(trustedRoot))))),
  )

const runRestore = (trustedRoot: string, plan: BackupPlan) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* BackupExecutor).restore(plan)
    }).pipe(Effect.provide(BackupExecutorLive.pipe(Layer.provide(NodeBackupArchive(trustedRoot))))),
  )

const restoreExecutor = (trustedRoot: string) =>
  Effect.runSync(
    Effect.service(BackupExecutor).pipe(
      Effect.provide(BackupExecutorLive.pipe(Layer.provide(NodeBackupArchive(trustedRoot)))),
    ),
  )

const octal = (value: number, length: number) =>
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii')
const rawArchive = (
  path: string,
  entries: ReadonlyArray<{
    readonly path: string
    readonly type: string
    readonly content?: Buffer
  }>,
) => {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 100, 'utf8')
    octal(0o600, 8).copy(header, 100)
    octal(0, 8).copy(header, 108)
    octal(0, 8).copy(header, 116)
    octal(content.length, 12).copy(header, 124)
    octal(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header.write(entry.type, 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    octal(
      [...header].reduce((total, byte) => total + byte, 0),
      8,
    ).copy(header, 148)
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return writeFile(path, zstdCompressSync(Buffer.concat(blocks)), {
    mode: 0o600,
  })
}
const maliciousArchive = (path: string, entryPath: string, type: string) =>
  rawArchive(path, [{ path: entryPath, type }])

describe('NodeBackupArchive', () => {
  it('creates a deterministic archive and restores it through atomic cutover', async () => {
    const plans = await createPlans()
    const first = await runCreate(plans.trustedRoot, plans.create)
    const firstBytes = await readFile(plans.archivePath)
    const second = await runCreate(plans.trustedRoot, plans.create)
    expect(second).toBe(first)
    expect(await readFile(plans.archivePath)).toEqual(firstBytes)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'old')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, first)
    await runRestore(plans.trustedRoot, plan)
    expect(await readFile(join(plans.targetRoot, 'config', 'server.json'), 'utf8')).toContain(
      'Gridora',
    )
    expect(await readFile(join(plans.targetRoot, 'data', 'world.db'), 'utf8')).toBe('world-state')
    expect(await stat(join(plans.targetRoot, 'backups', basename(plans.archivePath)))).toBeDefined()
  })

  it('retains the exact rollback tree until terminal finalize and compensates validation failure', async () => {
    const plans = await createPlans()
    const digest = await runCreate(plans.trustedRoot, plans.create)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'source-state')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digest)
    const executor = restoreExecutor(plans.trustedRoot)
    await Effect.runPromise(executor.stageRestore(plan))
    // Plugin validation happens against staging before the active tree moves.
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('source-state')
    await Effect.runPromise(executor.commitRestore(plan))
    const rollback = `${plans.targetRoot}.rollback-${basename(plan.stagingDirectory)}`
    expect(await readFile(join(rollback, 'old.txt'), 'utf8')).toBe('source-state')
    await Effect.runPromise(executor.rollbackRestore(plan))
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('source-state')

    await Effect.runPromise(executor.stageRestore(plan))
    await Effect.runPromise(executor.commitRestore(plan))
    expect(await readFile(join(rollback, 'old.txt'), 'utf8')).toBe('source-state')
    await Effect.runPromise(executor.finalizeRestore(plan))
    await expect(stat(rollback)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects corruption before extraction or cutover', async () => {
    const plans = await createPlans()
    const digest = await runCreate(plans.trustedRoot, plans.create)
    const bytes = await readFile(plans.archivePath)
    const corruptAt = Math.floor(bytes.length / 2)
    bytes[corruptAt] = (bytes[corruptAt] ?? 0) ^ 0xff
    await writeFile(plans.archivePath, bytes)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'preserved')
    await expect(
      runRestore(
        plans.trustedRoot,
        restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digest),
      ),
    ).rejects.toBeDefined()
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('preserved')
  })

  it('rejects a symlink in the source tree during archive creation', async () => {
    const plans = await createPlans()
    await symlink('/etc/passwd', join(plans.sourceRoot, 'data', 'escape'))
    await expect(runCreate(plans.trustedRoot, plans.create)).rejects.toBeDefined()
    await expect(stat(plans.archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['../escape', '0'],
    ['/absolute', '0'],
    ['data/link', '2'],
    ['data/hard', '1'],
    ['data/device', '3'],
  ])('rejects malicious archive entry %s of type %s before cutover', async (entryPath, type) => {
    const plans = await createPlans()
    await mkdir(join(plans.sourceRoot, 'backups'), { recursive: true })
    await maliciousArchive(plans.archivePath, entryPath, type)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'preserved')
    await expect(
      runRestore(
        plans.trustedRoot,
        restorePlan(
          plans.trustedRoot,
          plans.targetRoot,
          plans.archivePath,
          await checksum(plans.archivePath),
        ),
      ),
    ).rejects.toBeDefined()
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('preserved')
  })

  it('recovers an interrupted cutover and is idempotent after restart', async () => {
    const plans = await createPlans()
    const digest = await runCreate(plans.trustedRoot, plans.create)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'old')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digest)
    const layer = NodeBackupArchive(plans.trustedRoot)
    const inventory = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* BackupArchive
        yield* archive.checksum(plan)
        const entries = yield* archive.enumerate(plan)
        yield* archive.extractToStaging(plan, entries)
        return entries
      }).pipe(Effect.provide(layer)),
    )
    expect(inventory.length).toBeGreaterThan(0)
    const rollback = `${plans.targetRoot}.rollback-${basename(plan.stagingDirectory)}`
    await rename(plans.targetRoot, rollback)
    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* BackupArchive
        yield* archive.commitRestore(plan)
        yield* archive.commitRestore(plan)
      }).pipe(Effect.provide(layer)),
    )
    expect(await readFile(join(plans.targetRoot, 'data', 'world.db'), 'utf8')).toBe('world-state')
    expect(await readFile(join(rollback, 'old.txt'), 'utf8')).toBe('old')
  })

  it('fails before cutover when staging is missing and preserves the active target', async () => {
    const plans = await createPlans()
    const digest = await runCreate(plans.trustedRoot, plans.create)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'preserved')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digest)
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* BackupArchive).commitRestore(plan)
        }).pipe(Effect.provide(NodeBackupArchive(plans.trustedRoot))),
      ),
    ).rejects.toBeDefined()
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('preserved')
  })

  it('rolls the active target back if staging disappears after the first rename', async () => {
    const plans = await createPlans()
    const digest = await runCreate(plans.trustedRoot, plans.create)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'preserved')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digest)
    const rollback = `${plans.targetRoot}.rollback-${basename(plan.stagingDirectory)}`
    await rename(plans.targetRoot, rollback)
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* BackupArchive).commitRestore(plan)
        }).pipe(Effect.provide(NodeBackupArchive(plans.trustedRoot))),
      ),
    ).rejects.toBeDefined()
    expect(await readFile(join(plans.targetRoot, 'old.txt'), 'utf8')).toBe('preserved')
    await expect(stat(rollback)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses one verified snapshot when the public archive is swapped for the same inventory', async () => {
    const plans = await createPlans()
    const digestA = await runCreate(plans.trustedRoot, plans.create)
    const archiveA = await readFile(plans.archivePath)
    await writeFile(join(plans.sourceRoot, 'data', 'world.db'), 'attacker-content')
    await runCreate(plans.trustedRoot, plans.create)
    const archiveB = await readFile(plans.archivePath)
    await writeFile(plans.archivePath, archiveA)
    await mkdir(plans.targetRoot)
    await writeFile(join(plans.targetRoot, 'old.txt'), 'old')
    const plan = restorePlan(plans.trustedRoot, plans.targetRoot, plans.archivePath, digestA)
    const layer = NodeBackupArchive(plans.trustedRoot)
    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* BackupArchive
        expect(yield* archive.checksum(plan)).toBe(digestA)
        yield* Effect.promise(() => writeFile(plan.archivePath, archiveB))
        const entries = yield* archive.enumerate(plan)
        yield* archive.extractToStaging(plan, entries)
        yield* archive.commitRestore(plan)
        yield* archive.release(plan)
      }).pipe(Effect.provide(layer)),
    )
    expect(await readFile(join(plans.targetRoot, 'data', 'world.db'), 'utf8')).toBe('world-state')
  })

  it('aborts a small compressed zstd bomb before staging exhausts the disk policy', async () => {
    const plans = await createPlans()
    await mkdir(join(plans.sourceRoot, 'backups'), { recursive: true })
    await writeFile(plans.archivePath, zstdCompressSync(Buffer.alloc(32 * 1024)), { mode: 0o600 })
    const plan = {
      ...restorePlan(
        plans.trustedRoot,
        plans.targetRoot,
        plans.archivePath,
        await checksum(plans.archivePath),
      ),
      diskBytes: 1024,
    }
    await expect(runRestore(plans.trustedRoot, plan)).rejects.toBeDefined()
    await expect(stat(plan.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an archive exceeding the signed entry-count policy', async () => {
    const plans = await createPlans()
    await mkdir(join(plans.sourceRoot, 'backups'), { recursive: true })
    await rawArchive(
      plans.archivePath,
      Array.from({ length: 5 }, (_, index) => ({ path: `data/file-${index}`, type: '0' })),
    )
    const plan = {
      ...restorePlan(
        plans.trustedRoot,
        plans.targetRoot,
        plans.archivePath,
        await checksum(plans.archivePath),
      ),
      diskBytes: 2048,
    }
    await expect(runRestore(plans.trustedRoot, plan)).rejects.toBeDefined()
  })

  it.each([
    { label: 'compressed bytes', compressed: Buffer.alloc(1025), entries: undefined },
    {
      label: 'per-entry bytes',
      compressed: undefined,
      entries: [{ path: 'data/large', type: '0', content: Buffer.alloc(2049) }],
    },
    {
      label: 'aggregate bytes',
      compressed: undefined,
      entries: [
        { path: 'data/one', type: '0', content: Buffer.alloc(1200) },
        { path: 'data/two', type: '0', content: Buffer.alloc(1200) },
      ],
    },
  ])('rejects an archive exceeding signed $label limits', async ({ compressed, entries }) => {
    const plans = await createPlans()
    await mkdir(join(plans.sourceRoot, 'backups'), { recursive: true })
    if (compressed !== undefined) await writeFile(plans.archivePath, compressed)
    else await rawArchive(plans.archivePath, entries ?? [])
    const plan = {
      ...restorePlan(
        plans.trustedRoot,
        plans.targetRoot,
        plans.archivePath,
        await checksum(plans.archivePath),
      ),
      diskBytes: 1024,
    }
    await expect(runRestore(plans.trustedRoot, plan)).rejects.toBeDefined()
  })
})
