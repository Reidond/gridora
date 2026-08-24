import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  ServerProvisionCommercialReviewScope,
  ServerProvisionNodePlan,
} from '@gridora/server-plan-control'
import {
  makeHmacServerProvisionCommercialReviews,
  matchesAcceptedPluginChannel,
} from '../src/server-provision-runtime.js'

const acceptedPlan = (): ServerProvisionNodePlan => ({
  kind: 'provision-node',
  pluginId: 'arma-reforger',
  pluginVersion: '1.2.3',
  pluginSelectionRevision: 7,
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
    estimatedMonthlyIncreaseMinor: 1000,
    billingCadence: 'hourly',
    contractMonths: 1,
    committedMonthlyBeforeMinor: 0,
    projectedCommittedMonthlyMinor: 1000,
  },
  requiresNonHourlyCommitmentConfirmation: false,
  commercialConsentRequired: false,
  implications: {
    dns: 'publish after verified endpoint',
    mods: 'validate before activation',
    backups: 'apply policy after deployment',
    downtime: 'new deployment',
    billing: 'starts after acceptance',
  },
  warnings: [],
  explanation: 'no fit',
  newPaidInfrastructure: true,
})

const commercialScope: ServerProvisionCommercialReviewScope = {
  schemaVersion: 1,
  organizationId: 'org-a',
  actorId: 'owner-a',
  actorRole: 'owner',
  actorMembershipRevision: 3,
  intent: {
    schemaVersion: 1,
    name: 'Eastern Front',
    pluginId: 'arma-reforger',
    placementMode: 'auto',
    resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
  },
  offer: {
    pluginId: 'arma-reforger',
    pluginVersion: '1.2.3',
    pluginSelectionRevision: 7,
    placementMode: 'shared',
    providerType: 'ovhcloud',
    region: 'gra',
    plan: 'b2-15',
    currency: 'EUR',
    estimatedMonthlyIncreaseMinor: 1_000,
    billingCadence: 'monthly',
    contractMonths: 1,
    committedMonthlyBeforeMinor: 5_000,
    projectedCommittedMonthlyMinor: 6_000,
  },
  reviewedSelectionDigest: 'a'.repeat(64),
  expiresAtEpochMilliseconds: 2_000_000_360_000,
}

describe('server provision accepted plugin fence', () => {
  it('uses the reviewed plugin channel and rejects a mutable catalog drift before game acceptance', () => {
    const plan = acceptedPlan()
    expect(
      matchesAcceptedPluginChannel(plan, [
        {
          pluginId: 'arma-reforger',
          activeVersion: '1.2.3',
          selectionRevision: 7,
        },
      ]),
    ).toBe(true)
    expect(
      matchesAcceptedPluginChannel(plan, [
        {
          pluginId: 'arma-reforger',
          activeVersion: '1.2.4',
          selectionRevision: 8,
        },
      ]),
    ).toBe(false)
  })

  it('issues opaque commercial proof only for the exact reviewed offer scope', async () => {
    const reviews = makeHmacServerProvisionCommercialReviews(
      'commercial-review-test-secret-with-at-least-thirty-two-bytes',
    )
    const token = await Effect.runPromise(reviews.issue(commercialScope))

    expect(token).toMatch(/^[a-f0-9]{64}$/)
    await expect(Effect.runPromise(reviews.verify(commercialScope, token))).resolves.toBe(true)
    await expect(Effect.runPromise(reviews.verify(commercialScope, 'malformed'))).resolves.toBe(
      false,
    )
    await expect(
      Effect.runPromise(
        reviews.verify(commercialScope, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`),
      ),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(reviews.verify({ ...commercialScope, organizationId: 'org-b' }, token)),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(
        reviews.verify(
          { ...commercialScope, offer: { ...commercialScope.offer, plan: 'b2-30' } },
          token,
        ),
      ),
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(
        reviews.verify(
          { ...commercialScope, intent: { ...commercialScope.intent, name: 'Different request' } },
          token,
        ),
      ),
    ).resolves.toBe(false)
  })
})
