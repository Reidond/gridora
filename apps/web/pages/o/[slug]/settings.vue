<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import { useGridoraApi } from '~/services/gridora-api'

useSeoMeta({ title: 'Organization settings' })
const data = useOrganizationData()
const state = useGridoraState()
const organizationMutations = useGridoraMutations()
const api = useGridoraApi()
const route = useRoute()
const organizationSlug = computed(() => String(route.params.slug ?? ''))
const saved = ref(false)
const policySaved = ref(false)
const policyError = ref('')
const confirm = ref('')
const leaveConfirm = ref('')
const leaveError = ref('')
const leaving = ref(false)
const deleting = ref(false)
const deleteError = ref('')
const currentMembership = computed(() =>
  data.members.value.find((member) => member.id === state.value.currentUser.id),
)
const deleteOrganization = async () => {
  const organization = data.organization.value
  if (!organization || confirm.value !== organization.slug || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    const accepted = await api.deleteOrganization(
      organization.slug,
      organization.revision ?? 1,
      confirm.value,
      'retain',
    )
    await navigateTo(`/o/${organization.slug}/operations/${accepted.operation.id}`)
  } catch (cause) {
    deleteError.value =
      cause instanceof Error ? cause.message : 'Organization deletion could not be accepted.'
  } finally {
    deleting.value = false
  }
}
const form = reactive({
  name: data.organization.value?.name,
  slug: data.organization.value?.slug,
  timezone: data.organization.value?.timezone,
  region: data.organization.value?.region,
  budget: data.organization.value?.budgetWarning,
  maxNodes: 8,
  autoProvision: true,
  retention: 30,
})
const policyForm = reactive({
  providers: '',
  regions: '',
  plans: '',
  maxActiveNodes: 0,
  maxDedicatedNodes: 0,
  maxServersPerNode: 0,
  cpuMillis: 0,
  ramBytes: 0,
  diskBytes: 0,
  currency: '',
  softBudget: 0,
  hardBudget: 0,
  explicitCommitmentConfirmation: true,
})
const policyQuery = useQuery({
  queryKey: computed(() => ['organization', organizationSlug.value, 'policy']),
  enabled: computed(() => !data.isDemo.value && Boolean(organizationSlug.value)),
  queryFn: () => api.organizationPolicy(organizationSlug.value),
})
watch(
  () => policyQuery.data.value,
  (policy) => {
    if (!policy) return
    policyForm.providers = policy.allowedProviders.join(', ')
    policyForm.regions = policy.allowedRegions.join(', ')
    policyForm.plans = policy.allowedPlans.join(', ')
    policyForm.maxActiveNodes = policy.capacity.maxActiveNodes
    policyForm.maxDedicatedNodes = policy.capacity.maxDedicatedNodes
    policyForm.maxServersPerNode = policy.capacity.maxServersPerNode
    policyForm.cpuMillis = policy.capacity.maxDeploymentCpuMillis
    policyForm.ramBytes = policy.capacity.maxDeploymentRamBytes
    policyForm.diskBytes = policy.capacity.maxDeploymentDiskBytes
    policyForm.currency = policy.monthlyBudget.currency ?? ''
    policyForm.softBudget = policy.monthlyBudget.softLimitMinor / 100
    policyForm.hardBudget = policy.monthlyBudget.hardLimitMinor / 100
    policyForm.explicitCommitmentConfirmation =
      policy.nonHourlyCommitment.explicitConfirmationRequired
  },
  { immediate: true },
)
const splitList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
const canEditOperationalPolicy = computed(() =>
  ['Owner', 'Administrator'].includes(data.organization.value?.role ?? ''),
)
const canEditBudgetPolicy = computed(() => data.organization.value?.role === 'Owner')
const policyMutation = useMutation({
  mutationFn: async () => {
    const current = policyQuery.data.value
    if (!current) throw new Error('Organization policy is not loaded')
    const updated = {
      ...current,
      revision: current.revision + 1,
      allowedProviders: splitList(policyForm.providers),
      allowedRegions: splitList(policyForm.regions),
      allowedPlans: splitList(policyForm.plans),
      capacity: {
        maxActiveNodes: policyForm.maxActiveNodes,
        maxDedicatedNodes: policyForm.maxDedicatedNodes,
        maxServersPerNode: policyForm.maxServersPerNode,
        maxDeploymentCpuMillis: policyForm.cpuMillis,
        maxDeploymentRamBytes: policyForm.ramBytes,
        maxDeploymentDiskBytes: policyForm.diskBytes,
      },
      ...(canEditBudgetPolicy.value
        ? {
            monthlyBudget: {
              ...current.monthlyBudget,
              currency: policyForm.currency || null,
              softLimitMinor: Math.round(policyForm.softBudget * 100),
              hardLimitMinor: Math.round(policyForm.hardBudget * 100),
            },
            nonHourlyCommitment: {
              explicitConfirmationRequired: policyForm.explicitCommitmentConfirmation,
            },
          }
        : {}),
    }
    return api.updateOrganizationPolicy(organizationSlug.value, updated)
  },
  onSuccess: async () => {
    policySaved.value = true
    policyError.value = ''
    await policyQuery.refetch()
  },
  onError: (error) => {
    policySaved.value = false
    policyError.value = error instanceof Error ? error.message : 'Unable to update policy'
  },
})
const saveProfile = async () => {
  const organization = data.organization.value
  if (!organization) return
  if (data.isDemo.value) {
    saved.value = true
    return
  }
  const updated = await api.updateOrganizationProfile(organizationSlug.value, {
    name: form.name ?? organization.name,
    timezone: form.timezone ?? organization.timezone,
    defaultRegion: form.region ?? organization.region,
    expectedRevision: organization.revision ?? 1,
  })
  form.name = updated.name
  form.timezone = updated.timezone
  form.region = updated.defaultRegion
  organization.name = updated.name
  organization.timezone = updated.timezone
  organization.region = updated.defaultRegion
  organization.revision = updated.revision
  saved.value = true
}
const leaveOrganization = async () => {
  if (currentMembership.value === undefined) return
  leaving.value = true
  leaveError.value = ''
  try {
    await organizationMutations.leaveOrganization(currentMembership.value.revision)
  } catch (error) {
    leaveError.value =
      error instanceof Error
        ? error.message
        : 'Gridora could not remove your organization membership.'
  } finally {
    leaving.value = false
  }
}
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Organization settings"
      description="Profile, placement policy, budget guardrails, retention, and durable deletion controls."
    />
    <div
      v-if="!data.isDemo.value"
      class="rounded-lg border border-amber-300/15 bg-amber-300/[.04] p-3 text-xs text-amber-100"
    >
      Profile changes are available to Administrators. Policy changes are available to
      Administrators; budget and commitment changes require an Owner.
    </div>
    <div class="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div class="space-y-5">
        <form class="panel p-5 sm:p-6" @submit.prevent="saveProfile">
          <h2 class="section-title">Organization profile</h2>
          <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label class="field-label">Display name</label
              ><input v-model="form.name" class="native-input" />
            </div>
            <div>
              <label class="field-label">Slug</label
              ><input v-model="form.slug" class="native-input" disabled />
            </div>
            <div>
              <label class="field-label">Timezone</label
              ><input v-model="form.timezone" class="native-input" />
            </div>
            <div>
              <label class="field-label">Default region</label
              ><input v-model="form.region" class="native-input" />
            </div>
          </div>
          <div class="mt-5 flex items-center gap-3">
            <UButton type="submit">Save profile</UButton
            ><span v-if="saved" class="text-xs text-emerald-300"
              >Saved with a new profile revision.</span
            >
          </div>
        </form>
        <form class="panel p-5 sm:p-6" @submit.prevent="policyMutation.mutate()">
          <h2 class="section-title">Policies and quotas</h2>
          <p v-if="policyQuery.isLoading.value" class="muted mt-3 text-xs">Loading policy…</p>
          <p v-if="policyQuery.error.value" class="mt-3 text-xs text-red-200">
            {{
              policyQuery.error.value instanceof Error
                ? policyQuery.error.value.message
                : 'Policy unavailable'
            }}
          </p>
          <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label class="field-label">Allowed providers (comma-separated)</label>
              <input
                v-model="policyForm.providers"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Allowed regions</label>
              <input
                v-model="policyForm.regions"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Allowed plans</label>
              <input
                v-model="policyForm.plans"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Maximum active nodes</label
              ><input
                v-model.number="policyForm.maxActiveNodes"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Maximum dedicated nodes</label
              ><input
                v-model.number="policyForm.maxDedicatedNodes"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Maximum servers per node</label
              ><input
                v-model.number="policyForm.maxServersPerNode"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Deployment CPU (millicores)</label
              ><input
                v-model.number="policyForm.cpuMillis"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Deployment RAM (bytes)</label
              ><input
                v-model.number="policyForm.ramBytes"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Deployment disk (bytes)</label
              ><input
                v-model.number="policyForm.diskBytes"
                type="number"
                min="0"
                class="native-input"
                :disabled="!canEditOperationalPolicy"
              />
            </div>
            <div>
              <label class="field-label">Budget currency</label
              ><input
                v-model="policyForm.currency"
                maxlength="3"
                class="native-input uppercase"
                :disabled="!canEditBudgetPolicy"
              />
            </div>
            <div>
              <label class="field-label">Soft monthly budget</label
              ><input
                v-model.number="policyForm.softBudget"
                type="number"
                min="0"
                step="0.01"
                class="native-input"
                :disabled="!canEditBudgetPolicy"
              />
            </div>
            <div>
              <label class="field-label">Hard monthly budget</label
              ><input
                v-model.number="policyForm.hardBudget"
                type="number"
                min="0"
                step="0.01"
                class="native-input"
                :disabled="!canEditBudgetPolicy"
              />
            </div>
            <label
              class="flex items-center gap-3 self-end rounded-lg border border-white/8 p-3 text-sm"
              ><input
                v-model="policyForm.explicitCommitmentConfirmation"
                type="checkbox"
                class="accent-emerald-400"
                :disabled="!canEditBudgetPolicy"
              />Require confirmation for non-hourly commitments</label
            >
          </div>
          <div class="mt-5 flex items-center gap-3">
            <UButton
              type="submit"
              variant="outline"
              :loading="policyMutation.isPending.value"
              :disabled="!canEditOperationalPolicy || !policyQuery.data.value"
              >Update policy</UButton
            >
            <span v-if="policySaved" class="text-xs text-emerald-300">Policy revision saved.</span>
            <span v-if="policyError" class="text-xs text-red-200">{{ policyError }}</span>
          </div>
        </form>
      </div>
      <aside class="space-y-5">
        <section class="panel p-5">
          <h2 class="section-title">Organization</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div class="flex justify-between">
              <dt class="muted">Status</dt>
              <dd><StatusBadge :status="data.organization.value?.status ?? 'unknown'" /></dd>
            </div>
            <div class="flex justify-between">
              <dt class="muted">Your role</dt>
              <dd>{{ data.organization.value?.role }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="muted">Policy revision</dt>
              <dd>
                {{
                  policyQuery.data.value
                    ? `rev_${policyQuery.data.value.revision}`
                    : data.isDemo.value
                      ? 'rev_18'
                      : 'Unavailable'
                }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="muted">Resources</dt>
              <dd>{{ data.servers.value.length }} servers · {{ data.nodes.value.length }} nodes</dd>
            </div>
          </dl>
        </section>
        <section class="panel border-red-300/15 p-5">
          <h2 class="section-title text-amber-100">Leave organization</h2>
          <p class="muted mt-2 text-xs leading-relaxed">
            This removes only your membership. The final Owner must transfer ownership or add
            another Owner before leaving.
          </p>
          <p v-if="!currentMembership" class="mt-3 text-xs text-amber-100">
            Your current membership revision is unavailable. Refresh the workspace before leaving.
          </p>
          <input
            v-model="leaveConfirm"
            class="native-input mt-4 text-sm"
            :placeholder="`Type ${data.organization.value?.slug}`"
          />
          <UButton
            color="warning"
            variant="soft"
            class="mt-3 w-full justify-center"
            :loading="leaving"
            :disabled="
              currentMembership === undefined ||
              leaveConfirm !== data.organization.value?.slug ||
              leaving
            "
            @click="leaveOrganization"
            >Leave organization</UButton
          >
          <p v-if="leaveError" class="mt-3 text-xs text-red-200">{{ leaveError }}</p>
        </section>
        <section class="panel border-red-300/15 p-5">
          <h2 class="section-title text-red-200">Delete organization</h2>
          <p class="muted mt-2 text-xs leading-relaxed">
            Deletion creates a durable cleanup operation. Paid resources, backups, domains,
            credentials, and ownership must be resolved first.
          </p>
          <div class="mt-4 rounded-lg bg-red-400/[.035] p-3 text-xs text-red-100">
            Inventory: {{ data.nodes.value.length }} paid nodes,
            {{ data.servers.value.length }} deployments, {{ data.backups.value.length }} retained
            backups.
          </div>
          <input
            v-model="confirm"
            class="native-input mt-4 text-sm"
            :placeholder="`Type ${data.organization.value?.slug}`"
          /><UButton
            color="error"
            variant="soft"
            class="mt-3 w-full justify-center"
            :loading="deleting"
            :disabled="confirm !== data.organization.value?.slug || deleting"
            @click="deleteOrganization"
            >Begin cleanup operation</UButton
          >
          <p v-if="deleteError" class="mt-3 text-xs text-red-200">{{ deleteError }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>
