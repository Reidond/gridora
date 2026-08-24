<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'
import { issueDemoAuthState } from '~/services/demo-auth-state'
import { accessRedirectUrl } from '~/utils/gridora'
definePageMeta({ layout: 'public' })
useSeoMeta({ title: 'Organization invitation' })
const route = useRoute()
const state = useGridoraState()
const api = useGridoraApi()
const config = useRuntimeConfig()
const expired = computed(
  () => state.value.session.mode === 'demo' && String(route.params.token).startsWith('expired'),
)
const accepting = ref(false)
const error = ref('')
const accept = async () => {
  accepting.value = true
  error.value = ''
  try {
    const input = {
      intent: 'accept-invitation' as const,
      returnTo: '/',
      invitationToken: String(route.params.token),
    }
    if (state.value.session.mode === 'demo') {
      const authState = issueDemoAuthState({ ...input, expiresAt: Date.now() + 300_000 })
      await navigateTo(`/auth/complete?state=${encodeURIComponent(authState)}`)
    } else {
      const configured = String(config.public.accessCompletionUrl)
      if (!configured) throw new Error('Cloudflare Access entry URL is not configured')
      const issued = await api.createAuthIntent(input)
      const destination = accessRedirectUrl(configured, issued.state)
      await navigateTo(destination, { external: destination.startsWith('http') })
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The invitation could not be accepted.'
  } finally {
    accepting.value = false
  }
}
</script>
<template>
  <div class="mx-auto w-full max-w-md">
    <span class="grid size-12 place-items-center rounded-xl bg-emerald-400/10"
      ><UIcon
        :name="expired ? 'i-lucide-clock-alert' : 'i-lucide-mail-open'"
        class="size-5 text-emerald-300"
    /></span>
    <p class="eyebrow mt-6">Organization invitation</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-.04em]">
      {{ expired ? 'This invitation has expired' : 'You have a Gridora invitation' }}
    </h1>
    <p class="muted mt-3 text-sm leading-relaxed">
      {{
        expired
          ? 'Ask an Owner or Administrator to send a new invitation.'
          : 'Continue with Cloudflare Access. Gridora accepts the invitation only when the authenticated email matches the invited email.'
      }}
    </p>
    <p v-if="error" class="mt-5 rounded-lg bg-red-400/8 p-3 text-sm text-red-200" role="alert">
      {{ error }}
    </p>
    <div v-if="!expired" class="panel mt-6 p-4 text-sm">
      Gridora does not reveal the organization, role, or invited address before authentication.
    </div>
    <UButton
      v-if="!expired"
      class="mt-6 w-full justify-center"
      size="xl"
      :loading="accepting"
      @click="accept"
      >Accept invitation</UButton
    ><UButton v-else to="/sign-in" variant="outline" class="mt-6 w-full justify-center"
      >Return to sign in</UButton
    >
  </div>
</template>
