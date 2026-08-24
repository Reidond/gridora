import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helper = resolve(process.cwd(), 'infra/images/gridora-plugin-egress-lease')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const run = async (request: unknown, mode: 'missing' | 'exists' = 'missing') => {
  const root = await mkdtemp(join(tmpdir(), 'gridora-egress-helper-'))
  roots.push(root)
  const nft = join(root, 'nft')
  const log = join(root, 'nft.log')
  await writeFile(
    nft,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"$GRIDORA_TEST_NFT_LOG"\nif [ "$1" = get ] && [ "$GRIDORA_TEST_NFT_MODE" = missing ]; then exit 1; fi\n`,
  )
  await chmod(nft, 0o700)
  const child = spawn(helper, [], {
    env: {
      ...process.env,
      GRIDORA_TEST_NFT_COMMAND: nft,
      GRIDORA_TEST_NFT_LOG: log,
      GRIDORA_TEST_NFT_MODE: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.end(`${JSON.stringify(request)}\n`)
  const code = await new Promise<number | null>((resolveCode) => child.on('close', resolveCode))
  const commands = await readFile(log, 'utf8').catch(() => '')
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    commands,
  }
}

const request = (action: 'acquire' | 'release', address = '93.184.216.34') => ({
  schemaVersion: 1,
  action,
  leaseId: 'operation-a',
  entries: [
    { address, protocol: 'tcp', port: 443 },
    { address, protocol: 'udp', port: 27_015 },
  ],
})

describe('root-owned plugin egress lease helper', () => {
  it('adds exact interface, address, protocol, and port tuples with a bounded timeout', async () => {
    const result = await run(request('acquire'))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      leaseId: 'operation-a',
      applied: true,
    })
    expect(result.commands).toContain(
      'add element inet gridora permitted_game_egress_v4 { "gridora-egress0" . 93.184.216.34 . tcp . 443 timeout 65m }',
    )
    expect(result.commands).toContain(
      'add element inet gridora permitted_game_egress_v4 { "gridora-egress0" . 93.184.216.34 . udp . 27015 timeout 65m }',
    )
  })

  it('deletes only an existing exact tuple and rejects private or excess request fields', async () => {
    const released = await run(request('release'), 'exists')
    expect(released.code).toBe(0)
    expect(released.commands).toContain('delete element inet gridora permitted_game_egress_v4')

    const privateResult = await run(request('acquire', '127.0.0.1'))
    expect(privateResult.code).not.toBe(0)
    expect(privateResult.commands).toBe('')
    const excessResult = await run({ ...request('acquire'), hostname: 'example.com' })
    expect(excessResult.code).not.toBe(0)
    expect(excessResult.commands).toBe('')
  })
})
