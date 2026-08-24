<script setup lang="ts">
defineProps<{
  status: 'available' | 'not-implemented' | 'forbidden'
  title: string
}>()
</script>

<template>
  <EmptyState
    v-if="status !== 'available'"
    :title="status === 'forbidden' ? `${title} access restricted` : `${title} unavailable`"
    :description="
      status === 'forbidden'
        ? 'Your organization role does not permit this inventory.'
        : 'The deployed control plane does not implement this inventory yet. This is not a zero-resource result.'
    "
    :icon="status === 'forbidden' ? 'i-lucide-shield-alert' : 'i-lucide-construction'"
  />
</template>
