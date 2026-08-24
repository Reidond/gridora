<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { GridoraApiError } from '~/services/gridora-api'
import { useGridoraApi } from '~/services/gridora-api'
import type { Invitation } from '~/types/gridora'
useSeoMeta({ title: 'Invitations' })
const data = useOrganizationData()
const mutations = useGridoraMutations()
const state = useGridoraState()
const api = useGridoraApi()
const canInvite = computed(() =>
  Boolean(data.organization.value && canManage(data.organization.value.role)),
)
const remediationQuery = useQuery({
  queryKey: computed(() => [
    'organization',
    data.organization.value?.slug,
    'notification-remediation',
  ]),
  enabled: computed(
    () =>
      state.value.session.mode === 'api' &&
      canInvite.value &&
      Boolean(data.organization.value?.slug),
  ),
  queryFn: () => api.notificationRemediation(data.organization.value!.slug),
  retry: false,
})
const remediationError = computed(() =>
  remediationQuery.error.value instanceof GridoraApiError &&
  remediationQuery.error.value.status === 403
    ? ''
    : remediationQuery.error.value instanceof Error
      ? remediationQuery.error.value.message
      : '',
)
const remediationStatus = computed<'available' | 'forbidden'>(() => {
  if (!canInvite.value) return 'forbidden'
  if (remediationQuery.error.value instanceof GridoraApiError) {
    if (remediationQuery.error.value.status === 403) return 'forbidden'
  }
  return 'available'
})
const remediationRecords = computed(() => remediationQuery.data.value ?? [])
const form = reactive({ email: '', role: 'Operator' as 'Administrator' | 'Operator' | 'Viewer' })
const error = ref('')
const invite = async () => {
  if (!form.email) return
  error.value = ''
  try {
    await mutations.invite.mutateAsync(form)
    form.email = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The invitation could not be created.'
  }
}
const revoke = async (invitation: Invitation) => {
  error.value = ''
  try {
    await mutations.revokeInvitation(invitation)
  } catch (cause) {
    error.value =
      cause instanceof GridoraApiError && cause.status === 409
        ? 'The invitation changed. Gridora refreshed the list. Review it and try again.'
        : cause instanceof Error
          ? cause.message
          : 'The invitation could not be revoked.'
  }
}
const resend = async (invitation: Invitation) => {
  error.value = ''
  try {
    await mutations.resendInvitation(invitation)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The invitation could not be resent.'
  }
}
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Invitations"
      description="Time-limited, single-purpose invitations scoped to one organization and proposed role."
    />
    <p v-if="error" class="rounded-lg bg-red-400/8 p-3 text-sm text-red-200">{{ error }}</p>
    <div
      v-if="!data.isDemo.value"
      class="rounded-lg border border-amber-300/15 bg-amber-300/[.04] p-3 text-xs text-amber-100"
    >
      A pending invitation does not prove email delivery. Permanent delivery failures can appear in
      the read-only remediation inventory below.
    </div>
    <CapabilityState
      :status="data.capabilityStatus('invitations').value"
      title="Invitation inventory"
    />
    <div class="grid gap-5 xl:grid-cols-[360px_1fr]">
      <form
        v-if="data.capabilityStatus('invitations').value === 'available'"
        class="panel h-fit p-5"
        @submit.prevent="invite"
      >
        <h2 class="section-title">Invite a teammate</h2>
        <p class="page-copy">The authenticated email must match before acceptance.</p>
        <div class="mt-5">
          <label class="field-label">Email address</label
          ><input
            v-model="form.email"
            type="email"
            required
            class="native-input"
            placeholder="ops@example.com"
          />
        </div>
        <div class="mt-4">
          <label class="field-label">Role</label
          ><select v-model="form.role" class="native-select">
            <option>Administrator</option>
            <option>Operator</option>
            <option>Viewer</option>
          </select>
        </div>
        <div class="mt-4 rounded-lg bg-white/[.025] p-3 text-xs text-[#8ea9a1]">
          <strong class="text-[#c9d8d4]">{{ form.role }}</strong>
          <p class="mt-1">
            {{
              form.role === 'Administrator'
                ? 'Can manage infrastructure and members, but not ownership or deletion.'
                : form.role === 'Operator'
                  ? 'Can deploy and operate resources within policy.'
                  : 'Read-only access to organization resources.'
            }}
          </p>
        </div>
        <UButton
          type="submit"
          class="mt-5 w-full justify-center"
          :loading="mutations.invite.isPending.value"
          :disabled="!canInvite"
          >{{ data.isDemo.value ? 'Send invitation' : 'Create invitation' }}</UButton
        >
        <p v-if="!canInvite" class="muted mt-3 text-xs">Your role cannot create invitations.</p>
      </form>
      <div
        v-if="data.capabilityStatus('invitations').value === 'available'"
        class="panel overflow-x-auto"
      >
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invited by</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="invitation in data.invitations.value" :key="invitation.id">
              <td class="font-medium text-white">{{ invitation.email }}</td>
              <td>{{ invitation.role }}</td>
              <td><StatusBadge :status="invitation.status" /></td>
              <td>{{ invitation.invitedBy }}</td>
              <td>{{ invitation.expiresAt }}</td>
              <td>
                <div class="flex gap-1">
                  <UButton
                    v-if="invitation.status === 'pending'"
                    size="xs"
                    variant="ghost"
                    :disabled="!canInvite"
                    @click="resend(invitation)"
                    >Resend</UButton
                  >
                  <UButton
                    v-if="invitation.status === 'pending'"
                    size="xs"
                    color="error"
                    variant="ghost"
                    :disabled="!canInvite"
                    @click="revoke(invitation)"
                    >Revoke</UButton
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState
          v-if="!data.invitations.value.length"
          title="No invitations yet"
          description="Create an invitation to propose organization membership."
          icon="i-lucide-mail-plus"
        />
      </div>
    </div>
    <section class="panel overflow-hidden">
      <div
        class="flex flex-col justify-between gap-3 border-b border-white/8 p-5 sm:flex-row sm:items-start"
      >
        <div>
          <p class="eyebrow">Read-only</p>
          <h2 class="section-title mt-2">Invitation delivery remediation</h2>
          <p class="page-copy max-w-3xl">
            These token-free records report permanent invitation-email failures. This view does not
            resend email or reissue invitations. Review a record, then use the normal invitation
            workflow separately if a replacement is appropriate.
          </p>
        </div>
        <StatusBadge status="read only" />
      </div>
      <div
        v-if="data.isLoading.value || remediationQuery.isLoading.value"
        class="flex items-center gap-2 p-5 text-sm text-[#8ea9a1]"
        role="status"
      >
        <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Loading remediation records…
      </div>
      <CapabilityState
        v-else-if="remediationStatus !== 'available'"
        :status="remediationStatus"
        title="Delivery remediation"
      />
      <div v-else-if="remediationError" class="p-5">
        <p class="text-sm font-semibold text-red-100">Unable to load remediation records</p>
        <p class="mt-1 text-xs text-[#9e8d8d]">{{ remediationError }}</p>
        <UButton class="mt-3" size="sm" variant="outline" @click="remediationQuery.refetch()">
          Retry
        </UButton>
      </div>
      <div v-else-if="remediationRecords.length" class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Failure event</th>
              <th>Invitation</th>
              <th>Failure code</th>
              <th>Recorded</th>
              <th>Suggested response</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in remediationRecords" :key="record.eventId">
              <td>
                <code class="text-xs text-emerald-200">{{ record.eventId }}</code>
              </td>
              <td>
                <code class="text-xs text-[#a9beb8]">{{ record.invitationId }}</code>
              </td>
              <td>{{ record.code }}</td>
              <td>{{ new Date(record.eventCreatedAt).toLocaleString() }}</td>
              <td>Review before you create a replacement invitation</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState
        v-else
        title="No permanent delivery failures"
        :description="
          data.isDemo.value
            ? 'Demo mode contains no remediation records.'
            : 'The API returned no permanent invitation-email failure records for this organization.'
        "
        icon="i-lucide-mail-check"
      />
    </section>
  </div>
</template>
