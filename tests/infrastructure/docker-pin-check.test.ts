import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const checkPins = resolve(process.cwd(), 'infra/scripts/check-docker-pins.sh')
const provision = resolve(process.cwd(), 'infra/packer/scripts/provision.sh')
const indexUrl = 'https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const pinVariables = {
  'containerd.io': 'containerd_io_version',
  'docker-ce': 'docker_ce_version',
  'docker-ce-cli': 'docker_ce_cli_version',
  'docker-buildx-plugin': 'docker_buildx_version',
  'docker-compose-plugin': 'docker_compose_version',
} as const
type DockerPackage = keyof typeof pinVariables
const dockerPackages = Object.keys(pinVariables) as DockerPackage[]

const provisionPins = async () => {
  const source = await readFile(provision, 'utf8')
  return Object.fromEntries(
    dockerPackages.map((name) => {
      const match = source.match(new RegExp(`^readonly ${pinVariables[name]}='([^']+)'$`, 'm'))
      if (!match?.[1]) throw new Error(`provision.sh has no ${name} pin`)
      return [name, match[1]]
    }),
  ) as Record<DockerPackage, string>
}

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'gridora-docker-pins-'))
  roots.push(root)
  return root
}

const stanza = (name: string, version: string) =>
  `Package: ${name}\nArchitecture: amd64\nVersion: ${version}\nFilename: pool/stable/${name}_${version}.deb\n`

const writeIndex = async (root: string, entries: readonly (readonly [string, string])[]) => {
  const path = join(root, 'Packages')
  await writeFile(path, entries.map(([name, version]) => stanza(name, version)).join('\n'))
  return path
}

const writePinSource = async (root: string, pins: Partial<Record<DockerPackage, string>>) => {
  const path = join(root, 'provision.sh')
  await writeFile(
    path,
    [
      '#!/usr/bin/env bash',
      ...dockerPackages
        .filter((name) => pins[name] !== undefined)
        .map((name) => `readonly ${pinVariables[name]}='${pins[name]}'`),
      '',
    ].join('\n'),
  )
  return path
}

const run = (args: string[], env: Record<string, string> = {}) =>
  execute('bash', [checkPins, ...args], { env: { ...process.env, ...env } })

describe('Docker package pin drift check', () => {
  it('accepts the committed pins when they are the newest published versions', async () => {
    const root = await makeRoot()
    const pins = await provisionPins()
    const index = await writeIndex(root, [
      ['containerd.io', '1.7.28-1~ubuntu.24.04~noble'],
      ['docker-ce', '5:28.5.2-1~ubuntu.24.04~noble'],
      // Exact package matching: a newer related package must not count.
      ['docker-ce-rootless-extras', '5:99.0.0-1~ubuntu.24.04~noble'],
      ...dockerPackages.map((name) => [name, pins[name]] as const),
    ])

    const { stdout } = await run([index])

    for (const name of dockerPackages) {
      expect(stdout).toContain(`${name} ${pins[name]} is the newest published version`)
    }
  })

  it.each(dockerPackages)('fails when Docker publishes a newer %s', async (drifted) => {
    const root = await makeRoot()
    const pins = await provisionPins()
    const newer = '9:999.0.0-1~ubuntu.24.04~noble'
    const index = await writeIndex(root, [
      ...dockerPackages.map((name) => [name, pins[name]] as const),
      [drifted, newer],
    ])

    const failure = run([index])

    await expect(failure).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `${drifted} pin ${pins[drifted]} is behind the newest published version ${newer}`,
      ),
    })
    await expect(failure).rejects.toMatchObject({
      stderr: expect.stringContaining('Update the exact Docker pins'),
    })
  })

  it('reproduces the image run 36040577564 drift from the previous pins', async () => {
    const root = await makeRoot()
    const pinSource = await writePinSource(root, {
      'containerd.io': '2.3.3-1~ubuntu.24.04~noble',
      'docker-ce': '5:29.7.2-1~ubuntu.24.04~noble',
      'docker-ce-cli': '5:29.7.2-1~ubuntu.24.04~noble',
      'docker-buildx-plugin': '0.36.1-1~ubuntu.24.04~noble',
      'docker-compose-plugin': '5.5.0-1~ubuntu.24.04~noble',
    })
    const index = await writeIndex(root, [
      ['containerd.io', '2.3.3-1~ubuntu.24.04~noble'],
      ['containerd.io', '2.3.5-1~ubuntu.24.04~noble'],
      ['docker-ce', '5:29.7.2-1~ubuntu.24.04~noble'],
      ['docker-ce', '5:29.8.1-1~ubuntu.24.04~noble'],
      ['docker-ce-cli', '5:29.7.2-1~ubuntu.24.04~noble'],
      ['docker-ce-cli', '5:29.8.1-1~ubuntu.24.04~noble'],
      ['docker-buildx-plugin', '0.36.1-1~ubuntu.24.04~noble'],
      ['docker-buildx-plugin', '0.37.1-1~ubuntu.24.04~noble'],
      ['docker-compose-plugin', '5.5.0-1~ubuntu.24.04~noble'],
      ['docker-compose-plugin', '5.5.1-1~ubuntu.24.04~noble'],
    ])

    const failure = run([index], { GRIDORA_DOCKER_PIN_SOURCE: pinSource })

    await expect(failure).rejects.toMatchObject({ code: 1 })
    const { stderr } = (await failure.catch((error: unknown) => error)) as { stderr: string }
    expect(stderr.split('\n').filter((line) => line.includes(' is behind '))).toEqual([
      'containerd.io pin 2.3.3-1~ubuntu.24.04~noble is behind the newest published version 2.3.5-1~ubuntu.24.04~noble',
      'docker-ce pin 5:29.7.2-1~ubuntu.24.04~noble is behind the newest published version 5:29.8.1-1~ubuntu.24.04~noble',
      'docker-ce-cli pin 5:29.7.2-1~ubuntu.24.04~noble is behind the newest published version 5:29.8.1-1~ubuntu.24.04~noble',
      'docker-buildx-plugin pin 0.36.1-1~ubuntu.24.04~noble is behind the newest published version 0.37.1-1~ubuntu.24.04~noble',
      'docker-compose-plugin pin 5.5.0-1~ubuntu.24.04~noble is behind the newest published version 5.5.1-1~ubuntu.24.04~noble',
    ])
  })

  it.each([
    // Numeric, not lexical: 2.3.10 is newer than 2.3.9.
    { pin: '2.3.9-1', published: ['2.3.9-1', '2.3.10-1'], behind: '2.3.10-1' },
    // An epoch outranks any upstream version.
    { pin: '1:1.0.0-1', published: ['1:1.0.0-1', '9.9.9-1'], behind: null },
    { pin: '9.9.9-1', published: ['9.9.9-1', '1:1.0.0-1'], behind: '1:1.0.0-1' },
    // A tilde release candidate sorts before its final release.
    { pin: '2.4.0~rc1-1', published: ['2.4.0~rc1-1', '2.4.0-1'], behind: '2.4.0-1' },
    { pin: '2.4.0-1', published: ['2.4.0~rc1-1', '2.4.0-1'], behind: null },
    // The Debian revision breaks upstream ties.
    { pin: '2.4.0-1', published: ['2.4.0-1', '2.4.0-2'], behind: '2.4.0-2' },
    // Leading zeros do not change a numeric component.
    { pin: '2.4.010-1', published: ['2.4.010-1', '2.4.9-1'], behind: null },
  ] as const)(
    'orders Debian versions: pin $pin against $published',
    async ({ pin, published, behind }) => {
      const root = await makeRoot()
      const pins = { ...(await provisionPins()), 'containerd.io': pin }
      const pinSource = await writePinSource(root, pins)
      const index = await writeIndex(root, [
        ...dockerPackages
          .filter((name) => name !== 'containerd.io')
          .map((name) => [name, pins[name]] as const),
        ...published.map((version) => ['containerd.io', version] as const),
      ])
      const result = run([index], { GRIDORA_DOCKER_PIN_SOURCE: pinSource })
      if (behind === null) {
        await expect(result).resolves.toMatchObject({
          stdout: expect.stringContaining(`containerd.io ${pin} is the newest published version`),
        })
      } else {
        await expect(result).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            `containerd.io pin ${pin} is behind the newest published version ${behind}`,
          ),
        })
      }
    },
  )

  it('fails when a pinned package or pinned version is not in the index', async () => {
    const root = await makeRoot()
    const pins = await provisionPins()
    const withoutCompose = await writeIndex(
      root,
      dockerPackages
        .filter((name) => name !== 'docker-compose-plugin')
        .map((name) => [name, pins[name]] as const),
    )
    await expect(run([withoutCompose])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('docker-compose-plugin is not in the Docker package index'),
    })

    const unpublishedRoot = await makeRoot()
    const withdrawn = await writeIndex(unpublishedRoot, [
      ...dockerPackages
        .filter((name) => name !== 'docker-ce')
        .map((name) => [name, pins[name]] as const),
      ['docker-ce', '5:1.0.0-1~ubuntu.24.04~noble'],
    ])
    await expect(run([withdrawn])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `docker-ce pin ${pins['docker-ce']} is not in the Docker package index; newest is 5:1.0.0-1~ubuntu.24.04~noble`,
      ),
    })
  })

  it('rejects an empty index, an unreadable index, and an incomplete or duplicated pin source', async () => {
    const root = await makeRoot()
    const pins = await provisionPins()
    const empty = join(root, 'empty-Packages')
    await writeFile(empty, '')
    await expect(run([empty])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Docker package index contains no packages'),
    })
    await expect(run([join(root, 'absent-Packages')])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('is not readable'),
    })
    await expect(run([empty, empty])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('usage: check-docker-pins.sh'),
    })

    const index = await writeIndex(
      root,
      dockerPackages.map((name) => [name, pins[name]] as const),
    )
    const withoutBuildx = Object.fromEntries(
      Object.entries(pins).filter(([name]) => name !== 'docker-buildx-plugin'),
    )
    const incomplete = await writePinSource(await makeRoot(), withoutBuildx)
    await expect(run([index], { GRIDORA_DOCKER_PIN_SOURCE: incomplete })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('must define exactly one docker_buildx_version pin; found 0'),
    })

    const duplicated = await writePinSource(await makeRoot(), pins)
    await writeFile(
      duplicated,
      `${await readFile(duplicated, 'utf8')}readonly docker_ce_version='5:0.0.1-1'\n`,
    )
    await expect(run([index], { GRIDORA_DOCKER_PIN_SOURCE: duplicated })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('must define exactly one docker_ce_version pin; found 2'),
    })

    await expect(
      run([index], { GRIDORA_DOCKER_PIN_SOURCE: join(root, 'absent-provision.sh') }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('Docker pin source'),
    })
  })

  it('downloads the amd64 noble/stable index over HTTPS only when no index is given', async () => {
    const root = await makeRoot()
    const pins = await provisionPins()
    const index = await writeIndex(
      root,
      dockerPackages.map((name) => [name, pins[name]] as const),
    )
    const argumentsLog = join(root, 'curl-arguments')
    const curl = join(root, 'curl')
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"${argumentsLog}"
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output=$2; shift; fi
  shift
done
cp "${index}" "$output"
`,
    )
    await chmod(curl, 0o700)

    await expect(run([], { GRIDORA_CURL_COMMAND: curl })).resolves.toMatchObject({
      stdout: expect.stringContaining('is the newest published version'),
    })
    const curlArguments = (await readFile(argumentsLog, 'utf8')).trim().split('\n')
    expect(curlArguments).toEqual(
      expect.arrayContaining(['--fail', '--proto', '=https', '--tlsv1.2', indexUrl]),
    )

    const failingCurl = join(root, 'failing-curl')
    await writeFile(failingCurl, '#!/usr/bin/env bash\nexit 22\n')
    await chmod(failingCurl, 0o700)
    await expect(run([], { GRIDORA_CURL_COMMAND: failingCurl })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `could not download the Docker package index from ${indexUrl}`,
      ),
    })
  })
})
