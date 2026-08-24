import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path).replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>

describe('infrastructure security boundaries', () => {
  it('disables workers.dev and version preview ingress in every deployable Worker source config', () => {
    const workerConfigs = [
      'infra/cloudflare/wrangler.template.jsonc',
      'apps/api/wrangler.jsonc',
      'apps/web/wrangler.jsonc',
      'workers/realtime/wrangler.jsonc',
      'workers/workflows/wrangler.jsonc',
      'workers/queue-consumers/wrangler.jsonc',
    ]

    for (const path of workerConfigs) {
      const config = json(path)
      expect(config.workers_dev, `${path} must not publish a workers.dev ingress`).toBe(false)
      expect(config.preview_urls, `${path} must not publish version preview ingress`).toBe(false)
    }
  })

  it('does not put secret values in the Wrangler template', () => {
    const source = read('infra/cloudflare/wrangler.template.jsonc')
    const config = json('infra/cloudflare/wrangler.template.jsonc')
    expect(source).not.toMatch(/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY)"\s*:/)
    expect(config.workers_dev).toBe(false)
    expect(config.d1_databases).toEqual([
      expect.objectContaining({ binding: 'DB', migrations_dir: '../../packages/migrations/sql' }),
    ])
    expect(config.r2_buckets).toEqual([
      expect.objectContaining({ binding: 'ARTIFACTS', bucket_name: 'gridora-artifacts' }),
      expect.objectContaining({ binding: 'BACKUPS', bucket_name: 'gridora-backups' }),
      expect.objectContaining({ binding: 'LOGS', bucket_name: 'gridora-logs' }),
      expect.objectContaining({
        binding: 'NOTIFICATION_REMEDIATION',
        bucket_name: 'gridora-notification-remediation',
      }),
    ])
  })

  it('keeps the API template binding names equal to the application config', () => {
    const template = json('infra/cloudflare/wrangler.template.jsonc')
    const application = json('apps/api/wrangler.jsonc')
    expect(template.d1_databases).toEqual(application.d1_databases)
    expect(template.r2_buckets).toEqual(application.r2_buckets)
    expect(template.queues).toEqual(application.queues)
    expect(template.durable_objects).toEqual(application.durable_objects)
    expect(template.workflows).toEqual(application.workflows)
  })

  it('does not persist automatic API invocation URLs containing bearer path segments', () => {
    const application = json('apps/api/wrangler.jsonc')
    expect(application.observability).toEqual(
      expect.objectContaining({
        enabled: true,
        logs: expect.objectContaining({ enabled: true, invocation_logs: false }),
      }),
    )
  })

  it('restricts invitation email to one configured sender without remote sends', () => {
    const config = json('workers/queue-consumers/wrangler.jsonc')
    expect(config.send_email).toEqual([
      {
        name: 'INVITATION_EMAIL',
        allowed_sender_addresses: ['invitations@gridora.example'],
      },
    ])
    expect(JSON.stringify(config.send_email)).not.toContain('remote')
  })

  it('binds exact immutable log and token-free invitation remediation storage to their consumers', () => {
    const queueConsumer = json('workers/queue-consumers/wrangler.jsonc')
    const apiTemplate = json('infra/cloudflare/wrangler.template.jsonc')
    expect(queueConsumer.r2_buckets).toEqual([
      { binding: 'AUDIT_ARCHIVE', bucket_name: 'gridora-audit-archive' },
      { binding: 'LOGS', bucket_name: 'gridora-logs' },
      {
        binding: 'NOTIFICATION_REMEDIATION',
        bucket_name: 'gridora-notification-remediation',
      },
    ])
    expect(apiTemplate.r2_buckets).toContainEqual(
      expect.objectContaining({
        binding: 'NOTIFICATION_REMEDIATION',
        bucket_name: 'gridora-notification-remediation',
      }),
    )
  })

  it('requires immutable application image references', () => {
    const game = read('infra/docker/game-service.example.yaml')
    expect(game).toContain('GAME_IMAGE:?')
    expect(game).not.toMatch(/image:\s+[^$].*:latest/)
    expect(game).toContain('cap_drop: [ALL]')
    expect(game).toContain('no-new-privileges:true')
    expect(game).toContain('internal: false')
  })

  it('declares all private storage and scheduled queue resources in Terraform', () => {
    const terraform = read('infra/cloudflare/terraform/main.tf')
    expect(terraform).toContain('"backups"')
    expect(terraform).toContain('"logs"')
    expect(terraform).toContain('"policy-reconciliation"')
    expect(terraform).toContain('"policy-reconciliation-dlq"')
  })

  it('gates one multi-domain Access application and enables bounded Managed OAuth', () => {
    const terraform = read('infra/cloudflare/terraform/main.tf')
    const variables = read('infra/cloudflare/terraform/variables.tf')
    expect(terraform).toContain(
      'var.enable_resource_creation && var.enable_access_applications ? 1 : 0',
    )
    expect(terraform).toContain('resource "cloudflare_zero_trust_access_application" "console_api"')
    expect(terraform).not.toContain('resource "cloudflare_zero_trust_access_application" "console"')
    expect(terraform).not.toContain('resource "cloudflare_zero_trust_access_application" "api"')
    expect(terraform).toContain('destinations = [{')
    expect(terraform).toContain('uri  = var.console_hostname')
    expect(terraform).toContain('uri  = var.api_hostname')
    expect(terraform).toContain(
      'resource "cloudflare_zero_trust_access_application" "origin_authenticated"',
    )
    expect(terraform).toContain('agent    = "/v1/agent/*"')
    expect(terraform).toContain('internal = "/v1/internal/*"')
    expect(terraform).toContain(
      'resource "cloudflare_zero_trust_access_application" "public_auth_intent"',
    )
    expect(terraform).toContain('domain     = "${var.api_hostname}/v1/auth/intents"')
    expect(terraform).toContain('decision   = "bypass"')
    expect(terraform).toContain('oauth_configuration = {')
    expect(terraform).toContain('allow_any_on_loopback')
    expect(terraform).toContain('"https://${var.console_hostname}"')
    expect(terraform).toContain('allowed_origins = ["https://${var.public_app_hostname}"]')
    expect(terraform).toContain('allow_credentials = true')
    expect(terraform).toContain('access_token_lifetime = var.access_oauth_token_lifetime')
    expect(terraform).toContain('session_duration      = var.access_oauth_grant_duration')
    expect(variables).toContain('default     = false')
    expect(variables).toContain('default     = "15m"')
    expect(variables).toContain('default     = "336h"')

    const nonBrowserApplication = terraform.slice(
      terraform.indexOf(
        'resource "cloudflare_zero_trust_access_application" "origin_authenticated"',
      ),
      terraform.indexOf('resource "cloudflare_zero_trust_access_application" "public_auth_intent"'),
    )
    expect(nonBrowserApplication).not.toContain('cors_headers')
  })

  it('requires an explicit policy for game egress', () => {
    const permissioned = read('infra/docker/game-service-egress.example.yaml')
    const firewall = read('infra/images/nftables/gridora.nft')
    expect(permissioned).toContain('GRIDORA_NETWORK_POLICY_ID:?')
    expect(permissioned).toContain('internal: false')
    expect(firewall).toContain('type ifname . ipv4_addr . inet_proto . inet_service')
    expect(firewall).toContain('meta iifname . ip daddr . meta l4proto . th dport')
    expect(firewall).not.toContain('iifname "docker0" oifname != "docker0" accept')
  })

  it('gates image promotion', () => {
    const promote = read('infra/scripts/promote-image.sh')
    expect(promote).toContain('GRIDORA_PROMOTION_APPROVED')
    expect(promote).toContain('rollback.imageId')
  })
})
