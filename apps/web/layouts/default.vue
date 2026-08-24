<script setup lang="ts">
const sidebarOpen = ref(false)
const state = useGridoraState()
const data = useOrganizationData()
const realtimeState = useOrganizationRealtime(
  computed(() => (data.isDemo.value ? undefined : data.organization.value)),
)
const realtimeLabel = computed(
  () =>
    ({
      disabled: data.isDemo.value ? 'Demo data' : 'Realtime off',
      connecting: 'Realtime connecting',
      connected: 'Realtime connected',
      reconnecting: 'Realtime reconnecting',
      denied: 'Realtime access denied',
    })[realtimeState.value],
)
const activeOperations = computed(
  () =>
    data.operations.value.filter((operation) =>
      ['queued', 'running', 'waiting'].includes(operation.status),
    ).length,
)
</script>

<template>
  <div class="gridora-shell">
    <AppSidebar :open="sidebarOpen" @close="sidebarOpen = false" />
    <div class="min-h-screen lg:pl-[268px]">
      <header
        class="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/[.07] bg-[#07110f]/90 px-4 backdrop-blur-xl sm:px-6 lg:px-8"
      >
        <button
          class="grid size-9 place-items-center rounded-lg border border-white/10 lg:hidden"
          aria-label="Open navigation"
          @click="sidebarOpen = true"
        >
          <UIcon name="i-lucide-menu" />
        </button>
        <div class="flex-1" />
        <div class="ml-auto flex items-center gap-2">
          <div
            class="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-xs text-[#a9beb8]"
            role="status"
            :aria-label="realtimeLabel"
            :title="realtimeLabel"
          >
            <span
              class="status-dot"
              :class="
                realtimeState === 'connected'
                  ? 'bg-emerald-300'
                  : realtimeState === 'denied'
                    ? 'bg-red-300'
                    : realtimeState === 'disabled'
                      ? 'bg-slate-400'
                      : 'animate-pulse bg-amber-300'
              "
            />
            <span class="hidden md:inline">{{ realtimeLabel }}</span>
          </div>
          <NuxtLink
            :to="`/o/${data.organization.value?.slug}/operations`"
            :aria-label="
              activeOperations ? `${activeOperations} active operations` : 'No active operations'
            "
            class="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-xs text-[#a9beb8] hover:bg-white/5"
            ><span v-if="activeOperations" class="status-dot animate-pulse bg-amber-300" /><UIcon
              v-else
              name="i-lucide-activity"
            />
            <span class="hidden sm:inline">{{
              activeOperations ? `${activeOperations} active` : 'No active operations'
            }}</span></NuxtLink
          >
          <NuxtLink
            :to="`/o/${data.organization.value?.slug}/profile`"
            class="grid size-9 place-items-center rounded-full bg-emerald-400/12 text-xs font-bold text-emerald-200"
            :title="state.currentUser.email"
            :aria-label="`Signed in as ${state.currentUser.name}`"
            role="link"
          >
            {{
              state.currentUser.name
                .split(' ')
                .map((part) => part[0])
                .join('')
            }}
          </NuxtLink>
        </div>
      </header>
      <main class="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-8">
        <div
          v-if="state.session.mode === 'demo'"
          class="mb-5 flex items-center gap-2 rounded-lg border border-sky-300/15 bg-sky-300/[.04] px-3 py-2 text-xs text-sky-100"
        >
          <UIcon name="i-lucide-flask-conical" /> Demo data mode — no provider or control-plane
          changes are sent.
        </div>
        <div
          v-if="data.capabilityUnavailable.value.length"
          class="mb-5 rounded-lg border border-amber-300/15 bg-amber-300/[.04] px-3 py-2 text-xs text-amber-100"
        >
          <div class="flex gap-2">
            <UIcon name="i-lucide-construction" class="mt-0.5 shrink-0" />
            <p>
              <strong>Control-plane capability unavailable:</strong>
              {{ data.capabilityUnavailable.value.join(', ') }}. Empty panels below are not a live
              zero-resource result.
            </p>
          </div>
        </div>
        <div
          v-if="state.session.error || data.error.value"
          class="panel mb-5 border-red-300/15 p-4"
        >
          <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p class="text-sm font-semibold text-red-100">Unable to load organization data</p>
              <p class="mt-1 text-xs text-[#9e8d8d]">
                {{ state.session.error || data.error.value }}
              </p>
            </div>
            <UButton variant="outline" size="sm" @click="data.refresh">Retry</UButton>
          </div>
        </div>
        <div
          v-if="data.isLoading.value"
          class="mb-5 flex items-center gap-2 text-xs text-[#8ea9a1]"
          role="status"
        >
          <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Loading authorized
          organization resources…
        </div>
        <slot />
      </main>
    </div>
  </div>
</template>
