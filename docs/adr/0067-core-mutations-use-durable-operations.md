# ADR 0067: Use durable operations for core organization mutations

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0013, ADR 0034, ADR 0061, and ADR 0064

## Situation

Core routes changed identity, organization, invitation, membership, ownership,
and policy state. Some routes returned a resource or an empty response. Some
routes used an idempotency table, but they did not create an exact operation.
The compact audit records did not contain the full FR-18 evidence. A retry
after a lost response could therefore lose the operation response or require a
membership that the successful request had removed.

## Task

Bind each core mutation to one actor, one action, one target, one canonical
payload, and one durable operation. Commit the resource change, completed
operation, v1 audit envelope, outbox event, and replay receipt in one D1
transaction. Return a typed completed-mutation response. Keep the final Owner
and revision fences.

## Execution

Migration 0031 adds immutable tenant and organization-bootstrap mutation
receipts. Migration 0038 adds the last-organization preference and an immutable
platform identity receipt for response-loss-safe sign-up. A tenant receipt
scopes the raw `Idempotency-Key` by organization,
actor, and action. It stores a SHA-256 payload fingerprint and references the
exact operation. D1 checks the public key length, result size, canonical
operation link, resource identity, and completed status. The actor reference
uses the immutable identity row, not the removable membership row.

The core D1 repositories read a receipt before a mutation. An equal key and
fingerprint returns the original operation and result. A different fingerprint
returns a conflict. A new request writes the resource and outbox state, the
completed operation, the staged v1 audit envelope, the compact audit row, and
the receipt in one batch. Self-leave stages its audit before it removes the
membership. A retry reads the scoped receipt before organization membership
authorization.

Organization bootstrap uses a platform operation because the tenant does not
exist at the start of the transaction. Sign-up and sign-in use terminal
platform operations. Organization policy update and invitation acceptance use
terminal tenant operations. Invitation acceptance creates the membership
before it stages human tenant evidence.

The short-lived authentication intent retains its verifier and bound Access
subject after first consumption until its original alarm. A retry from the
same browser and Access subject can therefore reach the immutable sign-up or
sign-in receipt; another subject cannot consume or adopt it.

The registration-policy port reads the immutable decision for the protected
authentication state before it evaluates mutable identity or invitation
facts. An exact retry adopts that decision. A different intent for the same
state fails closed. Existing-identity invitation acceptance reads its core
mutation receipt before it rejects an already accepted invitation. A new key
cannot adopt that acceptance.

Organization profile update changes only the mutable display name, timezone,
and default region under a revision fence; the slug remains immutable.
Invitation resend rotates the deterministic one-time token derivation and
expiry without returning a token or token hash. Organization switching records
only a client preference and terminal audit; every later request is still
authorized independently. The profile page reports the current Cloudflare
Access assertion and sign-out boundary without inventing local passwords,
tokens, or an enumerable Gridora session store.

The API uses a separate `MutationCompleted` contract. It does not change the
queued `MutationAccepted` contract. Organization creation, member role, member
removal, self-leave, ownership transfer, invitation creation, invitation
acceptance, invitation revocation, and policy update return the operation ID,
resource ID, `succeeded` status, and operation link. Organization profile,
invitation resend, and organization switch use the same contract. Invitation tokens and
token hashes are not returned. The web client reads authoritative state after
the completed response.

## Consequences

A lost response does not create a second core mutation. The same raw key can be
used by a different actor or action. A changed payload cannot adopt an earlier
operation. Audit evidence references the exact operation and contains the
before state, after state, actor, request, source, and result. A historical
receipt does not prevent later member removal or self-leave.

The migration and route composition are local implementation evidence. They do
not prove a production migration or a live Cloudflare request.

## Verification

Focused D1 tests execute the real migrations and repository batches. They cover
same-key replay, payload mismatch, one exact operation, self-leave after the
membership is removed, actor and action scoping, public key boundaries, and a
tampered canonical response. They also cover organization profile immutability,
resend token non-disclosure, audited preference switching, and platform sign-up
receipt adoption. Policy and HTTP tests cover protected-state decision
adoption after identity or invitation state changes. Invitation tests cover
exact existing-identity response-loss adoption and reject a new key after
acceptance. Policy tests also cover revision races, exact replay,
actor/action scoping, and authoritative post-state. Type checks cover the D1
repositories, identity and organization services, API, generated client, CLI,
and web adapter. No live Worker, D1
database, Access policy, invitation email, or organization membership was
changed.
