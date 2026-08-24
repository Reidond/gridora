<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'
import { consumeDemoAuthState } from '~/services/demo-auth-state'
import { safeAppPath } from '~/utils/gridora'
definePageMeta({ layout: 'public' })
useSeoMeta({ title: 'Completing sign in' })
const route = useRoute()
const state = useGridoraState()
const api = useGridoraApi()
const status = ref<'loading' | 'error'>('loading')
onMounted(async () => {
  try {
    const authState = typeof route.query.state === 'string' ? route.query.state : ''
    if (!authState || !/^(?:state|demo_state)_[A-Za-z0-9-]+$/.test(authState))
      throw new Error('A valid authentication state is required')
    const completed =
      state.value.session.mode === 'demo'
        ? consumeDemoAuthState(authState)
        : await api.completeAuthentication(authState)
    if (state.value.session.mode === 'demo')
      await new Promise((resolve) => setTimeout(resolve, 300))
    else await useGridoraBootstrap()()
    const target = safeAppPath(completed.returnTo)
    if (completed.next === 'setup-organization')
      await navigateTo('/setup/organization', { replace: true })
    else await navigateTo(target, { replace: true })
  } catch {
    status.value = 'error'
  }
})
</script>
<template>
  <div class="mx-auto max-w-md text-center">
    <span class="mx-auto grid size-14 place-items-center rounded-2xl bg-emerald-400/10"
      ><UIcon
        :name="status === 'loading' ? 'i-lucide-loader-circle' : 'i-lucide-triangle-alert'"
        class="size-6 text-emerald-300"
        :class="status === 'loading' ? 'animate-spin' : ''"
    /></span>
    <h1 class="mt-5 text-xl font-semibold">
      {{ status === 'loading' ? 'Verifying your identity' : 'Unable to complete sign in' }}
    </h1>
    <p class="muted mt-2 text-sm">
      {{
        status === 'loading'
          ? 'Cloudflare Access establishes identity; Gridora is resolving your account and memberships.'
          : 'Try the sign-in flow again or contact support with the request ID.'
      }}
    </p>
    <UButton v-if="status === 'error'" to="/sign-in" class="mt-6">Return to sign in</UButton>
  </div>
</template>
