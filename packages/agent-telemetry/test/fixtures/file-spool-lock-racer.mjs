import { open, rm, writeFile } from 'node:fs/promises'

const [lockPath, startPath, replacedPath, releasePath] = process.argv.slice(2)

if ([lockPath, startPath, replacedPath, releasePath].some((value) => typeof value !== 'string'))
  throw new Error('lock race fixture requires four paths')

const waitForFile = async (path) => {
  for (;;) {
    try {
      await open(path, 'r').then((handle) => handle.close())
      return
    } catch (cause) {
      if (cause && typeof cause === 'object' && cause.code !== 'ENOENT') throw cause
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

await waitForFile(startPath)
await rm(lockPath)
const handle = await open(lockPath, 'wx', 0o600)
try {
  await handle.writeFile(
    JSON.stringify({
      pid: process.pid,
      processStart: null,
      token: 'fresh-cross-process-lock-token',
      acquiredAt: Date.now(),
    }),
  )
  await handle.sync()
  await writeFile(replacedPath, 'fresh-lock-written')
  await waitForFile(releasePath)
} finally {
  await handle.close()
}
