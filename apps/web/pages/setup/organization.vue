<script setup lang="ts">
import { GridoraApiError } from '~/services/gridora-api'
import { organizationSlugStatus } from '~/services/organization-setup'
definePageMeta({ layout: 'public' })
useSeoMeta({ title: 'Set up organization' })
const route = useRoute()
const mutations = useGridoraMutations()
const form = reactive({
  name: '',
  slug: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  region: 'eu-west',
  budgetWarning: 250,
  budgetCurrency: 'USD',
  invitations: '',
  terms: false,
})
const slugTouched = ref(false)
watch(
  () => form.name,
  (name) => {
    if (!slugTouched.value) form.slug = toSlug(name)
  },
)
const slugStatus = computed(() => organizationSlugStatus(form.slug))
const error = ref('')
const submit = async () => {
  error.value = ''
  if (
    !form.name ||
    !form.timezone.trim() ||
    !slugStatus.value.valid ||
    !form.terms ||
    !Number.isFinite(form.budgetWarning) ||
    form.budgetWarning < 0
  ) {
    error.value = 'Complete the required fields and use a valid organization slug.'
    return
  }
  try {
    const organization = await mutations.createOrganization.mutateAsync(form)
    await navigateTo(`/o/${organization.slug}/overview`)
  } catch (cause) {
    const ambiguous =
      !(cause instanceof GridoraApiError) ||
      cause.status === 0 ||
      cause.status >= 500 ||
      [408, 425, 429].includes(cause.status)
    error.value = ambiguous
      ? 'Gridora could not confirm the result. Retry this form. Gridora will use the same request key and will not create a duplicate organization.'
      : cause.message
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-xl">
    <p class="eyebrow">{{ route.query.additional ? 'New workspace' : 'One required step' }}</p>
    <h1 class="mt-3 text-3xl font-semibold tracking-[-.04em]">Set up your organization</h1>
    <p class="muted mt-3 text-sm leading-relaxed">
      This is your isolated workspace for servers, nodes, provider allocations, credentials, and
      audit. You become its Owner.
    </p>
    <form class="panel mt-7 space-y-5 p-5 sm:p-6" @submit.prevent="submit">
      <div>
        <label class="field-label" for="org-name">Organization name *</label
        ><input
          id="org-name"
          v-model="form.name"
          class="native-input"
          autocomplete="organization"
          placeholder="Night Watch"
        />
      </div>
      <div>
        <label class="field-label" for="org-slug">Organization slug *</label>
        <div class="flex">
          <span
            class="rounded-l-[.65rem] border border-r-0 border-white/15 bg-white/[.025] px-3 py-2.5 text-sm text-[#718c84]"
            >gridora.dev/o/</span
          ><input
            id="org-slug"
            v-model="form.slug"
            class="native-input rounded-l-none"
            placeholder="night-watch"
            @input="slugTouched = true"
          />
        </div>
        <p class="mt-1.5 text-xs" :class="slugStatus.valid ? 'text-emerald-300' : 'text-[#718c84]'">
          {{ slugStatus.message }}
        </p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="timezone">Timezone *</label
          ><input id="timezone" v-model="form.timezone" class="native-input" />
        </div>
        <div>
          <label class="field-label" for="region">Default region *</label
          ><select id="region" v-model="form.region" class="native-select">
            <option value="eu-west">Europe West</option>
            <option value="eu-central">Europe Central</option>
            <option value="us-east">US East</option>
            <option value="ca-east">Canada East</option>
          </select>
        </div>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="budget">Monthly budget warning</label>
          <div class="flex gap-2">
            <input
              id="budget"
              v-model.number="form.budgetWarning"
              min="0"
              step="0.01"
              type="number"
              class="native-input"
            />
            <select
              v-model="form.budgetCurrency"
              class="native-select w-28"
              aria-label="Budget currency"
            >
              <option>USD</option>
              <option>EUR</option>
              <option>GBP</option>
              <option>CAD</option>
            </select>
          </div>
        </div>
        <div>
          <label class="field-label" for="invites">Initial Viewer invitations</label
          ><input
            id="invites"
            v-model="form.invitations"
            class="native-input"
            placeholder="ops@example.com, observer@example.com"
            inputmode="email"
          />
          <p class="mt-1.5 text-xs text-[#718c84]">Separate email addresses with commas.</p>
        </div>
      </div>
      <label
        class="flex items-start gap-3 rounded-xl border border-white/8 p-3 text-sm text-[#9bb1aa]"
        ><input v-model="form.terms" type="checkbox" class="mt-1 accent-emerald-400" /><span
          >I accept the Terms, acceptable-use policy, and responsibility for provider usage
          charges.</span
        ></label
      >
      <div v-if="error" class="rounded-lg bg-red-400/8 p-3 text-sm text-red-200">{{ error }}</div>
      <UButton
        type="submit"
        size="xl"
        class="w-full justify-center"
        :loading="mutations.createOrganization.isPending.value"
        >Create organization</UButton
      >
    </form>
  </div>
</template>
