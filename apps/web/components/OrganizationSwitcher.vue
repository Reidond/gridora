<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'

const route = useRoute()
const state = useGridoraState()
const current = useCurrentOrganization()
const api = useGridoraApi()
const open = ref(false)
const query = ref('')
const organizations = computed(() =>
  state.value.organizations.filter((organization) =>
    organization.name.toLowerCase().includes(query.value.toLowerCase()),
  ),
)
const switchTo = async (slug: string) => {
  if (slug === current.value?.slug) {
    open.value = false
    return
  }
  await api.switchOrganization(slug)
  const suffix = route.path.includes('/o/') ? route.path.split('/').slice(3).join('/') : 'overview'
  open.value = false
  await navigateTo(`/o/${slug}/${suffix || 'overview'}`)
}
</script>

<template>
  <div class="relative">
    <button
      class="flex w-full items-center gap-3 rounded-xl border border-white/8 bg-white/[.025] p-2.5 text-left hover:border-emerald-300/20"
      :aria-expanded="open"
      aria-haspopup="listbox"
      aria-controls="organization-switcher-list"
      :disabled="!current"
      @click="open = !open"
    >
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-xs font-bold text-emerald-300"
        >{{ current?.name.slice(0, 2).toUpperCase() }}</span
      >
      <span class="min-w-0 flex-1"
        ><span class="block truncate text-sm font-medium">{{ current?.name }}</span
        ><span class="block text-[11px] text-[#718c84]">{{ current?.role }}</span></span
      >
      <UIcon name="i-lucide-chevrons-up-down" class="size-4 text-[#718c84]" />
    </button>
    <div
      v-if="open"
      id="organization-switcher-list"
      class="panel absolute left-0 top-[calc(100%+.5rem)] z-50 w-72 p-2 shadow-2xl"
      role="listbox"
      @keydown.esc="open = false"
    >
      <input
        v-model="query"
        class="native-input mb-2 text-sm"
        placeholder="Find an organization…"
        aria-label="Find an organization"
      />
      <button
        v-for="organization in organizations"
        :key="organization.id"
        class="flex w-full items-center gap-3 rounded-lg p-2.5 text-left hover:bg-white/5 disabled:opacity-45"
        :disabled="organization.status === 'suspended'"
        role="option"
        :aria-selected="organization.slug === current?.slug"
        @click="switchTo(organization.slug)"
      >
        <span class="grid size-8 place-items-center rounded-lg bg-white/5 text-[11px] font-bold">{{
          organization.name.slice(0, 2).toUpperCase()
        }}</span>
        <span class="min-w-0 flex-1"
          ><span class="block truncate text-sm">{{ organization.name }}</span
          ><span class="text-[11px] text-[#718c84]">{{ organization.role }}</span></span
        ><StatusBadge v-if="organization.status === 'suspended'" status="suspended" />
      </button>
      <p v-if="!organizations.length" class="p-3 text-xs text-[#718c84]">
        No matching organizations.
      </p>
      <NuxtLink
        to="/setup/organization?additional=true"
        class="mt-1 flex items-center gap-2 rounded-lg border-t border-white/8 p-2.5 text-sm text-emerald-300 hover:bg-white/5"
        @click="open = false"
        ><UIcon name="i-lucide-plus" /> Create organization</NuxtLink
      >
    </div>
  </div>
</template>
