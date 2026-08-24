import { describe, expect, it, vi } from 'vitest'
import { makeSystemCredentialStore } from '../src/node-runtime.js'

const processAdapter = () => ({
  run: vi.fn<(file: string, args: ReadonlyArray<string>) => Promise<string>>(),
  runWithInput:
    vi.fn<(file: string, args: ReadonlyArray<string>, input: string) => Promise<string>>(),
})

describe('system credential store', () => {
  it('reads, writes, and removes macOS Keychain credentials without plaintext arguments', async () => {
    const adapter = processAdapter()
    adapter.run.mockResolvedValueOnce(Buffer.from('refresh-secret').toString('base64'))
    adapter.runWithInput.mockResolvedValue('')
    adapter.run.mockResolvedValueOnce('')
    const store = makeSystemCredentialStore('darwin', adapter)

    await expect(store.get('default')).resolves.toBe('refresh-secret')
    await expect(store.set('default', 'refresh-secret')).resolves.toBeUndefined()
    await expect(store.remove('default')).resolves.toBeUndefined()

    expect(adapter.run).toHaveBeenNthCalledWith(1, '/usr/bin/security', [
      'find-generic-password',
      '-s',
      'dev.gridora.cli',
      '-a',
      'default',
      '-w',
    ])
    expect(adapter.runWithInput).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['-i'],
      expect.stringContaining(Buffer.from('refresh-secret').toString('base64')),
    )
    expect(adapter.runWithInput.mock.calls[0]?.[1]).not.toContain('refresh-secret')
  })

  it('uses Secret Service on Linux and sends the token only through standard input', async () => {
    const adapter = processAdapter()
    adapter.run.mockResolvedValueOnce('refresh-secret').mockResolvedValueOnce('')
    adapter.runWithInput.mockResolvedValue('')
    const store = makeSystemCredentialStore('linux', adapter)

    await expect(store.get('ops')).resolves.toBe('refresh-secret')
    await expect(store.set('ops', 'refresh-secret')).resolves.toBeUndefined()
    await expect(store.remove('ops')).resolves.toBeUndefined()

    expect(adapter.runWithInput).toHaveBeenCalledWith(
      'secret-tool',
      ['store', '--label=Gridora CLI', 'service', 'dev.gridora.cli', 'account', 'ops'],
      'refresh-secret',
    )
    expect(adapter.runWithInput.mock.calls[0]?.[1]).not.toContain('refresh-secret')
  })

  it('treats missing operating-system credentials as an empty store', async () => {
    const macAdapter = processAdapter()
    macAdapter.run.mockRejectedValue({ code: 44 })
    const linuxAdapter = processAdapter()
    linuxAdapter.run.mockRejectedValue({ code: 1 })

    await expect(makeSystemCredentialStore('darwin', macAdapter).get('default')).resolves.toBe(
      undefined,
    )
    await expect(makeSystemCredentialStore('linux', linuxAdapter).get('default')).resolves.toBe(
      undefined,
    )
  })

  it('rejects unsafe profile names before invoking a credential process', async () => {
    const adapter = processAdapter()
    const store = makeSystemCredentialStore('linux', adapter)

    await expect(store.get('../default')).rejects.toMatchObject({ code: 'invalid_profile' })
    expect(adapter.run).not.toHaveBeenCalled()
    expect(adapter.runWithInput).not.toHaveBeenCalled()
  })

  it('fails closed when the platform has no supported credential store', async () => {
    const adapter = processAdapter()
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.set('default', 'refresh-secret')).rejects.toMatchObject({
      code: 'keychain_unavailable',
    })
    expect(adapter.run).not.toHaveBeenCalled()
    expect(adapter.runWithInput).not.toHaveBeenCalled()
  })
})
