import { GridoraApiError } from '~/services/gridora-api'
import { isPublicAppRoute, publicAppSignInPath } from '~/utils/gridora'

export default defineNuxtRouteMiddleware(async (to) => {
  const publicRoute = isPublicAppRoute(to.path)
  if (import.meta.client) {
    const publicAppOrigin = String(useRuntimeConfig().public.publicAppOrigin).replace(/\/$/, '')
    if (publicAppOrigin && globalThis.location.origin === publicAppOrigin && !publicRoute)
      return navigateTo(publicAppSignInPath(to.fullPath), { replace: true })
  }
  if (publicRoute || import.meta.server) return
  const state = useGridoraState()
  try {
    await useGridoraBootstrap()()
  } catch (error) {
    if (error instanceof GridoraApiError && error.status === 401)
      return navigateTo(`/sign-in?returnTo=${encodeURIComponent(to.fullPath)}`)
  }
  if (state.value.session.error || to.path.startsWith('/setup/organization')) return
  if (!state.value.organizations.length) return navigateTo('/setup/organization')
  if (
    to.params.slug &&
    !state.value.organizations.some((organization) => organization.slug === to.params.slug)
  )
    return abortNavigation(
      createError({ statusCode: 403, statusMessage: 'Organization access denied' }),
    )
})
