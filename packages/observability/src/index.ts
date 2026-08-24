import { Context, Effect, Layer, Schema } from 'effect'

export const RequestTrace = Schema.Struct({
  requestId: Schema.String,
  correlationId: Schema.String,
  organizationId: Schema.optional(Schema.String),
  identityId: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
  workflowId: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  serverId: Schema.optional(Schema.String),
})

export type RequestTrace = typeof RequestTrace.Type
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, unknown>>

const secretField =
  /authorization|cookie|credential|password|secret|token|assertion|private[_-]?key|rcon/i

export const redact = (value: unknown, key = ''): unknown => {
  if (secretField.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = redact(entryValue, entryKey)
    }
    return result
  }
  return value
}

export interface LogEvent {
  readonly level: LogLevel
  readonly message: string
  readonly timestamp: string
  readonly fields: LogFields
}

export class StructuredLogger extends Context.Service<
  StructuredLogger,
  {
    readonly write: (level: LogLevel, message: string, fields?: LogFields) => Effect.Effect<void>
  }
>()('@gridora/observability/StructuredLogger') {}

export const makeConsoleLogger = (base: LogFields = {}): Layer.Layer<StructuredLogger> =>
  Layer.succeed(StructuredLogger, {
    write: (level, message, fields = {}) =>
      Effect.sync(() => {
        const event: LogEvent = {
          level,
          message,
          timestamp: new Date().toISOString(),
          fields: redact({ ...base, ...fields }) as LogFields,
        }
        const encoded = JSON.stringify(event)
        if (level === 'error') console.error(encoded)
        else if (level === 'warn') console.warn(encoded)
        else console.log(encoded)
      }),
  })

export const makeRequestTrace = (request: Request): RequestTrace => {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
  return {
    requestId,
    correlationId: request.headers.get('x-correlation-id') ?? requestId,
  }
}

export const organizationObjectKey = (
  organizationId: string,
  category: 'audit' | 'backups' | 'logs' | 'operations',
  resourceId: string,
): string =>
  `organizations/${encodeURIComponent(organizationId)}/${category}/${encodeURIComponent(resourceId)}`
