import { apiRoutes, unsupportedApiRoutes } from './contracts.js'

/**
 * This is a release inventory, not an authorization mechanism. It is checked
 * against the executable OpenAPI route list so a new mutation cannot be
 * omitted silently while its operation/audit conversion is in progress.
 */
export type AuditMutationCoverageState =
  | 'complete-v1'
  | 'blocked-before-side-effects'
  | 'conversion-in-progress'

export interface AuditMutationInventoryEntry {
  readonly operationId: string
  readonly state: AuditMutationCoverageState
  readonly owner: 'core' | 'node-platform' | 'game' | 'backup-destructive' | 'audit'
  readonly operationPath: string
  readonly idempotencyPath: string
  readonly auditPath: string
}

const conversion = (
  operationId: string,
  owner: AuditMutationInventoryEntry['owner'],
  operationPath: string,
  auditPath: string,
): AuditMutationInventoryEntry => ({
  operationId,
  state: 'conversion-in-progress',
  owner,
  operationPath,
  idempotencyPath: 'HTTP Idempotency-Key scoped to actor and operation action',
  auditPath,
})

const complete = (
  operationId: string,
  operationPath: string,
  auditPath: string,
  owner: AuditMutationInventoryEntry['owner'],
): AuditMutationInventoryEntry => ({
  ...conversion(operationId, owner, operationPath, auditPath),
  state: 'complete-v1',
})

/**
 * `conversion-in-progress` is intentionally a release blocker. It records a
 * known writer owner without pretending that a compact legacy insert is v1.
 */
export const apiMutationAuditInventory: readonly AuditMutationInventoryEntry[] = [
  complete(
    'deleteOrganization',
    'organization deletion operation and immutable child receipts',
    'organization deletion v1 audit',
    'backup-destructive',
  ),
  complete(
    'createPlatformProviderAccount',
    'deterministic terminal platform operation and immutable account receipt with response-loss adoption',
    'staged v1 platform envelope and compact audit bound to the exact operation',
    'node-platform',
  ),
  complete(
    'validatePlatformProviderAccount',
    'deterministic terminal platform operation and immutable account receipt',
    'staged v1 platform envelope and compact audit bound to the exact operation',
    'node-platform',
  ),
  complete(
    'disablePlatformProviderAccount',
    'deterministic terminal platform operation and immutable account receipt',
    'staged v1 platform envelope and compact audit bound to the exact operation',
    'node-platform',
  ),
  complete(
    'removePlatformProviderAccount',
    'deterministic terminal platform operation and immutable account tombstone receipt',
    'staged v1 platform envelope and compact audit bound to the exact operation',
    'node-platform',
  ),
  complete(
    'rotatePlatformProviderAccount',
    'deterministic terminal platform operation and immutable credential-revision receipt',
    'staged v1 platform envelope and compact audit bound to the exact operation',
    'node-platform',
  ),
  complete(
    'putPlatformProviderAllocation',
    'deterministic terminal platform operation and immutable organization-account allocation receipt',
    'staged v1 platform envelope and compact audit bound to the exact allocation target',
    'node-platform',
  ),
  complete(
    'deliverTunnelCredential',
    'terminal tunnel-delivery acceptance operation with response-loss adoption, followed by an exact machine command receipt',
    'strict v1 HTTP acceptance envelope and strict v1 machine completion envelope',
    'node-platform',
  ),
  complete('createOrganization', 'organization bootstrap operation', 'platform v1 audit', 'core'),
  complete(
    'updateOrganizationProfile',
    'tenant operation and immutable receipt',
    'tenant v1 audit',
    'core',
  ),
  complete(
    'switchOrganization',
    'tenant operation and immutable receipt',
    'tenant v1 audit',
    'core',
  ),
  complete(
    'updateOrganizationPolicy',
    'tenant operation and immutable receipt',
    'tenant v1 audit',
    'core',
  ),
  complete('createInvitation', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete('resendInvitation', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete('acceptInvitation', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete('updateMemberRole', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete('removeMember', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete(
    'leaveOrganization',
    'tenant operation and immutable receipt',
    'tenant v1 audit',
    'core',
  ),
  complete(
    'transferOwnership',
    'tenant operation and immutable receipt',
    'tenant v1 audit',
    'core',
  ),
  complete('revokeInvitation', 'tenant operation and immutable receipt', 'tenant v1 audit', 'core'),
  complete(
    'createProviderAccount',
    'actor-scoped terminal tenant operation and immutable create receipt with response-loss adoption',
    'staged v1 tenant envelope and compact audit bound to the exact create operation',
    'node-platform',
  ),
  complete(
    'testProviderAccount',
    'actor-scoped terminal tenant operation and immutable lifecycle receipt with response-loss adoption',
    'staged v1 tenant envelope and compact audit bound to the exact test operation',
    'node-platform',
  ),
  complete(
    'refreshProviderAccount',
    'actor-scoped terminal tenant operation, catalog refresh, and immutable lifecycle receipt',
    'staged v1 tenant envelope and compact audit bound to the exact refresh operation',
    'node-platform',
  ),
  complete(
    'disableProviderAccount',
    'actor-scoped terminal tenant operation and immutable lifecycle receipt',
    'staged v1 tenant envelope and compact audit bound to the exact disable operation',
    'node-platform',
  ),
  complete(
    'deleteProviderAccount',
    'actor-scoped terminal tenant operation and immutable credential-revocation lifecycle receipt',
    'staged v1 tenant envelope and compact audit bound to the exact removal operation',
    'node-platform',
  ),
  complete(
    'updateProviderAccountCredentials',
    'actor-scoped terminal tenant operation and immutable credential-revision receipt with response-loss adoption',
    'staged v1 tenant envelope and compact audit bound to the exact credential update operation',
    'node-platform',
  ),
  complete(
    'createNode',
    'immutable reviewed tenant acceptance, provider create-or-adopt execution, and exact response-loss adoption',
    'staged v1 acceptance and machine provider-created envelopes bound to terminal child operations',
    'node-platform',
  ),
  complete(
    'startNode',
    'account-bound runtime acceptance with a replayable Workflow start and provider dispatch receipt',
    'staged v1 acceptance plus terminal machine completion audit bound to exact child operations',
    'node-platform',
  ),
  complete(
    'stopNode',
    'account-bound runtime acceptance with a replayable Workflow start and provider dispatch receipt',
    'staged v1 acceptance plus terminal machine completion audit bound to exact child operations',
    'node-platform',
  ),
  complete(
    'reconcileNode',
    'account-bound observe-only runtime acceptance with a replayable Workflow start and receipt',
    'staged v1 acceptance plus terminal machine completion audit bound to exact child operations',
    'node-platform',
  ),
  complete(
    'applyGameServer',
    'durable server-provision parent operation with immutable node and game child operation IDs',
    'server.provision.accepted strict v1 tenant audit envelope and compact audit receipt',
    'core',
  ),
  complete(
    'applyGameServerManifest',
    'tenant-fenced desired-state resolution followed by a no-op or one reviewed server-provision, game-lifecycle, or policy operation',
    'no-op is side-effect free; accepted mutations delegate to their strict v1 operation and audit receipt',
    'game',
  ),
  complete('createGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('deleteGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('patchGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('startGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('stopGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('restartGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('updateGameServer', 'tenant operation', 'tenant v1 audit', 'game'),
  complete(
    'validateGameServerFiles',
    'tenant update operation with Steam validation semantics',
    'tenant v1 audit',
    'game',
  ),
  complete(
    'forceCleanupGameServer',
    'failed-node fenced tenant delete operation and cleanup receipt',
    'forced tenant v1 audit',
    'game',
  ),
  complete(
    'cloneGameServer',
    'immutable source draft plus server-provision parent operation',
    'tenant clone-source and provision v1 audits',
    'game',
  ),
  complete(
    'createGameServerDraft',
    'terminal tenant draft operation',
    'complete tenant v1 audit',
    'game',
  ),
  complete(
    'scheduleGameServerDraft',
    'terminal tenant schedule acceptance plus one-shot dispatch row',
    'complete tenant v1 acceptance audit',
    'game',
  ),
  complete('applyGameConfig', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('syncMods', 'tenant operation', 'tenant v1 audit', 'game'),
  complete('backupGameServer', 'tenant operation', 'tenant v1 audit', 'backup-destructive'),
  complete('restoreGameServer', 'tenant operation', 'tenant v1 audit', 'backup-destructive'),
  complete(
    'cancelOperation',
    'tenant cancellation operation',
    'tenant v1 audit',
    'backup-destructive',
  ),
  complete(
    'retireNode',
    'signed destructive Workflow claim, exact provider retirement observation, credential revocation, and exact Tunnel cleanup',
    'staged v1 HTTP acceptance plus machine provider, credential, Tunnel, and terminal retirement audit envelopes',
    'node-platform',
  ),
  complete(
    'rebuildNode',
    'signed destructive Workflow claim, immutable promoted-image/bootstrap handoff, provider observation, and agent-readiness receipt',
    'staged v1 HTTP acceptance plus machine bootstrap, provider observation, and terminal readiness audit envelopes',
    'node-platform',
  ),
  complete(
    'drainNode',
    'administrator-scoped terminal drain operation with immutable Workflow start and response-loss adoption',
    'staged v1 HTTP acceptance plus terminal machine drain-transition audit bound to exact child operations',
    'node-platform',
  ),
  complete(
    'uncordonNode',
    'administrator-scoped terminal leave-drain operation with immutable Workflow start and response-loss adoption',
    'staged v1 HTTP acceptance plus terminal machine leave-drain transition audit bound to exact child operations',
    'node-platform',
  ),
  complete(
    'rebootNode',
    'account-bound runtime acceptance with delivery-uncertainty fencing and provider reboot receipt',
    'staged v1 acceptance plus terminal machine completion audit bound to exact child operations',
    'node-platform',
  ),
  complete('moveGameServer', 'tenant move operation', 'tenant v1 audit', 'game'),
] as const

/** Non-HTTP mutation boundaries are tracked explicitly as well. */
export const nonHttpAuditMutationInventory = [
  complete('completeAuthentication', 'platform sign-in operation', 'platform v1 audit', 'core'),
  complete(
    'completeSignUp',
    'platform sign-up operation and immutable receipt',
    'platform v1 audit',
    'core',
  ),
  complete(
    'exchangeAgentRegistration',
    'request-scoped machine repository and immutable registration-exchange receipt',
    'strict v1 machine-origin tenant envelope',
    'node-platform',
  ),
  complete(
    'acceptAgentEvents',
    'request-scoped observation repository and immutable observation receipt',
    'strict v1 machine-origin tenant envelope',
    'node-platform',
  ),
  complete(
    'acceptAgentTelemetry',
    'machine telemetry operation',
    'tenant v1 audit',
    'node-platform',
  ),
  complete(
    'revokeAgentRegistration',
    'request-scoped machine repository and immutable registration-revoke receipt',
    'strict v1 machine-origin tenant envelope',
    'node-platform',
  ),
  complete(
    'recordAgentCommandResult',
    'coordinator acceptance followed by an exact machine command-result receipt',
    'strict v1 machine-origin tenant envelope',
    'node-platform',
  ),
  complete(
    'scheduledPolicyReconciliation',
    'terminal scheduler operation',
    'tenant v1 audit',
    'audit',
  ),
  complete(
    'scheduledOrphanReconciliation',
    'terminal scheduler operation',
    'tenant v1 audit',
    'audit',
  ),
  complete(
    'backupWorkflowCompletion',
    'workflow operation',
    'tenant v1 audit',
    'backup-destructive',
  ),
  complete(
    'nodeRuntimeLifecycleCompletion',
    'leased workflow completion with dispatch uncertainty fencing and durable observation receipt',
    'staged v1 machine-origin terminal audit bound to the exact runtime operation',
    'node-platform',
  ),
  complete('gameLifecycleCompletion', 'workflow operation', 'tenant v1 audit', 'game'),
  complete(
    'scheduledGameServerDispatch',
    'scheduler-fenced server-provision operation',
    'scheduler-origin tenant v1 audit',
    'game',
  ),
] as const satisfies readonly AuditMutationInventoryEntry[]

export const mutationInventoryReport = () => {
  const routes = [...apiRoutes, ...unsupportedApiRoutes].filter((route) => route.mutation)
  const routeOperationIds = routes.map((route) => route.operationId).sort()
  const inventoryOperationIds = apiMutationAuditInventory.map((entry) => entry.operationId).sort()
  const missing = routeOperationIds.filter(
    (operationId) => !inventoryOperationIds.includes(operationId),
  )
  const stale = inventoryOperationIds.filter(
    (operationId) => !routeOperationIds.includes(operationId),
  )
  const duplicate = inventoryOperationIds.filter(
    (operationId, index) => inventoryOperationIds.indexOf(operationId) !== index,
  )
  const blockedRoutes = routes
    .filter(
      (route) =>
        apiMutationAuditInventory.find((entry) => entry.operationId === route.operationId)
          ?.state === 'blocked-before-side-effects',
    )
    .filter((route) => route.successStatus !== 501)
    .map((route) => route.operationId)
  const conversionInProgress = [...apiMutationAuditInventory, ...nonHttpAuditMutationInventory]
    .filter((entry) => entry.state === 'conversion-in-progress')
    .map((entry) => entry.operationId)
    .sort()
  return {
    routeOperationIds,
    inventoryOperationIds,
    missing,
    stale,
    duplicate,
    blockedRoutes,
    conversionInProgress,
  }
}
