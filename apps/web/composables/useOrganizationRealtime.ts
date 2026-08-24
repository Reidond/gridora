import { useQueryClient } from '@tanstack/vue-query'
import { GridoraApiError, useGridoraApi } from '~/services/gridora-api'
import {
  createOrganizationRealtimeClient,
  type OrganizationRealtimeState,
} from '~/services/organization-realtime'

export const useOrganizationRealtime = (
  organization: Ref<{ readonly id: string; readonly slug: string } | undefined>,
) => {
  const config = useRuntimeConfig()
  const api = useGridoraApi()
  const queryClient = useQueryClient()
  const state = ref<OrganizationRealtimeState>('disabled')

  if (import.meta.client) {
    const client = createOrganizationRealtimeClient({
      apiBase: String(config.public.apiBase),
      pageUrl: window.location.href,
      fetchTicket: (slug, signal) => api.organizationEventsTicket(slug, signal),
      openSocket: (url) => new WebSocket(url),
      isAuthorizationDenied: (error) =>
        error instanceof GridoraApiError && (error.status === 401 || error.status === 403),
      onState: (next) => {
        state.value = next
      },
      onEvent: (_event, scope) => {
        void queryClient.invalidateQueries({
          queryKey: ['organization', scope.route],
          exact: false,
        })
      },
    })
    watch(
      organization,
      (current) => {
        client.start(current === undefined ? undefined : { id: current.id, route: current.slug })
      },
      { immediate: true },
    )
    onBeforeUnmount(() => client.stop())
  }

  return readonly(state)
}
