import { describe, expect, it } from 'vitest'
import {
  CommercialReviewRequiredApiCode,
  GridoraApiError,
  auditEventFromApi,
  backupFromApi,
  collectNotificationRemediation,
  gameServerFromApi,
  nodeFromApi,
  notificationRemediationFromApi,
  operationFromApi,
  providerFromApi,
  commercialReviewRecoveryFor,
  isCommercialReviewRequired,
} from '../services/gridora-api'
import {
  buildServerApplyRequest,
  describeReviewedBillingTerms,
  pluginSupports,
  requiresCommercialOfferReview,
  requiresNonHourlyCommitmentConfirmation,
} from '../services/server-apply'

describe('API inventory view models', () => {
  it('classifies only the actionable commercial-review conflict as requiring a fresh preview', () => {
    expect(
      isCommercialReviewRequired(
        new GridoraApiError(409, CommercialReviewRequiredApiCode, 'Offer changed'),
      ),
    ).toBe(true)
    expect(isCommercialReviewRequired(new GridoraApiError(409, 'CONFLICT', 'Other conflict'))).toBe(
      false,
    )
    expect(
      isCommercialReviewRequired(
        new GridoraApiError(503, CommercialReviewRequiredApiCode, 'Retry'),
      ),
    ).toBe(false)
    expect(
      commercialReviewRecoveryFor(
        new GridoraApiError(409, CommercialReviewRequiredApiCode, 'Offer changed'),
      ),
    ).toEqual({
      discardReviewedPlan: true,
      resetCommercialAcknowledgement: true,
      requireExplicitPreview: true,
    })
    expect(
      commercialReviewRecoveryFor(new GridoraApiError(409, 'CONFLICT', 'Other conflict')),
    ).toBeUndefined()
  })

  it('builds one exact server scheduler and game lifecycle intent from generic plugin fields', () => {
    const request = buildServerApplyRequest({
      name: 'Northern Range',
      pluginId: 'valheim',
      placementMode: 'auto',
      cpuCores: 2,
      memoryMiB: 4096,
      diskGiB: 40,
      domain: 'northern.example.test',
      configJson: '{"world":"Ashlands"}',
      modsJson: '[{"source":"workshop","id":"mod-1","loadOrder":0}]',
      includeMods: true,
      nonHourlyCommitmentConfirmed: true,
      commercialReviewToken: 'a'.repeat(64),
    })

    expect(request).toEqual({
      schemaVersion: 1,
      server: {
        schemaVersion: 1,
        name: 'Northern Range',
        pluginId: 'valheim',
        placementMode: 'auto',
        resources: {
          cpuMillis: 2000,
          ramBytes: 4294967296,
          diskBytes: 42949672960,
        },
        nonHourlyCommitmentConfirmed: true,
      },
      game: {
        schemaVersion: 1,
        name: 'Northern Range',
        pluginId: 'valheim',
        placement: { mode: 'shared' },
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
        config: { world: 'Ashlands' },
        mods: [{ source: 'workshop', id: 'mod-1', loadOrder: 0 }],
        domain: 'northern.example.test',
      },
      commercialReviewToken: 'a'.repeat(64),
    })
    expect(JSON.stringify(request)).not.toContain('provider')
    expect(JSON.stringify(request)).not.toContain('image')
  })

  it('uses plugin capabilities rather than game-name branches for optional mods', () => {
    expect(
      pluginSupports(
        {
          id: 'plugin-a',
          name: 'Any Game',
          version: '1.0.0',
          apiVersion: 'gridora.plugin/v1alpha1',
          enabled: true,
          capabilities: ['mods'],
          limitations: [],
        },
        'mods',
      ),
    ).toBe(true)
    expect(pluginSupports(undefined, 'mods')).toBe(false)
  })

  it('requires reviewed commercial consent only for a non-hourly plan that policy marks as requiring it', () => {
    expect(
      requiresNonHourlyCommitmentConfirmation({
        kind: 'provision-node',
        requiresNonHourlyCommitmentConfirmation: true,
        billing: { billingCadence: 'hourly' },
      }),
    ).toBe(false)
    expect(
      requiresNonHourlyCommitmentConfirmation({
        kind: 'provision-node',
        requiresNonHourlyCommitmentConfirmation: false,
        billing: { billingCadence: 'monthly' },
      }),
    ).toBe(false)
    expect(
      requiresNonHourlyCommitmentConfirmation({
        kind: 'provision-node',
        requiresNonHourlyCommitmentConfirmation: true,
        billing: { billingCadence: 'contract' },
      }),
    ).toBe(true)
    expect(
      requiresCommercialOfferReview({
        kind: 'provision-node',
        commercialConsentRequired: true,
        billing: { billingCadence: 'hourly' },
      }),
    ).toBe(false)
    expect(
      requiresCommercialOfferReview({
        kind: 'provision-node',
        commercialConsentRequired: true,
        billing: { billingCadence: 'monthly' },
      }),
    ).toBe(true)
  })

  it('renders the exact reviewed billing cadence and commitment term in the confirmation model', () => {
    expect(describeReviewedBillingTerms({ billingCadence: 'hourly', contractMonths: 1 })).toBe(
      'Hourly billing · no term commitment',
    )
    expect(describeReviewedBillingTerms({ billingCadence: 'monthly', contractMonths: 3 })).toBe(
      'Monthly billing · 3-month commitment',
    )
    expect(describeReviewedBillingTerms({ billingCadence: 'contract', contractMonths: 12 })).toBe(
      '12-month provider contract',
    )
  })

  it('rejects malformed mod JSON through the canonical server apply schema before request', () => {
    const draft = {
      name: 'Northern Range',
      pluginId: 'valheim',
      placementMode: 'shared' as const,
      cpuCores: 2,
      memoryMiB: 4096,
      diskGiB: 40,
      domain: '',
      configJson: '{}',
      includeMods: true,
      nonHourlyCommitmentConfirmed: false,
    }
    expect(() =>
      buildServerApplyRequest({
        ...draft,
        modsJson: '[{"source":"workshop","id":"mod-1"}]',
      }),
    ).toThrow(/server apply contract/)
    expect(() =>
      buildServerApplyRequest({
        ...draft,
        modsJson: '[{"source":"workshop","id":"mod-1","loadOrder":"first"}]',
      }),
    ).toThrow(/server apply contract/)
  })

  it('rejects a malformed commercial review proof before the typed client can submit it', () => {
    expect(() =>
      buildServerApplyRequest({
        name: 'Northern Range',
        pluginId: 'valheim',
        placementMode: 'auto',
        cpuCores: 2,
        memoryMiB: 4096,
        diskGiB: 40,
        domain: '',
        configJson: '{}',
        modsJson: '[]',
        includeMods: false,
        nonHourlyCommitmentConfirmed: true,
        commercialReviewToken: 'not-a-review-proof',
      }),
    ).toThrow(/server apply contract/)
  })

  it('does not invent game telemetry from desired or observed state', () => {
    const server = gameServerFromApi({
      id: 'server_01',
      name: 'Everon',
      pluginId: 'arma-reforger',
      pluginVersion: '1.0.0',
      observedState: 'running',
      placementPolicy: {},
      domain: null,
    })

    expect(server).toMatchObject({
      status: 'running',
      health: 'unknown',
      nodeId: 'Not assigned',
    })
    expect(server).not.toHaveProperty('endpoint')
    expect(server).not.toHaveProperty('players')
    expect(server).not.toHaveProperty('scenario')
    expect(server).not.toHaveProperty('build')
  })

  it('keeps unreported node telemetry absent', () => {
    const node = nodeFromApi({
      id: 'node_01',
      providerType: 'ovhcloud',
      region: 'GRA11',
      plan: 'b2-15',
      imageId: 'image_01',
      desiredState: 'ready',
      observedState: 'ready',
      reconciliationError: null,
      lastReconciledAt: null,
    })

    expect(node).toMatchObject({ provider: 'OVHcloud', status: 'ready', health: 'healthy' })
    expect(node).not.toHaveProperty('cpu')
    expect(node).not.toHaveProperty('costMonthly')
    expect(node).not.toHaveProperty('tunnel')
    expect(node).not.toHaveProperty('publicAddress')
  })

  it('uses only durable operation fields returned by the contract', () => {
    const operation = operationFromApi({
      id: 'operation_01',
      revision: 3,
      type: 'deploy-game-server',
      resourceType: 'game-server',
      resourceId: 'server_01',
      actorId: 'identity_01',
      status: 'waiting_external',
      progress: 40,
      createdAt: '2026-08-23T12:00:00Z',
      updatedAt: '2026-08-23T12:00:10Z',
    })

    expect(operation).toMatchObject({
      revision: 3,
      status: 'waiting',
      progress: 40,
      actor: 'identity_01',
      cancellable: false,
      logs: [],
      steps: [],
    })
    expect(operation).not.toHaveProperty('providerRequestId')
    expect(operation).not.toHaveProperty('retries')
  })

  it('maps only persisted operation detail evidence into the detail view', () => {
    const operation = operationFromApi({
      id: 'operation_02',
      revision: 4,
      type: 'retire-node',
      resourceType: 'node',
      resourceId: 'node_01',
      actorId: 'identity_01',
      status: 'waiting_external',
      progress: 60,
      createdAt: '2026-08-23T12:00:00Z',
      updatedAt: '2026-08-23T12:01:00Z',
      retryCount: 2,
      waitingReason: 'provider-cancellation-scheduled',
      providerReferenceHint: 'abcd...wxyz',
      cancellable: true,
      recovery: { message: 'Wait for authoritative external evidence.', retryAction: null },
      finalResource: null,
      steps: [
        {
          key: 'destructive-workflow:0',
          label: 'drain-node',
          state: 'complete',
          attempt: 2,
        },
      ],
      logs: [
        {
          id: 'audit_01',
          action: 'node.drain.completed',
          result: 'succeeded',
          createdAt: '2026-08-23T12:00:30Z',
        },
      ],
    })
    expect(operation).toMatchObject({
      elapsed: '60s',
      retries: 2,
      waitingReason: 'provider-cancellation-scheduled',
      providerRequestId: 'abcd...wxyz',
      cancellable: true,
      recoveryGuidance: 'Wait for authoritative external evidence.',
      resourceType: 'node',
      steps: [{ label: 'drain-node', status: 'complete', attempt: 2 }],
      logs: ['2026-08-23T12:00:30Z · node.drain.completed · succeeded'],
    })
  })

  it('maps canonical game-server operation resources to the server UI route type', () => {
    const operation = operationFromApi({
      id: 'operation_03',
      revision: 1,
      type: 'server.start',
      resourceType: 'game-server',
      resourceId: 'server_01',
      actorId: 'identity_01',
      status: 'succeeded',
      progress: 100,
      createdAt: '2026-08-23T12:00:00Z',
      updatedAt: '2026-08-23T12:00:10Z',
      finalResource: { type: 'game-server', id: 'server_01' },
    })
    expect(operation.resourceType).toBe('server')
    expect(operation.finalResource).toEqual({ type: 'server', id: 'server_01' })
  })

  it('uses optional backup metadata only when the API reports it', () => {
    const backup = backupFromApi({
      id: 'backup_01',
      serverId: 'server_01',
      checksum: 'sha256:value',
      metadata: {},
      state: 'available',
      createdAt: '2026-08-23T12:00:00Z',
      expiresAt: null,
    })

    expect(backup.server).toBe('server_01')
    expect(backup).not.toHaveProperty('size')
    expect(backup).not.toHaveProperty('consistency')
    expect(backup).not.toHaveProperty('retainedUntil')
  })

  it('maps provider and audit identifiers without replacing them with demo labels', () => {
    expect(
      providerFromApi({
        id: 'provider_01',
        scope: 'organization',
        organizationId: 'org_01',
        providerType: 'contabo',
        status: 'active',
        revision: 2,
        credentialRevision: 2,
        createdAt: '2026-08-23T11:00:00Z',
        updatedAt: '2026-08-23T12:00:00Z',
      }),
    ).toMatchObject({
      provider: 'Contabo',
      source: 'Organization account',
      status: 'healthy',
      regions: [],
    })

    expect(
      auditEventFromApi({
        id: 'audit_01',
        actorId: 'identity_01',
        action: 'invitation.create',
        targetType: 'invitation',
        targetId: 'invitation_01',
        result: 'succeeded',
        correlationId: 'correlation_01',
        createdAt: '2026-08-23T12:00:00Z',
        schemaVersion: 1,
        captureStatus: 'complete',
        envelope: {
          version: 1,
          captureStatus: 'complete',
          actor: { type: 'human', id: 'identity_01' },
          request: { id: 'request_01', correlationId: 'correlation_01' },
          operationId: 'operation_01',
          forced: false,
          breakGlass: false,
        },
      }),
    ).toMatchObject({
      actor: 'identity_01',
      target: 'invitation:invitation_01',
      outcome: 'success',
      requestId: 'correlation_01',
      schemaVersion: 1,
      captureStatus: 'complete',
      operationId: 'operation_01',
      actorType: 'human',
    })
  })

  it('keeps delivery remediation token-free and email-free', () => {
    const apiRecord = {
      eventId: 'event_01',
      invitationId: 'invitation_01',
      disposition: 'permanent-failure' as const,
      action: 'reissue-invitation' as const,
      code: 'E_RECIPIENT_SUPPRESSED',
      eventCreatedAt: '2026-08-23T12:00:00Z',
      email: 'must-not-be-copied@example.com',
      token: 'must-not-be-copied',
    }
    const remediation = notificationRemediationFromApi(apiRecord)

    expect(remediation).toEqual({
      eventId: 'event_01',
      invitationId: 'invitation_01',
      disposition: 'permanent-failure',
      action: 'reissue-invitation',
      code: 'E_RECIPIENT_SUPPRESSED',
      eventCreatedAt: '2026-08-23T12:00:00Z',
    })
    expect(JSON.stringify(remediation)).not.toContain('must-not-be-copied')
  })

  it('collects each remediation page and rejects a repeated cursor', async () => {
    const pages = [
      { items: ['event_01'], cursor: 'next', truncated: true },
      { items: ['event_02'], truncated: false },
    ]
    await expect(collectNotificationRemediation(async () => pages.shift()!)).resolves.toEqual([
      'event_01',
      'event_02',
    ])

    await expect(
      collectNotificationRemediation(async () => ({
        items: [],
        cursor: 'same',
        truncated: true,
      })),
    ).rejects.toThrow('invalid pagination cursor')
  })
})
