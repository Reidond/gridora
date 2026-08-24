<script setup lang="ts">
import { GridoraApiError } from '~/services/gridora-api'
import type { Member, Role } from '~/types/gridora'
useSeoMeta({ title: 'Members' })
const data = useOrganizationData()
const mutations = useGridoraMutations()
const state = useGridoraState()
const roles: Role[] = ['Administrator', 'Operator', 'Viewer']
const canEdit = computed(() => data.organization.value && canManage(data.organization.value.role))
const canTransfer = computed(() => data.organization.value?.role === 'Owner')
const removal = ref<Member | null>(null)
const transferTarget = ref('')
const error = ref('')
const failureMessage = (cause: unknown): string =>
  cause instanceof GridoraApiError && cause.status === 409
    ? 'The membership changed. Gridora refreshed the list. Review it and try again.'
    : cause instanceof Error
      ? cause.message
      : 'The membership action failed.'
const updateRole = async (member: Member, event: Event) => {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  error.value = ''
  try {
    await mutations.updateMemberRole(member, target.value as Role)
  } catch (cause) {
    error.value = failureMessage(cause)
  }
}
const removeMember = async () => {
  if (removal.value === null) return
  error.value = ''
  try {
    await mutations.removeMember(removal.value)
    removal.value = null
  } catch (cause) {
    error.value = failureMessage(cause)
  }
}
const transferOwnership = async () => {
  if (!transferTarget.value) return
  error.value = ''
  try {
    await mutations.transferOwnership(transferTarget.value)
    transferTarget.value = ''
  } catch (cause) {
    error.value = failureMessage(cause)
  }
}
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Members"
      description="Organization roles, join source, ownership safety, and immediate access revocation."
      ><template #actions
        ><UButton :to="`/o/${data.organization.value?.slug}/invitations`" icon="i-lucide-mail-plus"
          >Invite member</UButton
        ></template
      ></PageHeader
    >
    <CapabilityState :status="data.capabilityStatus('members').value" title="Member inventory" />
    <div
      v-if="data.capabilityStatus('members').value === 'available'"
      class="panel overflow-x-auto"
    >
      <table class="data-table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Join source</th>
            <th>Joined</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in data.members.value" :key="member.id">
            <td>
              <p class="font-medium text-white">{{ member.name }}</p>
              <p class="mt-1 text-xs text-[#718c84]">{{ member.email }}</p>
            </td>
            <td>
              <select
                :value="member.role"
                class="native-select w-auto py-1.5 text-xs"
                :disabled="!canEdit || member.id === state.currentUser.id"
                @change="updateRole(member, $event)"
              >
                <option v-if="member.role === 'Owner'">Owner</option>
                <option v-for="role in roles" :key="role">{{ role }}</option>
              </select>
            </td>
            <td>{{ member.source }}</td>
            <td>{{ member.joinedAt }}</td>
            <td><StatusBadge :status="member.status" /></td>
            <td>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                :disabled="!canEdit || member.id === state.currentUser.id"
                @click="removal = member"
                >Remove</UButton
              >
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-if="!data.members.value.length"
        title="No members returned"
        description="The organization membership inventory is empty."
        icon="i-lucide-users"
      />
    </div>
    <p v-if="error" class="rounded-lg bg-red-400/8 p-3 text-sm text-red-200">{{ error }}</p>
    <div v-if="removal" class="panel border-red-300/15 p-4">
      <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <p class="text-sm text-red-100">
          Remove {{ removal.name }}? Active organization sessions and owned automation credentials
          will be revoked.
        </p>
        <div class="flex gap-2">
          <UButton variant="ghost" @click="removal = null">Cancel</UButton
          ><UButton color="error" @click="removeMember">Remove member</UButton>
        </div>
      </div>
    </div>
    <div class="panel p-5">
      <h2 class="section-title">Ownership protection</h2>
      <p class="muted mt-2 max-w-3xl text-xs leading-relaxed">
        The final Owner cannot leave, be removed, or be demoted. Ownership transfer and membership
        changes are atomic and audited. Only Owners can delete the organization.
      </p>
      <div v-if="canTransfer" class="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row">
        <select v-model="transferTarget" class="native-select">
          <option value="">Select the new Owner</option>
          <option
            v-for="member in data.members.value.filter(
              (candidate) => candidate.id !== state.currentUser.id && candidate.status === 'active',
            )"
            :key="member.id"
            :value="member.id"
          >
            {{ member.name }} · {{ member.role }}
          </option>
        </select>
        <UButton
          variant="outline"
          icon="i-lucide-arrow-left-right"
          :disabled="!transferTarget"
          @click="transferOwnership"
          >Transfer ownership</UButton
        >
      </div>
    </div>
  </div>
</template>
