import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { createGridoraClient } from '../src/index.js'
import { makeInitialOrganizationPolicy } from '@gridora/policy-control'

describe('generated client', () => {
  it('keeps organization context in the request path and forwards idempotency', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json(
          {
            operationId: 'op_1',
            resourceId: 'srv_1',
            status: 'queued',
            links: { operation: '/op_1' },
          },
          { status: 202 },
        )
      },
    })
    const result = await Effect.runPromise(
      client.mutate(
        'night-watch',
        'game-servers',
        'POST',
        { name: 'Eastern' },
        {
          idempotencyKey: 'request-key-123',
        },
      ),
    )
    expect(result.status).toBe('queued')
    expect(request?.url).toBe('https://api.gridora.test/v1/organizations/night-watch/game-servers')
    expect(request?.headers.get('idempotency-key')).toBe('request-key-123')
  })

  it('sends the typed, revision-fenced move DTO to the dedicated server action', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json(
          {
            operationId: 'move-operation-1',
            resourceId: 'server-1',
            status: 'queued',
            links: { operation: '/v1/organizations/night-watch/operations/move-operation-1' },
          },
          { status: 202 },
        )
      },
    })

    await expect(
      Effect.runPromise(
        client.moveGameServer(
          'night/watch',
          'server/a',
          {
            expectedRevision: 7,
            action: 'move',
            targetNodeId: 'node-b',
            backupPolicy: 'required',
          },
          { idempotencyKey: 'move-request-1' },
        ),
      ),
    ).resolves.toMatchObject({ operationId: 'move-operation-1', resourceId: 'server-1' })

    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(
      'https://api.gridora.test/v1/organizations/night%2Fwatch/game-servers/server%2Fa/actions/move',
    )
    expect(request?.headers.get('idempotency-key')).toBe('move-request-1')
    await expect(request?.json()).resolves.toEqual({
      expectedRevision: 7,
      action: 'move',
      targetNodeId: 'node-b',
      backupPolicy: 'required',
    })
  })

  it('uses the opaque auth state with browser credentials', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return requests.length === 1
          ? Response.json({ state: 'state_1', expiresAt: Date.now() + 60_000 }, { status: 201 })
          : Response.json({
              intent: 'sign-in',
              next: 'dashboard',
              returnTo: '/dashboard',
              identity: {
                id: 'identity_1',
                accessSubject: 'subject_1',
                email: 'owner@example.com',
                displayName: 'Owner',
                status: 'active',
                signedUpAt: '2026-08-23T00:00:00.000Z',
                lastLoginAt: '2026-08-23T00:00:00.000Z',
              },
            })
      },
    })
    const issued = await Effect.runPromise(
      client.createAuthenticationIntent({ intent: 'sign-in', returnTo: '/dashboard' }),
    )
    await Effect.runPromise(client.completeAuthentication(issued.state))
    expect(requests[0]?.credentials).toBe('include')
    expect(requests[1]?.headers.get('x-gridora-auth-state')).toBe('state_1')
  })

  it('audits organization switching and exposes only the current Access session boundary', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.method === 'POST')
          return Response.json({
            operationId: 'operation-switch',
            resourceId: 'night-watch',
            status: 'succeeded',
            links: { operation: '/v1/organizations/night-watch/operations/operation-switch' },
          })
        return Response.json({
          provider: 'cloudflare-access',
          identity: {
            id: 'identity-1',
            accessSubject: 'subject-1',
            email: 'owner@example.com',
            displayName: 'Owner',
            status: 'active',
            signedUpAt: '2026-08-23T12:00:00Z',
            lastLoginAt: '2026-08-23T12:00:00Z',
          },
          subject: 'subject-1',
          email: 'owner@example.com',
          issuer: 'https://access.example.test',
          issuedAt: 1_800_000_000,
          expiresAt: 1_800_003_600,
          management: {
            authority: 'cloudflare-access',
            localSessionStorage: false,
            canEnumerateOtherSessions: false,
            signOutPath: '/cdn-cgi/access/logout',
          },
        })
      },
    })

    await Effect.runPromise(
      client.switchOrganization('night/watch', { idempotencyKey: 'switch-request-01' }),
    )
    const session = await Effect.runPromise(client.accessSession())
    expect(requests[0]?.url).toBe(
      'https://api.gridora.test/v1/organizations/night%2Fwatch/actions/switch',
    )
    expect(requests[0]?.headers.get('idempotency-key')).toBe('switch-request-01')
    expect(requests[1]?.url).toBe('https://api.gridora.test/v1/me/session')
    expect(session.management).toEqual({
      authority: 'cloudflare-access',
      localSessionStorage: false,
      canEnumerateOtherSessions: false,
      signOutPath: '/cdn-cgi/access/logout',
    })
  })

  it('issues an organization-bound realtime ticket and constructs an encoded WebSocket URL', async () => {
    let request: Request | undefined
    const ticket = `${'a'.repeat(32)}.${'b'.repeat(32)}`
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test/root-is-not-reused',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ ticket, expiresAt: 1_800_000_000_000 })
      },
    })

    const issued = await Effect.runPromise(client.issueOrganizationEventsTicket('night/watch'))
    const websocketUrl = client.organizationEventsWebSocketUrl('night/watch', issued.ticket)

    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(
      'https://api.gridora.test/root-is-not-reused/v1/organizations/night%2Fwatch/events/ticket',
    )
    expect(request?.headers.get('idempotency-key')).toBeNull()
    expect(websocketUrl).toBe(
      `wss://api.gridora.test/root-is-not-reused/v1/organizations/night%2Fwatch/events?ticket=${encodeURIComponent(ticket)}`,
    )
    expect(request?.url).not.toContain(ticket)
  })

  it('uses the composed health, archive, and one-time live-log paths without a 501 fallback', async () => {
    const requests: Request[] = []
    const ticket = `${'a'.repeat(32)}.${'b'.repeat(32)}`
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test/root',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const path = new URL(request.url).pathname
        if (path.endsWith('/health'))
          return Response.json({
            organizationId: 'night-watch',
            resourceType: 'server',
            resourceId: 'server-a',
            nodeId: 'node-a',
            serverId: 'server-a',
            sampledAt: '2026-08-23T12:00:00.000Z',
            status: 'healthy',
            summary: {},
          })
        if (path.endsWith('/logs')) return Response.json({ items: [] })
        if (path.endsWith('/logs/stream/ticket'))
          return Response.json({
            ticket,
            expiresAt: 1_800_000_000_000,
            organizationId: 'org-canonical-a',
            streamEpoch: 'deployment-a',
          })
        throw new Error(`Unexpected generated-client request: ${request.url}`)
      },
    })

    await expect(
      Effect.runPromise(client.gameServerHealth('night/watch', 'server/a')),
    ).resolves.toMatchObject({ resourceType: 'server', status: 'healthy' })
    await expect(
      Effect.runPromise(
        client.logArchives('night/watch', 'server/a', {
          from: '2026-08-23T11:00:00.000Z',
          limit: 5,
        }),
      ),
    ).resolves.toEqual({ items: [] })
    const issued = await Effect.runPromise(client.issueLiveLogTicket('night/watch', 'server/a'))

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'GET /root/v1/organizations/night%2Fwatch/game-servers/server%2Fa/health',
        'GET /root/v1/organizations/night%2Fwatch/game-servers/server%2Fa/logs',
        'POST /root/v1/organizations/night%2Fwatch/game-servers/server%2Fa/logs/stream/ticket',
      ],
    )
    expect(new URL(requests[1]!.url).searchParams.get('from')).toBe('2026-08-23T11:00:00.000Z')
    expect(new URL(requests[1]!.url).searchParams.get('limit')).toBe('5')
    expect(requests[2]?.headers.get('idempotency-key')).toBeNull()
    expect(issued).toMatchObject({ organizationId: 'org-canonical-a', streamEpoch: 'deployment-a' })
    expect(client.liveLogWebSocketUrl('night/watch', 'server/a', issued.ticket)).toBe(
      `wss://api.gridora.test/root/v1/organizations/night%2Fwatch/game-servers/server%2Fa/logs/stream?ticket=${encodeURIComponent(ticket)}`,
    )
  })

  it('rejects malformed realtime tickets and non-HTTP API schemes', () => {
    const client = createGridoraClient({ baseUrl: 'https://api.gridora.test' })
    expect(() => client.organizationEventsWebSocketUrl('org-a', 'ticket with spaces')).toThrow()
    const invalidProtocol = createGridoraClient({ baseUrl: 'ftp://api.gridora.test' })
    expect(() =>
      invalidProtocol.organizationEventsWebSocketUrl(
        'org-a',
        `${'a'.repeat(32)}.${'b'.repeat(32)}`,
      ),
    ).toThrow('Gridora API base URL must use HTTP or HTTPS')
  })

  it('sends revision-bearing membership and invitation mutation DTOs', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json({
          operationId: request.method === 'PATCH' ? 'operation-membership' : 'operation-invitation',
          resourceId: request.method === 'PATCH' ? 'identity_1' : 'invitation_1',
          status: 'succeeded',
          links: { operation: '/v1/organizations/org_1/operations/operation-1' },
        })
      },
    })
    await Effect.runPromise(client.updateMemberRole('org_1', 'identity_1', 'operator', 3, {}))
    await Effect.runPromise(client.revokeInvitation('org_1', 'invitation_1', 2, {}))
    await expect(requests[0]!.json()).resolves.toEqual({
      identityId: 'identity_1',
      role: 'operator',
      expectedRevision: 3,
    })
    await expect(requests[1]!.json()).resolves.toEqual({ expectedRevision: 2 })
  })

  it('sends revision-fenced organization profile and invitation resend DTOs', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json({
          operationId: `operation-${requests.length}`,
          resourceId: request.url.includes('/invitations/') ? 'invitation-1' : 'org-1',
          status: 'succeeded',
          links: { operation: `/v1/organizations/org-1/operations/operation-${requests.length}` },
        })
      },
    })
    await Effect.runPromise(
      client.updateOrganizationProfile(
        'org-1',
        { name: 'Renamed', timezone: 'Europe/Kyiv', defaultRegion: 'eu-west', expectedRevision: 4 },
        { idempotencyKey: 'profile-update-01' },
      ),
    )
    await Effect.runPromise(
      client.resendInvitation(
        'org-1',
        'invitation-1',
        { expectedRevision: 2, expiresAt: '2026-08-30T12:00:00Z' },
        { idempotencyKey: 'invitation-resend-01' },
      ),
    )
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'PUT /v1/organizations/org-1',
        'POST /v1/organizations/org-1/invitations/invitation-1/actions/resend',
      ],
    )
    expect(requests[0]?.headers.get('idempotency-key')).toBe('profile-update-01')
    expect(requests[1]?.headers.get('idempotency-key')).toBe('invitation-resend-01')
    await expect(requests[0]!.json()).resolves.toEqual({
      name: 'Renamed',
      timezone: 'Europe/Kyiv',
      defaultRegion: 'eu-west',
      expectedRevision: 4,
    })
    await expect(requests[1]!.json()).resolves.toEqual({
      expectedRevision: 2,
      expiresAt: '2026-08-30T12:00:00Z',
    })
  })

  it('sends self-leave to the revision-fenced organization action', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          operationId: 'operation-leave',
          resourceId: 'org_1',
          status: 'succeeded',
          links: { operation: '/v1/organizations/night-watch/operations/operation-leave' },
        })
      },
    })
    await Effect.runPromise(
      client.leaveOrganization('night-watch', 7, { idempotencyKey: 'leave-request-1' }),
    )
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('https://api.gridora.test/v1/organizations/night-watch/actions/leave')
    expect(request?.headers.get('idempotency-key')).toBe('leave-request-1')
    await expect(request!.json()).resolves.toEqual({ expectedRevision: 7 })
  })

  it('accepts an invitation with only the encoded path token', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          operationId: 'operation_accept',
          resourceId: 'invitation_1',
          status: 'succeeded',
          links: { operation: '/v1/organizations/org_1/operations/operation_accept' },
        })
      },
    })

    const invitationToken = 'a'.repeat(64)
    const accepted = await Effect.runPromise(
      client.acceptInvitation(invitationToken, { idempotencyKey: 'accept-key' }),
    )

    expect(accepted.status).toBe('succeeded')
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(
      `https://api.gridora.test/v1/invitations/${invitationToken}/actions/accept`,
    )
    expect(request?.headers.get('idempotency-key')).toBe('accept-key')
    expect(request?.body).toBeNull()
  })

  it('gets and updates the full revisioned organization policy', async () => {
    const requests: Request[] = []
    const current = makeInitialOrganizationPolicy({ organizationId: 'org_1', defaultRegion: 'eu' })
    const updated = { ...current, revision: 2, allowedProviders: ['ovhcloud'] }
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json(
          request.method === 'GET'
            ? current
            : {
                operationId: 'policy-update-one',
                resourceId: 'org_1',
                status: 'succeeded',
                links: { operation: '/v1/organizations/org_1/operations/policy-update-one' },
              },
        )
      },
    })
    await Effect.runPromise(client.organizationPolicy('organization-one'))
    await Effect.runPromise(
      client.updateOrganizationPolicy(
        'organization-one',
        { expectedRevision: 1, policy: updated },
        { idempotencyKey: 'policy-update-one' },
      ),
    )
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'GET /v1/organizations/organization-one/policy',
        'PUT /v1/organizations/organization-one/policy',
      ],
    )
    expect(requests[1]?.headers.get('idempotency-key')).toBe('policy-update-one')
    await expect(requests[1]!.json()).resolves.toEqual({ expectedRevision: 1, policy: updated })
  })

  it('sends revision-fenced provider-account lifecycle requests', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const action = request.url.endsWith('/test')
          ? 'test'
          : request.url.endsWith('/refresh')
            ? 'refresh'
            : request.url.endsWith('/actions/disable')
              ? 'disable'
              : 'remove'
        return Response.json({
          accountId: 'provider-one',
          organizationId: 'org_1',
          providerType: 'ovhcloud',
          action,
          outcome:
            action === 'test'
              ? 'valid'
              : action === 'refresh'
                ? 'refreshed'
                : action === 'disable'
                  ? 'disabled'
                  : 'removed',
          accountStatus: action === 'remove' ? null : action === 'disable' ? 'disabled' : 'active',
          revision: 8,
          operationId: `provider_account_${action}`,
          failureCategory: null,
          regionCount: 0,
          projectCount: 0,
          catalogItemCount: 0,
          completedAt: '2026-08-23T12:00:00.000Z',
        })
      },
    })

    const options = { idempotencyKey: 'provider-lifecycle-key' }
    await Effect.runPromise(
      client.testProviderAccount('org_1', 'provider-one', { expectedRevision: 7 }, options),
    )
    await Effect.runPromise(
      client.refreshProviderAccount('org_1', 'provider-one', { expectedRevision: 7 }, options),
    )
    await Effect.runPromise(
      client.disableProviderAccount('org_1', 'provider-one', { expectedRevision: 7 }, options),
    )
    await Effect.runPromise(
      client.deleteProviderAccount('org_1', 'provider-one', { expectedRevision: 7 }, options),
    )

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'POST /v1/organizations/org_1/provider-accounts/provider-one/test',
        'POST /v1/organizations/org_1/provider-accounts/provider-one/refresh',
        'POST /v1/organizations/org_1/provider-accounts/provider-one/actions/disable',
        'DELETE /v1/organizations/org_1/provider-accounts/provider-one',
      ],
    )
    for (const request of requests) {
      expect(request.headers.get('idempotency-key')).toBe('provider-lifecycle-key')
      await expect(request.json()).resolves.toEqual({ expectedRevision: 7 })
    }
  })

  it('requests a read-only game-server plan without an idempotency header', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          kind: 'existing-node',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          placementMode: 'shared',
          nodeId: 'node-a',
          resources: {
            cpuMillis: 2_000,
            ramBytes: 4_294_967_296,
            diskBytes: 42_949_672_960,
          },
          ports: [
            {
              name: 'game',
              protocol: 'udp',
              containerPort: 20_001,
              preferredPublicPort: 20_001,
              publicPort: 20_001,
            },
          ],
          newPaidInfrastructure: false,
          estimatedMonthlyIncreaseMinor: 0,
          explanation: 'Selected ready shared node node-a',
          warnings: [],
          candidates: [{ nodeId: 'node-a', accepted: true, reasons: [], score: 1 }],
        })
      },
    })
    const intent = {
      schemaVersion: 1 as const,
      name: 'Eastern Front',
      pluginId: 'arma-reforger',
      placementMode: 'auto' as const,
      resources: {
        cpuMillis: 2_000,
        ramBytes: 4_294_967_296,
        diskBytes: 42_949_672_960,
      },
      nonHourlyCommitmentConfirmed: false,
    }
    const result = await Effect.runPromise(client.planGameServer('night-watch', intent))
    expect(result.kind).toBe('existing-node')
    if (result.kind !== 'existing-node') throw new Error('expected existing node plan')
    expect(result.nodeId).toBe('node-a')
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(
      'https://api.gridora.test/v1/organizations/night-watch/game-servers/plan',
    )
    expect(request?.headers.get('idempotency-key')).toBeNull()
    await expect(request!.json()).resolves.toEqual(intent)
  })

  it('retains an opaque review-bound commercial token from a no-fit plan without private selection facts', async () => {
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async () =>
        Response.json({
          kind: 'provision-node',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          pluginSelectionRevision: 2,
          placementMode: 'shared',
          nodeIntent: {
            schemaVersion: 1,
            placementMode: 'shared',
            temporaryLifetimeHours: null,
            nonHourlyCommitmentConfirmed: false,
          },
          selectedInfrastructure: { providerType: 'ovhcloud', region: 'gra', plan: 'b2-15' },
          billing: {
            currency: 'EUR',
            estimatedMonthlyIncreaseMinor: 1_000,
            billingCadence: 'monthly',
            contractMonths: 1,
            committedMonthlyBeforeMinor: 5_000,
            projectedCommittedMonthlyMinor: 6_000,
          },
          requiresNonHourlyCommitmentConfirmation: true,
          commercialConsentRequired: true,
          commercialReviewToken: 'a'.repeat(64),
          implications: {
            dns: 'published after endpoint verification',
            mods: 'validated before activation',
            backups: 'applied after deployment',
            downtime: 'new deployment',
            billing: 'starts after acceptance',
          },
          warnings: [],
          explanation: 'No ready capacity fits',
          newPaidInfrastructure: true,
        }),
    })

    const result = await Effect.runPromise(
      client.planGameServer('night-watch', {
        schemaVersion: 1,
        name: 'Eastern Front',
        pluginId: 'arma-reforger',
        placementMode: 'auto',
        resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
        nonHourlyCommitmentConfirmed: false,
      }),
    )

    expect(result).toMatchObject({
      kind: 'provision-node',
      commercialReviewToken: 'a'.repeat(64),
    })
    expect(result).not.toHaveProperty('reviewedNodeProvision')
  })

  it('publishes the revision-fenced game lifecycle methods on tenant routes', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json(
          {
            operationId: 'operation-a',
            resourceId: 'server-a',
            status: 'queued',
            links: { operation: '/v1/organizations/org-a/operations/operation-a' },
          },
          { status: 202 },
        )
      },
    })
    const create = {
      schemaVersion: 1 as const,
      name: 'Eastern Front',
      pluginId: 'arma-reforger',
      placement: { mode: 'shared' as const },
      config: {},
      mods: [],
    }
    const mutation = { expectedRevision: 4, action: 'start' as const }
    const options = { idempotencyKey: 'game-mutation-a' }
    await Effect.runPromise(client.createGameServer('org-a', create, options))
    await Effect.runPromise(
      client.gameServerAction('org-a', 'server-a', 'start', mutation, options),
    )
    await Effect.runPromise(
      client.patchGameServer(
        'org-a',
        'server-a',
        {
          ...mutation,
          action: 'update',
          expectedConfigRevision: 1,
          expectedModRevision: 0,
          backupBeforeUpdate: false,
        },
        options,
      ),
    )
    await Effect.runPromise(
      client.applyGameConfig(
        'org-a',
        'server-a',
        {
          expectedRevision: 5,
          action: 'apply-config',
          expectedConfigRevision: 1,
          config: {},
        },
        options,
      ),
    )
    await Effect.runPromise(
      client.syncGameMods(
        'org-a',
        'server-a',
        {
          expectedRevision: 6,
          action: 'sync-mods',
          expectedConfigRevision: 2,
          expectedModRevision: 0,
          mods: [],
        },
        options,
      ),
    )
    await Effect.runPromise(
      client.deleteGameServer(
        'org-a',
        'server-a',
        {
          expectedRevision: 7,
          action: 'delete',
          backupPolicy: 'required',
        },
        options,
      ),
    )
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'POST /v1/organizations/org-a/game-servers',
        'POST /v1/organizations/org-a/game-servers/server-a/actions/start',
        'PATCH /v1/organizations/org-a/game-servers/server-a',
        'POST /v1/organizations/org-a/game-servers/server-a/config',
        'PUT /v1/organizations/org-a/game-servers/server-a/mods',
        'DELETE /v1/organizations/org-a/game-servers/server-a',
      ],
    )
    for (const request of requests)
      expect(request.headers.get('idempotency-key')).toBe('game-mutation-a')
  })

  it('creates a node from intent only and publishes separate platform authority mutations', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (new URL(request.url).pathname.endsWith('/nodes'))
          return Response.json({
            disposition: 'created',
            nodeId: 'node-a',
            operationId: 'op-a',
            workflowState: 'started',
            billing: {
              providerType: 'ovhcloud',
              currency: 'EUR',
              estimatedMonthlyMinor: 1200,
              billingCadence: 'hourly',
              contractMonths: 1,
              committedMonthlyBeforeMinor: 0,
              projectedCommittedMonthlyMinor: 1200,
              warnings: [],
            },
          })
        return Response.json({
          id: 'platform-ovh',
          scope: 'platform',
          organizationId: null,
          providerType: 'ovhcloud',
          credentialReference: 'platform-provider-platform-ovh',
          credentialRevision: 1,
          status: 'active',
          revision: 1,
          createdAt: '2026-08-23T12:00:00.000Z',
          updatedAt: '2026-08-23T12:00:00.000Z',
        })
      },
    })
    await Effect.runPromise(
      client.createNode(
        'org-a',
        {
          schemaVersion: 1,
          placementMode: 'dedicated',
          temporaryLifetimeHours: null,
          nonHourlyCommitmentConfirmed: false,
        },
        { idempotencyKey: 'node-create-a' },
      ),
    )
    await Effect.runPromise(
      client.createPlatformProviderAccount(
        'platform-ovh',
        { providerType: 'ovhcloud', credentialsBase64: btoa('credential-canary') },
        { idempotencyKey: 'platform-create-a' },
      ),
    )
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ['POST /v1/organizations/org-a/nodes', 'POST /v1/platform/provider-accounts'],
    )
    expect(requests[0]!.headers.get('idempotency-key')).toBe('node-create-a')
    await expect(requests[0]!.json()).resolves.toEqual({
      schemaVersion: 1,
      placementMode: 'dedicated',
      temporaryLifetimeHours: null,
      nonHourlyCommitmentConfirmed: false,
    })
  })

  it('retains the server-provision Workflow start state from the apply response', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json(
          {
            disposition: 'created',
            organizationId: 'org-a',
            operationId: 'op-server-provision-a',
            resourceId: 'server-provision-a',
            idempotencyKey: 'server-apply-a',
            fingerprint: 'a'.repeat(64),
            state: 'queued',
            workflowState: 'pending-reconciliation',
            plan: {
              kind: 'existing-node',
              pluginId: 'arma-reforger',
              pluginVersion: '0.1.0',
              placementMode: 'shared',
              nodeId: 'node-a',
              resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 },
              ports: [],
              newPaidInfrastructure: false,
              estimatedMonthlyIncreaseMinor: 0,
              explanation: 'existing ready capacity',
              warnings: [],
              candidates: [],
            },
          },
          { status: 202 },
        )
      },
    })

    const result = await Effect.runPromise(
      client.applyGameServer(
        'org-a',
        {
          schemaVersion: 1,
          server: {
            schemaVersion: 1,
            name: 'Eastern Front',
            pluginId: 'arma-reforger',
            placementMode: 'auto',
            resources: { cpuMillis: 2000, ramBytes: 4294967296, diskBytes: 42949672960 },
            nonHourlyCommitmentConfirmed: false,
          },
          game: {
            schemaVersion: 1,
            name: 'Eastern Front',
            pluginId: 'arma-reforger',
            placement: { mode: 'shared' },
            resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
            config: {},
            mods: [],
          },
          commercialReviewToken: 'a'.repeat(64),
        },
        { idempotencyKey: 'server-apply-a' },
      ),
    )

    expect(result.workflowState).toBe('pending-reconciliation')
    expect(request?.url).toBe('https://api.gridora.test/v1/organizations/org-a/game-servers/apply')
    expect(request?.headers.get('idempotency-key')).toBe('server-apply-a')
    await expect(request!.json()).resolves.toMatchObject({ commercialReviewToken: 'a'.repeat(64) })
  })

  it('reads and previews authoritative desired state without mutation idempotency', async () => {
    const requests: Request[] = []
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.url.endsWith('/config'))
          return Response.json({
            organizationId: 'org_1',
            serverId: 'server_1',
            plugin: { id: 'arma-reforger', version: '0.1.0' },
            revision: 2,
            activeRevision: 1,
            schemaVersion: 1,
            config: { passwordSecretRef: '[redacted]' },
            secretFields: [{ path: '/passwordSecretRef', state: 'configured' }],
            readOnly: true,
          })
        if (request.url.endsWith('/mods'))
          return Response.json({
            organizationId: 'org_1',
            serverId: 'server_1',
            plugin: { id: 'arma-reforger', version: '0.1.0' },
            desiredRevision: 2,
            resolvedRevision: 2,
            state: 'resolved',
            error: null,
            desiredMods: [],
            resolvedMods: [],
            readOnly: true,
          })
        if (request.url.endsWith('/config/plan'))
          return Response.json({
            organizationId: 'org_1',
            serverId: 'server_1',
            plugin: { id: 'arma-reforger', version: '0.1.0' },
            baseConfigRevision: 2,
            outcome: 'change',
            normalizedConfig: { passwordSecretRef: '[redacted]' },
            secretFields: [{ path: '/passwordSecretRef', state: 'configured' }],
            diff: [
              {
                path: '/passwordSecretRef',
                change: 'changed',
                before: '[redacted]',
                after: '[redacted]',
              },
            ],
            deployment: {
              pluginId: 'arma-reforger',
              pluginVersion: '0.1.0',
              resources: { cpu: 2, memoryMiB: 4_096, diskGiB: 40 },
              ports: [],
              install: { appId: 1_874_900, loginMode: 'anonymous' },
              config: { passwordSecretRef: '[redacted]' },
              secretFields: [{ path: '/passwordSecretRef', state: 'configured' }],
              mods: [],
              steps: ['validate'],
              sideEffects: false,
            },
            externalMetadata: { status: 'complete', reason: null },
            sideEffects: false,
          })
        return Response.json({
          organizationId: 'org_1',
          serverId: 'server_1',
          plugin: { id: 'arma-reforger', version: '0.1.0' },
          baseConfigRevision: 2,
          baseModRevision: 0,
          desiredMods: [],
          plannedMods: [],
          externalMetadata: { status: 'complete', reason: null },
          networkFetches: 0,
          sideEffects: false,
        })
      },
    })

    await Effect.runPromise(client.getGameConfig('org_1', 'server_1'))
    await Effect.runPromise(client.getGameMods('org_1', 'server_1'))
    await Effect.runPromise(
      client.previewGameConfig('org_1', 'server_1', {
        schemaVersion: 1,
        expectedConfigRevision: 2,
        config: { passwordSecretRef: 'secret-reference-one' },
      }),
    )
    await Effect.runPromise(
      client.planMods('org_1', 'server_1', {
        schemaVersion: 1,
        expectedConfigRevision: 2,
        expectedModRevision: 0,
        desiredMods: [],
      }),
    )

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'GET /v1/organizations/org_1/game-servers/server_1/config',
        'GET /v1/organizations/org_1/game-servers/server_1/mods',
        'POST /v1/organizations/org_1/game-servers/server_1/config/plan',
        'POST /v1/organizations/org_1/game-servers/server_1/mods/plan',
      ],
    )
    expect(requests.every((request) => request.headers.get('idempotency-key') === null)).toBe(true)
    await expect(requests[2]!.json()).resolves.toEqual({
      schemaVersion: 1,
      expectedConfigRevision: 2,
      config: { passwordSecretRef: 'secret-reference-one' },
    })
    await expect(requests[3]!.json()).resolves.toEqual({
      schemaVersion: 1,
      expectedConfigRevision: 2,
      expectedModRevision: 0,
      desiredMods: [],
    })
  })

  it('decodes persisted operation details without inventing retry actions', async () => {
    let request: Request | undefined
    const client = createGridoraClient({
      baseUrl: 'https://api.gridora.test',
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          id: 'operation-a',
          organizationId: 'org-a',
          type: 'retire-node',
          resourceType: 'node',
          resourceId: 'node-a',
          actorId: 'identity-a',
          status: 'waiting_external',
          progress: 60,
          idempotencyKey: 'retire-node-a',
          correlationId: 'correlation-a',
          revision: 3,
          createdAt: '2026-08-23T12:00:00.000Z',
          updatedAt: '2026-08-23T12:01:00.000Z',
          retryCount: 2,
          waitingReason: 'provider-cancellation-scheduled',
          providerReferenceHint: 'abcd...wxyz',
          cancellable: true,
          recovery: {
            code: 'wait-for-external-evidence',
            message:
              'Wait for authoritative external evidence; the operation will reconcile automatically.',
            retryAction: null,
          },
          finalResource: null,
          steps: [
            {
              key: 'destructive-workflow:0',
              label: 'drain-node',
              state: 'complete',
              attempt: 2,
              startedAt: '2026-08-23T12:00:10.000Z',
              completedAt: '2026-08-23T12:00:30.000Z',
            },
          ],
          logs: [
            {
              id: 'audit-a',
              action: 'node.drain.completed',
              result: 'succeeded',
              createdAt: '2026-08-23T12:00:30.000Z',
            },
          ],
        })
      },
    })

    const detail = await Effect.runPromise(client.operation('org-a', 'operation-a'))
    expect(request?.url).toBe(
      'https://api.gridora.test/v1/organizations/org-a/operations/operation-a',
    )
    expect(detail.retryCount).toBe(2)
    expect(detail.providerReferenceHint).toBe('abcd...wxyz')
    expect(detail.recovery.retryAction).toBeNull()
    expect(detail.steps).toHaveLength(1)
    expect(detail.logs).toHaveLength(1)
  })
})
