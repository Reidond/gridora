import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const extractor = resolve(process.cwd(), 'infra/scripts/extract-rootfs-evidence.sh')
const generateSbom = resolve(process.cwd(), 'infra/scripts/generate-sbom.sh')
const scanArtifact = resolve(process.cwd(), 'infra/scripts/scan-artifact.sh')
const verifyArtifact = resolve(process.cwd(), 'infra/scripts/verify-artifact.sh')
const verifyReleaseImageEvidence = resolve(
  process.cwd(),
  'infra/scripts/verify-release-image-evidence.sh',
)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const digest = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'gridora-image-evidence-'))
  roots.push(root)
  return root
}

const makeExecutable = async (root: string, name: string, contents: string) => {
  const path = join(root, name)
  await writeFile(path, contents)
  await chmod(path, 0o700)
  return path
}

const rootfsArchive = async (root: string) => {
  const rootfs = join(root, 'rootfs')
  const status = join(rootfs, 'var', 'lib', 'dpkg', 'status')
  const nestedContainerStatus = join(
    rootfs,
    'var',
    'lib',
    'docker',
    'overlay2',
    'fixture',
    'diff',
    'var',
    'lib',
    'dpkg',
    'status',
  )
  await mkdir(join(rootfs, 'var', 'lib', 'dpkg'), { recursive: true })
  await mkdir(join(nestedContainerStatus, '..'), { recursive: true })
  await writeFile(
    status,
    'Package: gridora-agent\nVersion: 1.0.0\n\nPackage: cloudflared\nVersion: 2026.8.2\n',
  )
  await writeFile(nestedContainerStatus, 'Package: nested-container-only\nVersion: 1.0.0\n')
  const archive = join(root, 'rootfs-source.tar')
  // A real Linux rootfs includes device nodes. The evidence extractor must not
  // recreate them as the unprivileged CI user merely to read dpkg status.
  await execute('tar', ['-cf', archive, '-C', rootfs, '.', '-C', '/', 'dev/null'])
  return archive
}

describe('node image rootfs evidence', () => {
  it('runs the explicit pinned scanner command with the fixed vulnerability policy', async () => {
    const root = await makeRoot()
    const archive = join(root, 'node.qcow2.rootfs.tar')
    const invocation = join(root, 'grype.log')
    const grype = await makeExecutable(
      root,
      'pinned-grype',
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" > "$GRIDORA_TEST_GRYPE_LOG"\n',
    )
    await writeFile(archive, 'rootfs fixture')

    await execute(scanArtifact, [archive, grype], {
      env: { ...process.env, GRIDORA_TEST_GRYPE_LOG: invocation },
    })

    expect(await readFile(invocation, 'utf8')).toBe(`${archive} --fail-on high --only-fixed\n`)
  })

  it('extracts a read-only guest filesystem archive and proves a non-empty package inventory', async () => {
    const root = await makeRoot()
    const artifact = join(root, 'node.qcow2')
    const source = await rootfsArchive(root)
    const archive = join(root, 'node.qcow2.rootfs.tar')
    const evidence = join(root, 'node.qcow2.rootfs-evidence.json')
    await writeFile(artifact, 'qcow2 fixture')
    const virtTarOut = await makeExecutable(
      root,
      'virt-tar-out',
      '#!/usr/bin/env bash\nset -euo pipefail\ncp "$GRIDORA_TEST_ROOTFS_ARCHIVE" "${!#}"\n',
    )

    await execute(extractor, [artifact, archive, evidence], {
      env: {
        ...process.env,
        GRIDORA_TEST_ROOTFS_ARCHIVE: source,
        GRIDORA_VIRT_TAR_OUT: virtTarOut,
      },
    })

    const result = JSON.parse(await readFile(evidence, 'utf8')) as {
      artifact: { name: string; sha256: string }
      rootfsArchive: {
        name: string
        sha256: string
        inventory: { format: string; packageCount: number }
      }
    }
    expect(result.artifact).toEqual({ name: 'node.qcow2', sha256: digest('qcow2 fixture') })
    expect(result.rootfsArchive.name).toBe('node.qcow2.rootfs.tar')
    expect(result.rootfsArchive.sha256).toBe(digest(await readFile(archive)))
    expect(result.rootfsArchive.inventory).toEqual({ format: 'dpkg-status', packageCount: 2 })
    const extractorSource = await readFile(extractor, 'utf8')
    expect(extractorSource).toContain('--extract --to-stdout')
    expect(extractorSource).not.toContain('--directory')
  })

  it('binds a non-empty SBOM to exactly the extracted rootfs evidence', async () => {
    const root = await makeRoot()
    const artifact = join(root, 'node.qcow2')
    const source = await rootfsArchive(root)
    const archive = join(root, 'node.qcow2.rootfs.tar')
    const evidence = join(root, 'node.qcow2.rootfs-evidence.json')
    const sbom = join(root, 'node.qcow2.spdx.json')
    await writeFile(artifact, 'qcow2 fixture')
    const virtTarOut = await makeExecutable(
      root,
      'virt-tar-out',
      '#!/usr/bin/env bash\nset -euo pipefail\ncp "$GRIDORA_TEST_ROOTFS_ARCHIVE" "${!#}"\n',
    )
    const syft = await makeExecutable(
      root,
      'syft',
      '#!/usr/bin/env bash\nset -euo pipefail\nfor argument in "$@"; do case "$argument" in spdx-json=*) output=${argument#spdx-json=};; esac; done\nprintf %s \'{"spdxVersion":"SPDX-2.3","packages":[{"name":"gridora-agent"},{"name":"cloudflared"}]}\' > "$output"\n',
    )

    await execute(extractor, [artifact, archive, evidence], {
      env: {
        ...process.env,
        GRIDORA_TEST_ROOTFS_ARCHIVE: source,
        GRIDORA_VIRT_TAR_OUT: virtTarOut,
      },
    })
    await execute(generateSbom, [archive, sbom, evidence], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GRIDORA_TEST_SYFT: syft },
    })

    const result = JSON.parse(await readFile(evidence, 'utf8')) as {
      sbom: { name: string; sha256: string; packageCount: number }
    }
    expect(result.sbom).toEqual({
      name: 'node.qcow2.spdx.json',
      sha256: digest(await readFile(sbom)),
      packageCount: 2,
    })
  })

  it('rejects a tampered rootfs and invokes Cosign verification for the protected workflow identity', async () => {
    const root = await makeRoot()
    const artifact = join(root, 'node.qcow2')
    const archive = join(root, 'node.qcow2.rootfs.tar')
    const sbom = join(root, 'node.qcow2.spdx.json')
    const evidence = join(root, 'node.qcow2.rootfs-evidence.json')
    const checksums = join(root, 'node.qcow2.sha256')
    const cosignLog = join(root, 'cosign.log')
    await writeFile(artifact, 'qcow2 fixture')
    await writeFile(archive, 'rootfs fixture')
    await writeFile(
      sbom,
      JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{ name: 'gridora-agent' }] }),
    )
    await writeFile(
      evidence,
      JSON.stringify({
        schemaVersion: 1,
        artifact: { name: 'node.qcow2', sha256: digest(await readFile(artifact)) },
        rootfsArchive: {
          name: 'node.qcow2.rootfs.tar',
          sha256: digest(await readFile(archive)),
          inventory: { format: 'dpkg-status', packageCount: 1 },
        },
        sbom: {
          name: 'node.qcow2.spdx.json',
          sha256: digest(await readFile(sbom)),
          packageCount: 1,
        },
      }),
    )
    await writeFile(
      checksums,
      `${digest(await readFile(artifact)).slice('sha256:'.length)}  ${artifact}\n${digest(await readFile(archive)).slice('sha256:'.length)}  ${archive}\n`,
    )
    await writeFile(`${artifact}.sigstore.json`, '{"bundle":"fixture"}')
    await makeExecutable(
      root,
      'cosign',
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" > "$GRIDORA_TEST_COSIGN_LOG"\n',
    )
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'gridora/test',
      GRIDORA_TEST_COSIGN_LOG: cosignLog,
    }

    await execute(verifyArtifact, [artifact, checksums, sbom, archive, evidence], { env })
    const invocation = await readFile(cosignLog, 'utf8')
    expect(invocation).toContain('verify-blob')
    expect(invocation).toContain(
      '--certificate-identity https://github.com/gridora/test/.github/workflows/image.yml@refs/heads/main',
    )
    await writeFile(archive, 'tampered rootfs fixture')
    await expect(
      execute(verifyArtifact, [artifact, checksums, sbom, archive, evidence], { env }),
    ).rejects.toMatchObject({
      code: expect.any(Number),
    })
  })

  it('requires an exact successful manual main run attempt and its nonexpired positive-size artifact', async () => {
    const root = await makeRoot()
    await makeExecutable(
      root,
      'gh',
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"/actions/workflows/image.yml/runs"*) printf '%s\\n' "$GRIDORA_TEST_RELEASE_RUNS" ;;
  *"/actions/runs/4242/attempts/3/jobs"*) printf '%s\\n' "$GRIDORA_TEST_RELEASE_JOBS" ;;
  *"/actions/runs/4242/artifacts"*) printf '%s\\n' "$GRIDORA_TEST_RELEASE_ARTIFACTS" ;;
  *) printf 'unexpected gh request: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
    )

    const tagSha = '0123456789abcdef0123456789abcdef01234567'
    const runs = JSON.stringify([
      {
        workflow_runs: [
          {
            id: 4242,
            run_attempt: 3,
            html_url: 'https://github.example/gridora/gridora/actions/runs/4242',
            head_sha: tagSha,
            event: 'workflow_dispatch',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-08-24T00:00:00Z',
          },
        ],
      },
    ])
    const jobs = JSON.stringify([
      {
        jobs: ['validate', 'build-local', 'provider-image-smoke'].map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      },
    ])
    const artifact = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify([
        {
          artifacts: [
            {
              name: 'gridora-node-4242-3',
              expired: false,
              size_in_bytes: 1,
              workflow_run: { id: 4242, head_branch: 'main', head_sha: tagSha },
              ...overrides,
            },
          ],
        },
      ])
    const environment = (artifacts: string, releaseJobs = jobs) => ({
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      GH_TOKEN: 'test-actions-read-token',
      REPOSITORY: 'gridora/gridora',
      TAG_SHA: tagSha,
      GRIDORA_RELEASE_EVIDENCE_MAX_ATTEMPTS: '1',
      GRIDORA_RELEASE_EVIDENCE_POLL_SECONDS: '0',
      GRIDORA_TEST_RELEASE_RUNS: runs,
      GRIDORA_TEST_RELEASE_JOBS: releaseJobs,
      GRIDORA_TEST_RELEASE_ARTIFACTS: artifacts,
    })

    await execute('bash', [verifyReleaseImageEvidence], { env: environment(artifact()) })

    for (const invalidArtifact of [
      artifact({ name: 'gridora-node-4242-2' }),
      artifact({ expired: true }),
      artifact({ size_in_bytes: 0 }),
      artifact({ workflow_run: { id: 4242, head_branch: 'main', head_sha: 'different-sha' } }),
    ]) {
      await expect(
        execute('bash', [verifyReleaseImageEvidence], { env: environment(invalidArtifact) }),
      ).rejects.toMatchObject({ code: expect.any(Number) })
    }

    const incompleteJobs = JSON.stringify([
      {
        jobs: ['validate', 'build-local'].map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      },
    ])
    await expect(
      execute('bash', [verifyReleaseImageEvidence], {
        env: environment(artifact(), incompleteJobs),
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
  })
})
