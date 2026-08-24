<script setup lang="ts">
defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
const route = useRoute()
const current = useCurrentOrganization()
const data = useOrganizationData()
const activeOperations = computed(
  () =>
    data.operations.value.filter((operation) =>
      ['queued', 'running', 'waiting'].includes(operation.status),
    ).length,
)
const links = [
  ['Overview', 'overview', 'i-lucide-layout-dashboard'],
  ['Game Servers', 'servers', 'i-lucide-gamepad-2'],
  ['Nodes', 'nodes', 'i-lucide-server'],
  ['Operations', 'operations', 'i-lucide-activity'],
  ['Plugins', 'plugins', 'i-lucide-blocks'],
  ['Backups', 'backups', 'i-lucide-archive'],
  ['Providers', 'providers', 'i-lucide-cloud'],
  ['Node Images', 'images', 'i-lucide-layers-3'],
]
const adminLinks = [
  ['Members', 'members', 'i-lucide-users'],
  ['Invitations', 'invitations', 'i-lucide-mail-plus'],
  ['Audit', 'audit', 'i-lucide-scroll-text'],
  ['Organization Settings', 'settings', 'i-lucide-settings'],
]
const href = (path: string) => `/o/${current.value?.slug}/${path}`
const active = (path: string) =>
  route.path === href(path) || (path !== 'overview' && route.path.startsWith(`${href(path)}/`))
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-30 bg-black/60 lg:hidden" @click="$emit('close')" />
  <aside
    class="fixed inset-y-0 left-0 z-40 flex w-[268px] flex-col border-r border-white/[.07] bg-[#08130f] p-4 transition-transform lg:visible lg:translate-x-0"
    :class="open ? 'visible translate-x-0' : 'invisible -translate-x-full'"
  >
    <div class="flex h-11 items-center justify-between px-1">
      <BrandMark /><button class="lg:hidden" aria-label="Close navigation" @click="$emit('close')">
        <UIcon name="i-lucide-x" />
      </button>
    </div>
    <div class="mt-4"><OrganizationSwitcher /></div>
    <nav v-if="current" class="mt-5 flex-1 overflow-y-auto" aria-label="Organization navigation">
      <p class="px-3 pb-2 text-[10px] font-bold uppercase tracking-[.12em] text-[#567168]">
        Workspace
      </p>
      <NuxtLink
        v-for="link in links"
        :key="link[1]"
        :to="href(link[1]!)"
        class="mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition"
        :class="
          active(link[1]!)
            ? 'bg-emerald-400/10 text-emerald-200'
            : 'text-[#8da59e] hover:bg-white/[.035] hover:text-white'
        "
        @click="$emit('close')"
        ><UIcon :name="link[2]!" class="size-4" />{{ link[0]
        }}<span
          v-if="link[1] === 'operations'"
          class="ml-auto rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300"
          >{{ activeOperations }}</span
        ></NuxtLink
      >
      <p class="mt-6 px-3 pb-2 text-[10px] font-bold uppercase tracking-[.12em] text-[#567168]">
        Organization
      </p>
      <NuxtLink
        v-for="link in adminLinks"
        :key="link[1]"
        :to="href(link[1]!)"
        class="mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition"
        :class="
          active(link[1]!)
            ? 'bg-emerald-400/10 text-emerald-200'
            : 'text-[#8da59e] hover:bg-white/[.035] hover:text-white'
        "
        @click="$emit('close')"
        ><UIcon :name="link[2]!" class="size-4" />{{ link[0] }}</NuxtLink
      >
    </nav>
    <div class="rounded-xl border border-amber-300/10 bg-amber-300/[.035] p-3">
      <div class="flex items-center gap-2 text-xs font-semibold text-amber-200">
        <UIcon name="i-lucide-shield-check" /> Secure control plane
      </div>
      <p class="mt-1 text-[10px] leading-relaxed text-[#7f968f]">
        The API verifies identity and organization role on every control-plane request.
      </p>
    </div>
  </aside>
</template>
