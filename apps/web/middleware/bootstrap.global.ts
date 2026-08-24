import { GridoraApiError } from '~/services/gridora-api'

export default defineNuxtRouteMiddleware(async (to) => {
  const publicRoute =
    ['/sign-in', '/sign-up', '/auth/complete'].includes(to.path) ||
    to.path.startsWith('/legal/') ||
    to.path.startsWith('/invitations/')
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
