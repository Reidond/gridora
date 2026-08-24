<script setup lang="ts">
defineProps<{ title: string; description: string; icon?: string }>()
</script>

<template>
  <div class="grid min-h-64 place-items-center p-8 text-center">
    <div>
      <span
        class="mx-auto grid size-11 place-items-center rounded-xl bg-emerald-400/8 text-emerald-300"
        ><UIcon :name="icon ?? 'i-lucide-box'" class="size-5"
      /></span>
      <h3 class="mt-4 font-semibold">{{ title }}</h3>
      <p class="muted mx-auto mt-1 max-w-sm text-sm">{{ description }}</p>
      <div v-if="$slots.default" class="mt-5"><slot /></div>
    </div>
  </div>
</template>
