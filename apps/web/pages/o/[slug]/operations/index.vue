<script setup lang="ts">
useSeoMeta({ title: 'Operations' })
const data = useOrganizationData()
const router = useRouter()
const rows = computed(() =>
  data.operations.value.map((operation) => ({
    ...operation,
    started: new Date(operation.startedAt).toLocaleString(),
    progressDisplay: `${operation.progress}%`,
  })),
)
const runningCount = computed(
  () => data.operations.value.filter((operation) => operation.status === 'running').length,
)
const waitingCount = computed(
  () => data.operations.value.filter((operation) => operation.status === 'waiting').length,
)
const succeededToday = computed(() => {
  const today = new Date().toDateString()
  return data.operations.value.filter(
    (operation) =>
      operation.status === 'succeeded' && new Date(operation.startedAt).toDateString() === today,
  ).length
})
const failedCount = computed(
  () => data.operations.value.filter((operation) => operation.status === 'failed').length,
)
const selectOperation = (row: Record<string, unknown>) =>
  router.push(`/o/${data.organization.value?.slug}/operations/${String(row.id)}`)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Operations"
      description="Durable workflow progress, waiting reasons, retries, recovery actions, and audit metadata."
    />
    <div class="grid gap-3 sm:grid-cols-3">
      <MetricCard
        label="In progress"
        :value="runningCount"
        detail="Work continues if you leave"
        icon="i-lucide-loader-circle"
      /><MetricCard
        label="Waiting"
        :value="waitingCount"
        :detail="waitingCount ? 'Waiting on an external dependency' : 'No waiting operations'"
        icon="i-lucide-clock-3"
        tone="warning"
      /><MetricCard
        label="Succeeded today"
        :value="succeededToday"
        :detail="`${failedCount} failed in the loaded inventory`"
        icon="i-lucide-circle-check"
      />
    </div>
    <CapabilityState
      :status="data.capabilityStatus('operations').value"
      title="Operation inventory"
    />
    <div
      v-if="data.capabilityStatus('operations').value === 'available'"
      class="panel overflow-hidden"
    >
      <InventoryTable
        :rows="rows"
        :columns="[
          { key: 'title', label: 'Operation' },
          { key: 'status', label: 'Status' },
          { key: 'progressDisplay', label: 'Progress' },
          { key: 'actor', label: 'Actor' },
          { key: 'elapsed', label: 'Elapsed' },
          { key: 'started', label: 'Started' },
        ]"
        filter-placeholder="Search operations…"
        empty-title="No operations yet"
        empty-description="Accepted control-plane mutations will appear here."
        empty-icon="i-lucide-activity"
        @select="selectOperation"
      >
        <template #cell-title="{ row }"
          ><p class="font-medium text-white">{{ row.title }}</p>
          <p class="mt-1 font-mono text-xs text-[#718c84]">{{ row.id }}</p></template
        >
        <template #cell-status="{ row }"
          ><StatusBadge :status="String(row.status)" />
          <p v-if="row.waitingReason" class="mt-1 max-w-48 text-[11px] text-amber-200">
            {{ row.waitingReason }}
          </p></template
        >
        <template #cell-progressDisplay="{ row }"
          ><div class="w-28">
            <div class="mb-1 text-xs">{{ row.progress }}%</div>
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${row.progress}%` }" />
            </div></div
        ></template>
      </InventoryTable>
    </div>
  </div>
</template>
