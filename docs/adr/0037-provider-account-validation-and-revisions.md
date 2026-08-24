# ADR 0037: Provider account validation and revisions

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0008, ADR 0013, ADR 0020, and ADR 0035

## Situation

An organization provider account contains encrypted credentials and mutable
operational state. A validation request can change account status and cached
catalog data. A credential update changes encrypted data. These changes have
different revision clocks. A removed account also has immutable audit and
idempotency records that refer to its account ID.

## Task

Gridora must validate credentials without creating a provider resource. Gridora
must keep provider selection authoritative. Gridora must serialize account state
and credential changes without coupling their revisions. Gridora must remove
credential material without deleting historical evidence. Gridora must not show
a removed account as usable inventory.

## Execution

The provider account row owns an account revision. The secret envelope owns a
credential revision. A credential update supplies both expected revisions. The
D1 transaction advances the account revision and the credential revision with
separate compare-and-set clauses. A test, refresh, or disable action advances the
account revision. It does not claim that unchanged ciphertext is a new credential
revision.

The lifecycle control selects the validator from the persisted provider type. It
does not select the validator from request data. The control opens one exact
provider-account envelope. It uses an acquire-use-release scope. The release
action overwrites the plaintext buffer after success, typed failure, defect, or
interruption.

The validation adapter decodes one exact provider credential schema. It allows
only HTTPS endpoints that match the trusted provider configuration. It performs
read-only authentication, region, project, and catalog discovery. It limits
timeouts, response bytes, page count, and item count. It maps remote failures to
the provider error taxonomy. It does not return a raw response or a secret.

The action repository stores the operation, audit event, account change, cached
catalog change, and replay result in one D1 batch. The request fingerprint binds
the organization, account, action, and expected account revision. A lost response
adopts only the exact stored result.

Removal requires an Owner, a disabled account, no active allocation, and no node
reference. Removal deletes the exact credential envelope. It keeps a disabled,
revisioned account tombstone. It keeps the original mutation replay and the new
lifecycle replay, operation, and audit records. Inventory excludes an account
that has a finalized remove action. Repository reads that require credentials
also exclude the tombstone because it has no matching envelope.

## Consequences

A status refresh cannot strand the next credential update. A credential update
cannot race an account action without a revision conflict. Historical replay and
audit rows keep referential integrity after removal. A removed credential cannot
be opened, validated, refreshed, or selected for a new operation.

Provider validation still depends on remote provider availability. Local tests
with mock HTTP prove the contract. They do not prove that supplied production
credentials work or that a paid provider account is approved for use.

## Verification

Tests must cover strict credential decoding, fixed provider selection, read-only
HTTP methods, endpoint trust, time and size bounds, pagination bounds, normalized
errors, secret redaction, plaintext cleanup after interruption, tenant isolation,
role boundaries, revision conflicts, exact replay, response loss, catalog writes,
disabled-account rejection, removal fences, tombstone filtering, and credential
rotation after an account lifecycle action.
