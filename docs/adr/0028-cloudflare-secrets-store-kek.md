# ADR 0028: Cloudflare Secrets Store key-encryption adapter

- Status: Accepted
- Date: 2026-08-23
- Extends: ADR 0020

## Context

ADR 0020 requires a production key service outside D1 and source code. A Worker
needs a narrow way to read the active key-encryption key and retained rotation keys.
The adapter must not expose key text to repositories or domain services.

## Decision

Gridora defines a key-encryption adapter for versioned Cloudflare Secrets Store
bindings. Each binding returns one base64url value that decodes to exactly 32 bytes.
The configured active version must exist in the keyring.

The adapter wraps a 32-byte data key with AES-256-GCM. Each wrap uses a fresh
96-bit IV. Authenticated data binds the wrapped key to the secret envelope scope.
The wrapped format contains a format version, IV, ciphertext, and authentication
tag. Unwrap selects the exact recorded key version and returns one generic typed
error for an unavailable key, malformed binding, changed authenticated data, or
cryptographic failure.

The adapter keeps old versions only for an explicit rotation overlap. It clears the
decoded raw key bytes after Web Crypto imports the key.

The API composes the adapter with the secret-envelope service and the D1
repository for feature-gated, Owner-only provider credential creation and
rotation. Provider types and envelope revisions are fenced in the same D1
transaction as metadata, idempotency, and audit. Wrangler binds each exact Secrets
Store secret. Live verification must still prove the binding and rotation path.

## Consequences

Secret-envelope services do not need a broad Cloudflare API token or plaintext key
variable. D1 still contains only ciphertext and wrapped data keys. A missing old
binding blocks unwrap for records that still use that version, so key retirement
must follow a complete migration or retention proof.

The current repository contains the adapter, provider secret endpoints, and local
HTTP and D1 tests. New provider accounts remain disabled until the separate live
validation and activation action succeeds. The repository does not contain a live
Secrets Store binding or live key-rotation result.

## Alternatives

We rejected a plaintext Worker variable for the key-encryption key. We rejected one
unversioned binding. We rejected silent fallback to the active key during unwrap.
We rejected detailed cryptographic errors that disclose keyring state.

## Verification

Wrap with the active version and unwrap with the recorded version. Confirm that two
wraps use different output. Keep an old version during rotation and unwrap its
records. Reject wrong authenticated data, a missing version, a malformed key, an
invalid format version, and changed ciphertext. In a protected environment, verify
the exact Secrets Store bindings without printing key values.
