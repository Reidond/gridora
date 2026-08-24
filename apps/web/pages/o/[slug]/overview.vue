<script setup lang="ts">
useSeoMeta({ title: 'Overview' })
const data = useOrganizationData()
const isDemo = data.isDemo
const fleet = computed(() =>
  summarizeFleet(data.servers.value, data.nodes.value, data.operations.value),
)
const capacity = computed(() =>
  data.nodes.value.some((node) => node.memory !== undefined)
    ? Math.round(
        data.nodes.value.reduce((sum, node) => sum + (node.memory ?? 0), 0) /
          data.nodes.value.filter((node) => node.memory !== undefined).length,
      )
    : undefined,
)
const waitingCount = computed(
  () => data.operations.value.filter((operation) => operation.status === 'waiting').length,
)
const attentionCount = computed(
  () =>
    data.servers.value.filter((server) => ['degraded', 'failed'].includes(server.health)).length +
    data.nodes.value.filter((node) => ['degraded', 'failed'].includes(node.health)).length,
)
const setupItems = computed(() => [
  { label: 'Provider capacity', done: data.providers.value.length > 0 },
  { label: 'Invite teammates', done: data.members.value.length > 1 },
  { label: 'Deploy first server', done: data.servers.value.length > 0 },
  { label: 'Configure backup policy', done: data.backups.value.length > 0 },
])
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      :title="`${data.organization.value?.name} overview`"
      :description="
        isDemo
          ? 'Demonstration infrastructure health, operations, costs, and drift.'
          : 'Authorized inventory and observed control-plane state for this organization.'
      "
      eyebrow="Organization control plane"
      ><template #actions
        ><UButton :to="`/o/${data.organization.value?.slug}/servers/new`" icon="i-lucide-plus"
          >Deploy server</UButton
        ></template
      ></PageHeader
    >
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Running servers"
        :value="fleet.running"
        :detail="`${data.servers.value.length} total deployments`"
        icon="i-lucide-gamepad-2"
      /><MetricCard
        label="Ready nodes"
        :value="fleet.readyNodes"
        :detail="
          capacity === undefined
            ? 'Utilization is not in the inventory contract'
            : `${capacity}% average memory reserved`
        "
        icon="i-lucide-server"
      /><MetricCard
        label="Active operations"
        :value="fleet.activeOperations"
        :detail="`${waitingCount} waiting on an external dependency`"
        icon="i-lucide-activity"
        tone="warning"
      /><MetricCard
        label="Estimated monthly"
        :value="isDemo ? formatCurrency(data.organization.value?.budgetUsed ?? 0) : '—'"
        :detail="
          isDemo
            ? `Warning at ${formatCurrency(data.organization.value?.budgetWarning ?? 0)}`
            : 'Budget totals are not in the bootstrap contract'
        "
        icon="i-lucide-wallet-cards"
      />
    </div>
    <div class="grid gap-5 xl:grid-cols-[1.45fr_.8fr]">
      <section class="panel overflow-hidden">
        <div class="flex items-center justify-between border-b border-white/8 p-4 sm:p-5">
          <div>
            <h2 class="section-title">Fleet health</h2>
            <p class="muted mt-1 text-xs">
              {{
                isDemo
                  ? 'Demo status includes process and protocol health.'
                  : 'Lifecycle state is separate from game-health telemetry, which may be unavailable.'
              }}
            </p>
          </div>
          <NuxtLink
            :to="`/o/${data.organization.value?.slug}/servers`"
            class="text-xs font-medium text-emerald-300"
            >View all</NuxtLink
          >
        </div>
        <div class="divide-y divide-white/[.06]">
          <NuxtLink
            v-for="server in data.servers.value.slice(0, 4)"
            :key="server.id"
            :to="`/o/${data.organization.value?.slug}/servers/${server.id}`"
            class="flex items-center gap-3 p-4 hover:bg-white/[.025]"
            ><span class="grid size-9 place-items-center rounded-lg bg-white/[.04]"
              ><UIcon name="i-lucide-gamepad-2" class="size-4 text-[#8ea9a1]" /></span
            ><span class="min-w-0 flex-1"
              ><span class="block truncate text-sm font-medium">{{ server.name }}</span
              ><span class="muted block truncate text-xs"
                >{{ server.scenario ?? 'Scenario not reported' }} ·
                {{ server.endpoint ?? 'Endpoint not assigned' }}</span
              ></span
            ><span
              v-if="server.players !== undefined && server.playerCapacity !== undefined"
              class="hidden text-xs text-[#8ea9a1] sm:block"
              >{{ server.players }}/{{ server.playerCapacity }} players</span
            ><StatusBadge :status="server.health === 'unknown' ? server.status : server.health"
          /></NuxtLink>
        </div>
        <EmptyState
          v-if="
            !data.servers.value.length && data.capabilityStatus('gameServers').value === 'available'
          "
          title="No game servers yet"
          description="Deploy a server when provider capacity and a promoted image are ready."
          icon="i-lucide-gamepad-2"
        />
      </section>
      <section class="panel p-5">
        <div class="flex items-center justify-between">
          <h2 class="section-title">Setup checklist</h2>
          <span class="text-xs text-[#718c84]"
            >{{ setupItems.filter((item) => item.done).length }}/{{ setupItems.length }}</span
          >
        </div>
        <div class="mt-5 space-y-3">
          <div v-for="item in setupItems" :key="item.label" class="flex items-center gap-3">
            <span
              class="grid size-6 place-items-center rounded-full"
              :class="
                item.done
                  ? 'bg-emerald-400/12 text-emerald-300'
                  : 'border border-white/12 text-[#567168]'
              "
              ><UIcon
                :name="item.done ? 'i-lucide-check' : 'i-lucide-circle'"
                class="size-3.5" /></span
            ><span
              class="text-sm"
              :class="item.done ? 'text-[#829b93] line-through' : 'text-[#c9d8d4]'"
              >{{ item.label }}</span
            >
          </div>
        </div>
        <div
          v-if="attentionCount"
          class="mt-6 rounded-xl border border-amber-300/12 bg-amber-300/[.035] p-3"
        >
          <div class="flex gap-2 text-xs font-semibold text-amber-200">
            <UIcon name="i-lucide-triangle-alert" /> {{ attentionCount }} observed items need
            attention
          </div>
          <p class="mt-1 text-[11px] leading-relaxed text-[#8d9583]">
            Review the degraded or failed resources in the inventory.
          </p>
        </div>
      </section>
    </div>
    <section class="panel overflow-hidden">
      <div class="flex items-center justify-between border-b border-white/8 p-4 sm:p-5">
        <div>
          <h2 class="section-title">Recent operations</h2>
          <p class="muted mt-1 text-xs">
            Durable workflows continue even when this console is closed.
          </p>
        </div>
        <NuxtLink
          :to="`/o/${data.organization.value?.slug}/operations`"
          class="text-xs font-medium text-emerald-300"
          >All operations</NuxtLink
        >
      </div>
      <div class="grid gap-px bg-white/[.06] md:grid-cols-3">
        <NuxtLink
          v-for="operation in data.operations.value.slice(0, 3)"
          :key="operation.id"
          :to="`/o/${data.organization.value?.slug}/operations/${operation.id}`"
          class="bg-[#0d1b18] p-4 hover:bg-[#10221e]"
          ><div class="flex items-start justify-between gap-2">
            <p class="text-sm font-medium">{{ operation.title }}</p>
            <StatusBadge :status="operation.status" />
          </div>
          <p class="muted mt-1 text-xs">{{ operation.actor }} · {{ operation.elapsed }}</p>
          <div class="progress-track mt-4">
            <div class="progress-fill" :style="{ width: `${operation.progress}%` }" /></div
        ></NuxtLink>
      </div>
      <EmptyState
        v-if="
          !data.operations.value.length && data.capabilityStatus('operations').value === 'available'
        "
        title="No operations yet"
        description="Accepted control-plane mutations will appear here."
        icon="i-lucide-activity"
      />
    </section>
  </div>
</template>
