import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { createLoginStart } from '../src/auth.js'
import { GridoraApi, type ApiRequest } from '../src/client.js'
import { parseCommand } from '../src/commands.js'
import {
  manifestToGameCreateIntent,
  manifestToServerCreateIntent,
  parseDataDocument,
  parseManifest,
} from '../src/manifest.js'
import {
  bootstrapOrganizationIdentifier,
  bootstrapThroughAccess,
  classifyOperationResult,
  discoverOAuth,
  exchangeTokens,
  parseGlobals,
  revokeRefreshToken,
  selectBootstrapOrganization,
} from '../src/node-runtime.js'
import { renderOutput } from '../src/output.js'
import { MemoryProfileStore } from '../src/profile.js'
import { CliFiles, executeRemoteCommand } from '../src/runner.js'

describe('CLI contracts', () => {
  it('creates an S256 PKCE request without putting the verifier in the URL', () => {
    const start = createLoginStart({
      authorizationEndpoint: 'https://auth.example/authorize',
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource: 'https://api.example',
      verifier: 'v'.repeat(64),
      state: 'state',
    })
    expect(start.authorizationUrl).toContain('code_challenge_method=S256')
    expect(start.authorizationUrl).toContain('resource=https%3A%2F%2Fapi.example')
    expect(start.authorizationUrl).not.toContain('audience=')
    expect(start.authorizationUrl).not.toContain('v'.repeat(64))
  })
  it('keeps organization overrides and stable operation watch options', async () => {
    const parsed = await Effect.runPromise(
      parseCommand([
        'operations',
        'watch',
        'operation-1',
        '--organization',
        'night-watch',
        '--timeout',
        '9000',
        '--output',
        'json',
      ]),
    )
    expect(parsed).toMatchObject({
      organization: 'night-watch',
      timeoutMs: 9000,
      format: 'json',
      request: {
        path: '/v1/operations/operation-1',
        organizationScoped: true,
      },
    })
  })
  it('marks logout as explicitly local-only when requested', async () => {
    await expect(
      Effect.runPromise(parseCommand(['auth', 'logout', '--local-only'])),
    ).resolves.toMatchObject({
      localAction: 'auth-logout',
      localOnly: true,
    })
  })
  it('renders redirected output without ANSI', () => {
    expect(renderOutput([{ id: 'one', status: 'ready' }], 'table')).not.toContain(
      String.fromCodePoint(27),
    )
  })
  it('routes nested organization commands and backup restore', async () => {
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'members',
          'remove',
          'org',
          'member',
          '--expected-revision',
          '3',
          '--idempotency-key',
          'member-remove-01',
        ]),
      ),
    ).resolves.toMatchObject({
      request: { method: 'DELETE', path: '/v1/organizations/org/members/member' },
    })
    await expect(
      Effect.runPromise(
        parseCommand(['backups', 'restore', 'backup-1', '--idempotency-key', 'backup-restore-01']),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/backups/backup-1/actions/restore',
        body: { schemaVersion: 1 },
      },
    })
  })
  it('sends exact supported organization mutation contracts to the API boundary', async () => {
    const requests: ApiRequest[] = []
    const api = Layer.succeed(GridoraApi, {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return { status: 200, data: null }
        }),
      watchOperation: () => Effect.succeed(null),
    })
    const layers = Layer.mergeAll(
      api,
      MemoryProfileStore([{ name: 'default', apiOrigin: 'https://api.gridora.dev' }]),
      Layer.succeed(CliFiles, { readUtf8: () => Effect.die('unused') }),
    )
    const commands = [
      [
        'organizations',
        'create',
        '--name',
        'Night Watch',
        '--slug',
        'night-watch',
        '--timezone',
        'Europe/Uzhgorod',
        '--default-region',
        'eu-west',
        '--terms-accepted',
        '--idempotency-key',
        'organization-1',
      ],
      [
        'organizations',
        'members',
        'update',
        'org-1',
        'identity-1',
        '--role',
        'operator',
        '--expected-revision',
        '4',
        '--idempotency-key',
        'member-update-01',
      ],
      [
        'organizations',
        'members',
        'remove',
        'org-1',
        'identity-2',
        '--expected-revision',
        '5',
        '--idempotency-key',
        'member-remove-02',
      ],
      [
        'organizations',
        'invitations',
        'create',
        'org-1',
        '--email',
        'operator@example.com',
        '--role',
        'operator',
        '--expires-at',
        '2026-09-01T00:00:00Z',
        '--idempotency-key',
        'invite-1',
      ],
      [
        'organizations',
        'invitations',
        'revoke',
        'org-1',
        'invitation-1',
        '--expected-revision',
        '6',
        '--idempotency-key',
        'invite-revoke-01',
      ],
      [
        'organizations',
        'ownership',
        'transfer',
        'org-1',
        '--target-identity',
        'identity-3',
        '--idempotency-key',
        'ownership-transfer-01',
      ],
      [
        'organizations',
        'leave',
        'org-1',
        '--expected-revision',
        '7',
        '--idempotency-key',
        'organization-leave-01',
      ],
    ] as const
    for (const argv of commands) {
      const parsed = await Effect.runPromise(parseCommand(argv))
      await Effect.runPromise(executeRemoteCommand(parsed, 'default').pipe(Effect.provide(layers)))
    }
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/organizations',
        body: {
          name: 'Night Watch',
          slug: 'night-watch',
          timezone: 'Europe/Uzhgorod',
          defaultRegion: 'eu-west',
          termsAccepted: true,
        },
        idempotencyKey: 'organization-1',
      },
      {
        method: 'PATCH',
        path: '/v1/organizations/org-1/members/identity-1',
        body: { identityId: 'identity-1', role: 'operator', expectedRevision: 4 },
        idempotencyKey: 'member-update-01',
      },
      {
        method: 'DELETE',
        path: '/v1/organizations/org-1/members/identity-2',
        body: { expectedRevision: 5 },
        idempotencyKey: 'member-remove-02',
      },
      {
        method: 'POST',
        path: '/v1/organizations/org-1/invitations',
        body: {
          email: 'operator@example.com',
          role: 'operator',
          expiresAt: '2026-09-01T00:00:00Z',
        },
        idempotencyKey: 'invite-1',
      },
      {
        method: 'DELETE',
        path: '/v1/organizations/org-1/invitations/invitation-1',
        body: { expectedRevision: 6 },
        idempotencyKey: 'invite-revoke-01',
      },
      {
        method: 'POST',
        path: '/v1/organizations/org-1/actions/transfer-ownership',
        body: { targetIdentityId: 'identity-3' },
        idempotencyKey: 'ownership-transfer-01',
      },
      {
        method: 'POST',
        path: '/v1/organizations/org-1/actions/leave',
        body: { expectedRevision: 7 },
        idempotencyKey: 'organization-leave-01',
      },
    ])
  })
  it('maps every documented organization read/local command without invented routes', async () => {
    await expect(Effect.runPromise(parseCommand(['organizations', 'list']))).resolves.toMatchObject(
      {
        request: { method: 'GET', path: '/v1/me/organizations' },
      },
    )
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'show', 'org-1'])),
    ).resolves.toMatchObject({ request: { method: 'GET', path: '/v1/organizations/org-1' } })
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'switch',
          'org-1',
          '--idempotency-key',
          'organization-switch-01',
        ]),
      ),
    ).resolves.toMatchObject({
      localAction: 'organization-switch',
      request: {
        method: 'POST',
        path: '/v1/organizations/org-1/actions/switch',
        idempotencyKey: 'organization-switch-01',
      },
    })
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'switch', 'org-1'])),
    ).rejects.toMatchObject({ code: 'usage', message: 'mutation requires --idempotency-key' })
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'members', 'list', 'org-1'])),
    ).resolves.toMatchObject({
      request: { method: 'GET', path: '/v1/organizations/org-1/members' },
    })
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'invitations', 'list', 'org-1'])),
    ).resolves.toMatchObject({
      request: { method: 'GET', path: '/v1/organizations/org-1/invitations' },
    })
  })
  it('requires and forwards idempotency for organization profile and invitation resend', async () => {
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'update',
          'org-1',
          '--name',
          'Renamed',
          '--timezone',
          'Europe/Kyiv',
          '--default-region',
          'eu-west',
          '--expected-revision',
          '4',
          '--idempotency-key',
          'profile-update-01',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'PUT',
        path: '/v1/organizations/org-1',
        idempotencyKey: 'profile-update-01',
        body: {
          name: 'Renamed',
          timezone: 'Europe/Kyiv',
          defaultRegion: 'eu-west',
          expectedRevision: 4,
        },
      },
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'invitations',
          'resend',
          'org-1',
          'invitation-1',
          '--expected-revision',
          '2',
          '--expires-at',
          '2026-08-30T12:00:00Z',
          '--idempotency-key',
          'invitation-resend-01',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/organizations/org-1/invitations/invitation-1/actions/resend',
        idempotencyKey: 'invitation-resend-01',
        body: { expectedRevision: 2, expiresAt: '2026-08-30T12:00:00Z' },
      },
    })
  })
  it('executes every documented organization read route through the mocked API boundary', async () => {
    const requests: ApiRequest[] = []
    const layers = Layer.mergeAll(
      Layer.succeed(GridoraApi, {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return { status: 200, data: [] }
          }),
        watchOperation: () => Effect.succeed(null),
      }),
      MemoryProfileStore([{ name: 'default', apiOrigin: 'https://api.gridora.dev' }]),
      Layer.succeed(CliFiles, { readUtf8: () => Effect.die('unused') }),
    )
    for (const argv of [
      ['organizations', 'list'],
      ['organizations', 'show', 'org-1'],
      ['organizations', 'members', 'list', 'org-1'],
      ['organizations', 'invitations', 'list', 'org-1'],
    ] as const) {
      const parsed = await Effect.runPromise(parseCommand(argv))
      await Effect.runPromise(executeRemoteCommand(parsed, 'default').pipe(Effect.provide(layers)))
    }
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/v1/me/organizations' },
      { method: 'GET', path: '/v1/organizations/org-1' },
      { method: 'GET', path: '/v1/organizations/org-1/members' },
      { method: 'GET', path: '/v1/organizations/org-1/invitations' },
    ])
  })
  it('requires the membership revision for organization leave', async () => {
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'leave', 'org-1'])),
    ).rejects.toMatchObject({ message: expect.stringContaining('--expected-revision') })
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'leave',
          'org-1',
          '--expected-revision',
          '3',
          '--idempotency-key',
          'organization-leave-02',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/organizations/org-1/actions/leave',
        body: { expectedRevision: 3 },
        idempotencyKey: 'organization-leave-02',
      },
    })
    await expect(
      Effect.runPromise(parseCommand(['organizations', 'delete', 'org-1'])),
    ).rejects.toMatchObject({ message: expect.stringContaining('--expected-revision') })
  })
  it('maps global and tenant inventory without inventing provider aliases', async () => {
    await expect(Effect.runPromise(parseCommand(['plugins', 'list']))).resolves.toMatchObject({
      request: { method: 'GET', path: '/v1/plugins' },
    })
    await expect(
      Effect.runPromise(parseCommand(['providers', 'list', '--organization', 'night-watch'])),
    ).resolves.toMatchObject({
      request: {
        method: 'GET',
        path: '/v1/provider-accounts',
        organizationScoped: true,
        organization: 'night-watch',
      },
    })
  })
  it('requires stable idempotency keys and exact mutation inputs', async () => {
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'create',
          '--name',
          'Night Watch',
          '--slug',
          'night-watch',
          '--timezone',
          'UTC',
          '--default-region',
          'eu-west',
          '--terms-accepted',
        ]),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('idempotency'),
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'organizations',
          'create',
          '--name',
          'Night Watch',
          '--slug',
          'night-watch',
          '--timezone',
          'UTC',
          '--default-region',
          'eu-west',
          '--terms-accepted',
          '--budget-warning-threshold-minor',
          '2500',
          '--idempotency-key',
          'organization-2',
        ]),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('currency') })
  })
  it('rejects unsafe identifiers and capabilities that the API marks unimplemented', async () => {
    for (const argv of [
      ['nodes', 'show', '../node'],
      ['providers', 'test', 'provider-1'],
      ['nodes', 'drain', 'node-1'],
      ['servers', 'move', 'server-1'],
      ['console', 'server-1'],
    ] as const) {
      await expect(Effect.runPromise(parseCommand(argv))).rejects.toMatchObject({
        message: expect.stringMatching(/invalid|not supported|requires/),
      })
    }
  })

  it('lists bounded archives before following a one-time live ticket stream', async () => {
    const parsed = await Effect.runPromise(
      parseCommand([
        'logs',
        'server-1',
        '--follow',
        '--component',
        'game',
        '--level',
        'warn',
        '--from',
        '2026-08-01T00:00:00.000Z',
        '--to',
        '2026-08-02T00:00:00.000Z',
        '--limit',
        '20',
      ]),
    )
    expect(parsed).toMatchObject({
      request: {
        method: 'GET',
        path: '/v1/game-servers/server-1/logs?limit=20&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z',
        organizationScoped: true,
      },
      liveLogs: {
        serverId: 'server-1',
        component: 'game',
        level: 'warn',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
      },
    })
    const requests: ApiRequest[] = []
    const layers = Layer.mergeAll(
      Layer.succeed(GridoraApi, {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return { status: 200, data: { items: [] } }
          }),
        watchOperation: () => Effect.succeed(null),
        streamLogs: (input) => Effect.succeed([{ sequence: 4, entry: input }]),
      }),
      MemoryProfileStore([
        {
          name: 'default',
          apiOrigin: 'https://api.gridora.dev',
          activeOrganization: 'night-watch',
        },
      ]),
      Layer.succeed(CliFiles, { readUtf8: () => Effect.die('unused') }),
    )
    await expect(
      Effect.runPromise(executeRemoteCommand(parsed, 'default').pipe(Effect.provide(layers))),
    ).resolves.toEqual({
      archives: { items: [] },
      live: [
        {
          sequence: 4,
          entry: {
            organization: 'night-watch',
            serverId: 'server-1',
            component: 'game',
            level: 'warn',
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-08-02T00:00:00.000Z',
          },
        },
      ],
    })
    expect(requests).toHaveLength(1)
  })

  it('routes backup inventory/create and revision-fenced operation cancellation', async () => {
    await expect(
      Effect.runPromise(parseCommand(['backups', 'list', 'server-1'])),
    ).resolves.toMatchObject({ request: { method: 'GET', path: '/v1/backups?serverId=server-1' } })
    await expect(
      Effect.runPromise(
        parseCommand([
          'backups',
          'create',
          'server-1',
          '--idempotency-key',
          'backup-create-01',
          '--wait',
        ]),
      ),
    ).resolves.toMatchObject({
      request: { method: 'POST', path: '/v1/game-servers/server-1/backups' },
      wait: true,
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'operations',
          'cancel',
          'operation-1',
          '--expected-revision',
          '3',
          '--idempotency-key',
          'cancel-operation-01',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/operations/operation-1/actions/cancel',
        body: { expectedOperationRevision: 3 },
      },
    })
  })

  it('builds the strict node-create intent without provider-selected fields', async () => {
    const command = await Effect.runPromise(
      parseCommand([
        'nodes',
        'create',
        '--placement-mode',
        'dedicated',
        '--temporary-lifetime-hours',
        '8',
        '--confirm-non-hourly-commitment',
        '--idempotency-key',
        'node-create-a',
      ]),
    )
    expect(command.request).toEqual({
      method: 'POST',
      path: '/v1/nodes',
      organizationScoped: true,
      idempotencyKey: 'node-create-a',
      body: {
        schemaVersion: 1,
        placementMode: 'dedicated',
        temporaryLifetimeHours: 8,
        nonHourlyCommitmentConfirmed: true,
      },
    })
  })
  it('watches an operation without sending a duplicate initial request', async () => {
    let requests = 0
    let watches = 0
    const layers = Layer.mergeAll(
      Layer.succeed(GridoraApi, {
        request: () =>
          Effect.sync(() => {
            requests += 1
            return { status: 200, data: null }
          }),
        watchOperation: (operationId, timeoutMs, organization) =>
          Effect.sync(() => {
            watches += 1
            return { operationId, timeoutMs, organization }
          }),
      }),
      MemoryProfileStore([
        {
          name: 'default',
          apiOrigin: 'https://api.gridora.dev',
          activeOrganization: 'night-watch',
        },
      ]),
      Layer.succeed(CliFiles, { readUtf8: () => Effect.die('unused') }),
    )
    const command = await Effect.runPromise(
      parseCommand(['operations', 'watch', 'operation-1', '--timeout', '9000']),
    )
    await Effect.runPromise(executeRemoteCommand(command, 'default').pipe(Effect.provide(layers)))
    expect({ requests, watches }).toEqual({ requests: 0, watches: 1 })
  })
  it('uses a failure exit code when a watched operation ends unsuccessfully', () => {
    expect(() =>
      classifyOperationResult('operation-1', { status: 'failed_terminal', progress: 75 }),
    ).toThrow(expect.objectContaining({ code: 'operation_failed', exitCode: 10 }))
    expect(classifyOperationResult('operation-1', { status: 'running' })).toEqual({ done: false })
  })
  it('decodes declarative files and sends reviewed server intents', async () => {
    await expect(Effect.runPromise(parseDataDocument('difficulty: veteran'))).resolves.toEqual({
      difficulty: 'veteran',
    })
    const foreignManifest = `
apiVersion: games.gridora.example/v1alpha1
kind: GameServer
metadata:
  name: foreign
  organization: another-org
spec:
  plugin: { id: arma-reforger, version: 1.0.0 }
  placement: { mode: auto }
  resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 }
  endpoint: {}
  updatePolicy: {}
  backupPolicy: {}
  config: {}
  mods: []
`
    const parsedManifest = await Effect.runPromise(parseManifest(foreignManifest))
    expect(parsedManifest).toMatchObject({ metadata: { organization: 'another-org' } })
    expect(manifestToServerCreateIntent(parsedManifest)).toMatchObject({
      name: 'foreign',
      nonHourlyCommitmentConfirmed: false,
    })
    expect(manifestToGameCreateIntent(parsedManifest)).toMatchObject({
      name: 'foreign',
      placement: { mode: 'shared' },
    })
    const parsed = await Effect.runPromise(
      parseCommand(['servers', 'apply', '--file', 'server.yaml', '--idempotency-key', 'server-01']),
    )
    expect(parsed.request).toMatchObject({
      method: 'POST',
      path: '/v1/game-servers/apply',
      idempotencyKey: 'server-01',
    })
  })
  it('routes lifecycle, config, and mod commands with revision/idempotency fences', async () => {
    await expect(
      Effect.runPromise(parseCommand(['servers', 'plan', '--file', 'server.yaml'])),
    ).resolves.toMatchObject({
      request: { method: 'POST', path: '/v1/game-servers/plan' },
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'servers',
          'start',
          'server-1',
          '--expected-revision',
          '4',
          '--idempotency-key',
          'start-001',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/game-servers/server-1/actions/start',
        body: { expectedRevision: 4, action: 'start' },
      },
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'servers',
          'delete',
          'server-1',
          '--expected-revision',
          '5',
          '--backup-policy',
          'required',
          '--idempotency-key',
          'delete-001',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'DELETE',
        path: '/v1/game-servers/server-1',
        body: { expectedRevision: 5, action: 'delete', backupPolicy: 'required' },
      },
    })
    await expect(
      Effect.runPromise(parseCommand(['servers', 'config', 'get', 'server-1'])),
    ).resolves.toMatchObject({
      request: { method: 'GET', path: '/v1/game-servers/server-1/config' },
    })
    await expect(
      Effect.runPromise(parseCommand(['mods', 'list', 'server-1'])),
    ).resolves.toMatchObject({
      request: { method: 'GET', path: '/v1/game-servers/server-1/mods' },
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'mods',
          'sync',
          'server-1',
          '--file',
          'mods.yaml',
          '--expected-revision',
          '7',
          '--idempotency-key',
          'mods-sync-1',
          '--wait',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'PUT',
        path: '/v1/game-servers/server-1/mods',
        body: { expectedRevision: 7, action: 'sync-mods' },
      },
      wait: true,
    })
    await expect(
      Effect.runPromise(
        parseCommand([
          'servers',
          'move',
          'server-1',
          '--node',
          'node-2',
          '--expected-revision',
          '7',
          '--idempotency-key',
          'server-move-1',
          '--wait',
        ]),
      ),
    ).resolves.toMatchObject({
      request: {
        method: 'POST',
        path: '/v1/game-servers/server-1/actions/move',
        body: {
          expectedRevision: 7,
          action: 'move',
          targetNodeId: 'node-2',
          backupPolicy: 'required',
        },
      },
      wait: true,
    })
    await expect(
      Effect.runPromise(parseCommand(['servers', 'move', 'server-1', '--expected-revision', '7'])),
    ).rejects.toMatchObject({ message: expect.stringContaining('--node') })
    await expect(
      Effect.runPromise(parseCommand(['servers', 'move', 'server-1', '--node', 'node-2'])),
    ).rejects.toMatchObject({ message: expect.stringContaining('--expected-revision') })
  })
  it('converts a manifest file to an API create intent without forwarding image authority', async () => {
    const requests: ApiRequest[] = []
    const layers = Layer.mergeAll(
      Layer.succeed(GridoraApi, {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return { status: 202, data: { operationId: 'op-1' } }
          }),
        watchOperation: () => Effect.succeed(null),
      }),
      MemoryProfileStore([
        {
          name: 'default',
          apiOrigin: 'https://api.gridora.dev',
          activeOrganization: 'night-watch',
        },
      ]),
      Layer.succeed(CliFiles, {
        readUtf8: () =>
          Effect.succeed(`
apiVersion: games.gridora.example/v1alpha1
kind: GameServer
metadata:
  name: Night server
  organization: night-watch
spec:
  plugin: { id: arma-reforger, version: client-must-not-select }
  placement: { mode: shared }
  resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 }
  billing:
    nonHourlyCommitmentConfirmed: true
    commercialReviewToken: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  endpoint: { domain: night.example.test }
  updatePolicy: {}
  backupPolicy: {}
  config: { name: Night server }
  mods: []
`),
      }),
    )
    const command = await Effect.runPromise(
      parseCommand(['servers', 'apply', '--file', 'server.yaml', '--idempotency-key', 'server-01']),
    )
    await Effect.runPromise(executeRemoteCommand(command, 'default').pipe(Effect.provide(layers)))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/game-servers/apply',
      body: {
        schemaVersion: 1,
        server: {
          schemaVersion: 1,
          name: 'Night server',
          pluginId: 'arma-reforger',
          placementMode: 'shared',
          resources: {
            cpuMillis: 2000,
            ramBytes: 4294967296,
            diskBytes: 42949672960,
          },
          nonHourlyCommitmentConfirmed: true,
        },
        game: {
          schemaVersion: 1,
          name: 'Night server',
          pluginId: 'arma-reforger',
          placement: { mode: 'shared' },
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
          config: { name: 'Night server' },
          mods: [],
          domain: 'night.example.test',
        },
        commercialReviewToken: 'a'.repeat(64),
      },
    })
    expect(JSON.stringify(requests[0]?.body)).not.toContain('client-must-not-select')
  })
  it('selects only a verified bootstrap membership and rejects unsafe profile names', () => {
    const memberships = [
      { organization: { id: 'org_1', slug: 'night-watch' }, role: 'owner' },
      { organization: { id: 'org_2', slug: 'day-watch' }, role: 'viewer' },
    ]
    expect(
      bootstrapOrganizationIdentifier(selectBootstrapOrganization(memberships, 'org_2') ?? {}),
    ).toBe('day-watch')
    expect(() => selectBootstrapOrganization(memberships, 'foreign')).toThrow(/not an active/)
    expect(() => parseGlobals(['--profile', '../../other', 'auth', 'status'])).toThrow(/profile/)
  })
  it('sends Managed OAuth to the Access gateway before origin assertion auth', async () => {
    const originalFetch = globalThis.fetch
    let observed: { readonly url: string; readonly authorization: string | undefined } | undefined
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      observed = { url, authorization: headers.get('authorization') ?? undefined }
      return Promise.resolve(
        new Response(JSON.stringify({ identity: { id: 'user' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      await expect(
        bootstrapThroughAccess('https://api.gridora.dev', 'managed-oauth-token'),
      ).resolves.toMatchObject({ identity: { id: 'user' } })
      expect(observed).toEqual({
        url: 'https://api.gridora.dev/v1/auth/bootstrap',
        authorization: 'Bearer managed-oauth-token',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  it('rejects insecure discovery and cross-origin OAuth endpoints', async () => {
    await expect(discoverOAuth('http://api.gridora.dev')).rejects.toThrow(/HTTPS/)
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return Promise.resolve(
        Response.json({
          issuer: 'https://api.gridora.dev',
          authorization_endpoint: 'https://evil.example/authorize',
          token_endpoint: 'https://api.gridora.dev/token',
        }),
      )
    }) as typeof fetch
    try {
      await expect(discoverOAuth('https://api.gridora.dev')).rejects.toThrow(/origin/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  it('accepts a discovered Access issuer and pins it on later discovery', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          issuer: 'https://team.cloudflareaccess.com',
          authorization_endpoint: 'https://team.cloudflareaccess.com/authorize',
          token_endpoint: 'https://team.cloudflareaccess.com/token',
          registration_endpoint: 'https://team.cloudflareaccess.com/register',
        }),
      )) as typeof fetch
    try {
      await expect(discoverOAuth('https://api.gridora.dev')).resolves.toMatchObject({
        issuer: 'https://team.cloudflareaccess.com/',
      })
      await expect(
        discoverOAuth('https://api.gridora.dev', 'https://different.cloudflareaccess.com'),
      ).rejects.toThrow(/configured issuer/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  it('keeps the prior refresh token when the provider does not rotate it', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ access_token: 'access-2', expires_in: 300 }))) as typeof fetch
    try {
      await expect(
        exchangeTokens(
          'https://team.cloudflareaccess.com/token',
          new URLSearchParams({ grant_type: 'refresh_token' }),
          'refresh-1',
        ),
      ).resolves.toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  it('revokes a refresh token before a copied token can refresh again', async () => {
    const originalFetch = globalThis.fetch
    const revoked = new Set<string>()
    const copiedToken = 'copied-refresh-token'
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(init?.redirect).toBe('error')
      if (url.endsWith('/.well-known/oauth-authorization-server'))
        return Promise.resolve(
          Response.json({
            issuer: 'https://api.gridora.dev',
            authorization_endpoint: 'https://api.gridora.dev/authorize',
            token_endpoint: 'https://api.gridora.dev/token',
            revocation_endpoint: 'https://api.gridora.dev/revoke',
          }),
        )
      if (!(init?.body instanceof URLSearchParams)) throw new Error('expected URL-encoded body')
      const body = init.body
      if (url.endsWith('/revoke')) {
        revoked.add(String(body.get('token')))
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (url.endsWith('/token') && revoked.has(String(body.get('refresh_token'))))
        return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 401 }))
      return Promise.resolve(
        Response.json({ access_token: 'access', refresh_token: 'next-refresh', expires_in: 300 }),
      )
    }) as typeof fetch
    try {
      await revokeRefreshToken({
        apiOrigin: 'https://api.gridora.dev',
        authIssuer: 'https://api.gridora.dev',
        clientId: 'gridora-cli',
        refreshToken: copiedToken,
      })
      await expect(
        exchangeTokens(
          'https://api.gridora.dev/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: copiedToken,
            client_id: 'gridora-cli',
          }),
        ),
      ).rejects.toMatchObject({ code: 'oauth_token_rejected', exitCode: 3 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('builds the exact organization deletion request with confirmation and retention policy', async () => {
    const parsed = await Effect.runPromise(
      parseCommand([
        'organizations',
        'delete',
        'night-watch',
        '--expected-revision',
        '7',
        '--backup-policy',
        'retain',
        '--idempotency-key',
        'organization-delete-night-watch',
      ]),
    )
    expect(parsed.request).toMatchObject({
      method: 'DELETE',
      path: '/v1/organizations/night-watch',
      body: {
        expectedOrganizationRevision: 7,
        typedSlug: 'night-watch',
        backupPolicy: 'retain',
      },
    })
  })
})
