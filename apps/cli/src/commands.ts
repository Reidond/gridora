import { Effect } from 'effect'
import type { ApiRequest } from './client.js'
import { CliError, ExitCode } from './errors.js'
import type { OutputFormat } from './output.js'

export interface ParsedCommand {
  readonly request?: ApiRequest
  readonly localAction?: 'auth-login' | 'auth-logout' | 'auth-status' | 'organization-switch'
  /** Uses the generated manifest client rather than the untyped compatibility port. */
  readonly manifestAction?: 'export' | 'validate' | 'draft' | 'plan' | 'apply' | 'schedule'
  readonly organization?: string
  readonly format: OutputFormat
  readonly wait: boolean
  readonly localOnly: boolean
  readonly timeoutMs: number
  readonly file?: string
  readonly positional: ReadonlyArray<string>
  /** The archive request always runs first; follow then consumes one live ticket. */
  readonly liveLogs?: {
    readonly serverId: string
    readonly component?:
      | 'agent'
      | 'cloudflared'
      | 'traefik'
      | 'docker'
      | 'game'
      | 'installer'
      | 'updater'
      | 'plugin-health'
      | 'provider-workflow'
    readonly level?: 'debug' | 'info' | 'warn' | 'error'
    readonly from?: string
    readonly to?: string
  }
}

type Route = Pick<ApiRequest, 'method' | 'path' | 'body' | 'organizationScoped'>

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const organizationIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const logComponents = [
  'agent',
  'cloudflared',
  'traefik',
  'docker',
  'game',
  'installer',
  'updater',
  'plugin-health',
  'provider-workflow',
] as const
const logLevels = ['debug', 'info', 'warn', 'error'] as const

const tenant = (method: ApiRequest['method'], path: string, body?: unknown): Route => ({
  method,
  path,
  organizationScoped: true,
  ...(body === undefined ? {} : { body }),
})

const platform = (method: ApiRequest['method'], path: string, body?: unknown): Route => ({
  method,
  path,
  ...(body === undefined ? {} : { body }),
})

const requireIdentifier = (value: string | undefined, label: string): string => {
  if (value === undefined || !identifier.test(value)) throw new Error(`${label} is invalid`)
  return value
}

const unsupported = (command: string): never => {
  throw new Error(`${command} is not supported by the current API`)
}

const query = (values: Readonly<Record<string, string | number | undefined>>): string => {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, String(value))
  }
  const encoded = parameters.toString()
  return encoded.length === 0 ? '' : `?${encoded}`
}

export const parseCommand = (argv: ReadonlyArray<string>): Effect.Effect<ParsedCommand, CliError> =>
  Effect.try({
    try: () => {
      const positional: string[] = []
      let organization: string | undefined
      let format: OutputFormat = 'table'
      let formatSpecified = false
      let wait = false
      let localOnly = false
      let timeoutMs = 300_000
      let timeoutSpecified = false
      let idempotencyKey: string | undefined
      let file: string | undefined
      let role: string | undefined
      let expectedRevision: number | undefined
      let email: string | undefined
      let expiresAt: string | undefined
      let targetIdentityId: string | undefined
      let targetNodeId: string | undefined
      let targetImageId: string | undefined
      let expectedConfigRevision: number | undefined
      let expectedModRevision: number | undefined
      let backupBeforeUpdate = false
      let backupPolicy:
        | 'required'
        | 'skip-authorized'
        | 'retain'
        | 'delete-after-retention'
        | undefined
      let organizationName: string | undefined
      let organizationSlug: string | undefined
      let timezone: string | undefined
      let defaultRegion: string | undefined
      let termsAccepted = false
      let budgetWarningThresholdMinor: number | undefined
      let budgetWarningCurrency: string | undefined
      let placementMode: 'shared' | 'dedicated' | undefined
      let temporaryLifetimeHours: number | undefined
      let nonHourlyCommitmentConfirmed = false
      let force = false
      let follow = false
      let logComponent: (typeof logComponents)[number] | undefined
      let logLevel: (typeof logLevels)[number] | undefined
      let logFrom: string | undefined
      let logTo: string | undefined
      let logLimit: number | undefined
      let logCursor: string | undefined

      for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index]
        if (token === '--wait') {
          wait = true
          continue
        }
        if (token === '--local-only') {
          localOnly = true
          continue
        }
        if (token === '--terms-accepted') {
          termsAccepted = true
          continue
        }
        if (token === '--confirm-non-hourly-commitment') {
          nonHourlyCommitmentConfirmed = true
          continue
        }
        if (token === '--backup-before-update') {
          backupBeforeUpdate = true
          continue
        }
        if (token === '--force') {
          force = true
          continue
        }
        if (token === '--follow') {
          follow = true
          continue
        }
        if (
          [
            '--organization',
            '--output',
            '--timeout',
            '--idempotency-key',
            '--file',
            '-f',
            '--role',
            '--expected-revision',
            '--email',
            '--expires-at',
            '--target-identity',
            '--node',
            '--target-image',
            '--expected-config-revision',
            '--expected-mod-revision',
            '--backup-policy',
            '--name',
            '--slug',
            '--timezone',
            '--default-region',
            '--budget-warning-threshold-minor',
            '--budget-warning-currency',
            '--placement-mode',
            '--temporary-lifetime-hours',
            '--component',
            '--level',
            '--from',
            '--to',
            '--limit',
            '--cursor',
          ].includes(token ?? '')
        ) {
          const value = argv[index + 1]
          if (value === undefined) throw new Error(`${token} requires a value`)
          index += 1
          if (token === '--organization') organization = value
          else if (token === '--output') {
            if (!(['table', 'json', 'yaml'] as const).includes(value as OutputFormat))
              throw new Error('--output must be table, json, or yaml')
            format = value as OutputFormat
            formatSpecified = true
          } else if (token === '--timeout') {
            timeoutMs = Number(value)
            timeoutSpecified = true
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
              throw new Error('--timeout must be a positive millisecond count')
          } else if (token === '--idempotency-key') idempotencyKey = value
          else if (token === '--role') role = value
          else if (token === '--expected-revision') {
            expectedRevision = Number(value)
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
              throw new Error('--expected-revision must be a positive integer')
          } else if (token === '--email') email = value
          else if (token === '--expires-at') expiresAt = value
          else if (token === '--target-identity') targetIdentityId = value
          else if (token === '--node') targetNodeId = value
          else if (token === '--target-image') targetImageId = value
          else if (token === '--expected-config-revision') {
            expectedConfigRevision = Number(value)
            if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 1)
              throw new Error('--expected-config-revision must be a positive integer')
          } else if (token === '--expected-mod-revision') {
            expectedModRevision = Number(value)
            if (!Number.isSafeInteger(expectedModRevision) || expectedModRevision < 0)
              throw new Error('--expected-mod-revision must be a non-negative integer')
          } else if (token === '--backup-policy') {
            if (
              !['required', 'skip-authorized', 'retain', 'delete-after-retention'].includes(value)
            )
              throw new Error('--backup-policy is invalid')
            backupPolicy = value as NonNullable<typeof backupPolicy>
          } else if (token === '--name') organizationName = value
          else if (token === '--slug') organizationSlug = value
          else if (token === '--timezone') timezone = value
          else if (token === '--default-region') defaultRegion = value
          else if (token === '--budget-warning-threshold-minor') {
            budgetWarningThresholdMinor = Number(value)
            if (
              !Number.isSafeInteger(budgetWarningThresholdMinor) ||
              budgetWarningThresholdMinor < 0
            )
              throw new Error('--budget-warning-threshold-minor must be a non-negative integer')
          } else if (token === '--budget-warning-currency') budgetWarningCurrency = value
          else if (token === '--placement-mode') {
            if (value !== 'shared' && value !== 'dedicated')
              throw new Error('--placement-mode must be shared or dedicated')
            placementMode = value
          } else if (token === '--temporary-lifetime-hours') {
            temporaryLifetimeHours = Number(value)
            if (!Number.isSafeInteger(temporaryLifetimeHours) || temporaryLifetimeHours < 1)
              throw new Error('--temporary-lifetime-hours must be a positive integer')
          } else if (token === '--component') {
            if (!(logComponents as readonly string[]).includes(value))
              throw new Error('--component is not a supported log component')
            logComponent = value as (typeof logComponents)[number]
          } else if (token === '--level') {
            if (!(logLevels as readonly string[]).includes(value))
              throw new Error('--level must be debug, info, warn, or error')
            logLevel = value as (typeof logLevels)[number]
          } else if (token === '--from') logFrom = value
          else if (token === '--to') logTo = value
          else if (token === '--limit') {
            logLimit = Number(value)
            if (!Number.isSafeInteger(logLimit) || logLimit < 1 || logLimit > 100)
              throw new Error('--limit must be an integer between 1 and 100')
          } else if (token === '--cursor') {
            if (value.length < 1 || value.length > 4096) throw new Error('--cursor is invalid')
            logCursor = value
          } else file = value
          continue
        }
        if (token?.startsWith('-')) throw new Error(`unknown option ${token}`)
        if (token !== undefined) positional.push(token)
      }

      if (organization !== undefined && !organizationIdentifier.test(organization))
        throw new Error('--organization is invalid')
      if (
        idempotencyKey !== undefined &&
        (idempotencyKey.length < 8 || idempotencyKey.length > 255)
      )
        throw new Error('--idempotency-key must contain between 8 and 255 characters')
      if (organizationSlug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(organizationSlug))
        throw new Error('--slug is invalid')
      if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error('--email is invalid')
      if (
        expiresAt !== undefined &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt)
      )
        throw new Error('--expires-at must be an ISO UTC timestamp')
      for (const [flag, timestamp] of [
        ['--from', logFrom],
        ['--to', logTo],
      ] as const) {
        if (
          timestamp !== undefined &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
            !Number.isFinite(Date.parse(timestamp)) ||
            new Date(Date.parse(timestamp)).toISOString() !== timestamp)
        )
          throw new Error(`${flag} must be an ISO UTC timestamp`)
      }
      if (logFrom !== undefined && logTo !== undefined && logTo < logFrom)
        throw new Error('--to must not precede --from')
      if (budgetWarningCurrency !== undefined && !/^[A-Z]{3}$/.test(budgetWarningCurrency))
        throw new Error('--budget-warning-currency must be an uppercase ISO 4217 code')
      if ((budgetWarningThresholdMinor === undefined) !== (budgetWarningCurrency === undefined))
        throw new Error('budget warning threshold and currency must be provided together')

      const [group, action, id, nestedAction, nestedId] = positional
      let localAction: ParsedCommand['localAction']
      let manifestAction: ParsedCommand['manifestAction']
      let route: Route | undefined
      let liveLogs: ParsedCommand['liveLogs']

      if (group === 'auth' && ['login', 'logout', 'status'].includes(action ?? '')) {
        if (positional.length !== 2) throw new Error('auth command has unexpected arguments')
        localAction = `auth-${action}` as ParsedCommand['localAction']
      } else if (group === 'organizations' && action === 'switch') {
        const organizationId = requireIdentifier(id, 'organization')
        if (positional.length !== 3)
          throw new Error('organizations switch has unexpected arguments')
        localAction = 'organization-switch'
        route = platform('POST', `/v1/organizations/${organizationId}/actions/switch`)
      } else if (group === 'organizations' && action === 'list') {
        route = platform('GET', '/v1/me/organizations')
      } else if (group === 'organizations' && action === 'show') {
        route = platform('GET', `/v1/organizations/${requireIdentifier(id, 'organization')}`)
      } else if (group === 'organizations' && action === 'update') {
        const organizationId = requireIdentifier(id, 'organization')
        if (
          organizationName === undefined ||
          timezone === undefined ||
          defaultRegion === undefined ||
          expectedRevision === undefined
        )
          throw new Error(
            'organizations update requires --name, --timezone, --default-region, and --expected-revision',
          )
        route = platform('PUT', `/v1/organizations/${organizationId}`, {
          name: organizationName,
          timezone,
          defaultRegion,
          expectedRevision,
        })
      } else if (group === 'organizations' && action === 'create') {
        if (
          organizationName === undefined ||
          organizationSlug === undefined ||
          timezone === undefined ||
          defaultRegion === undefined ||
          !termsAccepted
        )
          throw new Error(
            'organizations create requires --name, --slug, --timezone, --default-region, and --terms-accepted',
          )
        route = platform('POST', '/v1/organizations', {
          name: organizationName,
          slug: organizationSlug,
          timezone,
          defaultRegion,
          termsAccepted: true,
          ...(budgetWarningThresholdMinor === undefined
            ? {}
            : { budgetWarningThresholdMinor, budgetWarningCurrency }),
        })
      } else if (group === 'organizations' && action === 'members') {
        const organizationId = requireIdentifier(nestedAction, 'organization')
        if (id === 'list') route = platform('GET', `/v1/organizations/${organizationId}/members`)
        else if (id === 'update') {
          const member = requireIdentifier(nestedId, 'member')
          if (role === undefined || expectedRevision === undefined)
            throw new Error('members update requires --role and --expected-revision')
          if (!['owner', 'administrator', 'operator', 'viewer', 'automation'].includes(role))
            throw new Error('--role is not a valid organization role')
          route = platform('PATCH', `/v1/organizations/${organizationId}/members/${member}`, {
            identityId: member,
            role,
            expectedRevision,
          })
        } else if (id === 'remove') {
          const member = requireIdentifier(nestedId, 'member')
          if (expectedRevision === undefined)
            throw new Error('members remove requires --expected-revision')
          route = platform('DELETE', `/v1/organizations/${organizationId}/members/${member}`, {
            expectedRevision,
          })
        }
      } else if (group === 'organizations' && action === 'invitations') {
        const organizationId = requireIdentifier(nestedAction, 'organization')
        if (id === 'list')
          route = platform('GET', `/v1/organizations/${organizationId}/invitations`)
        else if (id === 'create') {
          if (email === undefined || role === undefined || expiresAt === undefined)
            throw new Error('invitations create requires --email, --role, and --expires-at')
          if (!['administrator', 'operator', 'viewer'].includes(role))
            throw new Error('--role is not a valid invitation role')
          route = platform('POST', `/v1/organizations/${organizationId}/invitations`, {
            email,
            role,
            expiresAt,
          })
        } else if (id === 'revoke') {
          const invitation = requireIdentifier(nestedId, 'invitation')
          if (expectedRevision === undefined)
            throw new Error('invitations revoke requires --expected-revision')
          route = platform(
            'DELETE',
            `/v1/organizations/${organizationId}/invitations/${invitation}`,
            { expectedRevision },
          )
        } else if (id === 'resend') {
          const invitation = requireIdentifier(nestedId, 'invitation')
          if (expectedRevision === undefined || expiresAt === undefined)
            throw new Error('invitations resend requires --expected-revision and --expires-at')
          route = platform(
            'POST',
            `/v1/organizations/${organizationId}/invitations/${invitation}/actions/resend`,
            { expectedRevision, expiresAt },
          )
        }
      } else if (group === 'organizations' && action === 'ownership' && id === 'transfer') {
        const organizationId = requireIdentifier(nestedAction, 'organization')
        const target = requireIdentifier(targetIdentityId, 'target identity')
        route = platform('POST', `/v1/organizations/${organizationId}/actions/transfer-ownership`, {
          targetIdentityId: target,
        })
      } else if (group === 'organizations' && action === 'leave') {
        const organizationId = requireIdentifier(id, 'organization')
        if (expectedRevision === undefined)
          throw new Error('organizations leave requires --expected-revision')
        route = platform('POST', `/v1/organizations/${organizationId}/actions/leave`, {
          expectedRevision,
        })
      } else if (group === 'organizations' && action === 'delete') {
        const organizationId = requireIdentifier(id, 'organization')
        if (
          expectedRevision === undefined ||
          (backupPolicy !== 'retain' && backupPolicy !== 'delete-after-retention')
        )
          throw new Error(
            'organizations delete requires --expected-revision and --backup-policy retain or delete-after-retention',
          )
        route = platform('DELETE', `/v1/organizations/${organizationId}`, {
          expectedOrganizationRevision: expectedRevision,
          typedSlug: organizationId,
          backupPolicy,
        })
      } else if (group === 'organizations') {
        unsupported(`organizations ${action ?? ''}`.trim())
      } else if (group === 'plugins' && action === 'list') {
        route = platform('GET', '/v1/plugins')
      } else if (group === 'plugins' && action === 'show') {
        route = platform('GET', `/v1/plugins/${requireIdentifier(id, 'plugin')}`)
      } else if (group === 'providers' && action === 'list') {
        route = tenant('GET', '/v1/provider-accounts')
      } else if (group === 'providers' && (action === 'test' || action === 'refresh')) {
        const account = requireIdentifier(id, 'provider account')
        if (expectedRevision === undefined)
          throw new Error(`providers ${action} requires --expected-revision`)
        route = tenant('POST', `/v1/provider-accounts/${account}/${action}`, {
          expectedRevision,
        })
      } else if (group === 'providers') {
        unsupported(`providers ${action ?? ''}`.trim())
      } else if (group === 'nodes' && action === 'list') {
        route = tenant('GET', '/v1/nodes')
      } else if (group === 'nodes' && action === 'show') {
        route = tenant('GET', `/v1/nodes/${requireIdentifier(id, 'node')}`)
      } else if (group === 'nodes' && action === 'create') {
        if (placementMode === undefined) throw new Error('nodes create requires --placement-mode')
        route = tenant('POST', '/v1/nodes', {
          schemaVersion: 1,
          placementMode,
          temporaryLifetimeHours: temporaryLifetimeHours ?? null,
          nonHourlyCommitmentConfirmed,
        })
      } else if (
        group === 'nodes' &&
        ['start', 'stop', 'reboot', 'reconcile'].includes(action ?? '')
      ) {
        const node = requireIdentifier(id, 'node')
        if (expectedRevision === undefined)
          throw new Error(`nodes ${action} requires --expected-revision`)
        route = tenant('POST', `/v1/nodes/${node}/actions/${action}`, {
          schemaVersion: 1,
          expectedDesiredRevision: expectedRevision,
        })
      } else if (group === 'nodes' && ['drain', 'uncordon', 'rebuild'].includes(action ?? '')) {
        const node = requireIdentifier(id, 'node')
        if (expectedRevision === undefined)
          throw new Error(`nodes ${action} requires --expected-revision`)
        if (backupPolicy !== 'required' && backupPolicy !== 'skip-authorized')
          throw new Error(`nodes ${action} requires --backup-policy required or skip-authorized`)
        if (action === 'rebuild' && targetImageId === undefined)
          throw new Error('nodes rebuild requires --target-image')
        route = tenant('POST', `/v1/nodes/${node}/actions/${action}`, {
          schemaVersion: 1,
          expectedNodeRevision: expectedRevision,
          force,
          backupPolicy,
          ...(action === 'rebuild'
            ? { targetImageId: requireIdentifier(targetImageId, 'target image') }
            : {}),
        })
      } else if (group === 'nodes' && action === 'delete') {
        const node = requireIdentifier(id, 'node')
        if (expectedRevision === undefined)
          throw new Error('nodes delete requires --expected-revision')
        if (backupPolicy !== 'required' && backupPolicy !== 'skip-authorized')
          throw new Error('nodes delete requires --backup-policy required or skip-authorized')
        route = tenant('DELETE', `/v1/nodes/${node}`, {
          schemaVersion: 1,
          expectedNodeRevision: expectedRevision,
          force,
          backupPolicy,
        })
      } else if (group === 'nodes') {
        unsupported(`nodes ${action ?? ''}`.trim())
      } else if (group === 'servers' && action === 'list') {
        route = tenant('GET', '/v1/game-servers')
      } else if (group === 'servers' && action === 'show') {
        route = tenant('GET', `/v1/game-servers/${requireIdentifier(id, 'server')}`)
      } else if (group === 'servers' && action === 'plan') {
        if (file === undefined) throw new Error('servers plan requires --file')
        route = tenant('POST', '/v1/game-servers/plan')
      } else if (group === 'servers' && action === 'apply') {
        if (file === undefined) throw new Error('servers apply requires --file')
        route = tenant('POST', '/v1/game-servers/apply')
      } else if (group === 'manifest' && action === 'export') {
        const server = requireIdentifier(id, 'server')
        manifestAction = 'export'
        route = tenant('GET', `/v1/game-servers/${server}/manifest`)
      } else if (group === 'manifest' && action === 'plan') {
        if (file === undefined) throw new Error('manifest plan requires --file')
        manifestAction = 'plan'
        route = tenant('POST', '/v1/game-server-manifests/plan')
      } else if (group === 'manifest' && action === 'validate') {
        if (file === undefined) throw new Error('manifest validate requires --file')
        manifestAction = 'validate'
        route = tenant('POST', '/v1/game-server-manifests/validate')
      } else if (group === 'manifest' && action === 'draft') {
        if (file === undefined) throw new Error('manifest draft requires --file')
        manifestAction = 'draft'
        route = tenant('POST', '/v1/game-server-drafts')
      } else if (group === 'manifest' && action === 'apply') {
        if (file === undefined) throw new Error('manifest apply requires --file')
        manifestAction = 'apply'
        route = tenant('POST', '/v1/game-server-manifests/apply')
      } else if (group === 'manifest' && action === 'schedule') {
        const draft = requireIdentifier(id, 'draft')
        if (file === undefined) throw new Error('manifest schedule requires --file')
        manifestAction = 'schedule'
        route = tenant('POST', `/v1/game-server-drafts/${draft}/actions/schedule`)
      } else if (group === 'manifest') {
        unsupported(`manifest ${action ?? ''}`.trim())
      } else if (group === 'servers' && ['start', 'stop', 'restart'].includes(action ?? '')) {
        const server = requireIdentifier(id, 'server')
        if (expectedRevision === undefined)
          throw new Error(`servers ${action} requires --expected-revision`)
        route = tenant('POST', `/v1/game-servers/${server}/actions/${action}`, {
          expectedRevision,
          action,
        })
      } else if (group === 'servers' && action === 'move') {
        const server = requireIdentifier(id, 'server')
        if (expectedRevision === undefined || targetNodeId === undefined)
          throw new Error('servers move requires --expected-revision and --node')
        route = tenant('POST', `/v1/game-servers/${server}/actions/move`, {
          expectedRevision,
          action: 'move',
          targetNodeId: requireIdentifier(targetNodeId, 'target node'),
          backupPolicy: 'required',
        })
      } else if (group === 'servers' && action === 'update') {
        const server = requireIdentifier(id, 'server')
        if (expectedRevision === undefined)
          throw new Error('servers update requires --expected-revision')
        if (
          file === undefined &&
          (expectedConfigRevision === undefined || expectedModRevision === undefined)
        )
          throw new Error(
            'servers update requires --file or --expected-config-revision and --expected-mod-revision',
          )
        route = tenant('POST', `/v1/game-servers/${server}/actions/update`, {
          expectedRevision,
          action: 'update',
          ...(expectedConfigRevision === undefined ? {} : { expectedConfigRevision }),
          ...(expectedModRevision === undefined ? {} : { expectedModRevision }),
          backupBeforeUpdate,
        })
      } else if (group === 'servers' && action === 'validate-files') {
        const server = requireIdentifier(id, 'server')
        if (
          expectedRevision === undefined ||
          expectedConfigRevision === undefined ||
          expectedModRevision === undefined
        )
          throw new Error(
            'servers validate-files requires --expected-revision, --expected-config-revision, and --expected-mod-revision',
          )
        route = tenant('POST', `/v1/game-servers/${server}/actions/validate-files`, {
          expectedRevision,
          action: 'update',
          expectedConfigRevision,
          expectedModRevision,
          backupBeforeUpdate,
        })
      } else if (group === 'servers' && action === 'delete') {
        const server = requireIdentifier(id, 'server')
        if (expectedRevision === undefined || backupPolicy === undefined)
          throw new Error('servers delete requires --expected-revision and --backup-policy')
        route = tenant('DELETE', `/v1/game-servers/${server}`, {
          expectedRevision,
          action: 'delete',
          backupPolicy,
        })
      } else if (group === 'servers' && action === 'force-cleanup') {
        const server = requireIdentifier(id, 'server')
        if (expectedRevision === undefined || backupPolicy === undefined)
          throw new Error('servers force-cleanup requires --expected-revision and --backup-policy')
        route = tenant('POST', `/v1/game-servers/${server}/actions/force-cleanup`, {
          expectedRevision,
          action: 'delete',
          backupPolicy,
          forcedCleanup: true,
        })
      } else if (group === 'servers' && action === 'clone') {
        const server = requireIdentifier(id, 'server')
        if (file === undefined) throw new Error('servers clone requires --file')
        route = tenant('POST', `/v1/game-servers/${server}/actions/clone`)
      } else if (group === 'servers' && action === 'config') {
        const server = requireIdentifier(nestedAction, 'server')
        if (id === 'get') route = tenant('GET', `/v1/game-servers/${server}/config`)
        else if (id === 'diff') {
          if (file === undefined) throw new Error('servers config diff requires --file')
          route = tenant('POST', `/v1/game-servers/${server}/config/plan`)
        } else if (id === 'apply') {
          if (expectedRevision === undefined)
            throw new Error('servers config apply requires --expected-revision')
          if (file === undefined) throw new Error('servers config apply requires --file')
          route = tenant('POST', `/v1/game-servers/${server}/config`, {
            expectedRevision,
            action: 'apply-config',
          })
        }
      } else if (group === 'servers') {
        unsupported(`servers ${action ?? ''}`.trim())
      } else if (group === 'mods') {
        const server = requireIdentifier(id, 'server')
        if (action === 'list') route = tenant('GET', `/v1/game-servers/${server}/mods`)
        else if (action === 'plan') {
          if (file === undefined) throw new Error('mods plan requires --file')
          route = tenant('POST', `/v1/game-servers/${server}/mods/plan`)
        } else if (action === 'sync') {
          if (expectedRevision === undefined)
            throw new Error('mods sync requires --expected-revision')
          if (file === undefined) throw new Error('mods sync requires --file')
          route = tenant('PUT', `/v1/game-servers/${server}/mods`, {
            expectedRevision,
            action: 'sync-mods',
          })
        } else unsupported(`mods ${action ?? ''}`.trim())
      } else if (group === 'backups' && action === 'list') {
        route = tenant('GET', `/v1/backups?serverId=${requireIdentifier(id, 'server')}`)
      } else if (group === 'backups' && action === 'create') {
        route = tenant('POST', `/v1/game-servers/${requireIdentifier(id, 'server')}/backups`, {
          schemaVersion: 1,
          includes: ['config', 'data', 'mods', 'state'],
          expiresAt: null,
        })
      } else if (group === 'backups' && action === 'restore') {
        route = tenant('POST', `/v1/backups/${requireIdentifier(id, 'backup')}/actions/restore`, {
          schemaVersion: 1,
          ...(targetNodeId === undefined ? {} : { targetNodeId }),
        })
      } else if (group === 'backups') {
        unsupported(`backups ${action ?? ''}`.trim())
      } else if (group === 'operations' && action === 'list') {
        route = tenant('GET', '/v1/operations')
      } else if (group === 'operations' && ['show', 'watch'].includes(action ?? '')) {
        route = tenant('GET', `/v1/operations/${requireIdentifier(id, 'operation')}`)
      } else if (group === 'operations' && action === 'cancel') {
        if (expectedRevision === undefined)
          throw new Error('operations cancel requires --expected-revision')
        route = tenant(
          'POST',
          `/v1/operations/${requireIdentifier(id, 'operation')}/actions/cancel`,
          {
            expectedOperationRevision: expectedRevision,
          },
        )
      } else if (group === 'operations') {
        unsupported(`operations ${action ?? ''}`.trim())
      } else if (group === 'logs') {
        const serverId = requireIdentifier(action, 'server')
        if (logComponent !== undefined || logLevel !== undefined) {
          if (!follow)
            throw new Error(
              '--component and --level require --follow because archive metadata is not entry-filterable',
            )
        }
        route = tenant(
          'GET',
          `/v1/game-servers/${serverId}/logs${query({
            limit: logLimit,
            from: logFrom,
            to: logTo,
            cursor: logCursor,
          })}`,
        )
        if (follow) {
          liveLogs = {
            serverId,
            ...(logComponent === undefined ? {} : { component: logComponent }),
            ...(logLevel === undefined ? {} : { level: logLevel }),
            ...(logFrom === undefined ? {} : { from: logFrom }),
            ...(logTo === undefined ? {} : { to: logTo }),
          }
        }
      } else if (group === 'console') {
        throw new Error(
          'console is not supported because no current built-in plugin declares console capability',
        )
      }

      if (localAction === undefined && route === undefined)
        throw new Error('unknown or incomplete command')
      if (manifestAction === 'export') {
        if (!formatSpecified) format = 'yaml'
        if (format === 'table') throw new Error('manifest export requires --output yaml or json')
      }
      const expectedPositionals =
        group === 'organizations' && ['members', 'invitations'].includes(action ?? '')
          ? ['update', 'remove', 'revoke', 'resend'].includes(id ?? '')
            ? 5
            : 4
          : group === 'organizations' && action === 'ownership'
            ? 4
            : group === 'servers' && action === 'config'
              ? 4
              : (action === 'list' && group !== 'backups' && group !== 'mods') ||
                  (group === 'organizations' && action === 'create') ||
                  (group === 'nodes' && action === 'create') ||
                  (group === 'servers' && ['apply', 'plan'].includes(action ?? '')) ||
                  (group === 'manifest' &&
                    ['apply', 'plan', 'validate', 'draft'].includes(action ?? ''))
                ? 2
                : group === 'logs'
                  ? 2
                  : localAction !== undefined && group === 'auth'
                    ? 2
                    : 3
      if (positional.length !== expectedPositionals)
        throw new Error('command has unexpected arguments')
      const organizationCreate = group === 'organizations' && action === 'create'
      const organizationUpdate = group === 'organizations' && action === 'update'
      const membershipUpdate = group === 'organizations' && action === 'members' && id === 'update'
      const membershipRemove = group === 'organizations' && action === 'members' && id === 'remove'
      const invitationCreate =
        group === 'organizations' && action === 'invitations' && id === 'create'
      const invitationRevoke =
        group === 'organizations' && action === 'invitations' && id === 'revoke'
      const invitationResend =
        group === 'organizations' && action === 'invitations' && id === 'resend'
      const ownershipTransfer =
        group === 'organizations' && action === 'ownership' && id === 'transfer'
      const organizationLeave = group === 'organizations' && action === 'leave'
      const organizationDelete = group === 'organizations' && action === 'delete'
      const operationCancel = group === 'operations' && action === 'cancel'
      const fileCommand =
        (group === 'servers' && ['apply', 'plan', 'update', 'clone'].includes(action ?? '')) ||
        (group === 'manifest' &&
          ['apply', 'plan', 'validate', 'draft', 'schedule'].includes(action ?? '')) ||
        (group === 'servers' && action === 'config' && id === 'apply') ||
        (group === 'servers' && action === 'config' && id === 'diff') ||
        (group === 'mods' && ['plan', 'sync'].includes(action ?? ''))
      if (
        !organizationCreate &&
        !organizationUpdate &&
        (organizationName !== undefined ||
          organizationSlug !== undefined ||
          timezone !== undefined ||
          defaultRegion !== undefined ||
          termsAccepted ||
          budgetWarningThresholdMinor !== undefined ||
          budgetWarningCurrency !== undefined)
      )
        throw new Error('organization setup options are only valid for organizations create')
      if (
        organizationUpdate &&
        (organizationSlug !== undefined ||
          termsAccepted ||
          budgetWarningThresholdMinor !== undefined ||
          budgetWarningCurrency !== undefined)
      )
        throw new Error(
          'organization slug, terms, and budget setup are immutable in profile update',
        )
      if (!membershipUpdate && !invitationCreate && role !== undefined)
        throw new Error('--role is not valid for this command')
      const gameRevisionOption =
        (group === 'servers' &&
          [
            'update',
            'validate-files',
            'start',
            'stop',
            'restart',
            'delete',
            'force-cleanup',
            'move',
          ].includes(action ?? '')) ||
        (group === 'servers' && action === 'config' && id === 'apply') ||
        (group === 'mods' && action === 'sync')
      const nodeRevisionOption =
        group === 'nodes' &&
        ['start', 'stop', 'reboot', 'reconcile', 'drain', 'uncordon', 'rebuild', 'delete'].includes(
          action ?? '',
        )
      const providerRevisionOption =
        group === 'providers' && ['test', 'refresh'].includes(action ?? '')
      if (
        !membershipUpdate &&
        !membershipRemove &&
        !organizationUpdate &&
        !invitationRevoke &&
        !invitationResend &&
        !organizationLeave &&
        !organizationDelete &&
        !operationCancel &&
        !gameRevisionOption &&
        !nodeRevisionOption &&
        !providerRevisionOption &&
        expectedRevision !== undefined
      )
        throw new Error('--expected-revision is not valid for this command')
      if (
        !gameRevisionOption &&
        (expectedConfigRevision !== undefined || expectedModRevision !== undefined)
      )
        throw new Error('game revision options are not valid for this command')
      if (
        !(group === 'servers' && ['update', 'validate-files'].includes(action ?? '')) &&
        backupBeforeUpdate
      )
        throw new Error('--backup-before-update is only valid for servers update or validate-files')
      if (
        !(group === 'servers' && ['delete', 'force-cleanup'].includes(action ?? '')) &&
        !organizationDelete &&
        !(group === 'nodes' && ['drain', 'uncordon', 'rebuild', 'delete'].includes(action ?? '')) &&
        backupPolicy !== undefined
      )
        throw new Error('--backup-policy is only valid for servers or organizations delete')
      if (
        !invitationCreate &&
        !invitationResend &&
        (email !== undefined || expiresAt !== undefined)
      )
        throw new Error('invitation options are only valid for invitations create or resend')
      if (invitationResend && email !== undefined)
        throw new Error('--email is only valid for invitations create')
      if (!ownershipTransfer && targetIdentityId !== undefined)
        throw new Error('--target-identity is only valid for ownership transfer')
      if (
        !(group === 'servers' && action === 'move') &&
        !(group === 'backups' && action === 'restore') &&
        targetNodeId !== undefined
      )
        throw new Error('--node is only valid for servers move or backups restore')
      if (!(group === 'nodes' && action === 'rebuild') && targetImageId !== undefined)
        throw new Error('--target-image is only valid for nodes rebuild')
      if (
        !(group === 'nodes' && ['drain', 'uncordon', 'rebuild', 'delete'].includes(action ?? '')) &&
        force
      )
        throw new Error('--force is only valid for destructive node lifecycle commands')
      const nodeCreate = group === 'nodes' && action === 'create'
      if (
        !nodeCreate &&
        (placementMode !== undefined ||
          temporaryLifetimeHours !== undefined ||
          nonHourlyCommitmentConfirmed)
      )
        throw new Error('node provisioning options are only valid for nodes create')
      if (!fileCommand && file !== undefined)
        throw new Error('--file is not valid for this command')
      if (
        group !== 'logs' &&
        (follow ||
          logComponent !== undefined ||
          logLevel !== undefined ||
          logFrom !== undefined ||
          logTo !== undefined ||
          logLimit !== undefined ||
          logCursor !== undefined)
      )
        throw new Error('log options are only valid for logs <server>')
      if (
        route?.organizationScoped !== true &&
        organization !== undefined &&
        localAction !== 'auth-login'
      )
        throw new Error(
          '--organization is only valid for organization-scoped commands or auth login',
        )
      const readOnlyPost =
        route?.path.endsWith('/plan') === true || route?.path.endsWith('/validate') === true
      if (
        route !== undefined &&
        route.method !== 'GET' &&
        !readOnlyPost &&
        idempotencyKey === undefined
      )
        throw new Error('mutation requires --idempotency-key')
      if (
        idempotencyKey !== undefined &&
        (route === undefined || route.method === 'GET' || readOnlyPost)
      )
        throw new Error('--idempotency-key is only valid for mutations')
      if (
        wait &&
        (route === undefined ||
          route.method === 'GET' ||
          readOnlyPost ||
          route.organizationScoped !== true)
      )
        throw new Error('--wait is only valid for asynchronous mutations')
      if (timeoutSpecified && !wait && !(group === 'operations' && action === 'watch'))
        throw new Error('--timeout requires --wait or operations watch')
      if (localOnly && localAction !== 'auth-logout')
        throw new Error('--local-only is only valid for auth logout')

      const request =
        route === undefined
          ? undefined
          : {
              ...route,
              ...(route.organizationScoped === true && organization !== undefined
                ? { organization }
                : {}),
              ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            }
      return {
        ...(request === undefined ? {} : { request }),
        ...(localAction === undefined ? {} : { localAction }),
        ...(manifestAction === undefined ? {} : { manifestAction }),
        ...(organization === undefined ? {} : { organization }),
        format,
        wait,
        localOnly,
        timeoutMs,
        ...(file === undefined ? {} : { file }),
        ...(liveLogs === undefined ? {} : { liveLogs }),
        positional,
      }
    },
    catch: (cause) =>
      new CliError({
        code: 'usage',
        message: cause instanceof Error ? cause.message : 'invalid command',
        exitCode: ExitCode.usage,
      }),
  })
