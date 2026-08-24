<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'
import { issueDemoAuthState } from '~/services/demo-auth-state'
import { accessRedirectUrl, safeAuthReturnPath } from '~/utils/gridora'
definePageMeta({ layout: 'public' })
useSeoMeta({ title: 'Sign in' })
const route = useRoute()
const config = useRuntimeConfig()
const state = useGridoraState()
const api = useGridoraApi()
const loading = ref(false)
const requestError = ref('')
const error = computed(() =>
  requestError.value
    ? requestError.value
    : route.query.error
      ? String(route.query.error)
      : route.query.reason === 'account-not-found'
        ? "We couldn't find a Gridora account for this identity. Create an account or ask an organization owner for an invitation."
        : '',
)
const continueToAccess = async () => {
  loading.value = true
  requestError.value = ''
  try {
    const returnTo = safeAuthReturnPath(route.query.returnTo)
    if (state.value.session.mode === 'demo') {
      const authState = issueDemoAuthState({
        intent: 'sign-in',
        returnTo,
        expiresAt: Date.now() + 300_000,
      })
      await navigateTo(`/auth/complete?state=${encodeURIComponent(authState)}`)
    } else {
      const configured = String(config.public.accessCompletionUrl)
      if (!configured) throw new Error('Cloudflare Access entry URL is not configured.')
      const issued = await api.createAuthIntent({ intent: 'sign-in', returnTo })
      const destination = accessRedirectUrl(configured, issued.state)
      await navigateTo(destination, { external: destination.startsWith('http') })
    }
  } catch (cause) {
    requestError.value = cause instanceof Error ? cause.message : 'The sign-in request failed.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md">
    <p class="eyebrow">Welcome back</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-.04em]">Sign in to Gridora</h1>
    <p class="mt-3 text-sm leading-relaxed text-[#8ea9a1]">
      Continue through your configured identity provider. Gridora never receives or stores your
      password.
    </p>
    <div
      v-if="error"
      class="mt-6 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-sm text-amber-100"
    >
      <div class="flex gap-3">
        <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
        <p>{{ error }}</p>
      </div>
    </div>
    <UButton
      class="mt-7 w-full justify-center"
      size="xl"
      icon="i-lucide-shield-check"
      :loading="loading"
      @click="continueToAccess"
      >Continue with Cloudflare Access</UButton
    >
    <div class="my-6 flex items-center gap-3">
      <span class="h-px flex-1 bg-white/8" /><span
        class="text-[11px] uppercase tracking-widest text-[#567168]"
        >Secure identity</span
      ><span class="h-px flex-1 bg-white/8" />
    </div>
    <p class="text-center text-sm text-[#8ea9a1]">
      New to Gridora?
      <NuxtLink
        :to="`/sign-up?returnTo=${encodeURIComponent(safeAuthReturnPath(route.query.returnTo, '/setup/organization'))}`"
        class="font-medium text-emerald-300 hover:text-emerald-200"
        >Create an account</NuxtLink
      >
    </p>
  </div>
</template>
