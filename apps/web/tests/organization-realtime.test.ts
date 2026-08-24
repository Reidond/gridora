import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrganizationRealtimeClient,
  decodeOrganizationEvent,
  maximumOrganizationEventBytes,
  organizationEventsWebSocketUrl,
  type OrganizationEventEnvelope,
  type OrganizationRealtimeScope,
  type OrganizationRealtimeState,
  type OrganizationRealtimeTicket,
} from '../services/organization-realtime'

class FakeSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = []

  constructor(readonly url: string) {}

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason })
  }

  open() {
    this.onopen?.({} as Event)
  }

  message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  closed(code: number) {
    this.onclose?.({ code } as CloseEvent)
  }
}

const ticket = (value = 'a'.repeat(32) + '.' + 'b'.repeat(32)): OrganizationRealtimeTicket => ({
  ticket: value,
  expiresAt: Date.now() + 60_000,
})

const event = (organizationId: string): OrganizationEventEnvelope => ({
  id: 'evt_01',
  organizationId,
  type: 'node.observation.updated',
  resourceId: 'node_01',
  occurredAt: '2026-08-23T12:00:00.000Z',
  data: { state: 'ready' },
})

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('organization realtime URL and event boundary', () => {
  it('maps only a secure API base to the exact tenant websocket route', () => {
    const url = new URL(
      organizationEventsWebSocketUrl(
        'https://api.gridora.test/control/',
        'https://console.gridora.test/o/night-watch',
        'night-watch',
        'ticket.value',
      ),
    )
    expect(url.origin).toBe('wss://api.gridora.test')
    expect(url.pathname).toBe('/control/v1/organizations/night-watch/events')
    expect(Array.from(url.searchParams.keys())).toEqual(['ticket'])
    expect(url.searchParams.get('ticket')).toBe('ticket.value')
    expect(() =>
      organizationEventsWebSocketUrl(
        'http://api.gridora.test',
        'https://console.gridora.test',
        'night-watch',
        'ticket.value',
      ),
    ).toThrow('secure API origin')
    expect(() =>
      organizationEventsWebSocketUrl(
        'https://api.gridora.test?redirect=https://other.test',
        'https://console.gridora.test',
        'night-watch',
        'ticket.value',
      ),
    ).toThrow('secure API origin')
  })

  it('accepts bounded exact envelopes only for the expected organization', () => {
    expect(decodeOrganizationEvent(JSON.stringify(event('org-a')), 'org-a')).toEqual(event('org-a'))
    expect(decodeOrganizationEvent(JSON.stringify(event('org-b')), 'org-a')).toBeUndefined()
    expect(
      decodeOrganizationEvent(JSON.stringify({ ...event('org-a'), unexpected: true }), 'org-a'),
    ).toBeUndefined()
    expect(decodeOrganizationEvent('{bad json', 'org-a')).toBeUndefined()
    expect(decodeOrganizationEvent(new Uint8Array([1, 2]), 'org-a')).toBeUndefined()
    expect(
      decodeOrganizationEvent('x'.repeat(maximumOrganizationEventBytes + 1), 'org-a'),
    ).toBeUndefined()
    let nested: Record<string, unknown> = {}
    for (let index = 0; index < 10; index += 1) nested = { child: nested }
    expect(
      decodeOrganizationEvent(JSON.stringify({ ...event('org-a'), data: nested }), 'org-a'),
    ).toBeUndefined()
  })
})

describe('organization realtime lifecycle', () => {
  const build = (
    fetchTicket: (organization: string, signal: AbortSignal) => Promise<OrganizationRealtimeTicket>,
  ) => {
    const sockets: FakeSocket[] = []
    const states: OrganizationRealtimeState[] = []
    const received: Array<{
      readonly event: OrganizationEventEnvelope
      readonly scope: OrganizationRealtimeScope
    }> = []
    const client = createOrganizationRealtimeClient({
      apiBase: 'https://api.gridora.test',
      pageUrl: 'https://console.gridora.test/o/night-watch/overview',
      fetchTicket,
      openSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      onState: (state) => states.push(state),
      onEvent: (receivedEvent, scope) => received.push({ event: receivedEvent, scope }),
    })
    return { client, sockets, states, received }
  }

  it('refreshes only the route bound to the validated organization event', async () => {
    const realtime = build(async () => ticket())
    realtime.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    realtime.sockets[0]?.open()
    realtime.sockets[0]?.message(JSON.stringify(event('org-b')))
    realtime.sockets[0]?.message(JSON.stringify(event('org-a')))
    expect(realtime.received).toEqual([
      { event: event('org-a'), scope: { route: 'night-watch', id: 'org-a' } },
    ])
    expect(realtime.states).toEqual(['connecting', 'connected'])
  })

  it('uses a fresh ticket after bounded reconnect delay and cleans up on organization switch', async () => {
    vi.useFakeTimers()
    let issued = 0
    const realtime = build(async () =>
      ticket(`${'a'.repeat(32)}.${String(++issued).padStart(32, 'b')}`),
    )
    realtime.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    const first = realtime.sockets[0]!
    first.open()
    first.closed(1006)
    expect(realtime.states.at(-1)).toBe('reconnecting')
    expect(realtime.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(realtime.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(realtime.sockets).toHaveLength(2)
    expect(issued).toBe(2)

    const second = realtime.sockets[1]!
    realtime.client.start({ route: 'second-org', id: 'org-b' })
    await settle()
    expect(second.closeCalls).toEqual([{ code: 1000, reason: 'client stopped' }])
    expect(realtime.sockets).toHaveLength(3)
    realtime.sockets[2]?.message(JSON.stringify(event('org-a')))
    realtime.sockets[2]?.message(JSON.stringify(event('org-b')))
    expect(realtime.received.at(-1)?.scope).toEqual({ route: 'second-org', id: 'org-b' })

    realtime.client.stop()
    expect(realtime.sockets[2]?.closeCalls).toEqual([{ code: 1000, reason: 'client stopped' }])
    expect(realtime.states.at(-1)).toBe('disabled')
  })

  it('caps exponential reconnect delay while obtaining a new ticket for every attempt', async () => {
    vi.useFakeTimers()
    let issued = 0
    const realtime = build(async () =>
      ticket(`${'a'.repeat(32)}.${String(++issued).padStart(32, 'b')}`),
    )
    realtime.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const delay of delays) {
      realtime.sockets.at(-1)?.closed(1006)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(realtime.sockets).toHaveLength(issued)
      await vi.advanceTimersByTimeAsync(1)
      await settle()
    }
    expect(issued).toBe(9)
    expect(realtime.sockets).toHaveLength(9)
  })

  it('stops without retry when ticket issuance or the socket reports authorization denial', async () => {
    vi.useFakeTimers()
    const denied = build(async () => Promise.reject({ status: 403 }))
    denied.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    expect(denied.states).toEqual(['connecting', 'denied'])
    await vi.runAllTimersAsync()
    expect(denied.sockets).toHaveLength(0)

    const revoked = build(async () => ticket())
    revoked.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    revoked.sockets[0]?.closed(4003)
    expect(revoked.states.at(-1)).toBe('denied')
    await vi.runAllTimersAsync()
    expect(revoked.sockets).toHaveLength(1)
  })

  it('never reports, logs, or persists ticket canaries', async () => {
    const canary = `${'canaryA'.repeat(5)}.${'canaryB'.repeat(5)}`
    const consoleCalls = vi.spyOn(console, 'log')
    const realtime = build(async () => ticket(canary))
    realtime.client.start({ route: 'night-watch', id: 'org-a' })
    await settle()
    expect(realtime.states.join(' ')).not.toContain(canary)
    expect(JSON.stringify(realtime.received)).not.toContain(canary)
    expect(consoleCalls).not.toHaveBeenCalled()
    expect(new URL(realtime.sockets[0]!.url).searchParams.get('ticket')).toBe(canary)
    expect(Object.keys(realtime)).not.toContain('ticket')
  })
})
