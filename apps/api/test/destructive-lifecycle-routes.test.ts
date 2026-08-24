import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  registerDestructiveLifecycleRoutes,
  type DestructiveLifecycleHttpFacade,
} from '../src/destructive-lifecycle-routes.js'

const requestBody = {
  expectedNodeRevision: 1,
  idempotencyKey: 'node-lifecycle-idempotency-0001',
  correlationId: 'correlation-a',
  backupPolicy: 'required',
}

const appWith = (facade: DestructiveLifecycleHttpFacade) => {
  const app = new Hono()
  registerDestructiveLifecycleRoutes(app, facade)
  return app
}

describe('destructive lifecycle HTTP boundary', () => {
  it('rejects a cross-tenant actor before forwarding a destructive node request', async () => {
    let forwarded = 0
    const app = appWith({
      authorize: async () => ({ organizationId: 'org-b', actorId: 'actor-a', role: 'owner' }),
      beginNodeLifecycle: async () => {
        forwarded += 1
        return {}
      },
      beginOrganizationDeletion: async () => ({}),
      cancelOperation: async () => ({}),
    })
    const response = await app.request(
      'http://api.test/v1/organizations/org-a/nodes/node-a/lifecycle/retire-node',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    )
    expect(response.status).toBe(403)
    expect(forwarded).toBe(0)
  })

  it('does not accept internal organization-deletion or Workflow routing fields from the public body', async () => {
    let forwarded = 0
    const app = appWith({
      authorize: async () => ({
        organizationId: 'org-a',
        actorId: 'actor-a',
        role: 'administrator',
      }),
      beginNodeLifecycle: async () => {
        forwarded += 1
        return {}
      },
      beginOrganizationDeletion: async () => ({}),
      cancelOperation: async () => ({}),
    })
    const response = await app.request(
      'http://api.test/v1/organizations/org-a/nodes/node-a/lifecycle/retire-node',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...requestBody,
          organizationDeletionOperationId: 'delete-org-operation',
          workflowBinding: 'DELETE_ORGANIZATION',
          resourceOperationDoName: 'resource-operation:org-a:organization:org-a',
        }),
      },
    )
    expect(response.status).toBe(400)
    expect(forwarded).toBe(0)
  })

  it('forwards only a tenant-fenced, normalized lifecycle command', async () => {
    let command: Parameters<DestructiveLifecycleHttpFacade['beginNodeLifecycle']>[0] | undefined
    const app = appWith({
      authorize: async () => ({
        organizationId: 'org-a',
        actorId: 'actor-a',
        role: 'administrator',
      }),
      beginNodeLifecycle: async (input) => {
        command = input
        return { operationId: 'operation-a' }
      },
      beginOrganizationDeletion: async () => ({}),
      cancelOperation: async () => ({}),
    })
    const response = await app.request(
      'http://api.test/v1/organizations/org-a/nodes/node-a/lifecycle/retire-node',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      },
    )
    expect(response.status).toBe(202)
    expect(command).toEqual({
      organizationId: 'org-a',
      actorId: 'actor-a',
      role: 'administrator',
      correlationId: 'correlation-a',
      idempotencyKey: 'node-lifecycle-idempotency-0001',
      action: 'retire-node',
      nodeId: 'node-a',
      expectedNodeRevision: 1,
      force: false,
      backupPolicy: 'required',
    })
  })
})
