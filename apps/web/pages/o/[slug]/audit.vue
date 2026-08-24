<script setup lang="ts">
useSeoMeta({ title: 'Audit' })
const data = useOrganizationData()
const query = ref('')
const events = computed(() =>
  data.audit.value.filter((e) =>
    Object.values(e).join(' ').toLowerCase().includes(query.value.toLowerCase()),
  ),
)
</script>
<template>
  <div class="space-y-6">
    <PageHeader
      title="Audit log"
      description="Append-only organization activity with actor, target, outcome, request, and correlation context."
      ><template #actions
        ><UButton variant="outline" icon="i-lucide-download" :disabled="!data.isDemo.value"
          >Export</UButton
        ></template
      ></PageHeader
    >
    <CapabilityState :status="data.capabilityStatus('audit').value" title="Audit events" />
    <div v-if="data.capabilityStatus('audit').value === 'available'" class="panel overflow-hidden">
      <div class="border-b border-white/8 p-3">
        <input
          v-model="query"
          class="native-input max-w-sm py-2 text-sm"
          placeholder="Filter actor, action, target, request…"
          aria-label="Filter audit events"
        />
      </div>
      <div class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Actor</th>
              <th>Target</th>
              <th>Time</th>
              <th>Outcome</th>
              <th>Request</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>
                <code class="text-xs text-emerald-200">{{ event.action }}</code>
              </td>
              <td>{{ event.actor }}</td>
              <td>{{ event.target }}</td>
              <td>{{ new Date(event.at).toLocaleString() }}</td>
              <td><StatusBadge :status="event.outcome" /></td>
              <td>
                <code class="text-xs text-[#718c84]">{{ event.requestId }}</code>
              </td>
              <td>
                <details v-if="event.envelope" class="max-w-xs text-xs">
                  <summary class="cursor-pointer text-[#9eb5aa]">
                    v{{ event.schemaVersion }} · {{ event.captureStatus }}
                  </summary>
                  <code
                    class="mt-2 block max-h-44 overflow-auto whitespace-pre-wrap text-[#718c84]"
                  >
                    {{ JSON.stringify(event.envelope, null, 2) }}
                  </code>
                </details>
                <span v-else class="text-xs text-[#718c84]">Legacy summary only</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState
        v-if="!events.length"
        :title="query ? 'No matching audit events' : 'No audit events returned'"
        :description="
          query ? 'Adjust the audit filter.' : 'The authorized audit inventory is empty.'
        "
        icon="i-lucide-scroll-text"
      />
    </div>
  </div>
</template>
