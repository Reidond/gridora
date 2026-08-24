import { describe, expect, it } from 'vitest'
import {
  apiMutationAuditInventory,
  mutationInventoryReport,
  nonHttpAuditMutationInventory,
} from '../src/mutation-audit-inventory.js'

describe('mutation audit inventory', () => {
  it('covers every declared HTTP mutation and treats unsupported routes as side-effect free', () => {
    const report = mutationInventoryReport()
    expect(report.missing).toEqual([])
    expect(report.stale).toEqual([])
    expect(report.duplicate).toEqual([])
    expect(report.blockedRoutes).toEqual([])
    expect(apiMutationAuditInventory.every((entry) => entry.operationPath.length > 0)).toBe(true)
    expect(apiMutationAuditInventory.every((entry) => entry.idempotencyPath.length > 0)).toBe(true)
    expect(apiMutationAuditInventory.every((entry) => entry.auditPath.length > 0)).toBe(true)
  })

  it('makes release-blocking conversion gaps and non-HTTP mutation writers explicit', () => {
    const report = mutationInventoryReport()
    expect(nonHttpAuditMutationInventory.length).toBeGreaterThan(0)
    expect(report.conversionInProgress).not.toContain('createOrganization')
    expect(
      apiMutationAuditInventory.find((entry) => entry.operationId === 'createOrganization')?.state,
    ).toBe('complete-v1')
    expect(report.conversionInProgress).not.toContain('deliverTunnelCredential')
    expect(report.conversionInProgress).not.toContain('acceptAgentEvents')
    expect(report.conversionInProgress).not.toContain('exchangeAgentRegistration')
    expect(report.conversionInProgress).not.toContain('revokeAgentRegistration')
    expect(report.conversionInProgress).not.toContain('recordAgentCommandResult')
    expect(report.conversionInProgress).not.toContain('createPlatformProviderAccount')
    expect(report.conversionInProgress).not.toContain('validatePlatformProviderAccount')
    expect(report.conversionInProgress).not.toContain('disablePlatformProviderAccount')
    expect(report.conversionInProgress).not.toContain('removePlatformProviderAccount')
    expect(report.conversionInProgress).not.toContain('rotatePlatformProviderAccount')
    expect(report.conversionInProgress).not.toContain('putPlatformProviderAllocation')
    expect(report.conversionInProgress).not.toContain('createProviderAccount')
    expect(report.conversionInProgress).not.toContain('testProviderAccount')
    expect(report.conversionInProgress).not.toContain('refreshProviderAccount')
    expect(report.conversionInProgress).not.toContain('disableProviderAccount')
    expect(report.conversionInProgress).not.toContain('deleteProviderAccount')
    expect(report.conversionInProgress).not.toContain('updateProviderAccountCredentials')
    expect(report.conversionInProgress).not.toContain('createNode')
    expect(report.conversionInProgress).not.toContain('startNode')
    expect(report.conversionInProgress).not.toContain('stopNode')
    expect(report.conversionInProgress).not.toContain('rebootNode')
    expect(report.conversionInProgress).not.toContain('reconcileNode')
    expect(report.conversionInProgress).not.toContain('nodeRuntimeLifecycleCompletion')
    expect(report.conversionInProgress).not.toContain('drainNode')
    expect(report.conversionInProgress).not.toContain('uncordonNode')
    expect(report.conversionInProgress).not.toContain('applyGameServerManifest')
    expect(report.conversionInProgress).not.toContain('rebuildNode')
    expect(report.conversionInProgress).not.toContain('retireNode')
  })

  it('preserves the explicit owner and evidence paths when a lane marks a mutation complete', () => {
    const all = [...apiMutationAuditInventory, ...nonHttpAuditMutationInventory]
    const byOperation = (operationId: string) =>
      all.find((entry) => entry.operationId === operationId)
    expect(byOperation('createOrganization')).toMatchObject({
      state: 'complete-v1',
      owner: 'core',
      operationPath: 'organization bootstrap operation',
      auditPath: 'platform v1 audit',
    })
    expect(byOperation('backupGameServer')).toMatchObject({
      state: 'complete-v1',
      owner: 'backup-destructive',
      operationPath: 'tenant operation',
      auditPath: 'tenant v1 audit',
    })
    expect(byOperation('scheduledPolicyReconciliation')).toMatchObject({
      state: 'complete-v1',
      owner: 'audit',
      operationPath: 'terminal scheduler operation',
      auditPath: 'tenant v1 audit',
    })
    expect(byOperation('scheduledOrphanReconciliation')).toMatchObject({
      state: 'complete-v1',
      owner: 'audit',
      operationPath: 'terminal scheduler operation',
      auditPath: 'tenant v1 audit',
    })
    expect(byOperation('createPlatformProviderAccount')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'deterministic terminal platform operation and immutable account receipt with response-loss adoption',
      auditPath: 'staged v1 platform envelope and compact audit bound to the exact operation',
    })
    expect(byOperation('putPlatformProviderAllocation')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'deterministic terminal platform operation and immutable organization-account allocation receipt',
      auditPath:
        'staged v1 platform envelope and compact audit bound to the exact allocation target',
    })
    expect(byOperation('updateProviderAccountCredentials')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'actor-scoped terminal tenant operation and immutable credential-revision receipt with response-loss adoption',
      auditPath:
        'staged v1 tenant envelope and compact audit bound to the exact credential update operation',
    })
    expect(byOperation('createNode')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'immutable reviewed tenant acceptance, provider create-or-adopt execution, and exact response-loss adoption',
      auditPath:
        'staged v1 acceptance and machine provider-created envelopes bound to terminal child operations',
    })
    expect(byOperation('nodeRuntimeLifecycleCompletion')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'leased workflow completion with dispatch uncertainty fencing and durable observation receipt',
      auditPath: 'staged v1 machine-origin terminal audit bound to the exact runtime operation',
    })
    expect(byOperation('drainNode')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'administrator-scoped terminal drain operation with immutable Workflow start and response-loss adoption',
      auditPath:
        'staged v1 HTTP acceptance plus terminal machine drain-transition audit bound to exact child operations',
    })
    expect(byOperation('uncordonNode')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'administrator-scoped terminal leave-drain operation with immutable Workflow start and response-loss adoption',
      auditPath:
        'staged v1 HTTP acceptance plus terminal machine leave-drain transition audit bound to exact child operations',
    })
    expect(byOperation('applyGameServerManifest')).toMatchObject({
      state: 'complete-v1',
      owner: 'game',
      operationPath:
        'tenant-fenced desired-state resolution followed by a no-op or one reviewed server-provision, game-lifecycle, or policy operation',
      auditPath:
        'no-op is side-effect free; accepted mutations delegate to their strict v1 operation and audit receipt',
    })
    expect(byOperation('rebuildNode')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'signed destructive Workflow claim, immutable promoted-image/bootstrap handoff, provider observation, and agent-readiness receipt',
      auditPath:
        'staged v1 HTTP acceptance plus machine bootstrap, provider observation, and terminal readiness audit envelopes',
    })
    expect(byOperation('retireNode')).toMatchObject({
      state: 'complete-v1',
      owner: 'node-platform',
      operationPath:
        'signed destructive Workflow claim, exact provider retirement observation, credential revocation, and exact Tunnel cleanup',
      auditPath:
        'staged v1 HTTP acceptance plus machine provider, credential, Tunnel, and terminal retirement audit envelopes',
    })
  })
})
