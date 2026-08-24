import { Effect, Schema } from 'effect'
import type { Hono } from 'hono'

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const IdempotencyKey = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const LifecycleActionBody = Schema.Struct({
  expectedNodeRevision: Revision,
  idempotencyKey: IdempotencyKey,
  correlationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  force: Schema.optional(Schema.Boolean),
  backupPolicy: Schema.optional(Schema.Literals(['required', 'skip-authorized'])),
  targetImageId: Schema.optional(Identifier),
})
const OrganizationDeletionBody = Schema.Struct({
  expectedOrganizationRevision: Revision,
  idempotencyKey: IdempotencyKey,
  correlationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  typedSlug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  backupPolicy: Schema.Literals(['retain', 'delete-after-retention']),
})
const CancellationBody = Schema.Struct({
  expectedOperationRevision: Revision,
  idempotencyKey: IdempotencyKey,
  correlationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
})

type ActorContext = {
  readonly organizationId: string
  readonly actorId: string
  readonly role: 'owner' | 'administrator' | 'operator' | 'viewer' | 'automation'
}

export interface DestructiveLifecycleHttpFacade {
  readonly authorize: (input: {
    readonly request: Request
    readonly organizationId: string
  }) => Promise<ActorContext>
  readonly beginNodeLifecycle: (input: {
    readonly organizationId: string
    readonly actorId: string
    readonly role: ActorContext['role']
    readonly correlationId: string
    readonly idempotencyKey: string
    readonly action: 'drain-node' | 'leave-drain' | 'rebuild-node' | 'retire-node'
    readonly nodeId: string
    readonly expectedNodeRevision: number
    readonly force: boolean
    readonly backupPolicy: 'required' | 'skip-authorized'
    readonly targetImageId?: string
  }) => Promise<unknown>
  readonly beginOrganizationDeletion: (input: {
    readonly organizationId: string
    readonly actorId: string
    readonly role: ActorContext['role']
    readonly correlationId: string
    readonly idempotencyKey: string
    readonly expectedOrganizationRevision: number
    readonly typedSlug: string
    readonly backupPolicy: 'retain' | 'delete-after-retention'
  }) => Promise<unknown>
  readonly cancelOperation: (input: {
    readonly organizationId: string
    readonly actorId: string
    readonly role: ActorContext['role']
    readonly correlationId: string
    readonly idempotencyKey: string
    readonly operationId: string
    readonly expectedOperationRevision: number
  }) => Promise<unknown>
}

const decode = async <A>(schema: Schema.Schema<A>, body: unknown): Promise<A | null> => {
  // These local schemas require no services; Schema's generic context is intentionally widened.
  const program = Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(
    body,
  ) as Effect.Effect<A, unknown, never>
  const exit = await Effect.runPromiseExit(program)
  return exit._tag === 'Success' ? exit.value : null
}

const guarded = async (
  request: Request,
  organizationId: string,
  facade: DestructiveLifecycleHttpFacade,
): Promise<ActorContext | null> => {
  try {
    const actor = await facade.authorize({ request, organizationId })
    return actor.organizationId === organizationId ? actor : null
  } catch {
    return null
  }
}

/**
 * Isolated route registration; composition explicitly opts it into the main API. The public body
 * never carries an organization-deletion parent id, workflow binding, or resource-operation name.
 */
export const registerDestructiveLifecycleRoutes = (
  app: Hono,
  facade: DestructiveLifecycleHttpFacade,
): void => {
  const nodeAction = (action: 'drain-node' | 'leave-drain' | 'rebuild-node' | 'retire-node') =>
    app.post(
      `/v1/organizations/:organizationId/nodes/:nodeId/lifecycle/${action}`,
      async (context) => {
        const organizationId = context.req.param('organizationId')
        const nodeId = context.req.param('nodeId')
        const actor = await guarded(context.req.raw, organizationId, facade)
        if (actor === null) return context.json({ code: 'forbidden' }, 403)
        const body = await decode(LifecycleActionBody, await context.req.json().catch(() => null))
        if (body === null) return context.json({ code: 'invalid_request' }, 400)
        if ((action === 'rebuild-node') !== (body.targetImageId !== undefined))
          return context.json({ code: 'invalid_request' }, 400)
        try {
          const accepted = await facade.beginNodeLifecycle({
            organizationId,
            actorId: actor.actorId,
            role: actor.role,
            correlationId: body.correlationId,
            idempotencyKey: body.idempotencyKey,
            action,
            nodeId,
            expectedNodeRevision: body.expectedNodeRevision,
            force: body.force ?? false,
            backupPolicy: body.backupPolicy ?? 'required',
            ...(body.targetImageId === undefined ? {} : { targetImageId: body.targetImageId }),
          })
          return context.json(accepted, 202)
        } catch {
          return context.json({ code: 'lifecycle_request_rejected' }, 409)
        }
      },
    )
  nodeAction('drain-node')
  nodeAction('leave-drain')
  nodeAction('rebuild-node')
  nodeAction('retire-node')

  app.post('/v1/organizations/:organizationId/delete', async (context) => {
    const organizationId = context.req.param('organizationId')
    const actor = await guarded(context.req.raw, organizationId, facade)
    if (actor === null) return context.json({ code: 'forbidden' }, 403)
    const body = await decode(OrganizationDeletionBody, await context.req.json().catch(() => null))
    if (body === null) return context.json({ code: 'invalid_request' }, 400)
    try {
      return context.json(
        await facade.beginOrganizationDeletion({
          organizationId,
          actorId: actor.actorId,
          role: actor.role,
          correlationId: body.correlationId,
          idempotencyKey: body.idempotencyKey,
          expectedOrganizationRevision: body.expectedOrganizationRevision,
          typedSlug: body.typedSlug,
          backupPolicy: body.backupPolicy,
        }),
        202,
      )
    } catch {
      return context.json({ code: 'organization_deletion_rejected' }, 409)
    }
  })

  app.post('/v1/organizations/:organizationId/operations/:operationId/cancel', async (context) => {
    const organizationId = context.req.param('organizationId')
    const operationId = context.req.param('operationId')
    const actor = await guarded(context.req.raw, organizationId, facade)
    if (actor === null) return context.json({ code: 'forbidden' }, 403)
    const body = await decode(CancellationBody, await context.req.json().catch(() => null))
    if (body === null) return context.json({ code: 'invalid_request' }, 400)
    try {
      return context.json(
        await facade.cancelOperation({
          organizationId,
          actorId: actor.actorId,
          role: actor.role,
          correlationId: body.correlationId,
          idempotencyKey: body.idempotencyKey,
          operationId,
          expectedOperationRevision: body.expectedOperationRevision,
        }),
        202,
      )
    } catch {
      return context.json({ code: 'operation_cancellation_rejected' }, 409)
    }
  })
}
