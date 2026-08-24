<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { useGridoraApi } from '~/services/gridora-api'

const route = useRoute()
const data = useOrganizationData()
const mutations = useGridoraMutations()
const state = useGridoraState()
const api = useGridoraApi()
const operationQuery = useQuery({
  queryKey: computed(() => [
    'organization',
    String(route.params.slug),
    'operation',
    String(route.params.id),
  ]),
  enabled: computed(() => state.value.session.mode === 'api' && Boolean(route.params.id)),
  queryFn: () => api.operation(String(route.params.slug), String(route.params.id)),
  retry: false,
})
const operation = computed(
  () =>
    operationQuery.data.value ?? data.operations.value.find((item) => item.id === route.params.id),
)
const finalResourceLink = computed(() => {
  const resource = operation.value?.finalResource
  if (resource === undefined) return undefined
  const slug = String(route.params.slug)
  switch (resource.type) {
    case 'server':
      return `/o/${slug}/servers/${resource.id}`
    case 'node':
      return `/o/${slug}/nodes/${resource.id}`
    case 'backup':
      return `/o/${slug}/backups`
    case 'organization':
      return `/o/${slug}`
    default:
      return undefined
  }
})
useSeoMeta({ title: () => operation.value?.title ?? 'Operation' })
</script>
<template>
  <div v-if="operation" class="space-y-6">
    <PageHeader
      :title="operation.title"
      :description="`${operation.id} · Started by ${operation.actor}`"
      eyebrow="Durable operation"
      ><template #actions
        ><UButton
          v-if="operation.cancellable"
          color="error"
          variant="soft"
          icon="i-lucide-circle-stop"
          @click="mutations.cancelOperation(operation)"
          >Cancel operation</UButton
        ></template
      ></PageHeader
    >
    <div class="grid gap-5 xl:grid-cols-[1fr_340px]">
      <section class="panel p-5 sm:p-6">
        <div class="flex items-start justify-between gap-4">
          <div>
            <StatusBadge :status="operation.status" />
            <p v-if="operation.waitingReason" class="mt-3 text-sm text-amber-200">
              {{ operation.waitingReason }}
            </p>
          </div>
          <p class="text-3xl font-semibold tracking-[-.04em]">{{ operation.progress }}%</p>
        </div>
        <div class="progress-track mt-5">
          <div class="progress-fill" :style="{ width: `${operation.progress}%` }" />
        </div>
        <div class="mt-7 space-y-0">
          <div
            v-for="(step, index) in operation.steps"
            :key="step.label"
            class="relative flex gap-4 pb-6 last:pb-0"
          >
            <span
              v-if="index < operation.steps.length - 1"
              class="absolute left-[11px] top-6 h-[calc(100%-14px)] w-px bg-white/10"
            /><span
              class="relative z-10 grid size-6 shrink-0 place-items-center rounded-full border"
              :class="
                step.status === 'complete'
                  ? 'border-emerald-400/30 bg-emerald-400/12 text-emerald-300'
                  : step.status === 'running'
                    ? 'border-amber-300/30 bg-amber-300/10 text-amber-200'
                    : 'border-white/12 bg-[#0d1b18] text-[#567168]'
              "
              ><UIcon
                :name="
                  step.status === 'complete'
                    ? 'i-lucide-check'
                    : step.status === 'running'
                      ? 'i-lucide-loader-circle'
                      : 'i-lucide-circle'
                "
                class="size-3"
                :class="step.status === 'running' ? 'animate-spin' : ''"
            /></span>
            <div>
              <p class="text-sm font-medium">{{ step.label }}</p>
              <p class="muted mt-1 text-xs">
                {{
                  step.status === 'complete'
                    ? 'Completed'
                    : step.status === 'running'
                      ? 'In progress'
                      : step.status === 'failed'
                        ? 'Failed'
                        : step.status === 'cancelled'
                          ? 'Cancelled'
                          : 'Pending previous step'
                }}
                <span v-if="step.attempt && step.attempt > 1"> · attempt {{ step.attempt }}</span>
              </p>
            </div>
          </div>
        </div>
        <div class="mt-8 overflow-hidden rounded-xl border border-white/8">
          <div
            class="flex items-center justify-between border-b border-white/8 bg-white/[.02] px-4 py-3"
          >
            <p class="text-xs font-semibold">Operation logs</p>
            <span class="text-[11px] text-[#718c84]">Recorded entries</span>
          </div>
          <div class="min-h-48 space-y-2 bg-[#050c0a] p-4 font-mono text-xs text-[#9bb0aa]">
            <p v-for="(line, index) in operation.logs" :key="line">
              <span class="mr-3 text-[#4f6b62]">{{ String(index + 1).padStart(2, '0') }}</span
              >{{ line }}
            </p>
            <p v-if="!operation.logs.length" class="text-[#718c84]">
              The operation contract does not include log entries.
            </p>
          </div>
        </div>
      </section>
      <aside class="space-y-5">
        <section class="panel p-5">
          <h2 class="section-title">Operation facts</h2>
          <dl class="mt-4 space-y-3 text-sm">
            <div
              v-for="item in [
                ['Resource', operation.resource],
                ['Type', operation.resourceType],
                ['Elapsed', operation.elapsed],
                ['Retries', operation.retries ?? 'Not reported'],
                ['Provider reference', operation.providerRequestId ?? 'Not recorded'],
                ['Cancellation', operation.cancellable ? 'Available' : 'Unavailable'],
              ]"
              :key="item[0]"
              class="flex justify-between gap-4"
            >
              <dt class="muted">{{ item[0] }}</dt>
              <dd class="break-all text-right">{{ item[1] }}</dd>
            </div>
          </dl>
        </section>
        <section class="panel p-5">
          <h2 class="section-title">Recovery</h2>
          <p class="muted mt-2 text-xs leading-relaxed">
            {{ operation.recoveryGuidance ?? 'No recovery guidance was recorded.' }}
          </p>
          <p v-if="operation.providerRequestId" class="muted mt-3 text-xs">
            Provider references are redacted before storage in this read model.
          </p>
          <UButton
            v-if="finalResourceLink"
            :to="finalResourceLink"
            variant="outline"
            class="mt-4 w-full justify-center"
            icon="i-lucide-arrow-up-right"
            >Open final resource</UButton
          >
          <p v-if="!operation.retryAction" class="muted mt-3 text-xs">
            No typed retry action is available for this operation.
          </p>
        </section>
      </aside>
    </div>
  </div>
  <EmptyState
    v-else-if="!data.isLoading.value && !operationQuery.isLoading.value"
    title="Operation not found"
    description="The authorized operation inventory does not contain this identifier."
    icon="i-lucide-activity"
  />
</template>
