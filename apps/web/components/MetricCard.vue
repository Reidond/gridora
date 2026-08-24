<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  detail?: string
  icon?: string
  tone?: 'default' | 'warning' | 'danger'
}>()
</script>

<template>
  <div class="panel panel-hover p-4 sm:p-5">
    <div class="flex items-center justify-between">
      <p class="text-xs font-medium text-[#8ea9a1]">{{ label }}</p>
      <UIcon v-if="icon" :name="icon" class="size-4 text-emerald-300/80" />
    </div>
    <p
      class="kpi-value"
      :class="
        tone === 'warning' ? 'text-amber-300' : tone === 'danger' ? 'text-red-300' : 'text-white'
      "
    >
      {{ value }}
    </p>
    <p v-if="detail" class="mt-1 text-xs text-[#6f8c83]">{{ detail }}</p>
  </div>
</template>
