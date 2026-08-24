import { Schema } from 'effect'

export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  code: Schema.Literals([
    'invalid-command',
    'invalid-signature',
    'expired-command',
    'wrong-organization',
    'wrong-node',
    'revision-conflict',
    'unsupported-command',
    'execution-failed',
    'state-failed',
    'command-in-progress',
    'payload-mismatch',
    'update-response-pending',
  ]),
  message: Schema.String,
}) {}
