import { Effect, Layer, Schema } from 'effect'
import { OrganizationContext } from '@gridora/domain'
import {
  OrphanClockLayer,
  OrphanControl,
  OrphanControlError,
  OrphanControlLive,
  OrphanDiscoveryPortLayer,
  OrphanRepositoryLayer,
  type OrphanReconciliationResult,
} from '@gridora/orphan-control'
import {
  makeOrphanD1Repository,
  type OrphanD1Database,
  type OrphanD1Options,
} from '@gridora/orphan-d1'
import {
  makeOrphanProviderDiscovery,
  type OrphanDiscoveryAccount,
  type OrphanProviderDiscoveryDependencies,
} from '@gridora/orphan-provider-discovery'
import type { SecretEnvelopeServiceShape } from '@gridora/secret-envelope'

export interface OrphanReconciliationRuntimeOptions {
  readonly database: OrphanD1Database
  readonly secrets: SecretEnvelopeServiceShape
  /** Opens one platform account from an audited encrypted platform secret store. */
  readonly openPlatformCredentials: (
    accountId: string,
    providerType: 'ovhcloud' | 'contabo',
  ) => Effect.Effect<Uint8Array, OrphanControlError>
  readonly providers: Pick<OrphanProviderDiscoveryDependencies, 'ovhcloud' | 'contabo'>
  readonly now?: () => Date
  readonly d1?: Partial<OrphanD1Options>
}

const failure = (
  operation: string,
  code: 'invalid-scope' | 'discovery-failed' = 'discovery-failed',
) => new OrphanControlError({ operation, code, message: 'orphan reconciliation failed' })

const accountSelect = `SELECT account.id, account.scope,
 account.organization_id AS accountOrganizationId,
 account.provider_type AS providerType,
 account.credential_reference AS credentialReference,
 CASE WHEN account.scope = 'platform' THEN platformEnvelope.revision ELSE envelope.revision END AS credentialRevision,
 account.status
 FROM provider_accounts AS account
 JOIN provider_allocations AS allocation
   ON allocation.provider_account_id = account.id
  AND allocation.organization_id = ?
  AND allocation.status = 'active'
 JOIN organizations AS organization
   ON organization.id = allocation.organization_id
  AND organization.status = 'active'
 LEFT JOIN secret_envelopes AS envelope
   ON envelope.organization_id = account.organization_id
  AND envelope.id = account.credential_reference
 AND envelope.scope_type = 'provider-account'
  AND envelope.scope_id = account.id
 LEFT JOIN platform_secret_envelopes AS platformEnvelope
   ON account.scope = 'platform'
  AND account.organization_id IS NULL
  AND platformEnvelope.id = account.credential_reference
  AND platformEnvelope.scope_type = 'provider-account'
  AND platformEnvelope.scope_id = account.id
 WHERE account.id = ?
   AND account.status = 'active'
   AND (
     (account.scope = 'platform' AND account.organization_id IS NULL AND platformEnvelope.id IS NOT NULL)
     OR
     (account.scope = 'organization' AND account.organization_id = ? AND envelope.id IS NOT NULL)
   )`

const AccountRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(['platform', 'organization']),
  accountOrganizationId: Schema.NullOr(Schema.String),
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  credentialReference: Schema.String,
  credentialRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Literal('active'),
})

/** Read one account only through an active allocation for the exact tenant. */
export const makeOrphanAccountLoader =
  (database: OrphanD1Database) =>
  (request: {
    readonly organizationId: string
    readonly providerAccountId: string
    readonly providerType: 'ovhcloud' | 'contabo'
  }): Effect.Effect<OrphanDiscoveryAccount, OrphanControlError> =>
    Effect.tryPromise({
      try: () =>
        database
          .prepare(accountSelect)
          .bind(request.organizationId, request.providerAccountId, request.organizationId)
          .first(),
      catch: () => failure('orphan.runtime.account'),
    }).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(failure('orphan.runtime.account.scope', 'invalid-scope'))
          : Schema.decodeUnknownEffect(AccountRow, { onExcessProperty: 'error' })(value).pipe(
              Effect.mapError(() => failure('orphan.runtime.account.decode')),
            ),
      ),
      Effect.flatMap((account) =>
        account.providerType !== request.providerType
          ? Effect.fail(failure('orphan.runtime.account.type', 'invalid-scope'))
          : Effect.succeed({
              id: account.id,
              scope: account.scope,
              organizationId: request.organizationId,
              accountOrganizationId: account.accountOrganizationId,
              providerType: account.providerType,
              credentialReference: account.credentialReference,
              credentialRevision: account.credentialRevision,
              status: account.status,
            } satisfies OrphanDiscoveryAccount),
      ),
    )

/**
 * The D1 repository verifies the active identity, membership, allocation,
 * organization, account, and provider tuple before orphan control calls the
 * discovery port. This context exists only to address the already-authorized
 * account envelope by exact tenant coordinates.
 */
const internalContext = (request: {
  readonly organizationId: string
  readonly actorId: string
  readonly runId: string
}) =>
  Schema.decodeUnknownEffect(OrganizationContext, { onExcessProperty: 'error' })({
    organizationId: request.organizationId,
    organizationSlug: 'internal',
    identityId: request.actorId,
    role: 'automation',
    correlationId: request.runId,
  }).pipe(Effect.mapError(() => failure('orphan.runtime.context', 'invalid-scope')))

/**
 * Compose the complete local orphan-reconciliation Effect. A signed internal
 * Queue or Workflow handler may call the returned function; no public route is
 * registered here.
 */
export const makeOrphanReconciliation = (options: OrphanReconciliationRuntimeOptions) => {
  const now = options.now ?? (() => new Date())
  const repository = makeOrphanD1Repository(options.database, {
    now: () => now().toISOString(),
    ...options.d1,
  })
  const loadAccount = makeOrphanAccountLoader(options.database)
  const discovery = makeOrphanProviderDiscovery({
    ...options.providers,
    now,
    loadAccount,
    openCredentials: (request, account) =>
      account.scope === 'platform'
        ? options
            .openPlatformCredentials(account.id, account.providerType)
            .pipe(Effect.mapError(() => failure('orphan.runtime.credentials.platform')))
        : Effect.gen(function* () {
            const context = yield* internalContext(request)
            return yield* options.secrets
              .open(context, {
                id: account.credentialReference,
                scopeType: 'provider-account',
                scopeId: account.id,
              })
              .pipe(Effect.mapError(() => failure('orphan.runtime.credentials.organization')))
          }),
  })
  const dependencies = Layer.mergeAll(
    OrphanDiscoveryPortLayer(discovery),
    OrphanRepositoryLayer(repository),
    OrphanClockLayer(now),
  )
  const live = OrphanControlLive.pipe(Layer.provide(dependencies))

  return (request: unknown): Effect.Effect<OrphanReconciliationResult, OrphanControlError> =>
    Effect.gen(function* () {
      return yield* (yield* OrphanControl).reconcile(request)
    }).pipe(Effect.provide(live))
}
