import { constants as fsConstants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { AgentUpdateManifest, canonicalJson } from '@gridora/agent-protocol'
import { Schema } from 'effect'
import { AGENT_UPDATE_CURRENT_LINK } from './agent-update-helper.js'
import { AGENT_UPDATE_HEALTH_PATH } from './self-update.js'

const HEALTH_API_VERSION = 'agent-update-health.gridora.dev/v1alpha1' as const
const MAX_RELEASE_BYTES = 8 * 1024

export interface AgentUpdateHealthPaths {
  readonly currentLink: string
  readonly healthPath: string
}

export const productionAgentUpdateHealthPaths: AgentUpdateHealthPaths = {
  currentLink: AGENT_UPDATE_CURRENT_LINK,
  healthPath: AGENT_UPDATE_HEALTH_PATH,
}

const mode = (value: number) => value & 0o7777
const safePath = (path: string) =>
  path.startsWith('/') && resolve(path) === path && !path.includes('\0')

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Writes a fixed-path, agent-owned readiness receipt after the new process has
 * initialized. The root helper accepts only this exact schema and release
 * tuple; an agent does not receive a root-owned activation path.
 */
export const markAgentUpdateHealthy = async (
  paths: AgentUpdateHealthPaths = productionAgentUpdateHealthPaths,
  now: () => Date = () => new Date(),
): Promise<boolean> => {
  if (
    !safePath(paths.currentLink) ||
    !safePath(paths.healthPath) ||
    dirname(paths.healthPath) === '/' ||
    !paths.currentLink.endsWith('/current') ||
    !paths.healthPath.endsWith('/health/receipt.json')
  )
    return false
  const releasePath = join(paths.currentLink, 'release.json')
  try {
    const link = await lstat(paths.currentLink)
    if (!link.isSymbolicLink()) return false
    const release = await lstat(releasePath)
    if (
      !release.isFile() ||
      release.isSymbolicLink() ||
      release.size < 1 ||
      release.size > MAX_RELEASE_BYTES
    )
      return false
    const manifest = await Schema.decodeUnknownPromise(AgentUpdateManifest, {
      onExcessProperty: 'error',
    })(JSON.parse(await readFile(releasePath, 'utf8')) as unknown)
    const receipt = Buffer.from(
      `${canonicalJson({
        apiVersion: HEALTH_API_VERSION,
        version: manifest.version,
        digest: manifest.source.sha256,
        startedAt: now().toISOString(),
      })}\n`,
      'utf8',
    )
    const directory = dirname(paths.healthPath)
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(receipt)
      await handle.sync()
      await handle.chmod(0o600)
      const metadata = await handle.stat()
      if (
        !metadata.isFile() ||
        mode(metadata.mode) !== 0o600 ||
        metadata.uid !== process.getuid?.()
      )
        return false
      await handle.close()
      handle = undefined
      await rename(temporary, paths.healthPath)
      await syncDirectory(directory)
      return true
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  } catch {
    return false
  }
}
