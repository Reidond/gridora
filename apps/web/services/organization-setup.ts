export interface OrganizationSetupForm {
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly region: string
  readonly terms: boolean
  readonly budgetWarning: number
  readonly budgetCurrency: string
  readonly invitations: string
}

export interface OrganizationSetupRequest {
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly region: string
  readonly termsAccepted: boolean
  readonly budgetWarningThresholdMinor: number
  readonly budgetWarningCurrency: string
  readonly initialInvitations: ReadonlyArray<{
    readonly email: string
    readonly role: 'viewer'
  }>
}

export interface OrganizationSlugStatus {
  readonly valid: boolean
  readonly message: string
}

export const organizationSlugStatus = (slug: string): OrganizationSlugStatus => {
  const valid = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/.test(slug)
  return {
    valid,
    message: valid
      ? 'Slug format is valid. Availability is checked when you submit.'
      : 'Use 3–48 lowercase letters, numbers, or hyphens',
  }
}

export const organizationSetupRequest = (
  input: OrganizationSetupForm,
): OrganizationSetupRequest => {
  const emails = [
    ...new Set(
      input.invitations
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  return {
    name: input.name,
    slug: input.slug,
    timezone: input.timezone,
    region: input.region,
    termsAccepted: input.terms,
    budgetWarningThresholdMinor: Math.round(input.budgetWarning * 100),
    budgetWarningCurrency: input.budgetCurrency.toUpperCase(),
    initialInvitations: emails.map((email) => ({ email, role: 'viewer' })),
  }
}
