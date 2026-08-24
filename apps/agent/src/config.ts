import { Schema } from 'effect'

export const AgentConfiguration = Schema.Struct({
  apiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
  organizationId: Schema.String,
  nodeId: Schema.String,
  providerInstanceId: Schema.String,
  controlPlaneUrl: Schema.String,
  expectedControlPlaneHost: Schema.String,
  allowLoopbackHttp: Schema.Boolean,
  stateDirectory: Schema.Literal('/var/lib/gridora/agent'),
  registrationTokenFile: Schema.Literal('/var/lib/gridora/bootstrap/registration-token'),
  signingPublicKeyFile: Schema.Literal('/etc/gridora/command-signing-public.pem'),
  dockerSocket: Schema.Literals(['/var/run/docker.sock', '/run/docker.sock']),
  agentVersion: Schema.String,
  pollWaitSeconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 30 }),
  ),
})
export type AgentConfiguration = typeof AgentConfiguration.Type
export const decodeAgentConfiguration = Schema.decodeUnknownEffect(AgentConfiguration)
