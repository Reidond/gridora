<script setup lang="ts">
import { GridoraApiError, useGridoraApi } from '~/services/gridora-api'

useSeoMeta({ title: 'Nodes' })
const data = useOrganizationData()
const router = useRouter()
const api = useGridoraApi()
const provisionOpen = ref(false)
const provisionPending = ref(false)
const provisionError = ref('')
const placementMode = ref<'shared' | 'dedicated'>('dedicated')
const temporaryLifetimeHours = ref('')
const nonHourlyCommitmentConfirmed = ref(false)
const canProvision = computed(() => {
  if (temporaryLifetimeHours.value === '') return true
  const hours = Number(temporaryLifetimeHours.value)
  return Number.isSafeInteger(hours) && hours > 0
})
const provisionNode = async () => {
  if (data.isDemo.value || provisionPending.value || !canProvision.value) return
  provisionError.value = ''
  provisionPending.value = true
  const hours = temporaryLifetimeHours.value === '' ? null : Number(temporaryLifetimeHours.value)
  try {
    const accepted = await api.createNode(data.organization.value?.slug ?? '', {
      schemaVersion: 1,
      placementMode: placementMode.value,
      temporaryLifetimeHours: hours,
      nonHourlyCommitmentConfirmed: nonHourlyCommitmentConfirmed.value,
    })
    await data.refresh()
    provisionOpen.value = false
    await router.push(`/o/${data.organization.value?.slug}/nodes/${accepted.nodeId}`)
  } catch (error) {
    if (error instanceof GridoraApiError && error.status === 409) await data.refresh()
    provisionError.value =
      error instanceof Error ? error.message : 'The node could not be accepted.'
  } finally {
    provisionPending.value = false
  }
}
const rows = computed(() =>
  data.nodes.value.map((n) => ({
    ...n,
    usage:
      n.cpu === undefined || n.memory === undefined || n.disk === undefined
        ? 'Not reported'
        : `${n.cpu}% / ${n.memory}% / ${n.disk}%`,
    cost: n.costMonthly === undefined ? 'Not reported' : `${formatCurrency(n.costMonthly)}/mo`,
  })),
)
const knownMemory = computed(() => data.nodes.value.filter((node) => node.memory !== undefined))
const averageMemory = computed(() =>
  knownMemory.value.length
    ? Math.round(
        knownMemory.value.reduce((sum, node) => sum + (node.memory ?? 0), 0) /
          knownMemory.value.length,
      )
    : undefined,
)
const knownMonthlyCost = computed(() =>
  data.nodes.value.some((node) => node.costMonthly !== undefined)
    ? data.nodes.value.reduce((sum, node) => sum + (node.costMonthly ?? 0), 0)
    : undefined,
)
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Nodes"
      description="Provider instances, agent and Tunnel health, capacity, images, and cancellation state."
      ><template #actions
        ><UButton
          icon="i-lucide-plus"
          :disabled="data.isDemo.value"
          :title="
            data.isDemo.value
              ? 'Provisioning is available from an authorized API workspace.'
              : undefined
          "
          @click="provisionOpen = true"
          >Provision node</UButton
        ></template
      ></PageHeader
    >
    <section v-if="provisionOpen" class="panel border-emerald-300/15 p-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="section-title">Provision node</h2>
          <p class="muted mt-2 text-sm">
            Gridora selects only an authorized provider allocation, catalog plan, and promoted
            image. This request never supplies provider credentials.
          </p>
        </div>
        <UButton variant="ghost" icon="i-lucide-x" @click="provisionOpen = false">Close</UButton>
      </div>
      <p
        v-if="provisionError"
        class="mt-4 rounded-lg border border-red-300/25 bg-red-400/10 px-3 py-2 text-sm text-red-100"
      >
        {{ provisionError }}
      </p>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="muted text-xs">
          Placement mode
          <select v-model="placementMode" class="native-input mt-1 w-full text-sm">
            <option value="dedicated">Dedicated</option>
            <option value="shared">Shared</option>
          </select>
        </label>
        <label class="muted text-xs">
          Temporary lifetime (hours, optional)
          <input
            v-model="temporaryLifetimeHours"
            class="native-input mt-1 w-full text-sm"
            inputmode="numeric"
            min="1"
            placeholder="No automatic expiry"
            type="number"
          />
        </label>
      </div>
      <label class="muted mt-3 flex items-center gap-2 text-xs">
        <input v-model="nonHourlyCommitmentConfirmed" type="checkbox" />
        I acknowledge a selected non-hourly provider commitment if policy allows it.
      </label>
      <p v-if="!canProvision" class="mt-2 text-xs text-red-100">
        Temporary lifetime must be a positive whole number of hours.
      </p>
      <UButton
        class="mt-4"
        icon="i-lucide-plus"
        :disabled="provisionPending || !canProvision"
        @click="provisionNode"
        >{{ provisionPending ? 'Submitting…' : 'Provision node' }}</UButton
      >
    </section>
    <div class="grid gap-3 sm:grid-cols-3">
      <MetricCard
        label="Ready nodes"
        :value="data.nodes.value.filter((n) => n.status === 'ready').length"
        :detail="`${new Set(data.nodes.value.map((node) => node.region)).size} reported regions`"
        icon="i-lucide-server"
      /><MetricCard
        label="Reserved memory"
        :value="averageMemory === undefined ? '—' : `${averageMemory}%`"
        detail="Utilization is shown only when the inventory reports it"
        icon="i-lucide-memory-stick"
      /><MetricCard
        label="Monthly estimate"
        :value="knownMonthlyCost === undefined ? '—' : formatCurrency(knownMonthlyCost)"
        detail="Pricing is shown only when the inventory reports it"
        icon="i-lucide-receipt"
      />
    </div>
    <CapabilityState :status="data.capabilityStatus('nodes').value" title="Node inventory" />
    <div v-if="data.capabilityStatus('nodes').value === 'available'" class="panel overflow-hidden">
      <InventoryTable
        :rows="rows"
        :columns="[
          { key: 'name', label: 'Node' },
          { key: 'status', label: 'Status' },
          { key: 'provider', label: 'Provider' },
          { key: 'region', label: 'Region' },
          { key: 'plan', label: 'Plan' },
          { key: 'usage', label: 'CPU / RAM / Disk' },
          { key: 'cost', label: 'Estimate' },
        ]"
        filter-placeholder="Search nodes…"
        empty-title="No nodes yet"
        empty-description="No VPS node inventory was returned for this organization."
        empty-icon="i-lucide-server"
        @select="(row) => router.push(`/o/${data.organization.value?.slug}/nodes/${row.id}`)"
        ><template #cell-name="{ row }"
          ><p class="font-medium text-white">{{ row.name }}</p>
          <p class="mt-1 text-xs text-[#718c84]">
            {{ row.deployments ?? 'Unknown' }} deployments ·
            {{ row.agentVersion ?? 'Agent version not reported' }}
          </p></template
        ><template #cell-status="{ row }"
          ><StatusBadge :status="row.health === 'unknown' ? row.status : row.health" /></template
      ></InventoryTable>
    </div>
  </div>
</template>
