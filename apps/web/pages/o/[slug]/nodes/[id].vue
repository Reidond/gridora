<script setup lang="ts">
import { GridoraApiError, useGridoraApi } from '~/services/gridora-api'

const route = useRoute()
const data = useOrganizationData()
const api = useGridoraApi()
const node = computed(() => data.nodes.value.find((item) => item.id === route.params.id))
useSeoMeta({ title: () => node.value?.name ?? 'Node' })
const confirm = ref('')
const pendingAction = ref<string | null>(null)
const actionError = ref('')
const force = ref(false)
const backupPolicy = ref<'required' | 'skip-authorized'>('required')
const targetImageId = ref('')
const nodeRevision = computed(() => node.value?.revision)
const apiActionsAvailable = computed(() => !data.isDemo.value && nodeRevision.value !== undefined)
const actionUnavailableMessage = computed(() =>
  data.isDemo.value
    ? 'Node lifecycle controls are available against an authorized API workspace.'
    : nodeRevision.value === undefined
      ? 'The node inventory did not return its desired-state revision. Refresh before changing it.'
      : '',
)
const capacity = computed(() =>
  node.value
    ? [
        { label: 'CPU', value: node.value.cpu },
        { label: 'Memory', value: node.value.memory },
        { label: 'Disk', value: node.value.disk },
      ].filter((item): item is { label: string; value: number } => item.value !== undefined)
    : [],
)
const facts = computed(() =>
  node.value
    ? [
        { label: 'Ownership', value: data.organization.value?.name },
        { label: 'Public address', value: node.value.publicAddress ?? 'Not reported' },
        { label: 'Image', value: node.value.image },
        { label: 'Last reconciled', value: node.value.lastReconciledAt ?? 'Not reported' },
        { label: 'Reconciliation error', value: node.value.reconciliationError ?? 'None reported' },
      ]
    : [],
)
const deployments = computed(() =>
  data.servers.value.filter((item) => item.nodeId === node.value?.id),
)
const resolvedTargetImageId = computed(() => targetImageId.value || node.value?.image || '')
const execute = async (label: string, operation: () => Promise<unknown>) => {
  pendingAction.value = label
  actionError.value = ''
  try {
    await operation()
    await data.refresh()
    if (label === 'retire') confirm.value = ''
  } catch (error) {
    if (error instanceof GridoraApiError && error.status === 409) await data.refresh()
    actionError.value =
      error instanceof Error ? error.message : 'The node action could not be accepted.'
  } finally {
    pendingAction.value = null
  }
}
const runRuntimeAction = (action: 'start' | 'stop' | 'reboot' | 'reconcile') => {
  const current = node.value
  if (!current || current.revision === undefined) return
  void execute(`runtime-${action}`, () =>
    api.nodeRuntimeAction(
      data.organization.value?.slug ?? '',
      current.id,
      action,
      current.revision!,
    ),
  )
}
const runLifecycleAction = (action: 'drain' | 'uncordon' | 'rebuild' | 'retire') => {
  const current = node.value
  if (!current || current.revision === undefined) return
  const imageId = action === 'rebuild' ? resolvedTargetImageId.value : undefined
  if (action === 'rebuild' && !imageId) {
    actionError.value = 'Select the promoted node image to use for this rebuild.'
    return
  }
  void execute(action, () =>
    api.nodeLifecycleAction(data.organization.value?.slug ?? '', current.id, action, {
      expectedNodeRevision: current.revision!,
      force: force.value,
      backupPolicy: backupPolicy.value,
      ...(imageId === undefined ? {} : { targetImageId: imageId }),
    }),
  )
}
</script>

<template>
  <div v-if="node" class="space-y-6">
    <PageHeader
      :title="node.name"
      :description="`${node.provider} · ${node.region} · ${node.plan}`"
      eyebrow="VPS node"
    >
      <template #actions
        ><UButton
          variant="outline"
          icon="i-lucide-git-pull-request-draft"
          :disabled="!apiActionsAvailable || pendingAction !== null || node.status === 'draining'"
          :title="actionUnavailableMessage || undefined"
          @click="runLifecycleAction('drain')"
          >Enter drain</UButton
        ><UButton
          color="error"
          variant="soft"
          icon="i-lucide-power"
          :disabled="!apiActionsAvailable || pendingAction !== null"
          :title="actionUnavailableMessage || undefined"
          @click="confirm = ''"
          >Retire</UButton
        ></template
      >
    </PageHeader>
    <p
      v-if="actionError"
      class="rounded-lg border border-red-300/25 bg-red-400/10 px-4 py-3 text-sm text-red-100"
    >
      {{ actionError }}
    </p>
    <p
      v-else-if="actionUnavailableMessage"
      class="rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100"
    >
      {{ actionUnavailableMessage }}
    </p>
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Node health"
        :value="node.status"
        :detail="`Observed health: ${node.health}`"
        icon="i-lucide-heart-pulse"
      />
      <MetricCard
        label="Agent"
        :value="node.agentVersion ?? '—'"
        detail="Agent telemetry is not in the node inventory contract"
        icon="i-lucide-radio-tower"
      />
      <MetricCard
        label="Tunnel"
        :value="node.tunnel ?? '—'"
        detail="Tunnel telemetry is not in the node inventory contract"
        icon="i-lucide-network"
      />
      <MetricCard
        label="Estimate"
        :value="node.costMonthly === undefined ? '—' : `${formatCurrency(node.costMonthly)}/mo`"
        detail="Pricing is shown only when reported"
        icon="i-lucide-wallet"
      />
    </div>
    <div class="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
      <section class="panel p-5">
        <h2 class="section-title">Capacity</h2>
        <div v-for="item in capacity" :key="item.label" class="mt-5">
          <div class="mb-2 flex justify-between text-sm">
            <span class="muted">{{ item.label }}</span
            ><span>{{ item.value }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${item.value}%` }" />
          </div>
        </div>
        <p v-if="!capacity.length" class="muted mt-4 text-sm">
          CPU, memory, and disk utilization are not in the current node inventory contract.
        </p>
        <h3 class="mt-7 text-sm font-semibold">Deployments</h3>
        <div class="mt-3 space-y-2">
          <NuxtLink
            v-for="server in deployments"
            :key="server.id"
            :to="`/o/${data.organization.value?.slug}/servers/${server.id}`"
            class="flex items-center justify-between rounded-lg border border-white/8 p-3 text-sm hover:border-emerald-300/20"
            ><span>{{ server.name }}</span
            ><StatusBadge :status="server.status"
          /></NuxtLink>
        </div>
        <p v-if="!deployments.length" class="muted mt-3 text-sm">
          No game servers report placement on this node.
        </p>
      </section>
      <aside class="space-y-5">
        <section class="panel p-5">
          <h2 class="section-title">Provider facts</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div v-for="item in facts" :key="item.label" class="flex justify-between gap-4">
              <dt class="muted">{{ item.label }}</dt>
              <dd class="text-right">{{ item.value }}</dd>
            </div>
          </dl>
        </section>
        <section class="panel p-5">
          <h2 class="section-title">Runtime control</h2>
          <p class="muted mt-2 text-xs leading-relaxed">
            Each action uses the current desired-state revision and preserves its idempotency key if
            the browser loses the response.
          </p>
          <div class="mt-4 grid grid-cols-2 gap-2">
            <UButton
              variant="outline"
              :disabled="!apiActionsAvailable || pendingAction !== null"
              @click="runRuntimeAction('start')"
              >Start</UButton
            ><UButton
              variant="outline"
              :disabled="!apiActionsAvailable || pendingAction !== null"
              @click="runRuntimeAction('stop')"
              >Stop</UButton
            ><UButton
              variant="outline"
              :disabled="!apiActionsAvailable || pendingAction !== null"
              @click="runRuntimeAction('reboot')"
              >Reboot</UButton
            ><UButton
              variant="outline"
              :disabled="!apiActionsAvailable || pendingAction !== null"
              @click="runRuntimeAction('reconcile')"
              >Reconcile</UButton
            >
          </div>
        </section>
        <section class="panel p-5">
          <h2 class="section-title">Lifecycle control</h2>
          <div class="mt-4 grid grid-cols-2 gap-2">
            <UButton
              variant="outline"
              :disabled="
                !apiActionsAvailable || pendingAction !== null || node.status === 'draining'
              "
              @click="runLifecycleAction('drain')"
              >Drain</UButton
            ><UButton
              variant="outline"
              :disabled="
                !apiActionsAvailable || pendingAction !== null || node.status !== 'draining'
              "
              @click="runLifecycleAction('uncordon')"
              >Uncordon</UButton
            >
          </div>
          <label class="muted mt-4 flex items-center gap-2 text-xs">
            <input v-model="force" type="checkbox" />
            Force after the server-side safety policy has been evaluated.
          </label>
          <label class="muted mt-3 block text-xs">
            Backup policy
            <select v-model="backupPolicy" class="native-input mt-1 w-full text-sm">
              <option value="required">Require backup</option>
              <option value="skip-authorized">Skip only when authorized</option>
            </select>
          </label>
          <label class="muted mt-3 block text-xs">
            Rebuild image
            <select v-model="targetImageId" class="native-input mt-1 w-full text-sm">
              <option value="">Current image ({{ node.image }})</option>
              <option v-for="image in data.images.value" :key="image.id" :value="image.id">
                {{ image.id }} · {{ image.status }}
              </option>
            </select>
          </label>
          <UButton
            class="mt-3 w-full justify-center"
            variant="outline"
            :disabled="!apiActionsAvailable || pendingAction !== null"
            @click="runLifecycleAction('rebuild')"
            >Rebuild node</UButton
          >
        </section>
        <section class="panel border-amber-300/12 p-5">
          <h2 class="section-title text-amber-100">Retirement safety</h2>
          <p class="muted mt-2 text-xs leading-relaxed">
            Drain migrates deployments first. Provider deletion and contract cancellation are
            tracked independently. Active backups and DNS impact are shown before confirmation.
          </p>
          <p class="mt-3 text-xs text-amber-100">
            Type the node identifier to acknowledge retirement. The accepted operation is then
            refetched from authoritative inventory.
          </p>
          <input
            v-model="confirm"
            class="native-input mt-4 text-sm"
            :placeholder="`Type ${node.name}`"
          /><UButton
            color="error"
            variant="soft"
            class="mt-3 w-full justify-center"
            :disabled="!apiActionsAvailable || pendingAction !== null || confirm !== node.name"
            @click="runLifecycleAction('retire')"
            >Schedule retirement</UButton
          >
        </section>
      </aside>
    </div>
  </div>
  <EmptyState
    v-else-if="!data.isLoading.value"
    title="Node not found"
    description="The authorized node inventory does not contain this identifier."
    icon="i-lucide-server-off"
  />
</template>
