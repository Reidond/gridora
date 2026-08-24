# ADR 0031: Server-enforced registration modes

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0014 and ADR 0016

## Situation

The public sign-up page cannot decide whether Gridora accepts a new account. A
client-side switch can be bypassed. Sign-in must not create an unknown account,
and a valid invitation must remain usable when public registration is closed.

## Task

Gridora must support `open`, `invitation-only`, and `closed` registration without
disclosing whether an email address, identity, or invitation exists. The decision
must happen after Access assertion validation and one-time intent validation.

## Execution

The API reads one server-side registration mode. A missing or invalid mode fails
closed.

- Sign-in permits an existing active identity. It never creates an identity.
- Public sign-up permits an existing identity in every mode. It creates a new
  identity only in `open` mode.
- Invitation completion can create or reuse an identity in every mode only after
  the server verifies the invitation token hash, email binding, state, expiry, and
  Access subject.

Every rejected public path uses one non-disclosing problem response. The API
stores a secret-free platform decision record keyed by the opaque authentication
state. A replay adopts that record instead of writing a second decision. The
decision audit finishes before account mutation. Identity creation and invitation
acceptance keep their existing atomic D1 transactions; the record does not claim
to be in the same transaction as those later operations.

## Consequences

Changing the web page cannot enable registration. Closing public registration
does not break an already issued valid invitation. Operators can audit policy
outcomes without storing the external email, invitation token, or Access JWT.

The mode is an environment-level control in this release. A future platform
control plane can manage it only through a separately authorized and audited
adapter.

## Verification

Behavioral HTTP tests must cover all three modes, known and unknown sign-in,
public sign-up, valid and invalid invitation completion, expired and consumed
invitations, email mismatch, opaque-state replay, invalid configuration, and exact
identity, membership, invitation, and audit side effects.
