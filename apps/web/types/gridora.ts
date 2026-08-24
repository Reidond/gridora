export type Role = 'Owner' | 'Administrator' | 'Operator' | 'Viewer'
export type Health = 'healthy' | 'degraded' | 'failed' | 'unknown'
export type OperationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface Organization {
  id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
  role: Role
  region: string
  timezone: string
  budgetUsed: number
  budgetWarning: number
  revision?: number
}

export interface GameServer {
  id: string
  name: string
  plugin: string
  pluginVersion: string
  status: 'running' | 'stopped' | 'deploying' | 'failed'
  health: Health
  nodeId: string
  endpoint?: string
  players?: number
  playerCapacity?: number
  scenario?: string
  build?: string
  lastBackupAt?: string
  /** Desired-state revision used by lifecycle mutation fences. */
  revision?: number
}

export interface Node {
  id: string
  name: string
  provider: 'OVHcloud' | 'Contabo'
  region: string
  plan: string
  status: 'ready' | 'provisioning' | 'draining' | 'offline'
  health: Health
  cpu?: number
  memory?: number
  disk?: number
  deployments?: number
  costMonthly?: number
  image: string
  agentVersion?: string
  tunnel?: 'connected' | 'degraded' | 'offline'
  publicAddress?: string
  lastReconciledAt?: string
  reconciliationError?: string
  /** Desired-state revision required by node runtime and lifecycle fences. */
  revision?: number
}

export interface OperationStep {
  label: string
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
  attempt?: number
}
export interface Operation {
  id: string
  revision: number
  title: string
  resource: string
  resourceType: 'server' | 'node' | 'backup' | 'organization'
  status: OperationStatus
  progress: number
  actor: string
  startedAt: string
  elapsed?: string
  retries?: number
  cancellable: boolean
  providerRequestId?: string
  waitingReason?: string
  recoveryGuidance?: string
  retryAction?: 'retry-operation'
  finalResource?: { type: string; id: string }
  steps: OperationStep[]
  logs: string[]
}

export interface Plugin {
  id: string
  name: string
  version: string
  apiVersion: string
  steamAppId?: string
  platforms?: string
  enabled: boolean
  capabilities: string[]
  limitations: string[]
}

export interface Backup {
  id: string
  serverId: string
  server: string
  createdAt: string
  size?: string
  consistency?: 'quiesced' | 'crash-consistent'
  status: 'available' | 'creating' | 'restoring' | 'deleting' | 'expired' | 'deleted' | 'failed'
  checksum: string
  retainedUntil?: string
}

export interface ProviderAccount {
  id: string
  provider: string
  source: 'Platform allocation' | 'Organization account'
  status: 'healthy' | 'disabled' | 'error'
  regions: string[]
  nodes?: number
  refreshedAt: string
  billing?: string
  revision?: number
}

export interface NodeImage {
  id: string
  version: string
  checksum: string
  signature: string
  providerMappings: Record<string, unknown>
  status: 'building' | 'candidate' | 'promoted' | 'retired' | 'failed'
  createdAt: string
  promotedAt?: string
}

export interface Member {
  id: string
  name: string
  email: string
  role: Role
  source: 'Created organization' | 'Invitation'
  joinedAt: string
  status: 'active' | 'suspended'
  revision: number
}

export interface Invitation {
  id: string
  email: string
  role: Exclude<Role, 'Owner'>
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  invitedBy: string
  expiresAt: string
  revision: number
}

export interface NotificationRemediation {
  eventId: string
  invitationId: string
  disposition: 'permanent-failure'
  action: 'reissue-invitation'
  code: string
  eventCreatedAt: string
}

export interface AuditEvent {
  id: string
  action: string
  actor: string
  target: string
  at: string
  outcome: 'success' | 'denied' | 'failed'
  requestId: string
  schemaVersion?: 0 | 1
  captureStatus?: 'legacy' | 'complete'
  operationId?: string
  actorType?: string
  forced?: boolean
  breakGlass?: boolean
  /** Authorized users can inspect the immutable, redacted evidence on demand. */
  envelope?: Record<string, unknown>
}

export interface GridoraState {
  currentUser: { id: string; name: string; email: string }
  organizations: Organization[]
  servers: Record<string, GameServer[]>
  nodes: Record<string, Node[]>
  operations: Record<string, Operation[]>
  plugins: Plugin[]
  backups: Record<string, Backup[]>
  providers: Record<string, ProviderAccount[]>
  images: Record<string, NodeImage[]>
  members: Record<string, Member[]>
  invitations: Record<string, Invitation[]>
  audit: Record<string, AuditEvent[]>
  session: { bootstrapped: boolean; loading: boolean; error: string; mode: 'api' | 'demo' }
}
