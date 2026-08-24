import { describe, expect, it } from 'vitest'
import { organizationSetupRequest, organizationSlugStatus } from '../services/organization-setup'

describe('organization setup request', () => {
  it('reports local format validation without claiming global slug availability', () => {
    expect(organizationSlugStatus('night-watch')).toEqual({
      valid: true,
      message: 'Slug format is valid. Availability is checked when you submit.',
    })
    expect(organizationSlugStatus('Night Watch')).toEqual({
      valid: false,
      message: 'Use 3–48 lowercase letters, numbers, or hyphens',
    })
  })

  it('sends explicit currency, minor units, and unique initial invitations', () => {
    expect(
      organizationSetupRequest({
        name: 'Night Watch',
        slug: 'night-watch',
        timezone: 'Europe/Uzhgorod',
        region: 'eu-west',
        terms: true,
        budgetWarning: 250.75,
        budgetCurrency: 'eur',
        invitations: 'OPS@example.com, observer@example.com; ops@example.com',
      }),
    ).toEqual({
      name: 'Night Watch',
      slug: 'night-watch',
      timezone: 'Europe/Uzhgorod',
      region: 'eu-west',
      termsAccepted: true,
      budgetWarningThresholdMinor: 25_075,
      budgetWarningCurrency: 'EUR',
      initialInvitations: [
        { email: 'ops@example.com', role: 'viewer' },
        { email: 'observer@example.com', role: 'viewer' },
      ],
    })
  })
})
