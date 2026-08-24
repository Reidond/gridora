import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)
const temporaryDirectories: string[] = []

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const json = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Cloudflare environment binding bridge', () => {
  it('renders every Worker binding to the exact staging resource contract', async () => {
    const outputDirectory = await temporaryDirectory('gridora-cloudflare-render-')
    await execute(
      process.execPath,
      [
        'infra/scripts/render-cloudflare-environment.mjs',
        '--environment-file',
        'infra/cloudflare/environment.ci.json',
        '--out-dir',
        outputDirectory,
      ],
      { cwd: root },
    )

    const api = await json(join(outputDirectory, 'apps/api/wrangler.jsonc'))
    const templateApi = await json(
      join(outputDirectory, 'infra/cloudflare/wrangler.template.jsonc'),
    )
    const realtime = await json(join(outputDirectory, 'workers/realtime/wrangler.jsonc'))
    const workflows = await json(join(outputDirectory, 'workers/workflows/wrangler.jsonc'))
    const consumers = await json(join(outputDirectory, 'workers/queue-consumers/wrangler.jsonc'))
    const web = await json(join(outputDirectory, 'apps/web/wrangler.jsonc'))
    const apiD1 = (api.d1_databases as ReadonlyArray<Record<string, string>>)[0]
    const apiR2 = api.r2_buckets as ReadonlyArray<Record<string, string>>
    const apiQueues = (api.queues as { producers: ReadonlyArray<Record<string, string>> }).producers
    const apiDurableObjects = (
      api.durable_objects as { bindings: ReadonlyArray<Record<string, string>> }
    ).bindings
    const apiSecretsStore = api.secrets_store_secrets as ReadonlyArray<Record<string, string>>

    expect(api.name).toBe('gridora-staging-api')
    expect(web.name).toBe('gridora-staging-web')
    expect(api.workers_dev).toBe(false)
    expect(api.preview_urls).toBe(false)
    expect(api.routes).toEqual([{ pattern: 'api.staging.gridora.coasts.red', custom_domain: true }])
    expect(templateApi.routes).toEqual([
      { pattern: 'api.staging.gridora.coasts.red', custom_domain: true },
    ])
    expect(web.workers_dev).toBe(false)
    expect(web.preview_urls).toBe(false)
    expect(web.routes).toEqual([
      { pattern: 'staging.gridora.coasts.red', custom_domain: true },
      { pattern: 'console.staging.gridora.coasts.red', custom_domain: true },
    ])
    expect(apiD1).toMatchObject({
      database_name: 'gridora-staging',
      database_id: '00000000-0000-4000-8000-000000000000',
    })
    expect(apiR2.map((binding) => binding.bucket_name)).toEqual([
      'gridora-staging-artifacts',
      'gridora-staging-backups',
      'gridora-staging-logs',
      'gridora-staging-notification-remediation',
    ])
    expect(apiQueues.map((binding) => binding.queue)).toContain('gridora-staging-telemetry')
    expect(apiDurableObjects).toContainEqual(
      expect.objectContaining({ script_name: 'gridora-staging-realtime' }),
    )
    expect(apiSecretsStore.map((binding) => binding.secret_name)).toEqual([
      'gridora-staging-provider-kek-v1',
      'gridora-staging-provider-kek-v2',
      'gridora-staging-cloudflare-tunnel-api-token',
      'gridora-staging-cloudflare-dns-api-token',
      'gridora-staging-agent-command-signing-key',
    ])
    expect(workflows.name).toBe('gridora-staging-workflows')
    expect(workflows.services).toEqual([{ binding: 'APPLICATION', service: 'gridora-staging-api' }])
    expect(consumers.name).toBe('gridora-staging-queue-consumers')
    for (const serviceOrEventWorker of [realtime, workflows, consumers]) {
      expect(serviceOrEventWorker.workers_dev).toBe(false)
      expect(serviceOrEventWorker.preview_urls).toBe(false)
      expect(serviceOrEventWorker).not.toHaveProperty('route')
      expect(serviceOrEventWorker).not.toHaveProperty('routes')
    }
    expect((consumers.vars as Record<string, string>).PUBLIC_APP_URL).toBe(
      'https://staging.gridora.coasts.red',
    )
    expect(
      (consumers.queues as { consumers: ReadonlyArray<Record<string, string>> }).consumers,
    ).toContainEqual(
      expect.objectContaining({
        queue: 'gridora-staging-telemetry',
        dead_letter_queue: 'gridora-staging-telemetry-dlq',
      }),
    )
    expect(JSON.stringify(api)).not.toContain('replace-with')
  })

  it('rejects an environment whose resource prefix could cross environment boundaries', async () => {
    const temporary = await temporaryDirectory('gridora-cloudflare-invalid-')
    const source = await json(resolve(root, 'infra/cloudflare/environment.ci.json'))
    const environmentFile = join(temporary, 'invalid.json')
    await writeFile(
      environmentFile,
      JSON.stringify({ ...source, resourcePrefix: 'gridora-production' }),
    )

    await expect(
      execute(
        process.execPath,
        [
          'infra/scripts/render-cloudflare-environment.mjs',
          '--environment-file',
          environmentFile,
          '--out-dir',
          join(temporary, 'rendered'),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow('resourcePrefix must be exactly gridora-staging')
  })

  it('renders the production custom domains directly below the declared zone', async () => {
    const temporary = await temporaryDirectory('gridora-cloudflare-production-')
    const source = await json(resolve(root, 'infra/cloudflare/environment.ci.json'))
    const environmentFile = join(temporary, 'production.json')
    await writeFile(
      environmentFile,
      JSON.stringify({
        ...source,
        environment: 'production',
        resourcePrefix: 'gridora-production',
        accessAudience: 'gridora-production-audience',
        apiHostname: 'api.gridora.coasts.red',
        publicAppHostname: 'gridora.coasts.red',
        consoleHostname: 'console.gridora.coasts.red',
        dnsTarget: 'nodes.gridora.coasts.red',
      }),
    )
    const outputDirectory = join(temporary, 'rendered')

    await execute(
      process.execPath,
      [
        'infra/scripts/render-cloudflare-environment.mjs',
        '--environment-file',
        environmentFile,
        '--out-dir',
        outputDirectory,
      ],
      { cwd: root },
    )

    const api = await json(join(outputDirectory, 'apps/api/wrangler.jsonc'))
    const web = await json(join(outputDirectory, 'apps/web/wrangler.jsonc'))
    expect(api.routes).toEqual([{ pattern: 'api.gridora.coasts.red', custom_domain: true }])
    expect(web.routes).toEqual([
      { pattern: 'gridora.coasts.red', custom_domain: true },
      { pattern: 'console.gridora.coasts.red', custom_domain: true },
    ])
  })

  it('rejects production or foreign-zone hostnames in the staging binding contract', async () => {
    const temporary = await temporaryDirectory('gridora-cloudflare-hostname-fence-')
    const source = await json(resolve(root, 'infra/cloudflare/environment.ci.json'))
    const invalidHostnames = [
      ['apiHostname', 'api.gridora.coasts.red'],
      ['publicAppHostname', 'gridora.coasts.red'],
      ['consoleHostname', 'console.gridora.coasts.red'],
      ['dnsTarget', 'nodes.gridora.coasts.red'],
      ['apiHostname', 'api.staging.gridora.other-zone.example'],
    ] as const

    for (const [field, value] of invalidHostnames) {
      const environmentFile = join(temporary, `${field}-${value}.json`)
      await writeFile(environmentFile, JSON.stringify({ ...source, [field]: value }))

      await expect(
        execute(
          process.execPath,
          [
            'infra/scripts/render-cloudflare-environment.mjs',
            '--environment-file',
            environmentFile,
            '--out-dir',
            join(temporary, `${field}-${value}-rendered`),
          ],
          { cwd: root },
        ),
      ).rejects.toThrow(`${field} must equal`)
    }
  })

  it('uses an offline init without credentials and a locked R2 init only with protected inputs', async () => {
    const temporary = await temporaryDirectory('gridora-terraform-init-')
    const output = join(temporary, 'terraform-arguments.txt')
    const terraform = join(temporary, 'terraform')
    await writeFile(
      terraform,
      [
        '#!/usr/bin/env sh',
        'printf "%s\\n" "$@" > "$GRIDORA_TEST_OUTPUT"',
        'printf "AWS_ENDPOINT_URL_S3=%s\\n" "$AWS_ENDPOINT_URL_S3" >> "$GRIDORA_TEST_OUTPUT"',
      ].join('\n'),
    )
    await chmod(terraform, 0o755)
    const environment = {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH ?? ''}`,
      GRIDORA_TEST_OUTPUT: output,
      GRIDORA_TERRAFORM_DIRECTORY: temporary,
    }

    await execute('sh', ['infra/scripts/terraform-init.sh', 'offline'], {
      cwd: root,
      env: environment,
    })
    expect(await readFile(output, 'utf8')).toContain('-backend=false')

    await expect(
      execute('sh', ['infra/scripts/terraform-init.sh', 'remote', 'staging'], {
        cwd: root,
        env: environment,
      }),
    ).rejects.toThrow('Missing required protected input: GRIDORA_TERRAFORM_STATE_BUCKET')

    await expect(
      execute('sh', ['infra/scripts/terraform-init.sh', 'remote', 'production'], {
        cwd: root,
        env: {
          ...environment,
          GRIDORA_TERRAFORM_STATE_BUCKET: 'gridora-state',
          GRIDORA_R2_ACCOUNT_ID: 'not-an-account-id',
          AWS_ACCESS_KEY_ID: 'test-access-key-id',
          AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
        },
      }),
    ).rejects.toThrow('Invalid protected input GRIDORA_R2_ACCOUNT_ID')

    await execute('sh', ['infra/scripts/terraform-init.sh', 'remote', 'production'], {
      cwd: root,
      env: {
        ...environment,
        GRIDORA_TERRAFORM_STATE_BUCKET: 'gridora-state',
        GRIDORA_R2_ACCOUNT_ID: '22222222222222222222222222222222',
        AWS_ACCESS_KEY_ID: 'test-access-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      },
    })
    const argumentsWritten = await readFile(output, 'utf8')
    expect(await readFile(join(temporary, 'backend.remote.tf'), 'utf8')).toBe(
      'terraform {\n  backend "s3" {}\n}\n',
    )
    expect(argumentsWritten).toContain('-backend-config=key=gridora/production/terraform.tfstate')
    expect(argumentsWritten).toContain('-backend-config=use_lockfile=true')
    expect(argumentsWritten).toContain(
      'AWS_ENDPOINT_URL_S3=https://22222222222222222222222222222222.r2.cloudflarestorage.com',
    )
    expect(argumentsWritten).not.toContain('test-access-key-id')
    expect(argumentsWritten).not.toContain('test-secret-access-key')
  })

  it('rejects any resource action in the credential-free Terraform validation plan', async () => {
    const temporary = await temporaryDirectory('gridora-terraform-plan-')
    const plan = join(temporary, 'plan.json')
    await writeFile(
      plan,
      JSON.stringify({
        resource_changes: [
          {
            address: 'cloudflare_r2_bucket.data["backups"]',
            change: { actions: ['create'] },
          },
        ],
      }),
    )

    await expect(
      execute(process.execPath, ['infra/scripts/assert-terraform-no-resource-changes.mjs', plan], {
        cwd: root,
      }),
    ).rejects.toThrow('default validation must not change resources')
  })
})
