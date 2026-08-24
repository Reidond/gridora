import type { GameServer, Node, Operation, Role } from '~/types/gridora'

export const toSlug = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

export const canManage = (role: Role) => role === 'Owner' || role === 'Administrator'
export const canOperate = (role: Role) => canManage(role) || role === 'Operator'

export const summarizeFleet = (
  servers: ReadonlyArray<GameServer>,
  nodes: ReadonlyArray<Node>,
  operations: ReadonlyArray<Operation>,
) => ({
  running: servers.filter((item) => item.status === 'running').length,
  degraded: servers.filter((item) => item.health === 'degraded' || item.health === 'failed').length,
  readyNodes: nodes.filter((item) => item.status === 'ready').length,
  activeOperations: operations.filter((item) =>
    ['queued', 'running', 'waiting'].includes(item.status),
  ).length,
})

export const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount)

/**
 * Accept only an unencoded, same-origin application path. Authentication return
 * targets are also validated by the API; this is a browser-side defence against
 * open redirects if a response is ever malformed or tampered with.
 */
export const safeAppPath = (value: unknown, fallback = '/') => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback
  let hasControlCharacter = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      hasControlCharacter = true
      break
    }
  }
  if (value.includes('\\') || /%(?:2f|5c)/i.test(value) || hasControlCharacter) return fallback
  try {
    const parsed = new URL(value, 'https://console.gridora.invalid')
    return parsed.origin === 'https://console.gridora.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback
  } catch {
    return fallback
  }
}

/** Keep issued auth state aligned with the API's deliberately narrow allowlist. */
export const safeAuthReturnPath = (value: unknown, fallback = '/') => {
  const path = safeAppPath(value, fallback)
  const pathname = path.split(/[?#]/, 1)[0]
  return pathname === '/' ||
    pathname === '/dashboard' ||
    pathname === '/setup/organization' ||
    pathname?.startsWith('/invitations/')
    ? path
    : fallback
}

/** The identity provider receives no authentication metadata except opaque state. */
export const accessRedirectUrl = (entryUrl: string, state: string) => {
  const url = new URL(entryUrl, globalThis.location?.origin ?? 'https://console.gridora.invalid')
  url.search = new URLSearchParams({ state }).toString()
  url.hash = ''
  return url.toString()
}
