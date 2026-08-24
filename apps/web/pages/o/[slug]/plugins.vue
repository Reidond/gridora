<script setup lang="ts">
useSeoMeta({ title: 'Plugins' })
const data = useOrganizationData()
const selected = ref(data.plugins.value[0])
watchEffect(() => {
  if (selected.value === undefined && data.plugins.value[0] !== undefined)
    selected.value = data.plugins.value[0]
})
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Game plugins"
      description="Build-time reviewed game capabilities, schemas, limits, and compatibility."
    />
    <div class="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div class="grid gap-4 sm:grid-cols-2">
        <button
          v-for="plugin in data.plugins.value"
          :key="plugin.id"
          class="panel panel-hover p-5 text-left"
          @click="selected = plugin"
        >
          <div class="flex items-start justify-between">
            <span class="grid size-10 place-items-center rounded-xl bg-emerald-400/8"
              ><UIcon name="i-lucide-blocks" class="text-emerald-300" /></span
            ><StatusBadge :status="plugin.enabled ? 'active' : 'disabled'" />
          </div>
          <h2 class="mt-5 text-lg font-semibold">{{ plugin.name }}</h2>
          <p class="muted mt-1 text-xs">
            v{{ plugin.version }}
            <template v-if="plugin.platforms"> · {{ plugin.platforms }}</template>
            <template v-if="plugin.steamAppId"> · Steam {{ plugin.steamAppId }}</template>
          </p>
          <div class="mt-4 flex flex-wrap gap-1.5">
            <span
              v-for="capability in plugin.capabilities"
              :key="capability"
              class="rounded-md bg-white/[.045] px-2 py-1 text-[10px] text-[#9bb0aa]"
              >{{ capability }}</span
            >
          </div>
        </button>
      </div>
      <aside v-if="selected" class="panel h-fit p-5 lg:sticky lg:top-24">
        <p class="eyebrow">Plugin manifest</p>
        <h2 class="mt-2 text-lg font-semibold">{{ selected.name }}</h2>
        <dl class="mt-5 space-y-3 text-sm">
          <div
            v-for="item in [
              ['Plugin ID', selected.id],
              ['Version', selected.version],
              ['API', selected.apiVersion],
              ['Steam App ID', selected.steamAppId ?? 'Not reported'],
              ['Platform', selected.platforms ?? 'Not reported'],
            ]"
            :key="item[0]"
            class="flex justify-between gap-4"
          >
            <dt class="muted">{{ item[0] }}</dt>
            <dd class="text-right">{{ item[1] }}</dd>
          </div>
        </dl>
        <div class="mt-5 border-t border-white/8 pt-4">
          <p class="text-xs font-semibold">Known limitations</p>
          <p v-for="item in selected.limitations" :key="item" class="muted mt-2 text-xs">
            {{ item }}
          </p>
        </div>
        <UButton
          :to="`/o/${data.organization.value?.slug}/servers/new`"
          class="mt-5 w-full justify-center"
          >Deploy with plugin</UButton
        >
      </aside>
    </div>
    <EmptyState
      v-if="!data.plugins.value.length && !data.isLoading.value"
      title="No game plugins available"
      description="The control plane did not return any reviewed plugin manifests."
      icon="i-lucide-blocks"
    />
  </div>
</template>
