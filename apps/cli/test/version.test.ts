import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runNodeCli } from '../src/node-runtime.js'

const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly version: string
  }
).version

describe('CLI version and help', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the package version without touching credentials or the network', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const fetch = vi.spyOn(globalThis, 'fetch')

    await expect(runNodeCli(['--version'])).resolves.toBe(0)

    expect(write).toHaveBeenCalledWith(`${packageVersion}\n`)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lists the version flag in help output', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(runNodeCli(['--help'])).resolves.toBe(0)

    expect(String(write.mock.calls[0]?.[0])).toContain('gridora --version')
  })

  it('rejects an invalid profile before printing the version', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const writeError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(runNodeCli(['--profile', '../x', '--version'])).resolves.toBe(2)

    expect(write).not.toHaveBeenCalledWith(`${packageVersion}\n`)
    expect(String(writeError.mock.calls[0]?.[0])).toContain('invalid_profile')
  })
})
