export const maximumOrganizationEventBytes = 64 * 1024

export interface OrganizationEventEnvelope {
  readonly id: string
  readonly organizationId: string
  readonly type: string
  readonly resourceId?: string
  readonly occurredAt: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface OrganizationRealtimeTicket {
  readonly ticket: string
  readonly expiresAt: number
}

export interface OrganizationRealtimeScope {
  readonly route: string
  readonly id: string
}

export type OrganizationRealtimeState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'denied'

interface RealtimeSocket {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  close: (code?: number, reason?: string) => void
}

export interface OrganizationRealtimeDependencies {
  readonly apiBase: string
  readonly pageUrl: string
  readonly fetchTicket: (
    organization: string,
    signal: AbortSignal,
  ) => Promise<OrganizationRealtimeTicket>
  readonly openSocket: (url: string) => RealtimeSocket
  readonly onEvent: (event: OrganizationEventEnvelope, scope: OrganizationRealtimeScope) => void
  readonly onState: (state: OrganizationRealtimeState) => void
  readonly isAuthorizationDenied?: (error: unknown) => boolean
  readonly setTimer?: (callback: () => void, delay: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
}

const identifier = (value: unknown, maximumLength = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumLength

const safeRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const boundedJson = (value: unknown): boolean => {
  let nodes = 0
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > 1024 || depth > 8) return false
    if (current === null || typeof current === 'boolean') return true
    if (typeof current === 'number') return Number.isFinite(current)
    if (typeof current === 'string') return current.length <= maximumOrganizationEventBytes
    if (Array.isArray(current))
      return current.length <= 256 && current.every((item) => visit(item, depth + 1))
    if (!safeRecord(current)) return false
    const entries = Object.entries(current)
    return (
      entries.length <= 256 &&
      entries.every(
        ([key, child]) => key.length > 0 && key.length <= 256 && visit(child, depth + 1),
      )
    )
  }
  return visit(value, 0)
}

export const decodeOrganizationEvent = (
  message: unknown,
  expectedOrganization: string,
): OrganizationEventEnvelope | undefined => {
  if (typeof message !== 'string') return undefined
  if (message.length > maximumOrganizationEventBytes) return undefined
  if (new TextEncoder().encode(message).byteLength > maximumOrganizationEventBytes) return undefined
  let value: unknown
  try {
    value = JSON.parse(message)
  } catch {
    return undefined
  }
  if (!safeRecord(value)) return undefined
  const allowedKeys = new Set(['id', 'organizationId', 'type', 'resourceId', 'occurredAt', 'data'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined
  if (
    !identifier(value.id) ||
    value.organizationId !== expectedOrganization ||
    !identifier(value.type, 128) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.type) ||
    (value.resourceId !== undefined && !identifier(value.resourceId)) ||
    !identifier(value.occurredAt, 64) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value.occurredAt) ||
    Number.isNaN(Date.parse(value.occurredAt)) ||
    !safeRecord(value.data) ||
    !boundedJson(value.data)
  )
    return undefined
  return {
    id: value.id,
    organizationId: value.organizationId,
    type: value.type,
    ...(value.resourceId === undefined ? {} : { resourceId: value.resourceId }),
    occurredAt: value.occurredAt,
    data: value.data,
  }
}

const websocketOrigin = (apiBase: string, pageUrl: string): URL => {
  const resolved = new URL(apiBase || '/', pageUrl)
  if (
    resolved.protocol !== 'https:' ||
    resolved.username !== '' ||
    resolved.password !== '' ||
    resolved.search !== '' ||
    resolved.hash !== ''
  )
    throw new Error('Gridora realtime requires a secure API origin.')
  resolved.protocol = 'wss:'
  return resolved
}

export const organizationEventsWebSocketUrl = (
  apiBase: string,
  pageUrl: string,
  organization: string,
  ticket: string,
): string => {
  if (!identifier(organization) || !/^[a-z0-9][a-z0-9-]*$/.test(organization))
    throw new Error('Gridora realtime requires a valid organization.')
  const url = websocketOrigin(apiBase, pageUrl)
  const prefix = url.pathname.replace(/\/$/, '')
  url.pathname = `${prefix}/v1/organizations/${encodeURIComponent(organization)}/events`
  url.search = ''
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

const validTicket = (value: OrganizationRealtimeTicket): boolean => {
  const now = Date.now()
  return (
    typeof value.ticket === 'string' &&
    value.ticket.length >= 32 &&
    value.ticket.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.ticket) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now &&
    value.expiresAt <= now + 120_000
  )
}

export const createOrganizationRealtimeClient = (
  dependencies: OrganizationRealtimeDependencies,
) => {
  const setTimer =
    dependencies.setTimer ??
    ((callback: () => void, delay: number): unknown => globalThis.setTimeout(callback, delay))
  const clearTimer =
    dependencies.clearTimer ??
    ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>))
  const authorizationDenied =
    dependencies.isAuthorizationDenied ??
    ((error: unknown) => safeRecord(error) && (error.status === 401 || error.status === 403))
  let generation = 0
  let organization: OrganizationRealtimeScope | undefined
  let socket: RealtimeSocket | undefined
  let abort: AbortController | undefined
  let reconnectTimer: unknown
  let reconnectAttempt = 0

  const setState = (state: OrganizationRealtimeState) => dependencies.onState(state)

  const cleanupConnection = () => {
    abort?.abort()
    abort = undefined
    if (reconnectTimer !== undefined) clearTimer(reconnectTimer)
    reconnectTimer = undefined
    if (socket !== undefined) {
      const current = socket
      socket = undefined
      current.onopen = null
      current.onmessage = null
      current.onerror = null
      current.onclose = null
      current.close(1000, 'client stopped')
    }
  }

  const reconnect = (expectedGeneration: number) => {
    if (expectedGeneration !== generation || organization === undefined) return
    const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6))
    reconnectAttempt += 1
    setState('reconnecting')
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined
      void connect(expectedGeneration)
    }, delay)
  }

  const connect = async (expectedGeneration: number): Promise<void> => {
    if (expectedGeneration !== generation || organization === undefined) return
    abort = new AbortController()
    const expectedOrganization = organization
    try {
      const issued = await dependencies.fetchTicket(expectedOrganization.route, abort.signal)
      if (expectedGeneration !== generation || abort.signal.aborted) return
      if (!validTicket(issued)) throw new Error('Gridora realtime ticket response was invalid.')
      const url = organizationEventsWebSocketUrl(
        dependencies.apiBase,
        dependencies.pageUrl,
        expectedOrganization.route,
        issued.ticket,
      )
      const current = dependencies.openSocket(url)
      socket = current
      current.onopen = () => {
        if (expectedGeneration !== generation || socket !== current) return
        reconnectAttempt = 0
        setState('connected')
      }
      current.onmessage = (message) => {
        if (expectedGeneration !== generation || socket !== current) return
        const event = decodeOrganizationEvent(message.data, expectedOrganization.id)
        if (event !== undefined) dependencies.onEvent(event, expectedOrganization)
      }
      current.onerror = () => {
        // The close event drives reconnection. Never surface a URL or ticket from browser errors.
      }
      current.onclose = (event) => {
        if (expectedGeneration !== generation || socket !== current) return
        socket = undefined
        if (event.code === 4003 || event.code === 4401 || event.code === 4403) {
          setState('denied')
          return
        }
        reconnect(expectedGeneration)
      }
    } catch (error) {
      if (expectedGeneration !== generation || abort.signal.aborted) return
      if (authorizationDenied(error)) {
        setState('denied')
        return
      }
      reconnect(expectedGeneration)
    }
  }

  const start = (nextOrganization: OrganizationRealtimeScope | undefined) => {
    if (
      organization !== undefined &&
      nextOrganization !== undefined &&
      organization.route === nextOrganization.route &&
      organization.id === nextOrganization.id
    )
      return
    generation += 1
    cleanupConnection()
    organization = nextOrganization
    reconnectAttempt = 0
    if (organization === undefined) {
      setState('disabled')
      return
    }
    setState('connecting')
    void connect(generation)
  }

  const stop = () => {
    generation += 1
    organization = undefined
    reconnectAttempt = 0
    cleanupConnection()
    setState('disabled')
  }

  return { start, stop }
}
