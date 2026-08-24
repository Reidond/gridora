<script setup lang="ts">
import {
  GridoraApiError,
  canConfirmProviderAccountRemoval,
  providerAccountActionPermissions,
  providerAccountErrorMessage,
  useGridoraApi,
  type CreateOrganizationProviderAccountInput,
  type ProviderAccountType,
  type ProviderAccountUiAction,
  type ProviderAccountViewModel,
  type ReplaceOrganizationProviderCredentialsInput,
} from '~/services/gridora-api'

useSeoMeta({ title: 'Providers' })
const data = useOrganizationData()
const api = useGridoraApi()
const route = useRoute()
const organizationSlug = computed(
  () => data.organization.value?.slug ?? String(route.params.slug ?? ''),
)
const role = computed(() => data.organization.value?.role)
const interactive = computed(
  () => !data.isDemo.value && data.capabilityStatus('providers').value === 'available',
)
const canCreate = computed(() => interactive.value && role.value === 'Owner')
const providers = computed(() => data.providers.value as ReadonlyArray<ProviderAccountViewModel>)

type CredentialMode = 'create' | 'replace'
const credentialMode = ref<CredentialMode>('create')
const credentialFormOpen = ref(false)
const credentialFormKey = ref(0)
const editingProvider = ref<ProviderAccountViewModel>()
const providerType = ref<ProviderAccountType>('ovhcloud')
const credentialFields = reactive({
  authUrl: '',
  region: '',
  projectId: '',
  applicationCredentialId: '',
  applicationCredentialSecret: '',
  tokenUrl: '',
  apiBaseUrl: '',
  clientId: '',
  clientSecret: '',
  apiUser: '',
  apiPassword: '',
})

const resetCredentialFields = () => {
  Object.assign(credentialFields, {
    authUrl: providerType.value === 'ovhcloud' ? 'https://auth.cloud.ovh.net/v3' : '',
    region: '',
    projectId: '',
    applicationCredentialId: '',
    applicationCredentialSecret: '',
    tokenUrl:
      providerType.value === 'contabo'
        ? 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token'
        : '',
    apiBaseUrl: providerType.value === 'contabo' ? 'https://api.contabo.com' : '',
    clientId: '',
    clientSecret: '',
    apiUser: '',
    apiPassword: '',
  })
  credentialFormKey.value += 1
}

watch(providerType, resetCredentialFields)
onBeforeUnmount(resetCredentialFields)

const openCreateForm = () => {
  if (!canCreate.value) return
  credentialMode.value = 'create'
  editingProvider.value = undefined
  providerType.value = 'ovhcloud'
  resetCredentialFields()
  credentialFormOpen.value = true
}

const permissionsFor = (provider: ProviderAccountViewModel) =>
  providerAccountActionPermissions(role.value, provider, interactive.value)

const openReplaceForm = (provider: ProviderAccountViewModel) => {
  if (!permissionsFor(provider).canReplaceCredentials) return
  credentialMode.value = 'replace'
  editingProvider.value = provider
  providerType.value = provider.providerType
  resetCredentialFields()
  credentialFormOpen.value = true
}

const closeCredentialForm = () => {
  resetCredentialFields()
  credentialFormOpen.value = false
  editingProvider.value = undefined
}

const createInput = (): CreateOrganizationProviderAccountInput =>
  providerType.value === 'ovhcloud'
    ? {
        providerType: 'ovhcloud',
        credentials: {
          authUrl: credentialFields.authUrl.trim(),
          region: credentialFields.region.trim(),
          projectId: credentialFields.projectId,
          applicationCredentialId: credentialFields.applicationCredentialId,
          applicationCredentialSecret: credentialFields.applicationCredentialSecret,
        },
      }
    : {
        providerType: 'contabo',
        credentials: {
          tokenUrl: credentialFields.tokenUrl.trim(),
          apiBaseUrl: credentialFields.apiBaseUrl.trim(),
          clientId: credentialFields.clientId,
          clientSecret: credentialFields.clientSecret,
          apiUser: credentialFields.apiUser,
          apiPassword: credentialFields.apiPassword,
        },
      }

const replacementInput = (
  provider: ProviderAccountViewModel,
): ReplaceOrganizationProviderCredentialsInput | undefined => {
  if (provider.revision === undefined || provider.credentialRevision === undefined) return undefined
  const input = createInput()
  return {
    ...input,
    expectedRevision: provider.revision,
    expectedCredentialRevision: provider.credentialRevision,
  }
}

const pendingAction = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const actionKey = (action: string, providerId = '') => `${action}:${providerId}`
const isPending = (action: string, providerId = '') =>
  pendingAction.value === actionKey(action, providerId)
const refreshWorkspace = async () => {
  await data.refresh()
}

const submitCredentials = async () => {
  const editing = editingProvider.value
  const action: ProviderAccountUiAction = editing ? 'replace credentials' : 'create'
  if (pendingAction.value) return
  pendingAction.value = actionKey(action, editing?.id)
  errorMessage.value = ''
  successMessage.value = ''
  let completed = false
  try {
    if (editing) {
      const input = replacementInput(editing)
      if (!input) {
        errorMessage.value =
          'Credential revisions are unavailable. Refresh the provider inventory before replacing credentials.'
        return
      }
      await api.updateProviderAccountCredentials(organizationSlug.value, editing.id, input)
      successMessage.value =
        'Credentials were replaced without displaying their stored value. Validate access before using the account.'
    } else {
      await api.createProviderAccount(organizationSlug.value, createInput())
      successMessage.value =
        'The organization account was added in a disabled state. Validate access to activate it.'
    }
    completed = true
  } catch (error) {
    errorMessage.value = providerAccountErrorMessage(error, action)
  } finally {
    resetCredentialFields()
    pendingAction.value = ''
  }
  if (completed) {
    credentialFormOpen.value = false
    editingProvider.value = undefined
    await refreshWorkspace()
  }
}

type LifecycleAction = 'test' | 'refresh' | 'disable' | 'remove'
const lifecycleLabel = (action: LifecycleAction): ProviderAccountUiAction =>
  action === 'test' ? 'validate access' : action === 'refresh' ? 'refresh metadata' : action

const lifecycleResultMessage = (result: {
  readonly outcome: string
  readonly regionCount: number
  readonly projectCount: number
  readonly catalogItemCount: number
}): string => {
  if (result.outcome === 'valid')
    return 'Provider access is valid and the organization account is active.'
  if (result.outcome === 'refreshed')
    return `Provider metadata was refreshed: ${result.regionCount} regions, ${result.projectCount} projects, and ${result.catalogItemCount} catalog entries were reported.`
  if (result.outcome === 'disabled')
    return 'The organization account is disabled. Validate access to re-enable it.'
  if (result.outcome === 'removed') return 'The organization account was removed.'
  if (result.outcome === 'retryable_failure')
    return 'The provider could not confirm access yet. Retry validation after the temporary failure clears.'
  return 'The provider rejected validation. Replace or correct the credentials, then validate again.'
}

const removalCandidate = ref('')
const removalConfirmation = ref('')
const cancelRemoval = () => {
  removalCandidate.value = ''
  removalConfirmation.value = ''
}

const runLifecycle = async (action: LifecycleAction, provider: ProviderAccountViewModel) => {
  if (provider.revision === undefined || pendingAction.value) return
  pendingAction.value = actionKey(action, provider.id)
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result =
      action === 'test'
        ? await api.testProviderAccount(organizationSlug.value, provider.id, provider.revision)
        : action === 'refresh'
          ? await api.refreshProviderAccount(organizationSlug.value, provider.id, provider.revision)
          : action === 'disable'
            ? await api.disableProviderAccount(
                organizationSlug.value,
                provider.id,
                provider.revision,
              )
            : await api.deleteProviderAccount(
                organizationSlug.value,
                provider.id,
                provider.revision,
              )
    successMessage.value = lifecycleResultMessage(result)
    if (action === 'remove') cancelRemoval()
    await refreshWorkspace()
  } catch (error) {
    errorMessage.value = providerAccountErrorMessage(error, lifecycleLabel(action))
    if (error instanceof GridoraApiError && error.status === 409) await refreshWorkspace()
  } finally {
    pendingAction.value = ''
  }
}

const beginRemoval = (provider: ProviderAccountViewModel) => {
  if (!permissionsFor(provider).canBeginRemove) return
  removalCandidate.value = provider.id
  removalConfirmation.value = ''
}
const confirmRemoval = (provider: ProviderAccountViewModel) => {
  if (
    canConfirmProviderAccountRemoval(
      role.value,
      provider,
      removalConfirmation.value,
      interactive.value,
    )
  )
    return runLifecycle('remove', provider)
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Provider capacity"
      description="Platform allocations and organization-owned provider accounts are shown separately. Stored credentials are never displayed."
    >
      <template #actions>
        <UButton type="button" icon="i-lucide-plus" :disabled="!canCreate" @click="openCreateForm">
          Add organization account
        </UButton>
      </template>
    </PageHeader>

    <p
      v-if="errorMessage"
      role="alert"
      class="rounded-lg border border-red-300/15 bg-red-400/8 p-3 text-sm text-red-100"
    >
      {{ errorMessage }}
    </p>
    <p
      v-if="successMessage"
      role="status"
      class="rounded-lg border border-emerald-300/15 bg-emerald-300/[.045] p-3 text-sm text-emerald-100"
    >
      {{ successMessage }}
    </p>
    <p
      v-if="data.isDemo.value"
      class="rounded-lg border border-amber-300/15 bg-amber-300/[.04] p-3 text-xs text-amber-100"
    >
      Demo provider records are read-only. Connect the API to manage organization accounts.
    </p>
    <p
      v-else-if="role !== 'Owner' && data.capabilityStatus('providers').value === 'available'"
      class="rounded-lg border border-white/8 bg-white/[.025] p-3 text-xs text-[#a8bcb6]"
    >
      {{
        role === 'Administrator'
          ? 'Administrators can validate and refresh organization accounts. Adding, replacing credentials, disabling, and removing require an Owner.'
          : 'Your organization role has read-only provider access.'
      }}
    </p>

    <CapabilityState :status="data.capabilityStatus('providers').value" title="Provider accounts" />

    <form
      v-if="credentialFormOpen"
      :key="credentialFormKey"
      class="panel p-5 sm:p-6"
      autocomplete="off"
      @submit.prevent="submitCredentials"
    >
      <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <p class="eyebrow">Organization-owned capacity</p>
          <h2 class="section-title mt-2">
            {{ credentialMode === 'create' ? 'Add provider account' : 'Replace credentials' }}
          </h2>
          <p class="page-copy max-w-3xl">
            Values are sent once to Gridora's encrypted credential envelope. The dashboard does not
            save, retrieve, or re-display them.
          </p>
        </div>
        <UButton type="button" variant="ghost" size="sm" @click="closeCredentialForm">
          Cancel
        </UButton>
      </div>

      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="provider-type">Provider</label>
          <select
            id="provider-type"
            v-model="providerType"
            class="native-select"
            :disabled="credentialMode === 'replace'"
          >
            <option value="ovhcloud">OVHcloud Public Cloud</option>
            <option value="contabo">Contabo</option>
          </select>
          <p v-if="credentialMode === 'replace'" class="muted mt-2 text-xs">
            Provider type is immutable. Add another account to change providers.
          </p>
        </div>
      </div>

      <div v-if="providerType === 'ovhcloud'" class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="ovh-auth-url">Identity endpoint</label>
          <input
            id="ovh-auth-url"
            v-model="credentialFields.authUrl"
            type="url"
            required
            minlength="8"
            maxlength="2048"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="ovh-region">Region</label>
          <input
            id="ovh-region"
            v-model="credentialFields.region"
            required
            maxlength="80"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
            placeholder="GRA11"
          />
        </div>
        <div>
          <label class="field-label" for="ovh-project-id">Project ID</label>
          <input
            id="ovh-project-id"
            v-model="credentialFields.projectId"
            required
            maxlength="4096"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="ovh-credential-id">Application credential ID</label>
          <input
            id="ovh-credential-id"
            v-model="credentialFields.applicationCredentialId"
            required
            maxlength="4096"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div class="sm:col-span-2">
          <label class="field-label" for="ovh-credential-secret">
            Application credential secret
          </label>
          <input
            id="ovh-credential-secret"
            v-model="credentialFields.applicationCredentialSecret"
            type="password"
            required
            maxlength="4096"
            autocomplete="new-password"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
      </div>

      <div v-else class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="contabo-token-url">Token endpoint</label>
          <input
            id="contabo-token-url"
            v-model="credentialFields.tokenUrl"
            type="url"
            required
            minlength="8"
            maxlength="2048"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="contabo-api-url">API endpoint</label>
          <input
            id="contabo-api-url"
            v-model="credentialFields.apiBaseUrl"
            type="url"
            required
            minlength="8"
            maxlength="2048"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="contabo-client-id">Client ID</label>
          <input
            id="contabo-client-id"
            v-model="credentialFields.clientId"
            required
            maxlength="4096"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="contabo-client-secret">Client secret</label>
          <input
            id="contabo-client-secret"
            v-model="credentialFields.clientSecret"
            type="password"
            required
            maxlength="4096"
            autocomplete="new-password"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="contabo-api-user">API user</label>
          <input
            id="contabo-api-user"
            v-model="credentialFields.apiUser"
            required
            maxlength="4096"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
        <div>
          <label class="field-label" for="contabo-api-password">API password</label>
          <input
            id="contabo-api-password"
            v-model="credentialFields.apiPassword"
            type="password"
            required
            maxlength="4096"
            autocomplete="new-password"
            autocapitalize="none"
            spellcheck="false"
            class="native-input"
          />
        </div>
      </div>

      <div class="mt-5 flex flex-wrap items-center gap-3">
        <UButton
          type="submit"
          :loading="
            isPending(
              credentialMode === 'create' ? 'create' : 'replace credentials',
              editingProvider?.id,
            )
          "
        >
          {{ credentialMode === 'create' ? 'Store account securely' : 'Replace credentials' }}
        </UButton>
        <p class="muted text-xs">
          Successful storage does not prove provider access; validate next.
        </p>
      </div>
    </form>

    <div
      v-if="data.capabilityStatus('providers').value === 'available'"
      class="grid gap-4 lg:grid-cols-2"
    >
      <article v-for="provider in providers" :key="provider.id" class="panel p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="eyebrow">{{ provider.source }}</p>
            <h2 class="mt-2 text-lg font-semibold">{{ provider.provider }}</h2>
            <code class="mt-1 block break-all text-xs text-[#8ea9a1]">{{ provider.id }}</code>
          </div>
          <StatusBadge :status="provider.status" />
        </div>

        <div v-if="provider.source === 'Platform allocation'" class="mt-5 space-y-4">
          <div>
            <p class="muted text-xs">Allowed regions (allocation policy)</p>
            <div v-if="provider.regions.length" class="mt-2 flex flex-wrap gap-2">
              <span
                v-for="region in provider.regions"
                :key="region"
                class="rounded-lg border border-white/8 px-2.5 py-1.5 text-xs text-[#a8bcb6]"
              >
                {{ region }}
              </span>
            </div>
            <p v-else class="muted mt-2 text-xs">Allocation regions are not reported.</p>
          </div>
          <div v-if="provider.allocation">
            <p class="muted text-xs">Allowed plans (allocation policy)</p>
            <div v-if="provider.allocation.allowedPlans.length" class="mt-2 flex flex-wrap gap-2">
              <span
                v-for="plan in provider.allocation.allowedPlans"
                :key="plan"
                class="rounded-lg border border-white/8 px-2.5 py-1.5 text-xs text-[#a8bcb6]"
              >
                {{ plan }}
              </span>
            </div>
            <p v-else class="muted mt-2 text-xs">No plan restriction was reported.</p>
          </div>
        </div>
        <p v-else class="muted mt-5 text-xs">
          Discovered regions are not exposed by the account inventory. Use metadata refresh to
          update the provider catalog without inventing availability here.
        </p>

        <dl class="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Active nodes</dt>
            <dd class="mt-1 font-semibold">{{ provider.nodes ?? 'Not reported' }}</dd>
          </div>
          <div class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Account updated</dt>
            <dd class="mt-1 font-semibold">
              {{ new Date(provider.refreshedAt).toLocaleString() }}
            </dd>
          </div>
          <div v-if="provider.allocation" class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Maximum active nodes</dt>
            <dd class="mt-1 font-semibold">{{ provider.allocation.maxActiveNodes }}</dd>
          </div>
          <div v-if="provider.revision" class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Account revision</dt>
            <dd class="mt-1 font-semibold">{{ provider.revision }}</dd>
          </div>
          <div v-if="provider.credentialRevision" class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Credential revision</dt>
            <dd class="mt-1 font-semibold">{{ provider.credentialRevision }}</dd>
          </div>
          <div v-if="provider.allocation" class="rounded-lg bg-white/[.025] p-3">
            <dt class="muted text-xs">Allocation revision</dt>
            <dd class="mt-1 font-semibold">{{ provider.allocation.revision }}</dd>
          </div>
        </dl>

        <div
          v-if="
            provider.allocation?.monthlyBudgetMinor !== null &&
            provider.allocation?.monthlyBudgetMinor !== undefined
          "
          class="mt-5 rounded-xl border border-amber-300/10 bg-amber-300/[.035] p-3"
        >
          <p class="flex gap-2 text-xs text-amber-100">
            <UIcon name="i-lucide-receipt-text" class="shrink-0" />
            Monthly budget cap: {{ provider.allocation.monthlyBudgetMinor }} minor currency units.
            The allocation inventory does not report a currency.
          </p>
        </div>

        <div
          v-if="provider.source === 'Platform allocation'"
          class="mt-5 rounded-lg bg-white/[.025] p-3"
        >
          <p class="text-xs text-[#a8bcb6]">
            Platform allocations are read-only here. Organization credential and lifecycle actions
            do not apply.
          </p>
        </div>
        <template v-else>
          <div class="mt-5 flex flex-wrap gap-2">
            <UButton
              type="button"
              variant="outline"
              size="sm"
              :loading="isPending('test', provider.id)"
              :disabled="!permissionsFor(provider).canTest"
              @click="runLifecycle('test', provider)"
            >
              {{ provider.status === 'disabled' ? 'Validate and enable' : 'Validate access' }}
            </UButton>
            <UButton
              type="button"
              variant="ghost"
              size="sm"
              :loading="isPending('refresh', provider.id)"
              :disabled="!permissionsFor(provider).canRefresh"
              @click="runLifecycle('refresh', provider)"
            >
              Refresh metadata
            </UButton>
            <UButton
              type="button"
              variant="ghost"
              size="sm"
              :disabled="!permissionsFor(provider).canReplaceCredentials"
              @click="openReplaceForm(provider)"
            >
              Replace credentials
            </UButton>
            <UButton
              v-if="role === 'Owner' && interactive"
              type="button"
              color="warning"
              variant="ghost"
              size="sm"
              :loading="isPending('disable', provider.id)"
              :disabled="!permissionsFor(provider).canDisable"
              @click="runLifecycle('disable', provider)"
            >
              Disable
            </UButton>
            <UButton
              v-if="role === 'Owner' && interactive"
              type="button"
              color="error"
              variant="ghost"
              size="sm"
              :disabled="!permissionsFor(provider).canBeginRemove"
              @click="beginRemoval(provider)"
            >
              Remove account
            </UButton>
          </div>
          <p v-if="role === 'Owner' && provider.status !== 'disabled'" class="muted mt-3 text-xs">
            Disable this account before removal. Disabling can be reversed by successful validation.
          </p>

          <form
            v-if="removalCandidate === provider.id"
            class="mt-5 rounded-xl border border-red-300/15 bg-red-400/[.035] p-4"
            @submit.prevent="confirmRemoval(provider)"
          >
            <p class="text-sm font-semibold text-red-100">Confirm account removal</p>
            <p class="mt-1 text-xs text-[#c9aaa8]">
              Gridora will refuse removal while allocations or nodes still reference this account.
              Type the exact account ID to continue.
            </p>
            <label class="field-label mt-4" :for="`remove-${provider.id}`">Account ID</label>
            <input
              :id="`remove-${provider.id}`"
              v-model="removalConfirmation"
              required
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              class="native-input"
            />
            <div class="mt-3 flex gap-2">
              <UButton
                type="submit"
                color="error"
                size="sm"
                :loading="isPending('remove', provider.id)"
                :disabled="
                  !canConfirmProviderAccountRemoval(
                    role,
                    provider,
                    removalConfirmation,
                    interactive,
                  )
                "
              >
                Permanently remove
              </UButton>
              <UButton type="button" variant="ghost" size="sm" @click="cancelRemoval">
                Cancel
              </UButton>
            </div>
          </form>
        </template>
      </article>
    </div>

    <EmptyState
      v-if="!providers.length && data.capabilityStatus('providers').value === 'available'"
      title="No provider capacity"
      description="Request a platform allocation or ask an Owner to add an organization account."
      icon="i-lucide-cloud-off"
    />
  </div>
</template>
