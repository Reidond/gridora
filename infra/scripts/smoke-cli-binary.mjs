#!/usr/bin/env node
// Build the packaged Gridora CLI with its tsdown build and prove that the
// emitted binary starts on the current platform. The smoke runs from an empty
// working directory with an empty configuration directory, so it reads no
// profile, credential store, or network endpoint.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cliDirectory = join(root, 'apps', 'cli')
const binary = join(cliDirectory, 'dist', 'main.mjs')
const { version } = JSON.parse(readFileSync(join(cliDirectory, 'package.json'), 'utf8'))

const fail = (message) => {
  process.stderr.write(`cli smoke failed: ${message}\n`)
  process.exit(1)
}

const build = spawnSync('pnpm', ['--filter', '@gridora/cli', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (build.status !== 0) fail(`tsdown build exited with ${build.status}`)

const workingDirectory = mkdtempSync(join(tmpdir(), 'gridora-cli-smoke-'))
try {
  const run = (flag) => {
    const result = spawnSync(process.execPath, [binary, flag], {
      cwd: workingDirectory,
      encoding: 'utf8',
      env: { ...process.env, GRIDORA_CONFIG_DIR: join(workingDirectory, 'config') },
      timeout: 30_000,
    })
    if (result.error !== undefined) fail(`${flag} could not start: ${result.error.message}`)
    if (result.status !== 0) fail(`${flag} exited with ${result.status}: ${result.stderr.trim()}`)
    return result.stdout
  }

  const reportedVersion = run('--version').trim()
  if (reportedVersion !== version)
    fail(`--version printed ${JSON.stringify(reportedVersion)}, expected ${version}`)
  const help = run('--help')
  if (!help.startsWith('gridora <auth|') || !help.includes('gridora --version'))
    fail('--help did not print the command summary')
  process.stdout.write(`cli smoke passed: ${process.platform} gridora ${version}\n`)
} finally {
  rmSync(workingDirectory, { recursive: true, force: true })
}
