<script setup lang="ts">
useSeoMeta({ title: 'Game servers' })
const data = useOrganizationData()
const router = useRouter()
const rows = computed(() =>
  data.servers.value.map((server) => ({
    ...server,
    playersDisplay:
      server.players === undefined || server.playerCapacity === undefined
        ? 'Not reported'
        : `${server.players}/${server.playerCapacity}`,
    node: data.nodes.value.find((node) => node.id === server.nodeId)?.name ?? server.nodeId,
  })),
)
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Game servers"
      description="Deployments, game-level health, players, endpoints, and placement for this organization."
      ><template #actions
        ><UButton :to="`/o/${data.organization.value?.slug}/servers/new`" icon="i-lucide-plus"
          >Deploy server</UButton
        ></template
      ></PageHeader
    >
    <CapabilityState
      :status="data.capabilityStatus('gameServers').value"
      title="Game server inventory"
    />
    <div
      v-if="data.capabilityStatus('gameServers').value === 'available'"
      class="panel overflow-hidden"
    >
      <InventoryTable
        :rows="rows"
        :columns="[
          { key: 'name', label: 'Server' },
          { key: 'status', label: 'Status' },
          { key: 'plugin', label: 'Game' },
          { key: 'playersDisplay', label: 'Players' },
          { key: 'node', label: 'Node' },
          { key: 'endpoint', label: 'Endpoint' },
        ]"
        filter-placeholder="Search game servers…"
        empty-title="No game servers yet"
        empty-description="Deploy a server after provider capacity and a promoted image are available."
        empty-icon="i-lucide-gamepad-2"
        @select="(row) => router.push(`/o/${data.organization.value?.slug}/servers/${row.id}`)"
        ><template #cell-name="{ row }"
          ><div class="font-medium text-white">{{ row.name }}</div>
          <div class="mt-0.5 text-xs text-[#718c84]">
            {{ row.scenario ?? 'Scenario not reported' }}
          </div></template
        ><template #cell-status="{ row }"
          ><StatusBadge :status="row.health === 'unknown' ? row.status : row.health" /></template
        ><template #cell-endpoint="{ value }"
          ><code class="text-xs text-emerald-200">{{ value ?? 'Not assigned' }}</code></template
        ></InventoryTable
      >
    </div>
  </div>
</template>
