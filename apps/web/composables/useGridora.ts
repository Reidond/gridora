import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { demoState } from '~/data/demo'
import type { BackupRestoreRequest, ServerApplyRequest } from '~/services/gridora-api'
import { GridoraApiError } from '~/services/gridora-api'
import { useGridoraApi } from '~/services/gridora-api'
import { organizationSetupRequest } from '~/services/organization-setup'
import type {
  GameServer,
  GridoraState,
  Invitation,
  Member,
  Operation,
  Organization,
  Role,
} from '~/types/gridora'

const emptyState = (): GridoraState => ({
  currentUser: { id: '', name: '', email: '' },
  organizations: [],
  plugins: [],
  servers: {},
  nodes: {},
  operations: {},
  backups: {},
  providers: {},
  images: {},
  members: {},
  invitations: {},
  audit: {},
  session: { bootstrapped: false, loading: false, error: '', mode: 'api' },
})

export const useGridoraState = () => {
  const config = useRuntimeConfig()
  return useState<GridoraState>('gridora-data', () =>
    config.public.dataMode === 'demo' ? demoState() : emptyState(),
  )
}

export const useGridoraBootstrap = () => {
  const state = useGridoraState()
  const api = useGridoraApi()
  return async () => {
    if (state.value.session.bootstrapped || state.value.session.mode === 'demo') return
    state.value.session.loading = true
    state.value.session.error = ''
    try {
      const bootstrap = await api.bootstrap()
      if (bootstrap.identity)
        state.value.currentUser = {
          id: bootstrap.identity.id,
          name: bootstrap.identity.name,
          email: bootstrap.identity.email,
        }
      state.value.organizations = bootstrap.organizations
      state.value.session.bootstrapped = true
    } catch (error) {
      if (error instanceof GridoraApiError && error.status === 401) throw error
      state.value.session.error =
        error instanceof Error ? error.message : 'Unable to load your Gridora account.'
      throw error
    } finally {
      state.value.session.loading = false
    }
  }
}

export const useCurrentOrganization = () => {
  const route = useRoute()
  const state = useGridoraState()
  return computed(() =>
    state.value.organizations.find((organization) => organization.slug === route.params.slug),
  )
}

export const useOrganizationData = () => {
  const organization = useCurrentOrganization()
  const state = useGridoraState()
  const api = useGridoraApi()
  const route = useRoute()
  const slug = computed(() => organization.value?.slug ?? String(route.params.slug ?? ''))
  const query = useQuery({
    queryKey: computed(() => ['organization', slug.value, 'workspace']),
    enabled: computed(() => Boolean(slug.value)),
    queryFn: () =>
      state.value.session.mode === 'demo'
        ? {
            servers: state.value.servers[slug.value] ?? [],
            nodes: state.value.nodes[slug.value] ?? [],
            operations: state.value.operations[slug.value] ?? [],
            backups: state.value.backups[slug.value] ?? [],
            providers: state.value.providers[slug.value] ?? [],
            images: state.value.images[slug.value] ?? [],
            members: state.value.members[slug.value] ?? [],
            invitations: state.value.invitations[slug.value] ?? [],
            audit: state.value.audit[slug.value] ?? [],
            unavailable: [],
            capabilities: {},
          }
        : api.workspace(slug.value),
  })
  const plugins = useQuery({
    queryKey: ['plugins'],
    queryFn: () => (state.value.session.mode === 'demo' ? state.value.plugins : api.plugins()),
  })
  return {
    organization,
    servers: computed(() => query.data.value?.servers ?? []),
    nodes: computed(() => query.data.value?.nodes ?? []),
    operations: computed(() => query.data.value?.operations ?? []),
    backups: computed(() => query.data.value?.backups ?? []),
    providers: computed(() => query.data.value?.providers ?? []),
    images: computed(() => query.data.value?.images ?? []),
    members: computed(() => query.data.value?.members ?? []),
    invitations: computed(() => query.data.value?.invitations ?? []),
    audit: computed(() => query.data.value?.audit ?? []),
    plugins: computed(() => plugins.data.value ?? []),
    isLoading: computed(() => query.isLoading.value || plugins.isLoading.value),
    error: computed(() =>
      query.error.value instanceof Error
        ? query.error.value.message
        : plugins.error.value instanceof Error
          ? plugins.error.value.message
          : '',
    ),
    capabilityUnavailable: computed(() => query.data.value?.unavailable ?? []),
    capabilityStatus: (name: string) =>
      computed(() => query.data.value?.capabilities?.[name] ?? 'available'),
    isDemo: computed(() => state.value.session.mode === 'demo'),
    refresh: () => query.refetch(),
  }
}

export const useGridoraMutations = () => {
  const state = useGridoraState()
  const route = useRoute()
  const api = useGridoraApi()
  const queryClient = useQueryClient()
  const slug = computed(() => String(route.params.slug ?? state.value.organizations[0]?.slug ?? ''))
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['organization', slug.value] })
  const refreshAfterRevisionConflict = async <A>(operation: () => Promise<A>): Promise<A> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof GridoraApiError && error.status === 409) await invalidate()
      throw error
    }
  }
  const operationFor = (
    title: string,
    resource: string,
    resourceType: Operation['resourceType'],
    id?: string,
  ): Operation => ({
    id: id ?? `op_${crypto.randomUUID().slice(0, 8)}`,
    revision: 1,
    title,
    resource,
    resourceType,
    status: 'queued',
    progress: 0,
    actor: state.value.currentUser.name,
    startedAt: new Date().toISOString(),
    elapsed: 'Just now',
    retries: 0,
    cancellable: true,
    steps: [
      { label: 'Request accepted', status: 'complete' },
      { label: 'Waiting for workflow', status: 'running' },
    ],
    logs: ['Idempotent operation accepted by Gridora'],
  })
  const enqueue = (operation: Operation) => {
    const operations =
      state.value.operations[slug.value] ?? (state.value.operations[slug.value] = [])
    operations.unshift(operation)
    void invalidate()
    return operation
  }
  return {
    createOrganization: useMutation({
      mutationFn: async (
        input: Pick<Organization, 'name' | 'slug' | 'timezone' | 'region'> & {
          budgetWarning: number
          budgetCurrency: string
          terms?: boolean
          invitations?: string
        },
      ) => {
        const organization =
          state.value.session.mode === 'demo'
            ? {
                id: `org_${crypto.randomUUID().slice(0, 8)}`,
                status: 'active' as const,
                role: 'Owner' as const,
                budgetUsed: 0,
                ...input,
              }
            : await api.createOrganization(
                organizationSetupRequest({
                  ...input,
                  invitations: input.invitations ?? '',
                  terms: input.terms === true,
                }),
              )
        state.value.organizations.push(organization)
        return organization
      },
    }),
    createServer: useMutation({
      mutationFn: async (input: ServerApplyRequest) => {
        const server: GameServer = {
          id: `srv_${crypto.randomUUID().slice(0, 8)}`,
          name: input.server.name,
          plugin: input.server.pluginId,
          pluginVersion: 'pending',
          status: 'deploying',
          health: 'unknown',
          nodeId: 'Scheduling',
          endpoint: 'Pending allocation',
          players: 0,
          build: 'pending',
        }
        let operation = operationFor(`Deploy ${server.name}`, server.name, 'server')
        let workflowState: 'started' | 'pending-reconciliation' | undefined
        if (state.value.session.mode === 'api') {
          const result = await api.createServer(slug.value, input)
          server.id = result.resourceId
          workflowState = result.workflowState
          operation = operationFor(
            `Deploy ${server.name}`,
            server.name,
            'server',
            result.operationId,
          )
        } else {
          const servers = state.value.servers[slug.value] ?? (state.value.servers[slug.value] = [])
          servers.unshift(server)
        }
        enqueue(operation)
        return {
          server,
          operation,
          ...(workflowState === undefined ? {} : { workflowState }),
        }
      },
    }),
    serverAction: useMutation({
      mutationFn: async ({
        server,
        action,
      }: {
        server: GameServer
        action: 'start' | 'stop' | 'restart' | 'backup'
      }) => {
        let operation = operationFor(
          `${action.charAt(0).toUpperCase()}${action.slice(1)} ${server.name}`,
          server.name,
          action === 'backup' ? 'backup' : 'server',
        )
        if (state.value.session.mode === 'api')
          operation.id = (
            await api.serverAction(slug.value, server.id, action, server.revision ?? 1)
          ).operationId
        else {
          if (action === 'start') server.status = 'running'
          if (action === 'stop') server.status = 'stopped'
        }
        return enqueue(operation)
      },
    }),
    moveServer: useMutation({
      mutationFn: async ({
        server,
        targetNodeId,
      }: {
        server: GameServer
        targetNodeId: string
      }) => {
        let operation = operationFor(`Move ${server.name}`, server.name, 'server')
        if (state.value.session.mode === 'api')
          operation.id = (
            await api.moveGameServer(slug.value, server.id, {
              expectedRevision: server.revision ?? 1,
              action: 'move',
              targetNodeId,
              backupPolicy: 'required',
            })
          ).operationId
        return enqueue(operation)
      },
    }),
    restoreBackup: useMutation({
      mutationFn: async (input: BackupRestoreRequest) => {
        let operation = operationFor('Restore backup', input.backupId, 'backup')
        if (state.value.session.mode === 'api')
          operation.id = (await api.restoreBackup(slug.value, input)).operationId
        return enqueue(operation)
      },
    }),
    invite: useMutation({
      mutationFn: async ({ email, role }: { email: string; role: Exclude<Role, 'Owner'> }) => {
        const invitation: Invitation =
          state.value.session.mode === 'api'
            ? await api.invite(slug.value, { email, role })
            : {
                id: `inv_${crypto.randomUUID().slice(0, 8)}`,
                email,
                role,
                status: 'pending',
                invitedBy: state.value.currentUser.name,
                expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
                revision: 1,
              }
        if (state.value.session.mode === 'demo') {
          const invitations =
            state.value.invitations[slug.value] ?? (state.value.invitations[slug.value] = [])
          invitations.unshift(invitation)
        }
        void invalidate()
        return invitation
      },
    }),
    updateMemberRole: async (member: Member, role: Role) => {
      if (state.value.session.mode === 'api') {
        await refreshAfterRevisionConflict(() =>
          api.updateMemberRole(slug.value, member.id, role, member.revision),
        )
      } else {
        const current = state.value.members[slug.value]?.find((item) => item.id === member.id)
        if (current) {
          current.role = role
          current.revision += 1
        }
      }
      void invalidate()
    },
    removeMember: async (member: Member) => {
      if (state.value.session.mode === 'api') {
        await refreshAfterRevisionConflict(() =>
          api.removeMember(slug.value, member.id, member.revision),
        )
      } else {
        const members = state.value.members[slug.value]
        const index = members?.findIndex((item) => item.id === member.id) ?? -1
        if (members !== undefined && index >= 0) members.splice(index, 1)
      }
      void invalidate()
    },
    leaveOrganization: async (expectedRevision: number) => {
      if (state.value.session.mode === 'api')
        await refreshAfterRevisionConflict(() =>
          api.leaveOrganization(slug.value, expectedRevision),
        )
      state.value.organizations = state.value.organizations.filter(
        (organization) => organization.slug !== slug.value,
      )
      delete state.value.members[slug.value]
      queryClient.removeQueries({ queryKey: ['organization', slug.value] })
      await navigateTo('/')
    },
    transferOwnership: async (targetIdentityId: string) => {
      if (state.value.session.mode === 'api')
        await api.transferOwnership(slug.value, targetIdentityId)
      else {
        const members = state.value.members[slug.value] ?? []
        const currentOwner = members.find((member) => member.id === state.value.currentUser.id)
        const target = members.find((member) => member.id === targetIdentityId)
        if (currentOwner !== undefined) currentOwner.role = 'Administrator'
        if (target !== undefined) target.role = 'Owner'
      }
      void invalidate()
    },
    revokeInvitation: async (invitation: Invitation) => {
      if (state.value.session.mode === 'api') {
        await refreshAfterRevisionConflict(() =>
          api.revokeInvitation(slug.value, invitation.id, invitation.revision),
        )
      } else {
        const current = state.value.invitations[slug.value]?.find(
          (item) => item.id === invitation.id,
        )
        if (current) {
          current.status = 'revoked'
          current.revision += 1
        }
      }
      void invalidate()
    },
    resendInvitation: async (invitation: Invitation) => {
      if (state.value.session.mode === 'api') {
        await refreshAfterRevisionConflict(() =>
          api.resendInvitation(
            slug.value,
            invitation.id,
            invitation.revision,
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
          ),
        )
      } else {
        const current = state.value.invitations[slug.value]?.find(
          (item) => item.id === invitation.id,
        )
        if (current) {
          current.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
          current.revision += 1
        }
      }
      void invalidate()
    },
    cancelOperation: async (operation: Operation) => {
      if (state.value.session.mode === 'api')
        await refreshAfterRevisionConflict(() =>
          api.cancelOperation(slug.value, operation.id, operation.revision),
        )
      else {
        const current = state.value.operations[slug.value]?.find((item) => item.id === operation.id)
        if (current?.cancellable) {
          current.status = 'cancelled'
          current.cancellable = false
          current.revision += 1
        }
      }
      void invalidate()
    },
  }
}
