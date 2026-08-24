<script setup lang="ts">
definePageMeta({ layout: 'public' })
const route = useRoute()
const title = computed(() =>
  route.params.document === 'privacy' ? 'Privacy Policy' : 'Terms of Service',
)
useSeoMeta({ title })
</script>
<template>
  <article class="mx-auto max-w-xl">
    <p class="eyebrow">Gridora legal</p>
    <h1 class="mt-3 text-3xl font-semibold">{{ title }}</h1>
    <p class="muted mt-5 text-sm leading-7">
      This deployment must publish its approved legal text before accepting production
      registrations. Gridora records the accepted document version and timestamp during organization
      setup.
    </p>
    <UButton to="/sign-up" variant="outline" class="mt-6">Return to sign up</UButton>
  </article>
</template>
