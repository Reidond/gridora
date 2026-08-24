<script setup lang="ts">
import {
  commercialReviewRecoveryFor,
  useGridoraApi,
  type ServerPlanResponse,
} from '~/services/gridora-api'
import {
  buildServerApplyRequest,
  describeReviewedBillingTerms,
  pluginSupports,
  requiresCommercialOfferReview,
} from '~/services/server-apply'

useSeoMeta({ title: 'Deploy server' })

const data = useOrganizationData()
const api = useGridoraApi()
const mutations = useGridoraMutations()
const step = ref(0)
const labels = ['Game', 'Placement', 'Configuration', 'Review']
const placementModes = [
  { id: 'auto' as const, label: 'Auto placement', detail: 'Best compatible ready capacity' },
  { id: 'shared' as const, label: 'Shared node', detail: 'Compatible shared capacity only' },
  {
    id: 'dedicated' as const,
    label: 'Dedicated node',
    detail: 'Isolated capacity when policy permits',
  },
]
const form = reactive<{
  name: string
  pluginId: string
  placementMode: 'auto' | 'shared' | 'dedicated'
  cpuCores: number
  memoryMiB: number
  diskGiB: number
  domain: string
  configJson: string
  modsJson: string
  nonHourlyCommitmentConfirmed: boolean
}>({
  name: '',
  pluginId: '',
  placementMode: 'auto',
  cpuCores: 2,
  memoryMiB: 4096,
  diskGiB: 40,
  domain: '',
  configJson: '{}',
  modsJson: '[]',
  nonHourlyCommitmentConfirmed: false,
})
const plan = ref<ServerPlanResponse | null>(null)
const previewError = ref('')
const deployError = ref('')
const draftBusy = ref(false)
const scheduleFor = ref('')
const draftMessage = ref('')

const selectedPlugin = computed(() =>
  data.plugins.value.find((plugin) => plugin.id === form.pluginId),
)
const supportsMods = computed(() => pluginSupports(selectedPlugin.value, 'mods'))
const requiresCommercialConsent = computed(() => requiresCommercialOfferReview(plan.value))

watchEffect(() => {
  if (!form.pluginId && data.plugins.value[0]) form.pluginId = data.plugins.value[0].id
  if (!supportsMods.value) form.modsJson = '[]'
})

const requestForForm = (commercialReviewToken?: string) =>
  buildServerApplyRequest({
    name: form.name,
    pluginId: form.pluginId,
    placementMode: form.placementMode,
    cpuCores: form.cpuCores,
    memoryMiB: form.memoryMiB,
    diskGiB: form.diskGiB,
    domain: form.domain,
    configJson: form.configJson,
    modsJson: form.modsJson,
    includeMods: supportsMods.value,
    nonHourlyCommitmentConfirmed: form.nonHourlyCommitmentConfirmed,
    ...(commercialReviewToken === undefined ? {} : { commercialReviewToken }),
  })

const review = async () => {
  previewError.value = ''
  deployError.value = ''
  try {
    const request = requestForForm()
    if (data.isDemo.value) plan.value = null
    else {
      const slug = data.organization.value?.slug
      if (!slug) throw new Error('An active organization is required to plan a deployment.')
      plan.value = await api.planServer(slug, request.server)
    }
    step.value = labels.length - 1
  } catch (cause) {
    previewError.value =
      cause instanceof Error ? cause.message : 'The deployment request could not be planned.'
  }
}

const next = async () => {
  if (step.value < labels.length - 2) step.value++
  else await review()
}

const deploy = async () => {
  deployError.value = ''
  try {
    if (requiresCommercialConsent.value && !form.nonHourlyCommitmentConfirmed)
      throw new Error(
        'Confirm the reviewed provider billing implication before submitting this plan.',
      )
    const commercialReviewToken =
      plan.value?.kind === 'provision-node' && plan.value.commercialConsentRequired
        ? plan.value.commercialReviewToken
        : undefined
    if (
      plan.value?.kind === 'provision-node' &&
      plan.value.commercialConsentRequired &&
      commercialReviewToken === undefined
    )
      throw new Error('Review the current commercial provider offer before submitting this plan.')
    const result = await mutations.createServer.mutateAsync(requestForForm(commercialReviewToken))
    await navigateTo(`/o/${data.organization.value?.slug}/operations/${result.operation.id}`)
  } catch (cause) {
    const recovery = commercialReviewRecoveryFor(cause)
    if (recovery !== undefined) {
      // The token cannot be reused. Return to the declarative configuration
      // step so the next explicit user action produces a fresh preview rather
      // than silently resubmitting a newly selected commercial offer.
      if (recovery.discardReviewedPlan) plan.value = null
      if (recovery.resetCommercialAcknowledgement) form.nonHourlyCommitmentConfirmed = false
      step.value = labels.length - 2
      deployError.value =
        'The provider offer changed. Review the current terms before submitting another deployment request.'
      return
    }
    deployError.value =
      cause instanceof Error ? cause.message : 'The deployment request could not be accepted.'
  }
}

const manifestForForm = () => {
  const request = requestForForm()
  const slug = data.organization.value?.slug
  const pluginVersion = selectedPlugin.value?.version
  if (!slug || !pluginVersion)
    throw new Error('An active organization and reviewed plugin version are required.')
  return {
    apiVersion: 'games.gridora.example/v1alpha1' as const,
    kind: 'GameServer' as const,
    metadata: { name: request.game.name, organization: slug },
    spec: {
      plugin: { id: request.game.pluginId, version: pluginVersion },
      placement: { mode: form.placementMode },
      resources: request.server.resources,
      billing: { nonHourlyCommitmentConfirmed: form.nonHourlyCommitmentConfirmed },
      endpoint: form.domain.trim().length === 0 ? {} : { domain: form.domain.trim().toLowerCase() },
      config: request.game.config,
      mods: request.game.mods,
    },
  }
}

const saveDraft = async (schedule: boolean) => {
  draftBusy.value = true
  deployError.value = ''
  draftMessage.value = ''
  try {
    const slug = data.organization.value?.slug
    if (!slug) throw new Error('An active organization is required.')
    const manifest = manifestForForm()
    await api.validateGameServerManifest(slug, manifest)
    const created = await api.createGameServerDraft(slug, manifest)
    if (schedule) {
      if (scheduleFor.value.length === 0) throw new Error('Choose a future schedule time.')
      const scheduledFor = new Date(scheduleFor.value).toISOString()
      await api.scheduleGameServerDraft(slug, created.draft.id, {
        expectedRevision: created.draft.revision,
        scheduledFor,
      })
      draftMessage.value = `Draft ${created.draft.id} is scheduled for ${new Date(scheduledFor).toLocaleString()}.`
    } else draftMessage.value = `Draft ${created.draft.id} was saved without starting a deployment.`
  } catch (cause) {
    deployError.value = cause instanceof Error ? cause.message : 'The draft could not be saved.'
  } finally {
    draftBusy.value = false
  }
}

const formatMinor = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100)
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6">
    <PageHeader
      title="Deploy game server"
      description="Describe a reviewed plugin workload. Gridora plans capacity before accepting a durable deployment operation."
      eyebrow="Create wizard"
    />
    <div class="flex overflow-x-auto rounded-xl border border-white/8 bg-white/[.02] p-1">
      <button
        v-for="(label, index) in labels"
        :key="label"
        class="flex min-w-32 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-medium"
        :class="
          step === index
            ? 'bg-emerald-400/10 text-emerald-200'
            : index < step
              ? 'text-[#a6bbb4]'
              : 'text-[#567168]'
        "
        :disabled="index > step"
        @click="step = index"
      >
        <span
          class="grid size-5 place-items-center rounded-full border text-[10px]"
          :class="index < step ? 'border-emerald-400/30 bg-emerald-400/10' : 'border-current'"
          >{{ index < step ? '✓' : index + 1 }}</span
        >{{ label }}
      </button>
    </div>
    <div class="grid gap-5 lg:grid-cols-[1fr_300px]">
      <form
        class="panel min-h-[470px] p-5 sm:p-7"
        @submit.prevent="step === labels.length - 1 ? deploy() : next()"
      >
        <div v-if="step === 0" class="space-y-5">
          <div>
            <p class="section-title">Choose a reviewed plugin</p>
            <p class="page-copy">
              Plugin IDs and capabilities come from the control plane. The console does not select
              an image, provider account, or game-specific configuration fields.
            </p>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label
              v-for="plugin in data.plugins.value"
              :key="plugin.id"
              class="panel-hover cursor-pointer rounded-xl border p-4"
              :class="
                form.pluginId === plugin.id
                  ? 'border-emerald-400/40 bg-emerald-400/[.055]'
                  : 'border-white/10'
              "
            >
              <input v-model="form.pluginId" type="radio" :value="plugin.id" class="sr-only" />
              <div class="flex justify-between gap-2">
                <span class="font-medium">{{ plugin.name }}</span>
                <StatusBadge :status="plugin.enabled ? 'active' : 'disabled'" />
              </div>
              <p class="muted mt-2 text-xs">{{ plugin.id }} · v{{ plugin.version }}</p>
              <div class="mt-3 flex flex-wrap gap-1">
                <span
                  v-for="capability in plugin.capabilities.slice(0, 4)"
                  :key="capability"
                  class="rounded bg-white/5 px-1.5 py-1 text-[10px] text-[#93aaa3]"
                  >{{ capability }}</span
                >
              </div>
            </label>
          </div>
          <div>
            <label class="field-label">Server name</label>
            <input v-model="form.name" required class="native-input" placeholder="Vernon Valley" />
          </div>
        </div>

        <div v-else-if="step === 1" class="space-y-5">
          <div>
            <p class="section-title">Placement and capacity</p>
            <p class="page-copy">
              The scheduler selects only organization-owned ready capacity. If none fits, the plan
              names the policy-admitted infrastructure and billing consequence before it is
              accepted.
            </p>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <label
              v-for="mode in placementModes"
              :key="mode.id"
              class="cursor-pointer rounded-xl border p-4"
              :class="
                form.placementMode === mode.id
                  ? 'border-emerald-400/40 bg-emerald-400/[.055]'
                  : 'border-white/10'
              "
            >
              <input v-model="form.placementMode" type="radio" :value="mode.id" class="sr-only" />
              <p class="text-sm font-medium">{{ mode.label }}</p>
              <p class="muted mt-1 text-xs">{{ mode.detail }}</p>
            </label>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="field-label">CPU cores</label>
              <input
                v-model.number="form.cpuCores"
                type="number"
                min="1"
                step="1"
                class="native-input"
              />
            </div>
            <div>
              <label class="field-label">Memory (MiB)</label>
              <input
                v-model.number="form.memoryMiB"
                type="number"
                min="128"
                step="1"
                class="native-input"
              />
            </div>
            <div>
              <label class="field-label">Disk (GiB)</label>
              <input
                v-model.number="form.diskGiB"
                type="number"
                min="1"
                step="1"
                class="native-input"
              />
            </div>
          </div>
        </div>

        <div v-else-if="step === 2" class="space-y-5">
          <div>
            <p class="section-title">Plugin contract</p>
            <p class="page-copy">
              Configuration is an object for the selected plugin's reviewed schema. The control
              plane performs plugin validation before it reserves game-server capacity.
            </p>
          </div>
          <div>
            <label class="field-label">Plugin configuration (JSON object)</label>
            <textarea
              v-model="form.configJson"
              class="native-textarea min-h-36 font-mono text-xs"
              spellcheck="false"
            />
          </div>
          <div v-if="supportsMods">
            <label class="field-label">Desired mods (JSON array)</label>
            <textarea
              v-model="form.modsJson"
              class="native-textarea min-h-32 font-mono text-xs"
              spellcheck="false"
              placeholder='[{"source":"workshop","id":"12345","loadOrder":0}]'
            />
            <p class="muted mt-1 text-xs">
              Each entry has source, id, optional requestedVersion, and loadOrder.
            </p>
          </div>
          <p
            v-else
            class="rounded-xl border border-white/10 bg-white/[.025] p-4 text-sm text-[#93aaa3]"
          >
            {{ selectedPlugin?.name ?? 'This plugin' }} does not advertise mod support, so no mod
            references will be sent.
          </p>
          <div>
            <label class="field-label">Requested domain (optional)</label>
            <input v-model="form.domain" class="native-input" placeholder="server.example.com" />
          </div>
        </div>

        <div v-else class="space-y-5">
          <div>
            <p class="section-title">Review deployment plan</p>
            <p class="page-copy">
              This review reflects the latest authoritative plan, not a client-selected provider or
              node.
            </p>
          </div>
          <div
            class="grid gap-px overflow-hidden rounded-xl border border-white/8 bg-white/8 sm:grid-cols-2"
          >
            <div
              v-for="item in [
                ['Plugin', selectedPlugin?.name ?? form.pluginId],
                ['Server', form.name],
                ['Placement', form.placementMode],
                ['Resources', `${form.cpuCores} CPU · ${form.memoryMiB} MiB · ${form.diskGiB} GiB`],
                [
                  'Mods',
                  supportsMods
                    ? 'Plugin-capable desired mod set'
                    : 'Not supported by selected plugin',
                ],
                ['Domain', form.domain || 'No domain requested'],
              ]"
              :key="item[0]"
              class="bg-[#0b1814] p-3"
            >
              <p class="text-[10px] uppercase tracking-wider text-[#5f7b72]">{{ item[0] }}</p>
              <p class="mt-1 text-sm text-[#cad9d5]">{{ item[1] }}</p>
            </div>
          </div>
          <div
            v-if="plan?.kind === 'existing-node'"
            class="rounded-xl border border-emerald-300/15 bg-emerald-300/[.035] p-4 text-sm"
          >
            <p class="font-semibold text-emerald-100">Existing ready capacity selected</p>
            <p class="muted mt-1">{{ plan.explanation }}</p>
            <p class="mt-2 text-xs text-[#93aaa3]">
              Node {{ plan.nodeId }} · {{ plan.placementMode }} placement · no new paid
              infrastructure.
            </p>
          </div>
          <div
            v-else-if="plan?.kind === 'provision-node'"
            class="rounded-xl border border-amber-300/20 bg-amber-300/[.04] p-4 text-sm text-amber-100"
          >
            <p class="font-semibold">New paid infrastructure is required</p>
            <p class="mt-1 text-xs opacity-85">{{ plan.explanation }}</p>
            <dl class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt class="opacity-70">Provider / region / plan</dt>
                <dd>
                  {{ plan.selectedInfrastructure.providerType }} ·
                  {{ plan.selectedInfrastructure.region }} · {{ plan.selectedInfrastructure.plan }}
                </dd>
              </div>
              <div>
                <dt class="opacity-70">Projected monthly increase</dt>
                <dd>
                  {{
                    formatMinor(plan.billing.estimatedMonthlyIncreaseMinor, plan.billing.currency)
                  }}
                </dd>
              </div>
              <div>
                <dt class="opacity-70">Billing terms</dt>
                <dd>{{ describeReviewedBillingTerms(plan.billing) }}</dd>
              </div>
              <div>
                <dt class="opacity-70">DNS</dt>
                <dd>{{ plan.implications.dns }}</dd>
              </div>
              <div>
                <dt class="opacity-70">Mods and backups</dt>
                <dd>{{ plan.implications.mods }} {{ plan.implications.backups }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="opacity-70">Downtime and billing</dt>
                <dd>{{ plan.implications.downtime }} {{ plan.implications.billing }}</dd>
              </div>
            </dl>
            <label
              v-if="requiresCommercialConsent"
              class="mt-4 flex items-start gap-3 rounded-lg border border-amber-200/20 bg-black/10 p-3 text-xs text-amber-50"
            >
              <input
                v-model="form.nonHourlyCommitmentConfirmed"
                type="checkbox"
                class="mt-0.5 accent-emerald-400"
              />
              <span>
                I confirm the reviewed
                {{ describeReviewedBillingTerms(plan.billing).toLowerCase() }} for
                {{ plan.selectedInfrastructure.providerType }}
                {{ plan.selectedInfrastructure.region }}/{{ plan.selectedInfrastructure.plan }}. If
                these terms change, Gridora requires a new review before it can submit the
                deployment.
              </span>
            </label>
            <p v-else-if="plan.billing.billingCadence === 'hourly'" class="mt-4 text-xs opacity-85">
              This plan has hourly billing, so no non-hourly commitment acknowledgement is required.
            </p>
            <p v-else class="mt-4 text-xs opacity-85">
              {{ describeReviewedBillingTerms(plan.billing) }}. Organization policy does not require
              a separate commercial acknowledgement for this offer.
            </p>
          </div>
          <div
            v-else
            class="rounded-xl border border-white/10 bg-white/[.025] p-4 text-sm text-[#93aaa3]"
          >
            Demo mode has no provider or capacity preflight. It does not present an invented price
            or allocation.
          </div>
        </div>

        <p
          v-if="previewError || deployError"
          class="mt-5 rounded-lg bg-red-400/8 p-3 text-sm text-red-200"
          role="alert"
        >
          {{ previewError || deployError }}
        </p>
        <p
          v-if="draftMessage"
          class="mt-5 rounded-lg bg-emerald-400/8 p-3 text-sm text-emerald-200"
          role="status"
        >
          {{ draftMessage }}
        </p>
        <div
          v-if="step === labels.length - 1"
          class="mt-5 rounded-xl border border-white/10 bg-white/[.02] p-4"
        >
          <p class="text-sm font-medium">Draft or schedule</p>
          <p class="muted mt-1 text-xs">
            Validation and draft persistence do not reserve capacity or contact a provider.
          </p>
          <div class="mt-3 flex flex-wrap items-end gap-2">
            <UButton type="button" variant="outline" :loading="draftBusy" @click="saveDraft(false)"
              >Save draft</UButton
            >
            <label class="min-w-56 flex-1">
              <span class="field-label">One-shot deployment time</span>
              <input v-model="scheduleFor" type="datetime-local" class="native-input" />
            </label>
            <UButton
              type="button"
              variant="outline"
              :loading="draftBusy"
              :disabled="!scheduleFor"
              @click="saveDraft(true)"
              >Schedule</UButton
            >
          </div>
        </div>
        <div class="mt-8 flex justify-between">
          <UButton type="button" variant="ghost" :disabled="step === 0" @click="step--"
            >Back</UButton
          >
          <UButton
            type="submit"
            :loading="mutations.createServer.isPending.value"
            :disabled="
              (step === 0 && (!form.name || !form.pluginId)) ||
              (step === labels.length - 1 &&
                requiresCommercialConsent &&
                !form.nonHourlyCommitmentConfirmed)
            "
            :icon="step === labels.length - 1 ? 'i-lucide-rocket' : 'i-lucide-arrow-right'"
            >{{ step === labels.length - 1 ? 'Submit deployment request' : 'Continue' }}</UButton
          >
        </div>
      </form>
      <aside class="panel h-fit p-5">
        <p class="eyebrow">Declarative request</p>
        <dl class="mt-4 space-y-3 text-sm">
          <div class="flex justify-between gap-3">
            <dt class="muted">Plugin</dt>
            <dd>{{ form.pluginId || 'Choose plugin' }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="muted">Placement</dt>
            <dd class="capitalize">{{ form.placementMode }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="muted">Resources</dt>
            <dd>{{ form.cpuCores }}c / {{ form.memoryMiB }} MiB</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="muted">Plan</dt>
            <dd>
              {{
                plan
                  ? plan.kind === 'provision-node'
                    ? 'New capacity'
                    : 'Existing capacity'
                  : data.isDemo.value
                    ? 'Demo only'
                    : 'Not reviewed'
              }}
            </dd>
          </div>
        </dl>
        <div class="mt-5 border-t border-white/8 pt-4">
          <p class="flex items-center gap-2 text-xs text-emerald-200">
            <UIcon name="i-lucide-shield-check" /> Organization boundary enforced
          </p>
          <p class="muted mt-2 text-[11px] leading-relaxed">
            Only {{ data.organization.value?.name }} policy, capacity, and plugin catalog facts can
            satisfy this request.
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
