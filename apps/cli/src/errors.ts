import { Schema } from 'effect'

export const ExitCode = {
  success: 0,
  internal: 1,
  usage: 2,
  authentication: 3,
  authorization: 4,
  notFound: 5,
  conflict: 6,
  validation: 7,
  provider: 8,
  unavailable: 9,
  operationFailed: 10,
  timeout: 11,
  partial: 12,
} as const
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export class CliError extends Schema.TaggedError<CliError>()('CliError', {
  code: Schema.String,
  message: Schema.String,
  exitCode: Schema.Number,
  details: Schema.optional(Schema.Unknown),
}) {}

export const errorEnvelope = (error: CliError) => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
})
