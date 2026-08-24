import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { makeDurableLogSpool, type DurableLogSpoolStorage } from '../src/index.js'
import { FILE_SPOOL_LOCKING_NOTE, makeFileDurableLogSpoolStorage } from '../src/file-spool.js'

const directories: string[] = []
const now = Date.parse('2026-08-23T12:00:00.000Z')
const entry = (sequence: number, timestamp = new Date(now + sequence).toISOString()) => ({
  organizationId: 'org-a',
  nodeId: 'node-a',
  serverId: 'server-a',
  component: 'game' as const,
  level: 'info' as const,
  timestamp,
  sequence,
  message: `line ${sequence}`,
})

const directory = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'gridora-log-spool-'))
  directories.push(value)
  return value
}

const waitForFile = async (path: string): Promise<void> => {
  for (;;) {
    try {
      await readFile(path)
      return
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code !== 'ENOENT')
        throw cause
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
}

const lockRaceFixture = fileURLToPath(
  new URL('./fixtures/file-spool-lock-racer.mjs', import.meta.url),
)

afterEach(async () => {
  while (directories.length > 0) {
    const value = directories.pop()!
    await rm(value, { recursive: true, force: true })
  }
})

describe('file-backed durable log spool', () => {
  it('serializes two independent producers across one lock and keeps both records', async () => {
    const root = await directory()
    const first = makeFileDurableLogSpoolStorage({ directory: root, now: () => now })
    const second = makeFileDurableLogSpoolStorage({ directory: root, now: () => now })
    const transition = (storage: DurableLogSpoolStorage, item: unknown) =>
      storage.transact((current) =>
        Effect.gen(function* () {
          yield* Effect.sleep(15)
          return { entries: [...current, item], result: undefined }
        }),
      )
    await Promise.all([
      Effect.runPromise(transition(first, entry(1))),
      Effect.runPromise(transition(second, entry(2))),
    ])
    const persisted = await Effect.runPromise(
      first.transact((current) => Effect.succeed({ entries: current, result: current })),
    )
    expect(persisted).toHaveLength(2)
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
      ]),
    )
    expect(first.capabilities.locking).toBe(FILE_SPOOL_LOCKING_NOTE)
  })

  it('does not unlink a fresh cross-process lock after stale recovery revalidation', async () => {
    const root = await directory()
    const staleToken = 'stale-cross-process-lock-token'
    const startPath = join(root, 'racer-start')
    const replacedPath = join(root, 'racer-replaced')
    const releasePath = join(root, 'racer-release')
    let child: ReturnType<typeof spawn> | undefined
    let childExited: Promise<void> | undefined
    const storage = makeFileDurableLogSpoolStorage({
      directory: root,
      staleLockMilliseconds: 1_000,
      lockWaitMilliseconds: 1_000,
      onStaleLockRevalidatedForTest: async () => {
        await writeFile(startPath, 'replace stale lock')
        await waitForFile(replacedPath)
      },
    })
    await writeFile(
      storage.lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        processStart: null,
        token: staleToken,
        acquiredAt: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    )
    child = spawn(
      process.execPath,
      [lockRaceFixture, storage.lockPath, startPath, replacedPath, releasePath],
      { stdio: 'ignore' },
    )
    childExited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`lock race fixture exited with ${String(code)}`))
      })
    })
    try {
      await expect(
        Effect.runPromise(
          storage.transact((current) => Effect.succeed({ entries: current, result: undefined })),
        ),
      ).rejects.toMatchObject({ code: 'offline' })
      const fresh = await readFile(storage.lockPath, 'utf8')
      expect(fresh).toContain('fresh-cross-process-lock-token')
      expect(fresh).not.toContain(staleToken)
    } finally {
      await writeFile(releasePath, 'release child')
      await childExited
    }
  })

  it('recovers a crash left a complete temp file before replacing corrupt state', async () => {
    const root = await directory()
    const storage = makeFileDurableLogSpoolStorage({ directory: root, now: () => now })
    const first = entry(1)
    await Effect.runPromise(
      storage.transact(() => Effect.succeed({ entries: [first], result: undefined })),
    )
    const recovered = entry(2)
    await writeFile(
      `${storage.dataPath}.tmp-crashed-process`,
      JSON.stringify({ version: 1, entries: [recovered], updatedAt: now }),
      { mode: 0o600 },
    )
    await writeFile(storage.dataPath, '{not-json', { mode: 0o600 })
    const spool = makeDurableLogSpool(storage)
    await expect(Effect.runPromise(spool.peek(10))).resolves.toEqual([
      expect.objectContaining({ sequence: 2 }),
    ])
    await expect(readFile(storage.dataPath, 'utf8')).resolves.toContain('"sequence":2')
  })

  it('keeps the durable record until ack and redacts before bytes reach disk', async () => {
    const root = await directory()
    const fileStorage = makeFileDurableLogSpoolStorage({ directory: root, now: () => now })
    const make = () => makeDurableLogSpool(fileStorage)
    const spool = make()
    await Effect.runPromise(
      spool.append({ ...entry(1), message: 'Bearer do-not-persist', fields: { token: 'canary' } }),
    )
    const raw = await readFile(fileStorage.dataPath, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('do-not-persist')
    await expect(Effect.runPromise(spool.peek(1))).resolves.toHaveLength(1)
    await Effect.runPromise(spool.acknowledgeThrough(1))
    const restarted = make()
    await expect(Effect.runPromise(restarted.peek(1))).resolves.toHaveLength(0)
  })

  it('rejects age and record bounds without silently deleting data', async () => {
    const root = await directory()
    const ageLimited = makeDurableLogSpool(
      makeFileDurableLogSpoolStorage({
        directory: root,
        maximumAgeMilliseconds: 1_000,
        now: () => now,
      }),
    )
    await expect(
      Effect.runPromise(ageLimited.append(entry(1, new Date(now - 2_000).toISOString()))),
    ).rejects.toMatchObject({ code: 'offline' })

    const boundedRoot = await directory()
    const boundedStorage = makeFileDurableLogSpoolStorage({
      directory: boundedRoot,
      now: () => now,
    })
    const tooMany = Array.from({ length: 4_097 }, (_, index) => entry(index + 1))
    await writeFile(
      boundedStorage.dataPath,
      JSON.stringify({ version: 1, entries: tooMany, updatedAt: now }),
      { mode: 0o600 },
    )
    const boundedSpool = makeDurableLogSpool(boundedStorage)
    await expect(Effect.runPromise(boundedSpool.peek(1))).rejects.toMatchObject({ code: 'offline' })
  })

  it('rejects traversal and symlinked directories before opening state', async () => {
    const root = await directory()
    expect(() =>
      makeFileDurableLogSpoolStorage({ directory: root, fileName: '../escape' }),
    ).toThrow()
    const link = `${root}-link`
    await symlink(root, link)
    directories.push(link)
    const storage = makeFileDurableLogSpoolStorage({ directory: link })
    const spool = makeDurableLogSpool(storage)
    await expect(Effect.runPromise(spool.size)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('rejects hostile directory/file modes and an unexpected owner UID', async () => {
    const insecureDirectory = await directory()
    await chmod(insecureDirectory, 0o755)
    const insecureDirectorySpool = makeDurableLogSpool(
      makeFileDurableLogSpoolStorage({ directory: insecureDirectory }),
    )
    await expect(Effect.runPromise(insecureDirectorySpool.size)).rejects.toMatchObject({
      code: 'invalid-input',
    })

    const insecureFileDirectory = await directory()
    const insecureFileStorage = makeFileDurableLogSpoolStorage({ directory: insecureFileDirectory })
    await writeFile(insecureFileStorage.dataPath, '{}', { mode: 0o644 })
    const insecureFileSpool = makeDurableLogSpool(insecureFileStorage)
    await expect(Effect.runPromise(insecureFileSpool.size)).rejects.toMatchObject({
      code: 'invalid-input',
    })

    const wrongOwnerDirectory = await directory()
    const wrongOwnerStorage = makeFileDurableLogSpoolStorage({
      directory: wrongOwnerDirectory,
      expectedUid: (process.getuid?.() ?? 0) + 1,
    })
    const wrongOwnerSpool = makeDurableLogSpool(wrongOwnerStorage)
    await expect(Effect.runPromise(wrongOwnerSpool.size)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('rejects a precreated symlink artifact during recovery without reading its target', async () => {
    const root = await directory()
    const storage = makeFileDurableLogSpoolStorage({ directory: root, now: () => now })
    const target = `${root}-outside`
    directories.push(target)
    await writeFile(target, JSON.stringify({ version: 1, entries: [], updatedAt: now }), {
      mode: 0o600,
    })
    await writeFile(storage.dataPath, '{corrupt', { mode: 0o600 })
    await symlink(target, `${storage.dataPath}.tmp-hostile`)
    const spool = makeDurableLogSpool(storage)
    await expect(Effect.runPromise(spool.peek(1))).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(readFile(target, 'utf8')).resolves.toContain('"version":1')
  })
})
