<script setup lang="ts">
const props = defineProps<{ status?: unknown }>()
const status = computed(() => String(props.status ?? 'unknown'))
const tone = computed(() => {
  if (
    [
      'healthy',
      'ready',
      'running',
      'succeeded',
      'active',
      'available',
      'connected',
      'promoted',
      'accepted',
    ].includes(status.value)
  )
    return 'green'
  if (
    [
      'degraded',
      'waiting',
      'provisioning',
      'deploying',
      'creating',
      'pending',
      'building',
    ].includes(status.value)
  )
    return 'amber'
  if (['failed', 'offline', 'error', 'revoked', 'expired', 'suspended'].includes(status.value))
    return 'red'
  return 'gray'
})
const classes = computed(
  () =>
    ({
      green: 'border-emerald-400/20 bg-emerald-400/8 text-emerald-300',
      amber: 'border-amber-400/20 bg-amber-400/8 text-amber-300',
      red: 'border-red-400/20 bg-red-400/8 text-red-300',
      gray: 'border-slate-400/20 bg-slate-400/8 text-slate-300',
    })[tone.value],
)
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold capitalize"
    :class="classes"
  >
    <span class="status-dot bg-current opacity-80" />{{ status.replace('-', ' ') }}
  </span>
</template>
