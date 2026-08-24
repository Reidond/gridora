import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RetryableInvitationEmailError,
  decodeInvitationEmailPayload,
  deriveInvitationToken,
  invitationEmailRemediationKey,
  invitationEmailRemediationRecord,
  writeInvitationEmailRemediation,
  sendInvitationEmail,
} from '../src/invitation-email.js'

const payload = () =>
  decodeInvitationEmailPayload({
    invitationId: 'invitation_1',
    email: 'member@example.com',
    role: 'operator',
    expiresAt: '2026-08-30T12:00:00.000Z',
    organizationName: "Ops <script>alert('canary-name')</script>\r\nBcc: attacker@example.com",
    tokenDerivation: { version: 'current-v1', scope: 'org_1:invitation-request-1' },
  })

const configuration = {
  publicAppUrl: 'https://console.gridora.dev/base/path?discarded=yes',
  from: 'invitations@gridora.dev',
  tokenKeys: {
    current: { version: 'current-v1', secret: 'test-secret-canary-token-key' },
    previous: { version: 'previous-v1', secret: 'previous-secret' },
  },
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('invitation token recovery', () => {
  it('derives the exact deterministic lowercase-hex HMAC used by invitation persistence', async () => {
    const scope = 'org_1:invitation-request-1'
    const expected = '818e4edfb662124f483c6563f54772779b35121dbaacc69bd4ec6f544ab99105'
    await expect(
      deriveInvitationToken(configuration.tokenKeys.current.secret, scope),
    ).resolves.toBe(expected)
  })
})

describe('invitation transactional email', () => {
  it('sends text and escaped HTML with a constructed URL and stable event id', async () => {
    const sent: Array<EmailMessageBuilder> = []
    const email: SendEmail = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        if (!('subject' in message)) throw new Error('Expected composed email')
        sent.push(message)
        return { messageId: 'message_1' }
      },
    }
    await expect(
      sendInvitationEmail('event_1', await payload(), configuration, email),
    ).resolves.toEqual({
      status: 'delivered',
      messageId: 'message_1',
    })
    const message = sent[0]
    expect(message).toBeDefined()
    expect(message?.headers).toEqual({ 'X-Gridora-Event-ID': 'event_1' })
    expect(message?.text).toContain(
      'Accept the invitation: https://console.gridora.dev/invitations/818e4ed',
    )
    expect(message?.text).not.toContain('discarded=yes')
    expect(message?.html).toContain(
      'Ops &lt;script&gt;alert(&#39;canary-name&#39;)&lt;/script&gt; Bcc: attacker@example.com',
    )
    expect(message?.html).not.toContain('<script>')
    expect(message?.html).toContain('/invitations/818e4ed')
    expect(message?.subject).not.toContain('\r')
    expect(message?.subject).not.toContain('\n')
  })

  it('retries only documented transient Email Service errors without leaking canaries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = Object.assign(new Error('secret canary-token and canary-name'), {
      code: 'E_RATE_LIMIT_EXCEEDED',
    })
    const email: SendEmail = {
      send: async () => {
        throw error
      },
    }
    const outcome = sendInvitationEmail('event_1', await payload(), configuration, email)
    await expect(outcome).rejects.toBeInstanceOf(RetryableInvitationEmailError)
    await expect(outcome).rejects.not.toThrow(/canary-token|canary-name/)
    expect(log).not.toHaveBeenCalled()
  })

  it('classifies validation and unknown provider errors as permanent using only a safe code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    for (const providerError of [
      Object.assign(new Error('canary-token canary-name'), { code: 'E_VALIDATION_ERROR' }),
      Object.assign(new Error('canary-token canary-name'), {
        code: 'E_UNDOCUMENTED_PROVIDER_ERROR',
      }),
    ]) {
      const email: SendEmail = {
        send: async () => {
          throw providerError
        },
      }
      const result = await sendInvitationEmail('event_1', await payload(), configuration, email)
      expect(JSON.stringify(result)).not.toMatch(/canary-token|canary-name/)
      expect(result.status).toBe('permanent-failure')
    }
    expect(log).not.toHaveBeenCalled()
  })

  it('treats an unavailable token key version as retryable without sending', async () => {
    let sends = 0
    const email: SendEmail = {
      send: async () => {
        sends += 1
        return { messageId: 'unexpected' }
      },
    }
    const input = await payload()
    await expect(
      sendInvitationEmail(
        'event_1',
        {
          ...input,
          tokenDerivation: { ...input.tokenDerivation, version: 'retired-v0' },
        },
        configuration,
        email,
      ),
    ).rejects.toMatchObject({ code: 'TOKEN_KEY_VERSION_UNAVAILABLE' })
    expect(sends).toBe(0)
  })

  it('creates a deterministic token-free terminal remediation contract', async () => {
    const record = await invitationEmailRemediationRecord({
      eventId: 'event_1',
      organizationId: 'org_1',
      invitationId: 'invitation_1',
      code: 'E_RECIPIENT_SUPPRESSED',
      eventCreatedAt: '2026-08-23T12:00:00.000Z',
    })
    expect(record).toEqual({
      version: 1,
      disposition: 'permanent-failure',
      action: 'reissue-invitation',
      eventId: 'event_1',
      organizationId: 'org_1',
      invitationId: 'invitation_1',
      code: 'E_RECIPIENT_SUPPRESSED',
      eventCreatedAt: '2026-08-23T12:00:00.000Z',
    })
    expect(JSON.stringify(record)).not.toMatch(
      /member@example\.com|canary-token|canary-name|tokenDerivation/,
    )
    expect(invitationEmailRemediationKey('org_1', 'event_1')).toBe(
      'organizations/org_1/notification-remediation/event_1.json',
    )
  })

  it('replays remediation persistence to the same key and byte-identical token-free body', async () => {
    const writes: Array<{ key: string; value: string }> = []
    const input = {
      eventId: 'event_1',
      organizationId: 'org_1',
      invitationId: 'invitation_1',
      code: 'E_RECIPIENT_SUPPRESSED',
      eventCreatedAt: '2026-08-23T12:00:00.000Z' as const,
    }
    const write = async (key: string, value: string) => {
      writes.push({ key, value })
    }
    await writeInvitationEmailRemediation(input, write)
    await writeInvitationEmailRemediation(input, write)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(JSON.stringify(writes)).not.toMatch(
      /member@example\.com|canary-token|canary-name|tokenDerivation/,
    )
  })
})
