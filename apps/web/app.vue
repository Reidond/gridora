<script setup lang="ts">
useHead({
  titleTemplate: (title) => (title ? `${title} · Gridora` : 'Gridora Console'),
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
