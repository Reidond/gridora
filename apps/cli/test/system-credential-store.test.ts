import { describe, expect, it, vi } from 'vitest'
import {
  makeSystemCredentialStore,
  powerShellLiteral,
  windowsVaultScript,
} from '../src/node-runtime.js'

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
    const store = makeSystemCredentialStore('freebsd', adapter)

    await expect(store.set('default', 'refresh-secret')).rejects.toMatchObject({
      code: 'keychain_unavailable',
    })
    expect(adapter.run).not.toHaveBeenCalled()
    expect(adapter.runWithInput).not.toHaveBeenCalled()
  })
})

describe('Windows credential vault', () => {
  const powerShellPrefix = ['-NoProfile', '-NonInteractive', '-Command'] as const
  const encodedSecret = Buffer.from('refresh-secret', 'utf8').toString('base64')
  const missingItem = Object.assign(new Error('Command failed'), { code: 44 })
  const vaultError = Object.assign(new Error('Command failed'), { code: 1 })
  const powerShellAbsent = Object.assign(new Error('spawn powershell.exe ENOENT'), {
    code: 'ENOENT',
  })

  it('reads the vault through Windows PowerShell with the exact WinRT script', async () => {
    const adapter = processAdapter()
    adapter.run.mockResolvedValueOnce(encodedSecret)
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.get('ops')).resolves.toBe('refresh-secret')

    expect(adapter.run).toHaveBeenCalledTimes(1)
    expect(adapter.run).toHaveBeenCalledWith('powershell.exe', [
      ...powerShellPrefix,
      [
        "$ErrorActionPreference = 'Stop'",
        '[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null',
        '$vault = New-Object Windows.Security.Credentials.PasswordVault',
        "$resource = 'dev.gridora.cli'",
        "$account = 'ops'",
        'try { $credential = $vault.Retrieve($resource, $account) } catch { $missing = -2147023728; if ($_.Exception.HResult -eq $missing -or $_.Exception.InnerException.HResult -eq $missing) { exit 44 }; exit 1 }',
        '$credential.RetrievePassword()',
        '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credential.Password)))',
      ].join('; '),
    ])
    expect(adapter.runWithInput).not.toHaveBeenCalled()
  })

  it('stores the token only through standard input as base64 UTF-8', async () => {
    const adapter = processAdapter()
    adapter.runWithInput.mockResolvedValueOnce('')
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.set('ops', 'refresh-secret')).resolves.toBeUndefined()

    expect(adapter.runWithInput).toHaveBeenCalledWith(
      'powershell.exe',
      [...powerShellPrefix, windowsVaultScript('set', 'ops')],
      `${encodedSecret}\n`,
    )
    const args = adapter.runWithInput.mock.calls[0]?.[1]?.join(' ')
    expect(args).not.toContain('refresh-secret')
    expect(args).not.toContain(encodedSecret)
    expect(windowsVaultScript('set', 'ops')).toContain("$encoded = (@($input) -join '').Trim()")
    expect(windowsVaultScript('set', 'ops')).toContain(
      '$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $account, $password)))',
    )
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it('removes the vault item for the validated profile', async () => {
    const adapter = processAdapter()
    adapter.run.mockResolvedValueOnce('')
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.remove('ops')).resolves.toBeUndefined()

    expect(adapter.run).toHaveBeenCalledWith('powershell.exe', [
      ...powerShellPrefix,
      windowsVaultScript('remove', 'ops'),
    ])
    expect(windowsVaultScript('remove', 'ops')).toMatch(
      /\$vault\.Retrieve\(\$resource, \$account\).*exit 44.*; \$vault\.Remove\(\$credential\)$/,
    )
  })

  it('treats only the Element-not-found exit as a missing item', async () => {
    const adapter = processAdapter()
    adapter.run.mockRejectedValue(missingItem)
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.get('ops')).resolves.toBeUndefined()
    await expect(store.remove('ops')).resolves.toBeUndefined()
    expect(windowsVaultScript('get', 'ops')).toContain('$missing = -2147023728')
  })

  it('fails closed with keychain failure codes when the vault reports an error', async () => {
    const adapter = processAdapter()
    adapter.run.mockRejectedValue(vaultError)
    adapter.runWithInput.mockRejectedValue(vaultError)
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.get('ops')).rejects.toMatchObject({
      code: 'keychain_read_failed',
      exitCode: 3,
    })
    await expect(store.set('ops', 'refresh-secret')).rejects.toMatchObject({
      code: 'keychain_write_failed',
      exitCode: 3,
    })
    await expect(store.remove('ops')).rejects.toMatchObject({
      code: 'keychain_delete_failed',
      exitCode: 3,
    })
  })

  it('fails closed as unavailable when Windows PowerShell is absent', async () => {
    const adapter = processAdapter()
    adapter.run.mockRejectedValue(powerShellAbsent)
    adapter.runWithInput.mockRejectedValue(powerShellAbsent)
    const store = makeSystemCredentialStore('win32', adapter)

    await expect(store.get('ops')).rejects.toMatchObject({
      code: 'keychain_unavailable',
      exitCode: 3,
    })
    await expect(store.set('ops', 'refresh-secret')).rejects.toMatchObject({
      code: 'keychain_unavailable',
      exitCode: 3,
    })
    await expect(store.remove('ops')).rejects.toMatchObject({
      code: 'keychain_unavailable',
      exitCode: 3,
    })
  })

  it('rejects a hostile profile name before PowerShell starts', async () => {
    const adapter = processAdapter()
    const store = makeSystemCredentialStore('win32', adapter)

    for (const hostile of ["ops'; Remove-Item -Recurse C:\\", 'ops\u2019; exit 0', 'ops $env:X'])
      await expect(store.set(hostile, 'refresh-secret')).rejects.toMatchObject({
        code: 'invalid_profile',
      })
    expect(adapter.run).not.toHaveBeenCalled()
    expect(adapter.runWithInput).not.toHaveBeenCalled()
  })

  it('escapes every PowerShell single-quote form in a profile literal', () => {
    expect(powerShellLiteral('ops')).toBe("'ops'")
    expect(powerShellLiteral("ops'; Remove-Item C:\\")).toBe("'ops''; Remove-Item C:\\'")
    expect(powerShellLiteral('a\u2018b\u2019c\u201Ad\u201Be')).toBe(
      "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'",
    )
    expect(windowsVaultScript('get', "x'y")).toContain("$account = 'x''y'")
  })
})
