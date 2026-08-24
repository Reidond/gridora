import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const runCleanup = (root: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      resolve(process.cwd(), 'infra/images/clean-cloud-init-sensitive-cache'),
      [],
      { env: { ...process.env, GRIDORA_TEST_ROOT: root }, timeout: 10_000 },
      (error, _stdout, stderr) => {
        if (error === null) resolvePromise()
        else reject(new Error(`cache cleanup failed: ${stderr}`))
      },
    )
  })

describe('cloud-init sensitive cache cleanup', () => {
  it('removes cached user-data and preserves the installed reboot credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gridora-cloud-init-'))
    const instance = join(root, 'var/lib/cloud/instances/instance-a')
    const runtime = join(root, 'run/cloud-init')
    const gridora = join(root, 'etc/gridora')
    const tunnel = join(root, 'var/lib/gridora/tunnel')
    const logs = join(root, 'var/log')
    const secret = 'registration-secret-that-must-not-remain-in-cache'

    try {
      await mkdir(instance, { recursive: true })
      await mkdir(runtime, { recursive: true })
      await mkdir(gridora, { recursive: true })
      await mkdir(tunnel, { recursive: true })
      await mkdir(logs, { recursive: true })
      await writeFile(join(instance, 'user-data.txt'), `registration=${secret}\n`)
      await writeFile(join(instance, 'user-data.txt.i'), `registration=${secret}\n`)
      await writeFile(join(instance, 'obj.pkl'), `serialized=${secret}\n`)
      await writeFile(join(instance, 'sem'), 'boot-state\n')
      await writeFile(join(runtime, 'instance-data-sensitive.json'), `{"secret":"${secret}"}\n`)
      await writeFile(join(logs, 'cloud-init.log'), `write_files=${secret}\n`)
      await writeFile(join(logs, 'cloud-init-output.log'), `output=${secret}\n`)
      await writeFile(join(tunnel, 'credential'), 'installed-by-secure-channel\n')

      await runCleanup(root)

      await expect(readFile(join(instance, 'user-data.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(join(instance, 'user-data.txt.i'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(join(instance, 'obj.pkl'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        readFile(join(runtime, 'instance-data-sensitive.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(logs, 'cloud-init.log'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(join(logs, 'cloud-init-output.log'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readFile(join(instance, 'sem'), 'utf8')).toBe('boot-state\n')
      expect(await readFile(join(root, 'etc/cloud/cloud-init.disabled'), 'utf8')).toBe('')
      expect(await readFile(join(tunnel, 'credential'), 'utf8')).toBe(
        'installed-by-secure-channel\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
