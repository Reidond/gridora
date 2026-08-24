<script setup lang="ts">
definePageMeta({ layout: 'public' })
const state = useGridoraState()

if (!state.value.session.error) {
  await navigateTo(
    state.value.organizations[0]
      ? `/o/${state.value.organizations[0].slug}/overview`
      : '/setup/organization',
    { replace: true },
  )
}
</script>

<template>
  <div v-if="state.session.error" class="mx-auto max-w-lg text-center">
    <UIcon name="i-lucide-cloud-off" class="mx-auto size-10 text-amber-200" />
    <h1 class="mt-5 text-2xl font-semibold">Unable to load Gridora</h1>
    <p class="muted mt-3 text-sm">{{ state.session.error }}</p>
    <UButton class="mt-6" @click="reloadNuxtApp()">Retry</UButton>
  </div>
</template>
