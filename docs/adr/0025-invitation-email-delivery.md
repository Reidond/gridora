# ADR 0025: Invitation email delivery

- Status: Accepted
- Date: 2026-08-23

## Context

An invitation is not useful when the invitee cannot receive its link. A plaintext
invitation token in D1, a Queue, or a log would create a reusable credential leak.
An API token for email would add another broad secret to the Worker.

## Decision

The invitation transaction writes an outbox event with the invitation facts, a
token derivation scope, and a token key version. It does not write the plaintext
token. The outbox consumer recovers the deterministic token from the versioned
keyring only when it builds the message.

The Queue Worker uses the Cloudflare Email Service Worker binding. The binding has
an allowed sender address. The message contains text and escaped HTML. The link
targets `/invitations/<encoded-token>`. The event ID is a stable email header.

The consumer retries only transient service failures. For a permanent failure, the
consumer first writes a deterministic, token-free remediation record to an
organization-scoped R2 key. It then moves the leased outbox row to a terminal failed
state. A terminal row is not eligible for another delivery claim. A failure to
write the remediation record remains retryable.

Email delivery is at least once because the service has no send idempotency key. A
crash after send and before outbox acknowledgement can produce a duplicate message
with the same event ID and link.

## Consequences

D1 and Queue payloads do not contain the invitation bearer token. The remediation
record also excludes the token, recipient address, and organization name. The
deployment must keep old token keys during the maximum invitation and outbox
lifetime. An operator must onboard and verify the sender domain before production
use. The organization console gives Owners and Administrators a read-only view of
the token-free remediation records. It does not retry the terminal email or reveal
an old invitation token. A future reissue action must create a new invitation
token, expiry, outbox event, and audit event in one idempotent transaction; a view
action must never silently perform that mutation.

## Alternatives

We rejected a token returned only to the inviter. It does not complete delivery. We
rejected a plaintext token in the Queue. We rejected the REST API from a Worker
because the native binding needs no Cloudflare API token.

## Verification

Create an invitation and lose the request response. Drain the outbox more than once.
Confirm stable content and event ID. Confirm that transient errors retry. Confirm
that permanent errors create one deterministic token-free remediation record and
that the outbox row cannot be claimed again. Confirm that HTML input is escaped and
token canaries do not enter D1, R2 remediation data, Queue logs, or errors. Open the
emailed route and complete an email-matched Access flow.
