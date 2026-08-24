<script setup lang="ts">
useSeoMeta({ title: 'Backups' })
const data = useOrganizationData()
const mutations = useGridoraMutations()
const restore = ref('')
const restoreTargetServer = ref('')
const restoreTargetNode = ref('')
const error = ref('')
const selectedRestoreServer = computed(() =>
  data.servers.value.find((server) => server.id === restoreTargetServer.value),
)
const beginRestore = (backup: { id: string; serverId: string }) => {
  restore.value = backup.id
  restoreTargetServer.value = backup.serverId
  const source = data.servers.value.find((server) => server.id === backup.serverId)
  restoreTargetNode.value = source?.nodeId === 'Not assigned' ? '' : (source?.nodeId ?? '')
}
watch(restoreTargetServer, () => {
  const nodeId = selectedRestoreServer.value?.nodeId
  if (nodeId !== undefined && nodeId !== 'Not assigned') restoreTargetNode.value = nodeId
})
const confirmRestore = async () => {
  if (!restore.value) return
  error.value = ''
  try {
    const operation = await mutations.restoreBackup.mutateAsync({
      backupId: restore.value,
      ...(restoreTargetServer.value.length === 0
        ? {}
        : { targetServerId: restoreTargetServer.value }),
      ...(restoreTargetNode.value.length === 0 ? {} : { targetNodeId: restoreTargetNode.value }),
    })
    await navigateTo(`/o/${data.organization.value?.slug}/operations/${operation.id}`)
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'The restore request could not be accepted.'
  }
}
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Backups"
      description="Encrypted restore points with game, configuration, mod-set, node, and consistency metadata."
    />
    <div class="grid gap-3 sm:grid-cols-3">
      <MetricCard
        label="Available"
        :value="data.backups.value.length"
        detail="Authorized backup inventory entries"
        icon="i-lucide-archive"
      /><MetricCard
        label="Policy coverage"
        value="Daily"
        detail="Default schedule for every deployed server"
        icon="i-lucide-shield-check"
        tone="warning"
      /><MetricCard
        label="Next scheduled"
        value="≤ 24h"
        detail="Durable scheduler retries lost dispatch responses"
        icon="i-lucide-clock"
      />
    </div>
    <CapabilityState :status="data.capabilityStatus('backups').value" title="Backup inventory" />
    <div
      v-if="data.capabilityStatus('backups').value === 'available'"
      class="panel overflow-x-auto"
    >
      <table class="data-table">
        <thead>
          <tr>
            <th>Server</th>
            <th>Created</th>
            <th>Size</th>
            <th>Consistency</th>
            <th>Retention</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="backup in data.backups.value" :key="backup.id">
            <td>
              <p class="font-medium text-white">{{ backup.server }}</p>
              <code class="text-[10px] text-[#718c84]">{{ backup.checksum }}</code>
            </td>
            <td>{{ new Date(backup.createdAt).toLocaleString() }}</td>
            <td>{{ backup.size ?? 'Not reported' }}</td>
            <td>{{ backup.consistency ?? 'Not reported' }}</td>
            <td>
              {{
                backup.retainedUntil
                  ? new Date(backup.retainedUntil).toLocaleString()
                  : 'Not retained'
              }}
            </td>
            <td><StatusBadge :status="backup.status" /></td>
            <td>
              <UButton size="xs" variant="outline" @click="beginRestore(backup)">Restore</UButton>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-if="!data.backups.value.length"
        title="No backups yet"
        description="Create a backup from a game server after deployment."
        icon="i-lucide-archive"
      />
    </div>
    <p v-if="error" class="rounded-lg bg-red-400/8 p-3 text-sm text-red-200" role="alert">
      {{ error }}
    </p>
    <div v-if="restore" class="panel border-amber-300/15 p-5">
      <div class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p class="font-semibold text-amber-100">Stage and validate restore?</p>
          <p class="muted mt-1 text-xs">
            The control plane validates the schema-v1 restore request, organization ownership,
            plugin compatibility, and selected target before active data is replaced.
          </p>
        </div>
        <div class="flex gap-2">
          <UButton variant="ghost" @click="restore = ''">Cancel</UButton
          ><UButton :loading="mutations.restoreBackup.isPending.value" @click="confirmRestore"
            >Start restore operation</UButton
          >
        </div>
      </div>
      <div class="mt-5 grid gap-4 border-t border-white/8 pt-5 sm:grid-cols-2">
        <div>
          <label class="field-label">Target server</label>
          <select v-model="restoreTargetServer" class="native-select">
            <option value="">Resolve from backup metadata</option>
            <option v-for="server in data.servers.value" :key="server.id" :value="server.id">
              {{ server.name }} · {{ server.plugin }}
            </option>
          </select>
        </div>
        <div>
          <label class="field-label">Target node</label>
          <select v-model="restoreTargetNode" class="native-select">
            <option value="">Resolve from compatible target server</option>
            <option v-for="node in data.nodes.value" :key="node.id" :value="node.id">
              {{ node.name }} · {{ node.region }} · {{ node.status }}
            </option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>
