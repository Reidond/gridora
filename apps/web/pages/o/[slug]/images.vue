<script setup lang="ts">
useSeoMeta({ title: 'Node images' })
const data = useOrganizationData()
const images = computed(() =>
  data.images.value.map((image) => ({
    ...image,
    built: new Date(image.createdAt).toLocaleString(),
    providers: Object.keys(image.providerMappings).join(' · ') || 'Not registered',
    nodes: data.nodes.value.filter((node) => node.image === image.id).length,
  })),
)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Node images"
      description="Authorized image inventory with checksums, signatures, promotion state, and provider mappings."
    />
    <CapabilityState :status="data.capabilityStatus('images').value" title="Node image inventory" />
    <div v-if="data.capabilityStatus('images').value === 'available'" class="panel overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>State</th>
            <th>Created</th>
            <th>Provider mappings</th>
            <th>Nodes</th>
            <th>Integrity metadata</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="image in images" :key="image.id">
            <td>
              <p class="font-mono font-medium text-white">{{ image.version }}</p>
              <p class="mt-1 text-xs text-[#718c84]">{{ image.id }}</p>
            </td>
            <td><StatusBadge :status="image.status" /></td>
            <td>{{ image.built }}</td>
            <td>{{ image.providers }}</td>
            <td>{{ image.nodes }}</td>
            <td>
              <span class="text-xs text-emerald-300">Checksum and signature recorded</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-if="!images.length"
        title="No node images yet"
        description="The organization has no visible image inventory."
        icon="i-lucide-package-open"
      />
    </div>
    <div class="panel p-5">
      <p class="flex items-center gap-2 text-sm font-medium">
        <UIcon name="i-lucide-shield-check" class="text-emerald-300" /> Promotion policy
      </p>
      <p class="muted mt-2 max-w-3xl text-xs leading-relaxed">
        Gridora accepts only promoted images for placement. The inventory state does not by itself
        prove that every external scan or provider registration remains current.
      </p>
    </div>
  </div>
</template>
