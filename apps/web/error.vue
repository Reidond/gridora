<script setup lang="ts">
defineProps<{ error: { statusCode: number; statusMessage?: string } }>()
</script>
<template>
  <div class="grid min-h-screen place-items-center bg-[#07110f] p-6">
    <div class="max-w-md text-center">
      <BrandMark />
      <p class="eyebrow mt-10">Error {{ error.statusCode }}</p>
      <h1 class="mt-3 text-3xl font-semibold">
        {{ error.statusMessage ?? 'Something went wrong' }}
      </h1>
      <p class="muted mt-3 text-sm">
        The requested organization resource may not exist or your membership may not permit access.
      </p>
      <UButton to="/" class="mt-6">Return to Gridora</UButton>
    </div>
  </div>
</template>
