PRAGMA foreign_keys = ON;

-- Platform-scoped, secret-free decisions made before an organization may
-- exist. The opaque authentication state is the deduplication identifier.
CREATE TABLE registration_policy_decisions (
  decision_id TEXT PRIMARY KEY NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('sign-in', 'public-sign-up', 'invitation-completion')),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'invitation-only', 'closed')),
  identity_known INTEGER NOT NULL CHECK (identity_known IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('allow-existing', 'allow-create', 'deny')),
  reason TEXT NOT NULL CHECK (reason IN (
    'existing_identity', 'open_registration', 'unknown_sign_in',
    'public_registration_disabled', 'valid_invitation', 'invalid_invitation',
    'expired_invitation', 'invitation_binding_mismatch', 'invitation_already_consumed'
  )),
  decided_at_epoch_ms INTEGER NOT NULL CHECK (decided_at_epoch_ms > 0)
) STRICT;

CREATE INDEX registration_policy_decisions_timeline
  ON registration_policy_decisions(decided_at_epoch_ms DESC);
