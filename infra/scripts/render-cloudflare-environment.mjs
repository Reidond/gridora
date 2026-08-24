#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const configSources = [
  'infra/cloudflare/wrangler.template.jsonc',
  'apps/api/wrangler.jsonc',
  'apps/web/wrangler.jsonc',
  'workers/realtime/wrangler.jsonc',
  'workers/workflows/wrangler.jsonc',
  'workers/queue-consumers/wrangler.jsonc',
]

const fail = (message) => {
  process.stderr.write(`Cloudflare environment rendering failed: ${message}\n`)
  process.exitCode = 1
  throw new Error(message)
}

const usage = () =>
  fail(
    'usage: node infra/scripts/render-cloudflare-environment.mjs --environment-file <file> --out-dir <directory>',
  )

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  if (index < 0 || args[index + 1] === undefined) usage()
  return args[index + 1]
}

if (args.length !== 4 || !args.includes('--environment-file') || !args.includes('--out-dir'))
  usage()

const environmentFile = resolve(process.cwd(), option('--environment-file'))
const outputDirectory = resolve(process.cwd(), option('--out-dir'))

const parseJsonc = (source, path) => {
  try {
    return JSON.parse(source.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    fail(`${path} must be valid JSON or JSONC with trailing commas only`)
  }
}

const input = parseJsonc(readFileSync(environmentFile, 'utf8'), environmentFile)

const requiredString = (name) => {
  const value = input[name]
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(`${name} must be a non-empty string in ${environmentFile}`)
  if (value.includes('replace-with')) fail(`${name} must not use a placeholder value`)
  return value
}

const requiredBoolean = (name) => {
  const value = input[name]
  if (typeof value !== 'boolean') fail(`${name} must be a boolean in ${environmentFile}`)
  return value
}

const matches = (name, value, pattern, description) => {
  if (!pattern.test(value)) fail(`${name} ${description}`)
  return value
}

const hostname = (name) =>
  matches(
    name,
    requiredString(name),
    /^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}$/,
    'must be a lowercase DNS hostname',
  )

const environment = requiredString('environment')
if (environment !== 'staging' && environment !== 'production')
  fail('environment must be staging or production')

const resourcePrefix = requiredString('resourcePrefix')
if (resourcePrefix !== `gridora-${environment}`)
  fail(`resourcePrefix must be exactly gridora-${environment}`)

const accountId = matches(
  'accountId',
  requiredString('accountId'),
  /^[0-9a-f]{32}$/,
  'must be a 32-character lowercase hexadecimal Cloudflare account ID',
)
const zoneId = matches(
  'zoneId',
  requiredString('zoneId'),
  /^[0-9a-f]{32}$/,
  'must be a 32-character lowercase hexadecimal Cloudflare zone ID',
)
const d1DatabaseId = matches(
  'd1DatabaseId',
  requiredString('d1DatabaseId'),
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'must be a lowercase UUID returned by Terraform for the D1 database',
)
const secretsStoreId = matches(
  'secretsStoreId',
  requiredString('secretsStoreId'),
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  'must be a lowercase Secrets Store ID',
)
const zoneName = hostname('zoneName')
const apiHostname = hostname('apiHostname')
const publicAppHostname = hostname('publicAppHostname')
const consoleHostname = hostname('consoleHostname')
const dnsTarget = hostname('dnsTarget')

// A production deployment is reachable only on the reviewed custom domains.
// The managed zone stays the same for both environments; staging is an
// environment label inside the Gridora product namespace. This makes it impossible for a
// staging input to point a rendered Worker or DNS binding at a production
// hostname merely by supplying a syntactically-valid DNS name.
const productHostname = `gridora.${zoneName}`
const environmentProductHostname =
  environment === 'production' ? productHostname : `${environment}.${productHostname}`
const expectedHostnames = {
  apiHostname: `api.${environmentProductHostname}`,
  publicAppHostname: environmentProductHostname,
  consoleHostname: `console.${environmentProductHostname}`,
  dnsTarget: `nodes.${environmentProductHostname}`,
}
const assertEnvironmentHostname = (name, value) => {
  if (value !== expectedHostnames[name])
    fail(`${name} must equal ${expectedHostnames[name]} for ${environment}`)
}

assertEnvironmentHostname('apiHostname', apiHostname)
assertEnvironmentHostname('publicAppHostname', publicAppHostname)
assertEnvironmentHostname('consoleHostname', consoleHostname)
assertEnvironmentHostname('dnsTarget', dnsTarget)
const accessIssuer = requiredString('accessIssuer').replace(/\/$/, '')
try {
  const url = new URL(accessIssuer)
  if (url.protocol !== 'https:' || url.origin !== accessIssuer)
    fail('accessIssuer must be an https origin without a path, query, or fragment')
} catch {
  fail('accessIssuer must be an https origin')
}
const accessAudience = matches(
  'accessAudience',
  requiredString('accessAudience'),
  /^[A-Za-z0-9._:-]+$/,
  'must be a non-secret Access audience value without whitespace',
)
const invitationEmailFrom = matches(
  'invitationEmailFrom',
  requiredString('invitationEmailFrom'),
  /^[^\s@]+@[^\s@]+$/,
  'must be a valid sender email address',
)
const invitationEmailDomain = invitationEmailFrom.slice(invitationEmailFrom.lastIndexOf('@') + 1)
if (invitationEmailDomain !== zoneName && !invitationEmailDomain.endsWith(`.${zoneName}`))
  fail('invitationEmailFrom must use the declared zoneName')
const agentCommandSigningPublicKeyPem = requiredString('agentCommandSigningPublicKeyPem')
if (!agentCommandSigningPublicKeyPem.includes('BEGIN PUBLIC KEY'))
  fail('agentCommandSigningPublicKeyPem must contain a public PEM header')
const nodeImageTrustedPublicKeyDigests = requiredString('nodeImageTrustedPublicKeyDigests')
if (
  !nodeImageTrustedPublicKeyDigests
    .split(',')
    .every((digest) => /^sha256:[0-9a-f]{64}$/.test(digest.trim()))
)
  fail('nodeImageTrustedPublicKeyDigests must be comma-separated sha256: digests')
const agentVersion = matches(
  'agentVersion',
  requiredString('agentVersion'),
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
  'must be a semantic version',
)
const nodeBootstrapTtlSeconds = input.nodeBootstrapTtlSeconds
if (!Number.isSafeInteger(nodeBootstrapTtlSeconds) || nodeBootstrapTtlSeconds < 60)
  fail('nodeBootstrapTtlSeconds must be an integer of at least 60')
const invitationTokenKeyVersion = matches(
  'invitationTokenKeyVersion',
  requiredString('invitationTokenKeyVersion'),
  /^v[1-9][0-9]*$/,
  'must be a positive vN version',
)
const providerKekActiveVersion = matches(
  'providerKekActiveVersion',
  requiredString('providerKekActiveVersion'),
  /^[1-9][0-9]*$/,
  'must be a positive numeric key version',
)
const nodeRegistrationTokenKeyVersion = matches(
  'nodeRegistrationTokenKeyVersion',
  requiredString('nodeRegistrationTokenKeyVersion'),
  /^[1-9][0-9]*$/,
  'must be a positive numeric key version',
)
const registrationMode = requiredString('registrationMode')
if (!['open', 'invitation-only'].includes(registrationMode))
  fail('registrationMode must be open or invitation-only')
const providerByopEnabled = requiredBoolean('providerByopEnabled')

const resourceName = (name) => {
  if (name === 'gridora-control-plane') return resourcePrefix
  if (!name.startsWith('gridora-')) return name
  return `${resourcePrefix}-${name.slice('gridora-'.length)}`
}

const rewriteRelativePath = (sourceDirectory, outputFile, sourcePath) => {
  if (typeof sourcePath !== 'string') return sourcePath
  const target = resolve(sourceDirectory, sourcePath)
  const rendered = relative(dirname(outputFile), target).split(sep).join('/')
  return rendered === '' ? '.' : rendered
}

const rewritePaths = (config, sourceFile, outputFile) => {
  const sourceDirectory = dirname(sourceFile)
  config.$schema = rewriteRelativePath(sourceDirectory, outputFile, config.$schema)
  config.main = rewriteRelativePath(sourceDirectory, outputFile, config.main)
  if (config.assets?.directory !== undefined)
    config.assets.directory = rewriteRelativePath(
      sourceDirectory,
      outputFile,
      config.assets.directory,
    )
  for (const binding of config.d1_databases ?? [])
    if (binding.migrations_dir !== undefined)
      binding.migrations_dir = rewriteRelativePath(
        sourceDirectory,
        outputFile,
        binding.migrations_dir,
      )
}

const customDomainRoutesBySource = new Map([
  ['infra/cloudflare/wrangler.template.jsonc', [apiHostname]],
  ['apps/api/wrangler.jsonc', [apiHostname]],
  ['apps/web/wrangler.jsonc', [publicAppHostname, consoleHostname]],
])

const customDomainRoute = (hostname) => ({ pattern: hostname, custom_domain: true })

const applyDeploymentExposure = (config, sourceRelativePath) => {
  // Cloudflare defaults workers.dev to enabled when neither routes nor this
  // setting are present. All reviewed deployments are either custom-domain
  // HTTP entrypoints or service/event-only Workers, so neither workers.dev nor
  // version preview URLs are a valid production ingress.
  config.workers_dev = false
  config.preview_urls = false
  delete config.route

  const hostnames = customDomainRoutesBySource.get(sourceRelativePath)
  if (hostnames === undefined) {
    delete config.routes
    return
  }

  config.routes = hostnames.map(customDomainRoute)
}

const assertDeploymentExposure = (config, sourceRelativePath) => {
  if (config.workers_dev !== false)
    fail(`${sourceRelativePath} must set workers_dev to false in rendered configuration`)
  if (config.preview_urls !== false)
    fail(`${sourceRelativePath} must set preview_urls to false in rendered configuration`)
  if (config.route !== undefined)
    fail(`${sourceRelativePath} must not use the singular route setting in rendered configuration`)

  const expectedHostnames = customDomainRoutesBySource.get(sourceRelativePath)
  if (expectedHostnames === undefined) {
    if (config.routes !== undefined)
      fail(`${sourceRelativePath} is service or event-only and must not expose a public route`)
    return
  }

  const expectedRoutes = expectedHostnames.map(customDomainRoute)
  if (JSON.stringify(config.routes) !== JSON.stringify(expectedRoutes))
    fail(`${sourceRelativePath} must expose only its reviewed custom domain routes`)
}

const applyEnvironmentBindings = (config, sourceRelativePath) => {
  config.name = resourceName(config.name)
  applyDeploymentExposure(config, sourceRelativePath)

  for (const binding of config.d1_databases ?? []) {
    binding.database_name = resourcePrefix
    binding.database_id = d1DatabaseId
  }
  for (const binding of config.r2_buckets ?? [])
    binding.bucket_name = resourceName(binding.bucket_name)
  for (const binding of config.queues?.producers ?? []) binding.queue = resourceName(binding.queue)
  for (const binding of config.queues?.consumers ?? []) {
    binding.queue = resourceName(binding.queue)
    if (binding.dead_letter_queue !== undefined)
      binding.dead_letter_queue = resourceName(binding.dead_letter_queue)
  }
  for (const binding of config.services ?? []) binding.service = resourceName(binding.service)
  for (const binding of config.durable_objects?.bindings ?? [])
    if (binding.script_name !== undefined) binding.script_name = resourceName(binding.script_name)
  for (const binding of config.workflows ?? []) {
    binding.name = resourceName(binding.name)
    if (binding.script_name !== undefined) binding.script_name = resourceName(binding.script_name)
  }
  for (const binding of config.secrets_store_secrets ?? []) {
    binding.store_id = secretsStoreId
    binding.secret_name = resourceName(binding.secret_name)
  }

  if (config.vars !== undefined) {
    if ('ACCESS_ISSUER' in config.vars) config.vars.ACCESS_ISSUER = accessIssuer
    if ('ACCESS_AUDIENCE' in config.vars) config.vars.ACCESS_AUDIENCE = accessAudience
    if ('PUBLIC_APP_ORIGIN' in config.vars)
      config.vars.PUBLIC_APP_ORIGIN = `https://${publicAppHostname}`
    if ('CONSOLE_ORIGIN' in config.vars) config.vars.CONSOLE_ORIGIN = `https://${consoleHostname}`
    if ('CLOUDFLARE_ACCOUNT_ID' in config.vars) config.vars.CLOUDFLARE_ACCOUNT_ID = accountId
    if ('CLOUDFLARE_DNS_ZONE_ID' in config.vars) config.vars.CLOUDFLARE_DNS_ZONE_ID = zoneId
    if ('CONTROL_PLANE_URL' in config.vars)
      config.vars.CONTROL_PLANE_URL = `https://${apiHostname}/`
    if ('AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM' in config.vars)
      config.vars.AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM = agentCommandSigningPublicKeyPem
    if ('NODE_IMAGE_TRUSTED_PUBLIC_KEY_DIGESTS' in config.vars)
      config.vars.NODE_IMAGE_TRUSTED_PUBLIC_KEY_DIGESTS = nodeImageTrustedPublicKeyDigests
    if ('AGENT_VERSION' in config.vars) config.vars.AGENT_VERSION = agentVersion
    if ('NODE_BOOTSTRAP_TTL_SECONDS' in config.vars)
      config.vars.NODE_BOOTSTRAP_TTL_SECONDS = String(nodeBootstrapTtlSeconds)
    if ('INVITATION_TOKEN_KEY_VERSION' in config.vars)
      config.vars.INVITATION_TOKEN_KEY_VERSION = invitationTokenKeyVersion
    if ('PROVIDER_KEK_ACTIVE_VERSION' in config.vars)
      config.vars.PROVIDER_KEK_ACTIVE_VERSION = providerKekActiveVersion
    if ('NODE_REGISTRATION_TOKEN_KEY_VERSION' in config.vars)
      config.vars.NODE_REGISTRATION_TOKEN_KEY_VERSION = nodeRegistrationTokenKeyVersion
    if ('REGISTRATION_MODE' in config.vars) config.vars.REGISTRATION_MODE = registrationMode
    if ('PROVIDER_BYOP_ENABLED' in config.vars)
      config.vars.PROVIDER_BYOP_ENABLED = String(providerByopEnabled)
    if ('PUBLIC_APP_URL' in config.vars) config.vars.PUBLIC_APP_URL = `https://${publicAppHostname}`
    if ('INVITATION_EMAIL_FROM' in config.vars)
      config.vars.INVITATION_EMAIL_FROM = invitationEmailFrom
    if ('NUXT_PUBLIC_API_BASE' in config.vars)
      config.vars.NUXT_PUBLIC_API_BASE = `https://${apiHostname}`
    if ('NUXT_PUBLIC_DATA_MODE' in config.vars) config.vars.NUXT_PUBLIC_DATA_MODE = 'api'
    if ('NUXT_PUBLIC_ACCESS_COMPLETION_URL' in config.vars)
      config.vars.NUXT_PUBLIC_ACCESS_COMPLETION_URL = `https://${consoleHostname}/auth/complete`
    if ('NUXT_PUBLIC_PUBLIC_APP_ORIGIN' in config.vars)
      config.vars.NUXT_PUBLIC_PUBLIC_APP_ORIGIN = `https://${publicAppHostname}`
  }
  for (const binding of config.send_email ?? [])
    binding.allowed_sender_addresses = [invitationEmailFrom]
}

const assertNoPlaceholder = (value, path = 'config') => {
  if (typeof value === 'string') {
    if (value.includes('replace-with') || value.includes('your-team.cloudflareaccess.com'))
      fail(`${path} still contains a deployment placeholder`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaceholder(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) assertNoPlaceholder(entry, `${path}.${key}`)
}

const renderedConfigs = []
for (const sourceRelativePath of configSources) {
  const sourceFile = resolve(root, sourceRelativePath)
  const outputFile = resolve(outputDirectory, sourceRelativePath)
  const config = parseJsonc(readFileSync(sourceFile, 'utf8'), sourceRelativePath)
  applyEnvironmentBindings(config, sourceRelativePath)
  rewritePaths(config, sourceFile, outputFile)
  assertNoPlaceholder(config, sourceRelativePath)
  assertDeploymentExposure(config, sourceRelativePath)
  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(outputFile, `${JSON.stringify(config, null, 2)}\n`)
  renderedConfigs.push({ source: sourceRelativePath, rendered: outputFile })
}

process.stdout.write(
  `${JSON.stringify({ environment, resourcePrefix, configs: renderedConfigs }, null, 2)}\n`,
)
