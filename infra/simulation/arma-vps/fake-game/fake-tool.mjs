#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import dgram from 'node:dgram'

const executable = basename(process.argv[1] ?? '')
const argv = process.argv.slice(2)

const argumentAfter = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

const requirePath = (name) => {
  const value = argumentAfter(name)
  if (value === undefined || !value.startsWith('/work/')) {
    throw new Error(`${name} must name a path inside /work`)
  }
  return value
}

const runSteam = async () => {
  const root = requirePath('+force_install_dir')
  if (argumentAfter('+app_update') !== '1874900' || !argv.includes('validate')) {
    throw new Error('unexpected SteamCMD application plan')
  }
  await mkdir(root, { recursive: true })
  await writeFile(`${root}/build-id`, '1874900-acceptance\n', 'utf8')
  process.stdout.write('Success! App 1874900 fully installed. buildid=1874900001\n')
}

const runModDownload = async () => {
  const modId = argumentAfter('-downloadMod')
  const profile = requirePath('-profile')
  if (modId === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(modId)) {
    throw new Error('invalid simulated mod identity')
  }
  await mkdir(profile, { recursive: true })
  await writeFile(`${process.cwd()}/${modId}.pak`, `validated:${modId}\n`, 'utf8')
  process.stdout.write(`Downloaded mod ${modId}\n`)
}

const bindUdp = (port) => {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (message, peer) => {
    socket.send(
      Buffer.from(`GRIDORA_ARMA_ACCEPTANCE:${message.toString('utf8')}`),
      peer.port,
      peer.address,
    )
  })
  socket.bind(port, '0.0.0.0')
  return socket
}

const runServer = async () => {
  const config = JSON.parse(await readFile('/work/config/config/server.json', 'utf8'))
  if (typeof config?.game?.scenarioId !== 'string') throw new Error('runtime config is missing')
  await writeFile(
    '/work/state/runtime-ready',
    JSON.stringify({ build: '1874900001', scenario: config.game.scenarioId }) + '\n',
    'utf8',
  )
  const sockets = [bindUdp(2001), bindUdp(17777)]
  const stop = () => {
    for (const socket of sockets) socket.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.stdout.write('Simulated Arma Reforger runtime ready\n')
}

const validateConfig = async () => {
  const path = requirePath('--path')
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (
    config?.game?.name === 'FAIL_VALIDATION' ||
    typeof config?.game?.scenarioId !== 'string' ||
    !Number.isInteger(config?.game?.maxPlayers)
  ) {
    throw new Error('simulated Arma configuration validation failed')
  }
  process.stdout.write('configuration valid\n')
}

const validateMods = async () => {
  const root = requirePath('--root')
  const entries = await readdir(root)
  if (!entries.some((entry) => entry.endsWith('.pak'))) {
    throw new Error('simulated Arma mod validation failed')
  }
  process.stdout.write('mods valid\n')
}

const validateRestore = async () => {
  const root = requirePath('--root')
  await Promise.all([readFile(`${root}/config/server.json`), readFile(`${root}/profile`)])
  process.stdout.write('restore valid\n')
}

const queryHealth = async () => {
  const receipt = JSON.parse(await readFile('/work/state/runtime-ready', 'utf8'))
  process.stdout.write(`OK players=0 scenario=${receipt.scenario} build=${receipt.build}\n`)
}

try {
  if (executable === 'steamcmd') await runSteam()
  else if (executable === 'ArmaReforgerServer' && argv.includes('-downloadMod')) {
    await runModDownload()
  } else if (executable === 'ArmaReforgerServer') await runServer()
  else if (executable === 'gridora-game-query' && argv[0] === 'validate-config') {
    await validateConfig()
  } else if (executable === 'gridora-game-query' && argv[0] === 'validate-mods') {
    await validateMods()
  } else if (executable === 'gridora-game-query' && argv[0] === 'validate-restore') {
    await validateRestore()
  } else if (executable === 'gridora-game-query' && argv[0] === 'arma-reforger') {
    await queryHealth()
  } else {
    throw new Error(`unsupported simulated executable plan: ${executable}`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
