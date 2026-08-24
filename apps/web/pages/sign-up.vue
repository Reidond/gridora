<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'
import { issueDemoAuthState } from '~/services/demo-auth-state'
import { accessRedirectUrl } from '~/utils/gridora'
definePageMeta({ layout: 'public' })
useSeoMeta({ title: 'Create account' })
const route = useRoute()
const config = useRuntimeConfig()
const appState = useGridoraState()
const api = useGridoraApi()
const loading = ref(false)
const error = ref(typeof route.query.error === 'string' ? route.query.error : '')
const displayName = ref('')
const state = computed(() => String(route.query.state ?? 'open'))
const continueToAccess = async () => {
  loading.value = true
  error.value = ''
  const token = typeof route.query.invitation === 'string' ? route.query.invitation : ''
  const intent = token ? ('accept-invitation' as const) : ('sign-up' as const)
  const returnTo = token ? '/' : '/setup/organization'
  const authInput = {
    intent,
    returnTo,
    ...(token ? { invitationToken: token } : { displayName: displayName.value.trim() }),
  }
  try {
    if (appState.value.session.mode === 'demo') {
      const authState = issueDemoAuthState({ ...authInput, expiresAt: Date.now() + 300_000 })
      await navigateTo(`/auth/complete?state=${encodeURIComponent(authState)}`)
    } else {
      const configured = String(config.public.accessCompletionUrl)
      if (!configured) throw new Error('Cloudflare Access entry URL is not configured.')
      const issued = await api.createAuthIntent(authInput)
      const destination = accessRedirectUrl(configured, issued.state)
      await navigateTo(destination, { external: destination.startsWith('http') })
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The account request failed.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md">
    <p class="eyebrow">Start operating</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-.04em]">Create your Gridora account</h1>
    <p class="mt-3 text-sm leading-relaxed text-[#8ea9a1]">
      Use an approved identity provider, then create your organization or join a team through an
      invitation.
    </p>
    <p v-if="error" class="mt-5 rounded-lg bg-red-400/8 p-3 text-sm text-red-200" role="alert">
      {{ error }}
    </p>
    <div
      v-if="state !== 'open'"
      class="mt-6 rounded-xl border p-4 text-sm"
      :class="
        state === 'invitation-only'
          ? 'border-amber-300/20 bg-amber-300/[.06] text-amber-100'
          : 'border-red-300/20 bg-red-300/[.06] text-red-100'
      "
    >
      <p class="font-semibold">
        {{
          state === 'invitation-only' ? 'Invitation required' : 'Registration is currently closed'
        }}
      </p>
      <p class="mt-1 opacity-75">
        {{
          state === 'invitation-only'
            ? 'Open the invitation sent by your organization owner to continue.'
            : 'Contact the Gridora administrator for access.'
        }}
      </p>
    </div>
    <div class="mt-6">
      <label class="field-label" for="display-name">Display name</label
      ><input
        id="display-name"
        v-model="displayName"
        class="native-input"
        autocomplete="name"
        placeholder="Alex Morgan"
      />
    </div>
    <UButton
      class="mt-5 w-full justify-center"
      size="xl"
      icon="i-lucide-user-plus"
      :loading="loading"
      :disabled="
        (!route.query.invitation && !displayName.trim()) ||
        (state !== 'open' && !route.query.invitation)
      "
      @click="continueToAccess"
      >Continue to create account</UButton
    >
    <p class="mt-4 text-xs leading-relaxed text-[#718c84]">
      By continuing, you agree to Gridora's
      <NuxtLink to="/legal/terms" class="text-[#acc0ba]">Terms</NuxtLink> and
      <NuxtLink to="/legal/privacy" class="text-[#acc0ba]">Privacy Policy</NuxtLink>. Authentication
      is handled by the deployment's identity provider.
    </p>
    <p class="mt-7 text-center text-sm text-[#8ea9a1]">
      Already have an account?
      <NuxtLink to="/sign-in" class="font-medium text-emerald-300">Sign in</NuxtLink>
    </p>
  </div>
</template>
