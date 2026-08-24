import { safeAppPath } from '~/utils/gridora'

export type AuthIntent = 'sign-in' | 'sign-up' | 'accept-invitation'

export type AuthCompletion = {
  intent: AuthIntent
  next: 'dashboard' | 'setup-organization'
  returnTo: string
  membership?: { organizationId: string }
}

type StoredDemoIntent = {
  intent: AuthIntent
  returnTo: string
  displayName?: string
  invitationToken?: string
  expiresAt: number
}

const prefix = 'gridora:demo-auth:'

export const issueDemoAuthState = (intent: StoredDemoIntent) => {
  const state = `demo_state_${crypto.randomUUID()}`
  sessionStorage.setItem(`${prefix}${state}`, JSON.stringify(intent))
  return state
}

export const consumeDemoAuthState = (state: string): AuthCompletion => {
  const key = `${prefix}${state}`
  const raw = sessionStorage.getItem(key)
  sessionStorage.removeItem(key)
  if (!raw) throw new Error('Authentication state is invalid, expired, or already used')
  const stored = JSON.parse(raw) as StoredDemoIntent
  if (stored.expiresAt <= Date.now()) throw new Error('Authentication state has expired')
  return {
    intent: stored.intent,
    next: stored.intent === 'sign-up' ? 'setup-organization' : 'dashboard',
    returnTo: safeAppPath(stored.returnTo),
    ...(stored.intent === 'accept-invitation'
      ? { membership: { organizationId: 'org_night_watch' } }
      : {}),
  }
}
