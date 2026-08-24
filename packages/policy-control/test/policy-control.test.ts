import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  decodeOrganizationPolicy,
  evaluateIdlePolicy,
  evaluatePolicyAdmission,
  makeInitialOrganizationPolicy,
  makeLifecyclePolicyAdmission,
  OrganizationPolicyV1,
  type AdmissionInput,
  type AdmissionRequest,
  type OrganizationPolicyRepositoryShape,
  type OrganizationUsage,
  type PolicyWarning,
  type PriceEstimate,
} from '../src/index.js'

const now = 2_000_000_000_000

const policy = (overrides: Partial<OrganizationPolicyV1> = {}): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId: 'org-a',
  revision: 7,
  allowedProviders: ['ovhcloud', 'contabo'],
  allowedRegions: ['eu-west', 'de-central'],
  allowedPlans: ['b2-15', 'cloud-vps-10'],
  capacity: {
    maxActiveNodes: 5,
    maxDedicatedNodes: 2,
    maxServersPerNode: 4,
    maxDeploymentCpuMillis: 4_000,
    maxDeploymentRamBytes: 8_589_934_592,
    maxDeploymentDiskBytes: 107_374_182_400,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 10_000,
    hardLimitMinor: 15_000,
  },
  temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
  idle: { action: 'shutdown', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [{ dayOfWeekUtc: 1, startMinuteUtc: 120, durationMinutes: 60 }],
  updates: { automatic: 'security', requireMaintenanceWindow: true },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
  ...overrides,
})

const request = (overrides: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
  organizationId: 'org-a',
  action: 'provision-node',
  provider: 'ovhcloud',
  region: 'eu-west',
  plan: 'b2-15',
  dedicatedNode: false,
  targetNodeId: null,
  resources: null,
  temporaryNodeLifetimeHours: 24,
  destructiveBackup: 'not-applicable',
  nonHourlyCommitmentConfirmed: false,
  updateContext: { mode: 'not-applicable', category: 'not-applicable' },
  ...overrides,
})

const usage = (overrides: Partial<OrganizationUsage> = {}): OrganizationUsage => ({
  organizationId: 'org-a',
  observedAtEpochMilliseconds: now - 1_000,
  activeNodes: 1,
  dedicatedNodes: 0,
  serversByNode: { 'node-a': 2 },
  estimatedCommittedMonthlyMinor: 4_000,
  currency: 'EUR',
  ...overrides,
})

const knownPrice = (
  overrides: Partial<Extract<PriceEstimate, { status: 'known' }>> = {},
): Extract<PriceEstimate, { status: 'known' }> => ({
  status: 'known',
  provider: 'ovhcloud',
  region: 'eu-west',
  plan: 'b2-15',
  currency: 'EUR',
  estimatedMonthlyMinor: 5_000,
  billingCadence: 'hourly',
  contractMonths: 1,
  observedAtEpochMilliseconds: now - 10_000,
  validUntilEpochMilliseconds: now + 10_000,
  ...overrides,
})

const input = (overrides: Partial<AdmissionInput> = {}): AdmissionInput => ({
  policy: policy(),
  request: request(),
  usage: usage(),
  price: knownPrice(),
  nowEpochMilliseconds: now,
  ...overrides,
})

const codes = (value: ReturnType<typeof evaluatePolicyAdmission>) =>
  value.outcome === 'deny' ? value.violations.map((violation) => violation.code) : []

describe('versioned policy schema', () => {
  it('decodes a complete v1 policy', async () => {
    await expect(Effect.runPromise(decodeOrganizationPolicy(policy()))).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 7,
    })
  })

  it('rejects unknown versions and invalid maintenance/update policy', async () => {
    await expect(
      Effect.runPromise(
        decodeOrganizationPolicy({
          ...policy(),
          schemaVersion: 2,
          maintenanceWindows: [{ dayOfWeekUtc: 7, startMinuteUtc: 1_440, durationMinutes: 0 }],
          updates: { automatic: 'sometimes', requireMaintenanceWindow: true },
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'PolicyValidationError', code: 'invalid_policy_schema' })
  })

  it('rejects duplicate allow-list entries and inverted budget thresholds', async () => {
    await expect(
      Effect.runPromise(
        decodeOrganizationPolicy({ ...policy(), allowedProviders: ['ovhcloud', 'ovhcloud'] }),
      ),
    ).rejects.toMatchObject({ code: 'duplicate_allow_list_value' })
    await expect(
      Effect.runPromise(
        decodeOrganizationPolicy({
          ...policy(),
          monthlyBudget: {
            currency: 'EUR',
            setupWarningMinor: null,
            softLimitMinor: 20_000,
            hardLimitMinor: 10_000,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'soft_budget_exceeds_hard_budget' })
    await expect(
      Effect.runPromise(
        decodeOrganizationPolicy({
          ...policy(),
          monthlyBudget: {
            currency: null,
            setupWarningMinor: 5_000,
            softLimitMinor: 0,
            hardLimitMinor: 0,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'setup_warning_currency_required' })
  })

  it('rejects excess fields and automatic updates without a required maintenance window', async () => {
    await expect(
      Effect.runPromise(decodeOrganizationPolicy({ ...policy(), clientSuppliedBypass: true })),
    ).rejects.toMatchObject({ code: 'invalid_policy_schema' })
    await expect(
      Effect.runPromise(
        decodeOrganizationPolicy({
          ...policy(),
          maintenanceWindows: [],
          updates: { automatic: 'all', requireMaintenanceWindow: true },
        }),
      ),
    ).rejects.toMatchObject({ code: 'automatic_update_requires_maintenance_window' })
  })

  it('accepts only safe integer minor units', () => {
    expect(() =>
      Schema.decodeUnknownSync(OrganizationPolicyV1)({
        ...policy(),
        monthlyBudget: {
          currency: 'EUR',
          setupWarningMinor: null,
          softLimitMinor: 10_000.5,
          hardLimitMinor: 15_000,
        },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(OrganizationPolicyV1)({
        ...policy(),
        monthlyBudget: {
          currency: 'EUR',
          setupWarningMinor: null,
          softLimitMinor: 10_000,
          hardLimitMinor: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrow()
  })
})

describe('initial organization policy', () => {
  it('serializes the exact fail-closed revision-1 contract without inventing currency', () => {
    expect(
      makeInitialOrganizationPolicy({ organizationId: 'org-new', defaultRegion: 'eu-west' }),
    ).toEqual({
      schemaVersion: 1,
      organizationId: 'org-new',
      revision: 1,
      allowedProviders: [],
      allowedRegions: ['eu-west'],
      allowedPlans: [],
      capacity: {
        maxActiveNodes: 0,
        maxDedicatedNodes: 0,
        maxServersPerNode: 0,
        maxDeploymentCpuMillis: 0,
        maxDeploymentRamBytes: 0,
        maxDeploymentDiskBytes: 0,
      },
      monthlyBudget: {
        currency: null,
        setupWarningMinor: null,
        softLimitMinor: 0,
        hardLimitMinor: 0,
      },
      temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 1 },
      idle: { action: 'none', afterMinutes: 1 },
      backups: { requiredBeforeDelete: true },
      maintenanceWindows: [],
      updates: { automatic: 'disabled', requireMaintenanceWindow: false },
      contabo: { maxContractMonths: 1 },
      nonHourlyCommitment: { explicitConfirmationRequired: true },
    })
  })

  it('preserves an optional setup warning without converting it into authorization', () => {
    const initial = makeInitialOrganizationPolicy({
      organizationId: 'org-new',
      defaultRegion: 'eu-west',
      setupBudgetWarning: { minor: 2_500, currency: 'EUR' },
    })
    expect(initial.monthlyBudget).toEqual({
      currency: 'EUR',
      setupWarningMinor: 2_500,
      softLimitMinor: 0,
      hardLimitMinor: 0,
    })
    expect(initial.allowedProviders).toEqual([])
    expect(initial.allowedPlans).toEqual([])
    expect(initial.capacity).toEqual({
      maxActiveNodes: 0,
      maxDedicatedNodes: 0,
      maxServersPerNode: 0,
      maxDeploymentCpuMillis: 0,
      maxDeploymentRamBytes: 0,
      maxDeploymentDiskBytes: 0,
    })
  })

  it('denies paid creation under the initial policy', () => {
    const initial = makeInitialOrganizationPolicy({
      organizationId: 'org-a',
      defaultRegion: 'eu-west',
      setupBudgetWarning: { minor: 2_500, currency: 'EUR' },
    })
    const decision = evaluatePolicyAdmission(input({ policy: initial }))
    expect(codes(decision)).toEqual(
      expect.arrayContaining([
        'provider_not_allowed',
        'plan_not_allowed',
        'active_node_limit',
        'hard_budget_exceeded',
      ]),
    )
  })

  it('rejects malformed identifiers, region, warning currency, and non-integer minor units', () => {
    expect(() =>
      makeInitialOrganizationPolicy({ organizationId: '', defaultRegion: 'eu-west' }),
    ).toThrow()
    expect(() =>
      makeInitialOrganizationPolicy({ organizationId: 'org-new', defaultRegion: 'bad region' }),
    ).toThrow()
    expect(() =>
      makeInitialOrganizationPolicy({
        organizationId: 'org-new',
        defaultRegion: 'eu-west',
        setupBudgetWarning: { minor: 1, currency: 'eur' },
      }),
    ).toThrow()
    expect(() =>
      makeInitialOrganizationPolicy({
        organizationId: 'org-new',
        defaultRegion: 'eu-west',
        setupBudgetWarning: { minor: 1.5, currency: 'EUR' },
      }),
    ).toThrow()
  })
})

describe('tenant and allow-list boundaries', () => {
  it('fails closed when usage belongs to another organization', () => {
    const decision = evaluatePolicyAdmission(input({ usage: usage({ organizationId: 'org-b' }) }))
    expect(decision.outcome).toBe('deny')
    expect(codes(decision)).toContain('usage_tenant_mismatch')
  })

  it('fails closed when the policy belongs to another organization', () => {
    const decision = evaluatePolicyAdmission(input({ policy: policy({ organizationId: 'org-b' }) }))
    expect(codes(decision)).toContain('policy_tenant_mismatch')
  })

  it.each([
    ['provider', request({ provider: 'other' }), 'provider_not_allowed'],
    ['region', request({ region: 'us-east' }), 'region_not_allowed'],
    ['plan', request({ plan: 'unbounded' }), 'plan_not_allowed'],
  ] as const)('denies a disallowed %s', (_label, value, expected) => {
    expect(codes(evaluatePolicyAdmission(input({ request: value })))).toContain(expected)
  })

  it('treats a missing target node in tenant usage as a scope failure', () => {
    const decision = evaluatePolicyAdmission(
      input({
        request: request({
          action: 'deploy-server',
          targetNodeId: 'node-from-other-org',
          resources: { cpuMillis: 1_000, ramBytes: 1_000, diskBytes: 1_000 },
        }),
        price: { status: 'unknown' },
      }),
    )
    expect(codes(decision)).toContain('usage_tenant_mismatch')
  })
})

describe('hard capacity and exact boundaries', () => {
  it('allows equality at all configured limits', () => {
    const provision = evaluatePolicyAdmission(
      input({
        usage: usage({ activeNodes: 4, dedicatedNodes: 1, estimatedCommittedMonthlyMinor: 10_000 }),
        request: request({ dedicatedNode: true }),
        price: knownPrice({ estimatedMonthlyMinor: 5_000 }),
      }),
    )
    expect(provision.outcome).toBe('warn')

    const placement = evaluatePolicyAdmission(
      input({
        request: request({
          action: 'deploy-server',
          targetNodeId: 'node-a',
          resources: {
            cpuMillis: 4_000,
            ramBytes: 8_589_934_592,
            diskBytes: 107_374_182_400,
          },
        }),
        usage: usage({ serversByNode: { 'node-a': 3 } }),
        price: { status: 'unknown' },
      }),
    )
    expect(placement).toEqual({ outcome: 'allow', warnings: [] })
  })

  it('denies one beyond each hard capacity', () => {
    const nodeDecision = evaluatePolicyAdmission(
      input({
        usage: usage({ activeNodes: 5, dedicatedNodes: 2 }),
        request: request({ dedicatedNode: true }),
      }),
    )
    expect(codes(nodeDecision)).toEqual(
      expect.arrayContaining(['active_node_limit', 'dedicated_node_limit']),
    )

    const serverDecision = evaluatePolicyAdmission(
      input({
        request: request({
          action: 'deploy-server',
          targetNodeId: 'node-a',
          resources: {
            cpuMillis: 4_001,
            ramBytes: 8_589_934_593,
            diskBytes: 107_374_182_401,
          },
        }),
        usage: usage({ serversByNode: { 'node-a': 4 } }),
        price: { status: 'unknown' },
      }),
    )
    expect(codes(serverDecision)).toEqual(
      expect.arrayContaining([
        'servers_per_node_limit',
        'deployment_cpu_limit',
        'deployment_ram_limit',
        'deployment_disk_limit',
      ]),
    )
  })
})

describe('estimated budget and provider commitment policy', () => {
  it('allows exactly at the soft budget and warns distinctly above it', () => {
    const exact = evaluatePolicyAdmission(
      input({ usage: usage({ estimatedCommittedMonthlyMinor: 5_000 }) }),
    )
    expect(exact).toEqual({ outcome: 'allow', warnings: [] })

    const above = evaluatePolicyAdmission(
      input({ usage: usage({ estimatedCommittedMonthlyMinor: 5_001 }) }),
    )
    expect(above).toMatchObject({
      outcome: 'warn',
      warnings: [{ code: 'soft_budget_exceeded', projectedEstimatedMonthlyMinor: 10_001 }],
    })
  })

  it('warns at the hard boundary and denies only above it', () => {
    const exact = evaluatePolicyAdmission(
      input({ usage: usage({ estimatedCommittedMonthlyMinor: 10_000 }) }),
    )
    expect(exact.outcome).toBe('warn')
    const above = evaluatePolicyAdmission(
      input({ usage: usage({ estimatedCommittedMonthlyMinor: 10_001 }) }),
    )
    expect(codes(above)).toContain('hard_budget_exceeded')
  })

  it.each([
    [{ status: 'unknown' } as const, 'price_unknown'],
    [knownPrice({ validUntilEpochMilliseconds: now }), 'price_stale'],
  ])('fails closed for unknown or stale price data', (price, expected) => {
    expect(codes(evaluatePolicyAdmission(input({ price })))).toContain(expected)
  })

  it('requires an exact scoped price and matching integer-minor-unit currency', () => {
    const decision = evaluatePolicyAdmission(
      input({ price: knownPrice({ provider: 'contabo', currency: 'USD' }) }),
    )
    expect(codes(decision)).toEqual(
      expect.arrayContaining(['price_scope_mismatch', 'price_currency_mismatch']),
    )
  })

  it('enforces Contabo contract duration and explicit non-hourly confirmation', () => {
    const contaboRequest = request({
      provider: 'contabo',
      region: 'de-central',
      plan: 'cloud-vps-10',
      nonHourlyCommitmentConfirmed: false,
    })
    const decision = evaluatePolicyAdmission(
      input({
        request: contaboRequest,
        price: knownPrice({
          provider: 'contabo',
          region: 'de-central',
          plan: 'cloud-vps-10',
          billingCadence: 'contract',
          contractMonths: 13,
        }),
      }),
    )
    expect(codes(decision)).toEqual(
      expect.arrayContaining(['contabo_contract_too_long', 'non_hourly_confirmation_required']),
    )

    const allowed = evaluatePolicyAdmission(
      input({
        request: { ...contaboRequest, nonHourlyCommitmentConfirmed: true },
        price: knownPrice({
          provider: 'contabo',
          region: 'de-central',
          plan: 'cloud-vps-10',
          billingCadence: 'monthly',
          contractMonths: 12,
        }),
      }),
    )
    expect(allowed.outcome).toBe('allow')
  })
})

describe('expiry, destructive backup, and lifecycle adapter', () => {
  it('enforces automatic expiry and its exact maximum lifetime', () => {
    expect(
      evaluatePolicyAdmission(input({ request: request({ temporaryNodeLifetimeHours: 168 }) }))
        .outcome,
    ).toBe('allow')
    expect(
      codes(
        evaluatePolicyAdmission(input({ request: request({ temporaryNodeLifetimeHours: null }) })),
      ),
    ).toContain('temporary_expiry_required')
    expect(
      codes(
        evaluatePolicyAdmission(input({ request: request({ temporaryNodeLifetimeHours: 169 }) })),
      ),
    ).toContain('temporary_lifetime_limit')
  })

  it.each(['missing', 'skip-authorized', 'not-applicable'] as const)(
    'does not let %s bypass required destructive backup policy',
    (destructiveBackup) => {
      const decision = evaluatePolicyAdmission(
        input({
          request: request({ action: 'delete-server', destructiveBackup }),
          price: { status: 'unknown' },
        }),
      )
      expect(codes(decision)).toContain('backup_required_before_delete')
    },
  )

  it('allows destructive deletion only with a verified backup when required', () => {
    const decision = evaluatePolicyAdmission(
      input({
        request: request({ action: 'delete-server', destructiveBackup: 'verified' }),
        price: { status: 'unknown' },
      }),
    )
    expect(decision).toEqual({ outcome: 'allow', warnings: [] })
  })

  it('records soft warnings before admitting a lifecycle command', async () => {
    const recorded: PolicyWarning[][] = []
    const repository: OrganizationPolicyRepositoryShape = { get: () => Effect.succeed(policy()) }
    const adapter = makeLifecyclePolicyAdmission(
      repository,
      {
        resolve: () =>
          Effect.succeed({
            request: request(),
            usage: usage({ estimatedCommittedMonthlyMinor: 5_001 }),
            price: knownPrice(),
          }),
      },
      { nowEpochMilliseconds: Effect.succeed(now) },
      {
        record: (_organizationId, warnings) =>
          Effect.sync(() => {
            recorded.push([...warnings])
          }),
      },
    )
    await Effect.runPromise(
      adapter.admit(
        { organizationId: 'org-a', kind: 'provision-node' },
        { organizationId: 'org-a', id: 'node-a', kind: 'node' },
      ),
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.[0]?.code).toBe('soft_budget_exceeded')
  })

  it('fails closed when policy, facts, or warning persistence is unavailable', async () => {
    const unavailablePolicy = makeLifecyclePolicyAdmission(
      { get: () => Effect.die('unreachable') },
      { resolve: () => Effect.die('unreachable') },
      { nowEpochMilliseconds: Effect.succeed(now) },
      { record: () => Effect.void },
    )
    await expect(
      Effect.runPromise(
        unavailablePolicy.admit(
          { organizationId: 'org-a', kind: 'provision-node' },
          { organizationId: 'org-b', id: 'node-a', kind: 'node' },
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'PolicyAdmissionDeniedError', code: 'usage_tenant_mismatch' })
  })
})

describe('automatic-update and idle reconciler policy', () => {
  const mondayAt = (hour: number, minute: number) => Date.UTC(2026, 7, 24, hour, minute, 0, 0) // Monday

  it('denies disabled automatic updates but permits an explicit manual update', () => {
    const disabled = policy({ updates: { automatic: 'disabled', requireMaintenanceWindow: false } })
    expect(
      codes(
        evaluatePolicyAdmission(
          input({
            policy: disabled,
            request: request({
              action: 'update-server',
              updateContext: { mode: 'automatic', category: 'security' },
            }),
            price: { status: 'unknown' },
          }),
        ),
      ),
    ).toContain('automatic_updates_disabled')
    expect(
      evaluatePolicyAdmission(
        input({
          policy: disabled,
          request: request({
            action: 'update-server',
            updateContext: { mode: 'manual', category: 'feature' },
          }),
          price: { status: 'unknown' },
        }),
      ).outcome,
    ).toBe('allow')
  })

  it('allows only security-category automatic updates in security mode', () => {
    const decision = evaluatePolicyAdmission(
      input({
        request: request({
          action: 'update-server',
          updateContext: { mode: 'automatic', category: 'feature' },
        }),
        price: { status: 'unknown' },
        nowEpochMilliseconds: mondayAt(2, 0),
      }),
    )
    expect(codes(decision)).toContain('automatic_update_category_not_allowed')
  })

  it('uses inclusive-start and exclusive-end UTC maintenance boundaries', () => {
    const updateRequest = request({
      action: 'update-server',
      updateContext: { mode: 'automatic', category: 'security' },
    })
    expect(
      evaluatePolicyAdmission(
        input({
          request: updateRequest,
          price: { status: 'unknown' },
          nowEpochMilliseconds: mondayAt(2, 0),
        }),
      ).outcome,
    ).toBe('allow')
    expect(
      codes(
        evaluatePolicyAdmission(
          input({
            request: updateRequest,
            price: { status: 'unknown' },
            nowEpochMilliseconds: mondayAt(3, 0),
          }),
        ),
      ),
    ).toContain('outside_maintenance_window')
  })

  it('supports maintenance windows that wrap into the next UTC day and week', () => {
    const wrapping = policy({
      maintenanceWindows: [{ dayOfWeekUtc: 0, startMinuteUtc: 1_410, durationMinutes: 90 }],
    })
    const automatic = request({
      action: 'update-server',
      updateContext: { mode: 'automatic', category: 'security' },
    })
    expect(
      evaluatePolicyAdmission(
        input({
          policy: wrapping,
          request: automatic,
          price: { status: 'unknown' },
          nowEpochMilliseconds: mondayAt(0, 30),
        }),
      ).outcome,
    ).toBe('allow')
    expect(
      codes(
        evaluatePolicyAdmission(
          input({
            policy: wrapping,
            request: automatic,
            price: { status: 'unknown' },
            nowEpochMilliseconds: mondayAt(1, 0),
          }),
        ),
      ),
    ).toContain('outside_maintenance_window')
  })

  it('rejects missing or irrelevant update context', () => {
    expect(
      codes(
        evaluatePolicyAdmission(
          input({
            request: request({ action: 'update-server' }),
            price: { status: 'unknown' },
          }),
        ),
      ),
    ).toContain('update_context_invalid')
    expect(
      codes(
        evaluatePolicyAdmission(
          input({
            request: request({ updateContext: { mode: 'manual', category: 'feature' } }),
          }),
        ),
      ),
    ).toContain('update_context_invalid')
  })

  it('projects idle reconciliation deterministically at the exact threshold', () => {
    const idlePolicy = policy({
      idle: { action: 'delete', afterMinutes: 60 },
      backups: { requiredBeforeDelete: true },
    })
    expect(
      evaluateIdlePolicy({
        policy: idlePolicy,
        nowEpochMilliseconds: now,
        lastActivityEpochMilliseconds: now - 60 * 60_000 + 1,
      }),
    ).toEqual({ action: 'none', reason: 'not-idle' })
    expect(
      evaluateIdlePolicy({
        policy: idlePolicy,
        nowEpochMilliseconds: now,
        lastActivityEpochMilliseconds: now - 60 * 60_000,
      }),
    ).toEqual({
      action: 'delete',
      reason: 'idle-threshold-reached',
      backupRequiredBeforeDelete: true,
    })
  })
})
