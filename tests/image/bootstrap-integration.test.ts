import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface CloudConfigFile {
  readonly path: string
  readonly owner: string
  readonly permissions: string
  readonly encoding?: string
  readonly content: string
}

const render = (source: string, values: Readonly<Record<string, string>>): string =>
  source.replace(/\$\{([a-z0-9_]+)\}/gi, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`missing bootstrap value: ${name}`)
    return value
  })

const reservation = {
  schemaVersion: 1,
  organizationId: 'org-a',
  nodeId: 'node-a',
  operationId: 'operation-a',
  providerType: 'ovhcloud',
  providerImageId: 'provider-image-a',
  imageId: 'image-a',
  imageVersion: '2026.08.23',
  imageChecksum: `sha256:${'a'.repeat(64)}`,
  controlPlaneUrl: 'https://api.gridora.example',
  expectedControlPlaneHost: 'api.gridora.example',
  allowLoopbackHttp: false,
  dockerSocket: '/var/run/docker.sock',
  agentVersion: '0.1.0',
  pollWaitSeconds: 20,
  registrationExpiresAt: '2099-08-23T12:00:00Z',
  registrationToken: 'b'.repeat(64),
  commandSigningPublicKeyPem: 'test-public-key',
}

describe('rendered node bootstrap', () => {
  const template = readFileSync(
    resolve(process.cwd(), 'infra/images/cloud-init/node-bootstrap.yaml.tmpl'),
    'utf8',
  )
  const rendered = render(template, {
    bootstrap_reservation_json_base64: Buffer.from(JSON.stringify(reservation)).toString('base64'),
  })
  const config = parse(rendered) as { readonly write_files: ReadonlyArray<CloudConfigFile> }
  const files = new Map(config.write_files.map((file) => [file.path, file]))

  it('renders only the strict root bootstrap reservation', () => {
    const source = files.get('/var/lib/gridora/bootstrap/reservation.json')
    expect(source).toMatchObject({
      owner: 'root:root',
      permissions: '0600',
    })
    expect(JSON.parse(Buffer.from(source?.content ?? '', 'base64').toString('utf8'))).toEqual(
      reservation,
    )
    expect(files.size).toBe(1)
  })

  it('gives each service only its own credential', () => {
    const registration = files.get('/var/lib/gridora/bootstrap/registration-token')

    expect(registration).toBeUndefined()
    expect(files.has('/etc/gridora/cloudflared-token')).toBe(false)
    expect(files.has('/var/lib/gridora/tunnel/credential')).toBe(false)
    expect(rendered).not.toContain('tunnel-secret')
  })

  it('keeps restart inputs outside the ephemeral /run filesystem', () => {
    expect([...files.keys()].filter((path) => path.startsWith('/run/'))).toEqual([])
    expect(files.has('/etc/gridora/agent.json')).toBe(false)
    expect(rendered).not.toContain('systemctl, start, gridora-node-bootstrap')
  })
})
