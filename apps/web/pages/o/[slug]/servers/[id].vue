<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'

const route = useRoute()
const data = useOrganizationData()
const mutations = useGridoraMutations()
const api = useGridoraApi()
// The template is guarded by v-if; the assertion works around Vue's loss of that narrowing inside filter callbacks.
const server = computed(
  () =>
    data.servers.value.find(
      (item) => item.id === route.params.id,
    ) as (typeof data.servers.value)[number],
)
useSeoMeta({ title: () => server.value?.name ?? 'Server' })
const pluginCapabilities = computed(() => {
  const currentServer = server.value
  if (!currentServer) return new Set<string>()
  const plugin = data.plugins.value.find(
    (item) =>
      (item.id === currentServer.plugin || item.name === currentServer.plugin) &&
      item.version === currentServer.pluginVersion,
  )
  const aliases: Readonly<Record<string, string>> = {
    configuration: 'config',
    'workbench mods': 'mods',
    'query health': 'query',
    'quiesced backup': 'backup',
    'crash-consistent backup': 'backup',
    rcon: 'console',
  }
  return new Set(
    (plugin?.capabilities ?? []).map((capability) => {
      const normalized = capability.trim().toLowerCase()
      return aliases[normalized] ?? normalized
    }),
  )
})
const supports = (capability: string) => pluginCapabilities.value.has(capability)
const tabs = computed(() => [
  'Overview',
  ...(supports('config') ? ['Configuration'] : []),
  ...(supports('mods') ? ['Mods'] : []),
  ...(supports('health') || supports('query') ? ['Players / Status'] : []),
  ...(supports('logs') ? ['Logs'] : []),
  ...(supports('console') ? ['Console'] : []),
  ...(supports('backup') ? ['Backups'] : []),
  ...(supports('query') ? ['Networking'] : []),
  'Operations',
  'Audit',
])
const activeTab = ref(String(route.query.tab ?? 'Overview'))
const organizationSlug = computed(() =>
  String(route.params.slug ?? data.organization.value?.slug ?? ''),
)
/** Route slugs are presentation names; wire frames must bind to this canonical ID. */
const organizationId = computed(() => String(data.organization.value?.id ?? ''))
type ConfigRead = {
  readonly revision: number
  readonly activeRevision: number
  readonly schemaVersion: number
  readonly config: Record<string, unknown>
}
type ConfigPreview = {
  readonly outcome: 'no-change' | 'change'
  readonly diff: ReadonlyArray<{ readonly path: string; readonly change: string }>
}
type ModsRead = {
  readonly desiredRevision: number
  readonly resolvedRevision: number
  readonly state: 'resolved' | 'pending' | 'failed'
  readonly error: string | null
  readonly desiredMods: ReadonlyArray<{
    readonly source: string
    readonly id: string
    readonly requestedVersion: string | null
    readonly loadOrder: number
  }>
  readonly resolvedMods: ReadonlyArray<unknown>
}
const configRead = ref<ConfigRead>()
const configPreview = ref<ConfigPreview>()
const modsRead = ref<ModsRead>()
const configDraft = ref('{}')
const modsDraft = ref('[]')
const desiredStateLoading = ref(false)
const configError = ref('')
const modsError = ref('')
const desiredStateActionBusy = ref('')
const parseEditorJson = (source: string, label: string): unknown => {
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error(`${label} must contain valid JSON.`)
  }
}
const loadDesiredState = async () => {
  if (data.isDemo.value || !server.value || !organizationSlug.value) return
  desiredStateLoading.value = true
  configError.value = ''
  modsError.value = ''
  const currentServer = server.value
  const [configResult, modsResult] = await Promise.allSettled([
    api.gameConfig(organizationSlug.value, currentServer.id),
    api.gameMods(organizationSlug.value, currentServer.id),
  ])
  if (configResult.status === 'fulfilled') {
    configRead.value = configResult.value as ConfigRead
    configDraft.value = JSON.stringify(configResult.value.config, null, 2)
  } else {
    configError.value =
      configResult.reason instanceof Error
        ? configResult.reason.message
        : 'Configuration could not be read.'
  }
  if (modsResult.status === 'fulfilled') {
    modsRead.value = modsResult.value as ModsRead
    modsDraft.value = JSON.stringify(modsResult.value.desiredMods, null, 2)
  } else {
    modsError.value =
      modsResult.reason instanceof Error ? modsResult.reason.message : 'Mods could not be read.'
  }
  desiredStateLoading.value = false
}
watch(
  [activeTab, () => server.value?.id, () => data.isDemo.value, tabs],
  () => {
    if (!tabs.value.includes(activeTab.value)) activeTab.value = tabs.value[0] ?? 'Overview'
    if (activeTab.value === 'Configuration' || activeTab.value === 'Mods') void loadDesiredState()
  },
  { immediate: true },
)
const configContainsRedactedValue = computed(() => configDraft.value.includes('[redacted]'))
const previewConfig = async () => {
  if (!server.value || !configRead.value) return
  desiredStateActionBusy.value = 'config-preview'
  configError.value = ''
  try {
    const config = parseEditorJson(configDraft.value, 'Configuration')
    if (typeof config !== 'object' || config === null || Array.isArray(config))
      throw new Error('Configuration must be a JSON object.')
    configPreview.value = (await api.gameConfigPreview(organizationSlug.value, server.value.id, {
      schemaVersion: configRead.value.schemaVersion,
      expectedConfigRevision: configRead.value.revision,
      config,
    })) as ConfigPreview
  } catch (cause) {
    configError.value = cause instanceof Error ? cause.message : 'Configuration preview failed.'
  } finally {
    desiredStateActionBusy.value = ''
  }
}
const applyConfig = async () => {
  if (!server.value || !configRead.value || configContainsRedactedValue.value) return
  desiredStateActionBusy.value = 'config-apply'
  configError.value = ''
  try {
    const config = parseEditorJson(configDraft.value, 'Configuration')
    if (typeof config !== 'object' || config === null || Array.isArray(config))
      throw new Error('Configuration must be a JSON object.')
    const operation = await api.applyGameConfig(organizationSlug.value, server.value.id, {
      expectedRevision: server.value.revision ?? 1,
      action: 'apply-config',
      expectedConfigRevision: configRead.value.revision,
      config,
    })
    await navigateTo(`/o/${organizationSlug.value}/operations/${operation.operationId}`)
  } catch (cause) {
    configError.value = cause instanceof Error ? cause.message : 'Configuration apply failed.'
  } finally {
    desiredStateActionBusy.value = ''
  }
}
const planMods = async () => {
  if (!server.value || !configRead.value || !modsRead.value) return
  desiredStateActionBusy.value = 'mods-plan'
  modsError.value = ''
  try {
    const desiredMods = parseEditorJson(modsDraft.value, 'Mods')
    if (!Array.isArray(desiredMods)) throw new Error('Mods must be a JSON array.')
    await api.gameModsPlan(organizationSlug.value, server.value.id, {
      schemaVersion: 1,
      expectedConfigRevision: configRead.value.revision,
      expectedModRevision: modsRead.value.desiredRevision,
      desiredMods,
    })
    await loadDesiredState()
  } catch (cause) {
    modsError.value = cause instanceof Error ? cause.message : 'Mod plan failed.'
  } finally {
    desiredStateActionBusy.value = ''
  }
}
const syncMods = async () => {
  if (!server.value || !configRead.value || !modsRead.value) return
  desiredStateActionBusy.value = 'mods-sync'
  modsError.value = ''
  try {
    const mods = parseEditorJson(modsDraft.value, 'Mods')
    if (!Array.isArray(mods)) throw new Error('Mods must be a JSON array.')
    const operation = await api.syncGameMods(organizationSlug.value, server.value.id, {
      expectedRevision: server.value.revision ?? 1,
      action: 'sync-mods',
      expectedConfigRevision: configRead.value.revision,
      expectedModRevision: modsRead.value.desiredRevision,
      mods,
    })
    await navigateTo(`/o/${organizationSlug.value}/operations/${operation.operationId}`)
  } catch (cause) {
    modsError.value = cause instanceof Error ? cause.message : 'Mod sync failed.'
  } finally {
    desiredStateActionBusy.value = ''
  }
}
const tabId = (tab: string) => `server-tab-${toSlug(tab)}`
const onTabKey = async (event: KeyboardEvent, index: number) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.value.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.value.length) % tabs.value.length
  activeTab.value = tabs.value[next]!
  await nextTick()
  document.getElementById(tabId(tabs.value[next]!))?.focus()
}
const actionBusy = ref('')
const actionError = ref('')
const moveTargetNodeId = ref('')
const cloneName = ref('')
const cloneDomain = ref('')
const showClone = ref(false)
const forceCleanupConfirmation = ref('')
const forceCleanupBackupPolicy = ref<'required' | 'skip-authorized'>('required')
const showForceCleanup = ref(false)
const moveCandidates = computed(() =>
  data.nodes.value.filter((node) => node.status === 'ready' && node.id !== server.value?.nodeId),
)
const act = async (action: 'start' | 'stop' | 'restart' | 'backup') => {
  if (!server.value) return
  actionBusy.value = action
  actionError.value = ''
  try {
    const operation = await mutations.serverAction.mutateAsync({ server: server.value, action })
    await navigateTo(`/o/${data.organization.value?.slug}/operations/${operation.id}`)
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : `The ${action} action could not be accepted.`
  } finally {
    actionBusy.value = ''
  }
}
const moveServer = async () => {
  const currentServer = server.value
  const targetNodeId = moveTargetNodeId.value
  if (!currentServer || targetNodeId.length === 0) return
  if (targetNodeId === currentServer.nodeId) {
    actionError.value = 'Choose a different ready node for this move.'
    return
  }
  actionBusy.value = 'move'
  actionError.value = ''
  try {
    const operation = await mutations.moveServer.mutateAsync({
      server: currentServer,
      targetNodeId,
    })
    await navigateTo(`/o/${data.organization.value?.slug}/operations/${operation.id}`)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'The move could not be accepted.'
  } finally {
    actionBusy.value = ''
  }
}
const validateFiles = async () => {
  const currentServer = server.value
  if (!currentServer) return
  actionBusy.value = 'validate-files'
  actionError.value = ''
  try {
    if (!configRead.value || !modsRead.value) await loadDesiredState()
    if (!configRead.value || !modsRead.value)
      throw new Error('Current configuration and mod revisions are unavailable.')
    const operation = await api.validateGameServerFiles(organizationSlug.value, currentServer.id, {
      expectedRevision: currentServer.revision ?? 1,
      action: 'update',
      expectedConfigRevision: configRead.value.revision,
      expectedModRevision: modsRead.value.desiredRevision,
      backupBeforeUpdate: false,
    })
    await navigateTo(`/o/${organizationSlug.value}/operations/${operation.operationId}`)
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : 'File validation could not be accepted.'
  } finally {
    actionBusy.value = ''
  }
}
const cloneServer = async () => {
  const currentServer = server.value
  if (!currentServer || cloneName.value.trim().length === 0) return
  actionBusy.value = 'clone'
  actionError.value = ''
  try {
    const result = await api.cloneGameServer(organizationSlug.value, currentServer.id, {
      name: cloneName.value.trim(),
      ...(cloneDomain.value.trim().length === 0
        ? {}
        : { domain: cloneDomain.value.trim().toLowerCase() }),
    })
    await navigateTo(`/o/${organizationSlug.value}/operations/${result.acceptance.operationId}`)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'The clone could not be accepted.'
  } finally {
    actionBusy.value = ''
  }
}
const forceCleanup = async () => {
  const currentServer = server.value
  if (!currentServer || forceCleanupConfirmation.value !== currentServer.name) return
  actionBusy.value = 'force-cleanup'
  actionError.value = ''
  try {
    const result = await api.forceCleanupGameServer(organizationSlug.value, currentServer.id, {
      expectedRevision: currentServer.revision ?? 1,
      action: 'delete',
      backupPolicy: forceCleanupBackupPolicy.value,
      forcedCleanup: true,
    })
    await navigateTo(`/o/${organizationSlug.value}/operations/${result.operationId}`)
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : 'Forced cleanup could not be accepted.'
  } finally {
    actionBusy.value = ''
  }
}
type ServerLogArchive = {
  readonly id: string
  readonly firstTimestamp: string
  readonly lastTimestamp: string
  readonly entryCount: number
  readonly compressedBytes: number
  readonly state: string
}
type ServerLogEntry = {
  readonly organizationId: string
  readonly nodeId: string
  readonly serverId?: string
  readonly component: string
  readonly level: string
  readonly timestamp: string
  readonly sequence: number
  readonly message: string
}
const archivedLogEntries = ref<ReadonlyArray<ServerLogEntry>>([])
const liveLogEntries = ref<ReadonlyArray<ServerLogEntry>>([])
const logArchives = ref<ReadonlyArray<ServerLogArchive>>([])
const logCursor = ref<string>()
const logsLoading = ref(false)
const archiveLoadingId = ref('')
const logsError = ref('')
const logComponent = ref('')
const logLevel = ref('')
const liveLogsConnected = ref(false)
const healthStatus = ref<string>()
const healthSampledAt = ref<string>()
let liveLogSocket: WebSocket | undefined
let liveLogEpoch: string | undefined
const effectiveHealth = computed(
  () =>
    healthStatus.value ??
    (server.value?.health === 'unknown' ? server.value.status : server.value?.health),
)
const isServerLogEntry = (value: unknown): value is ServerLogEntry => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    organizationId.value.length > 0 &&
    entry.organizationId === organizationId.value &&
    entry.serverId === server.value?.id &&
    typeof entry.nodeId === 'string' &&
    typeof entry.component === 'string' &&
    typeof entry.level === 'string' &&
    typeof entry.timestamp === 'string' &&
    Number.isSafeInteger(entry.sequence) &&
    typeof entry.message === 'string'
  )
}
const isLiveLogFrame = (
  value: unknown,
  expectedOrganizationId: string,
  expectedServerId: string,
  expectedEpoch: string,
): value is {
  readonly type: 'log'
  readonly organizationId: string
  readonly serverId: string
  readonly streamEpoch: string
  readonly sequence: number
  readonly cursor: string
  readonly entry: ServerLogEntry
} => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (
    frame.type === 'log' &&
    frame.organizationId === expectedOrganizationId &&
    frame.serverId === expectedServerId &&
    frame.streamEpoch === expectedEpoch &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence === (frame.entry as { readonly sequence?: unknown } | undefined)?.sequence &&
    frame.cursor === `${encodeURIComponent(expectedEpoch)}.${frame.sequence}` &&
    isServerLogEntry(frame.entry)
  )
}
const visibleLogEntries = computed(() =>
  [...archivedLogEntries.value, ...liveLogEntries.value]
    .filter(
      (entry) =>
        (logComponent.value === '' || entry.component === logComponent.value) &&
        (logLevel.value === '' || entry.level === logLevel.value),
    )
    .slice(-1_000),
)
const closeLiveLogs = () => {
  const socket = liveLogSocket
  liveLogSocket = undefined
  liveLogsConnected.value = false
  if (
    socket !== undefined &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  )
    socket.close(1000, 'logs tab closed')
}
const loadLogArchive = async (archiveId: string) => {
  if (data.isDemo.value || !server.value || !organizationSlug.value) return
  archiveLoadingId.value = archiveId
  logsError.value = ''
  try {
    const archive = await api.gameServerLogArchive(
      organizationSlug.value,
      server.value.id,
      archiveId,
    )
    archivedLogEntries.value = archive.entries.filter(isServerLogEntry)
  } catch (cause) {
    logsError.value = cause instanceof Error ? cause.message : 'The log archive could not be read.'
  } finally {
    archiveLoadingId.value = ''
  }
}
const loadLogArchives = async (next = false) => {
  if (data.isDemo.value || !server.value || !organizationSlug.value || (next && !logCursor.value))
    return
  logsLoading.value = true
  logsError.value = ''
  try {
    const page = await api.gameServerLogArchives(organizationSlug.value, server.value.id, {
      limit: 50,
      ...(next && logCursor.value !== undefined ? { cursor: logCursor.value } : {}),
    })
    const incoming = page.items as ReadonlyArray<ServerLogArchive>
    logArchives.value = next
      ? [
          ...logArchives.value,
          ...incoming.filter(
            (item) => !logArchives.value.some((current) => current.id === item.id),
          ),
        ]
      : incoming
    logCursor.value = page.nextCursor
  } catch (cause) {
    logsError.value = cause instanceof Error ? cause.message : 'Log archives could not be loaded.'
  } finally {
    logsLoading.value = false
  }
}
const startLiveLogs = async () => {
  if (data.isDemo.value || !server.value || !organizationSlug.value || liveLogsConnected.value)
    return
  closeLiveLogs()
  logsError.value = ''
  try {
    const currentServerId = server.value.id
    const currentOrganizationId = organizationId.value
    // A ticket is intentionally issued once for this exact server. Never retry
    // the same ticket after an upgrade failure; request a new one instead.
    const ticket = await api.issueGameServerLiveLogTicket(organizationSlug.value, currentServerId)
    if (
      ticket.expiresAt <= Date.now() ||
      currentOrganizationId.length === 0 ||
      ticket.organizationId !== currentOrganizationId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ticket.streamEpoch)
    )
      throw new Error('The live log ticket has an invalid organization or deployment scope.')
    if (liveLogEpoch !== ticket.streamEpoch) {
      liveLogEpoch = ticket.streamEpoch
      liveLogEntries.value = []
    }
    const socket = new WebSocket(
      api.gameServerLiveLogUrl(organizationSlug.value, currentServerId, ticket.ticket),
    )
    liveLogSocket = socket
    socket.onopen = () => {
      if (liveLogSocket === socket) liveLogsConnected.value = true
    }
    socket.onclose = () => {
      if (liveLogSocket === socket) {
        liveLogSocket = undefined
        liveLogsConnected.value = false
      }
    }
    socket.onerror = () => {
      if (liveLogSocket === socket)
        logsError.value = 'The live log stream could not be opened. Request a new ticket to retry.'
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data.length > 64 * 1024) return
      try {
        const frame = JSON.parse(event.data) as unknown
        if (!isLiveLogFrame(frame, ticket.organizationId, currentServerId, ticket.streamEpoch))
          return
        liveLogEntries.value = [...liveLogEntries.value, frame.entry].slice(-1_000)
      } catch {
        // Ignore malformed control frames without ever treating them as logs.
      }
    }
  } catch (cause) {
    logsError.value =
      cause instanceof Error ? cause.message : 'A live log ticket could not be issued.'
  }
}
const loadHealth = async () => {
  if (data.isDemo.value || !server.value || !organizationSlug.value) return
  try {
    const snapshot = await api.gameServerHealth(organizationSlug.value, server.value.id)
    healthStatus.value = snapshot.status
    healthSampledAt.value = snapshot.sampledAt
  } catch (cause) {
    // Inventory remains visible if a telemetry snapshot has not yet arrived.
    healthStatus.value = undefined
    healthSampledAt.value = undefined
  }
}
watch(
  [activeTab, () => server.value?.id, organizationSlug, () => data.isDemo.value],
  () => {
    if (activeTab.value === 'Logs') void loadLogArchives()
    else closeLiveLogs()
    void loadHealth()
  },
  { immediate: true },
)
onBeforeUnmount(closeLiveLogs)
const consoleCommand = ref('')
const sent = ref<string[]>([])
const serverBackups = computed(() =>
  data.backups.value.filter((item) => item.serverId === server.value?.id),
)
const sendCommand = () => {
  if (!consoleCommand.value.trim()) return
  sent.value.unshift(`> ${consoleCommand.value}`)
  consoleCommand.value = ''
}
</script>
<template>
  <div v-if="server" class="space-y-6">
    <div class="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <NuxtLink
          :to="`/o/${data.organization.value?.slug}/servers`"
          class="mb-3 inline-flex items-center gap-1 text-xs text-[#7f9991] hover:text-white"
          ><UIcon name="i-lucide-arrow-left" /> Game servers</NuxtLink
        >
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="page-title">{{ server.name }}</h1>
          <StatusBadge :status="effectiveHealth" />
        </div>
        <p class="page-copy">
          {{ server.plugin }} {{ server.pluginVersion }} ·
          {{ server.endpoint ?? 'Endpoint not assigned' }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="supports('backup')"
          variant="outline"
          icon="i-lucide-archive"
          :loading="actionBusy === 'backup'"
          :disabled="actionBusy !== ''"
          @click="act('backup')"
          >Back up</UButton
        ><UButton
          v-if="supports('lifecycle') && server.status === 'stopped'"
          icon="i-lucide-play"
          :loading="actionBusy === 'start'"
          :disabled="actionBusy !== ''"
          @click="act('start')"
          >Start</UButton
        ><UButton
          v-else-if="supports('lifecycle')"
          variant="outline"
          icon="i-lucide-rotate-cw"
          :loading="actionBusy === 'restart'"
          :disabled="actionBusy !== ''"
          @click="act('restart')"
          >Restart</UButton
        ><UButton
          v-if="supports('lifecycle') && server.status !== 'stopped'"
          color="error"
          variant="soft"
          icon="i-lucide-square"
          :loading="actionBusy === 'stop'"
          :disabled="actionBusy !== ''"
          @click="act('stop')"
          >Stop</UButton
        >
        <UButton
          v-if="supports('lifecycle')"
          variant="outline"
          icon="i-lucide-file-check-2"
          :loading="actionBusy === 'validate-files'"
          :disabled="actionBusy !== ''"
          @click="validateFiles"
          >Validate files</UButton
        >
        <UButton
          v-if="supports('lifecycle')"
          variant="outline"
          icon="i-lucide-copy"
          :disabled="actionBusy !== ''"
          @click="showClone = !showClone"
          >Clone</UButton
        >
        <UButton
          v-if="supports('lifecycle') && server.status === 'failed'"
          color="error"
          variant="outline"
          icon="i-lucide-shield-alert"
          :disabled="actionBusy !== ''"
          @click="showForceCleanup = !showForceCleanup"
          >Force cleanup</UButton
        >
        <div
          v-if="supports('lifecycle')"
          class="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[.02] px-2 py-1"
        >
          <label class="sr-only" for="move-target-node">Move target node</label>
          <select
            id="move-target-node"
            v-model="moveTargetNodeId"
            class="native-select max-w-40 text-xs"
            :disabled="actionBusy !== '' || moveCandidates.length === 0"
          >
            <option value="" disabled>
              {{ moveCandidates.length === 0 ? 'No ready target node' : 'Move to ready node' }}
            </option>
            <option v-for="node in moveCandidates" :key="node.id" :value="node.id">
              {{ node.name }} · {{ node.region }}
            </option>
          </select>
          <UButton
            variant="outline"
            icon="i-lucide-arrow-right-left"
            :loading="actionBusy === 'move'"
            :disabled="actionBusy !== '' || moveTargetNodeId.length === 0"
            @click="moveServer"
            >Move</UButton
          >
        </div>
      </div>
    </div>
    <div v-if="showClone" class="panel grid gap-3 p-4 sm:grid-cols-2">
      <div class="sm:col-span-2">
        <p class="section-title">Clone desired state</p>
        <p class="page-copy">
          The source manifest is read server-side. Provider, image, and deployment coordinates
          cannot be copied from this form.
        </p>
      </div>
      <label
        ><span class="field-label">New server name</span
        ><input v-model="cloneName" class="native-input"
      /></label>
      <label
        ><span class="field-label">New domain (optional)</span
        ><input v-model="cloneDomain" class="native-input"
      /></label>
      <div class="sm:col-span-2">
        <UButton
          :loading="actionBusy === 'clone'"
          :disabled="cloneName.trim().length === 0"
          @click="cloneServer"
          >Create clone</UButton
        >
      </div>
    </div>
    <div v-if="showForceCleanup && server.status === 'failed'" class="panel border-red-400/20 p-4">
      <p class="section-title text-red-100">Failed-node forced cleanup</p>
      <p class="page-copy">
        Acceptance still requires an active rebuild or retire inventory for this exact failed node.
        Type the server name to authorize cleanup.
      </p>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label
          ><span class="field-label">Backup policy</span
          ><select v-model="forceCleanupBackupPolicy" class="native-select">
            <option value="required">Require existing/new backup evidence</option>
            <option value="skip-authorized">Explicitly authorize backup skip</option>
          </select></label
        >
        <label
          ><span class="field-label">Type {{ server.name }}</span
          ><input v-model="forceCleanupConfirmation" class="native-input"
        /></label>
      </div>
      <UButton
        class="mt-3"
        color="error"
        :loading="actionBusy === 'force-cleanup'"
        :disabled="forceCleanupConfirmation !== server.name"
        @click="forceCleanup"
        >Authorize forced cleanup</UButton
      >
    </div>
    <p v-if="!data.isDemo.value" class="muted text-xs">
      Lifecycle actions are revision-fenced and reported through the operation workflow. Backups
      remain unavailable until their provider evidence adapter is deployed.
    </p>
    <p v-if="actionError" class="rounded-lg bg-red-400/8 p-3 text-sm text-red-200" role="alert">
      {{ actionError }}
    </p>
    <div
      class="flex overflow-x-auto border-b border-white/8"
      role="tablist"
      aria-label="Server details"
    >
      <button
        v-for="(tab, index) in tabs"
        :key="tab"
        :id="tabId(tab)"
        role="tab"
        :aria-selected="activeTab === tab"
        aria-controls="server-tab-panel"
        :tabindex="activeTab === tab ? 0 : -1"
        class="whitespace-nowrap border-b-2 px-3 py-3 text-xs font-medium"
        :class="
          activeTab === tab
            ? 'border-emerald-300 text-emerald-200'
            : 'border-transparent text-[#718c84] hover:text-white'
        "
        @click="activeTab = tab"
        @keydown="onTabKey($event, index)"
      >
        {{ tab }}
      </button>
    </div>
    <div id="server-tab-panel" role="tabpanel" :aria-labelledby="tabId(activeTab)">
      <div v-if="activeTab === 'Overview'" class="grid gap-5 xl:grid-cols-[1.4fr_.8fr]">
        <div class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-3">
            <MetricCard
              label="Players"
              :value="
                server.players === undefined || server.playerCapacity === undefined
                  ? '—'
                  : `${server.players}/${server.playerCapacity}`
              "
              detail="Player telemetry is shown only when reported"
              icon="i-lucide-users"
            /><MetricCard
              label="Build"
              :value="server.build ?? '—'"
              detail="The inventory does not currently report an installed build"
              icon="i-lucide-package-check"
            /><MetricCard
              label="Last backup"
              :value="
                server.lastBackupAt
                  ? new Date(server.lastBackupAt).toLocaleString()
                  : serverBackups[0]
                    ? new Date(serverBackups[0].createdAt).toLocaleString()
                    : '—'
              "
              detail="The latest authorized backup inventory entry"
              icon="i-lucide-archive"
            />
          </div>
          <section class="panel p-5">
            <h2 class="section-title">Health hierarchy</h2>
            <div v-if="data.isDemo.value" class="mt-5 grid gap-3 sm:grid-cols-2">
              <div
                v-for="item in [
                  ['Provider', 'Healthy'],
                  ['Node', 'Healthy'],
                  ['Container', 'Running'],
                  ['Game process', 'Running'],
                  ['Protocol query', 'Healthy'],
                  ['Mod set', '12/12 active'],
                ]"
                :key="item[0]"
                class="flex items-center justify-between rounded-lg border border-white/[.06] p-3"
              >
                <span class="text-sm text-[#91a9a1]">{{ item[0] }}</span
                ><span class="flex items-center gap-2 text-xs text-emerald-300"
                  ><span class="status-dot bg-emerald-300" />{{ item[1] }}</span
                >
              </div>
            </div>
            <dl v-else class="mt-5 space-y-3 text-sm">
              <div class="flex justify-between gap-4 rounded-lg border border-white/[.06] p-3">
                <dt class="muted">Observed server state</dt>
                <dd>{{ server.status }}</dd>
              </div>
              <div class="flex justify-between gap-4 rounded-lg border border-white/[.06] p-3">
                <dt class="muted">Game health</dt>
                <dd>
                  {{
                    healthStatus ?? (server.health === 'unknown' ? 'Not reported' : server.health)
                  }}
                  <span v-if="healthSampledAt" class="muted text-xs">
                    · {{ new Date(healthSampledAt).toLocaleString() }}</span
                  >
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <aside class="space-y-5">
          <section class="panel p-5">
            <h2 class="section-title">Deployment</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="muted">Scenario</dt>
                <dd class="text-right">{{ server.scenario ?? 'Not reported' }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="muted">Node</dt>
                <dd>{{ server.nodeId }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="muted">Endpoint</dt>
                <dd class="text-right font-mono text-xs text-emerald-200">
                  {{ server.endpoint ?? 'Not assigned' }}
                </dd>
              </div>
              <div v-if="data.isDemo.value" class="flex justify-between gap-4">
                <dt class="muted">Ports</dt>
                <dd>2001–2003/UDP</dd>
              </div>
            </dl>
          </section>
          <section v-if="data.isDemo.value" class="panel p-5">
            <h2 class="section-title">Resource use</h2>
            <div
              v-for="item in [
                ['CPU', 42],
                ['Memory', 61],
                ['Disk', 54],
              ]"
              :key="item[0]"
              class="mt-4"
            >
              <div class="mb-1.5 flex justify-between text-xs">
                <span class="muted">{{ item[0] }}</span
                ><span>{{ item[1] }}%</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${item[1]}%` }" />
              </div>
            </div>
          </section>
        </aside>
      </div>
      <div v-else-if="activeTab === 'Configuration'" class="grid gap-5 lg:grid-cols-2">
        <template v-if="data.isDemo.value">
          <section class="panel p-5">
            <h2 class="section-title">Active configuration</h2>
            <div class="mt-4 space-y-4">
              <div>
                <label class="field-label">Scenario</label
                ><select class="native-select">
                  <option>{{ server.scenario }}</option>
                </select>
              </div>
              <div>
                <label class="field-label">Player capacity</label
                ><input class="native-input" type="number" :value="server.playerCapacity" />
              </div>
              <div>
                <label class="field-label">Server password</label
                ><input class="native-input" value="Secret reference ·••••" disabled />
              </div>
              <UButton>Preview changes</UButton>
            </div>
          </section>
          <section class="panel p-5">
            <h2 class="section-title">Version history</h2>
            <div class="mt-4 space-y-3">
              <div
                v-for="version in ['v18 · Current', 'v17 · 20 Aug', 'v16 · 14 Aug']"
                :key="version"
                class="flex justify-between rounded-lg border border-white/8 p-3 text-sm"
              >
                <span>{{ version }}</span
                ><span class="muted">Alex Morgan</span>
              </div>
            </div>
          </section>
        </template>
        <template v-else>
          <section class="panel p-5">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h2 class="section-title">Desired configuration</h2>
                <p class="page-copy">
                  Revision {{ configRead?.revision ?? '—' }} · active revision
                  {{ configRead?.activeRevision ?? '—' }}
                </p>
              </div>
              <span v-if="desiredStateLoading" class="muted text-xs">Loading…</span>
            </div>
            <p
              v-if="configError"
              class="mt-4 rounded-lg bg-red-400/8 p-3 text-sm text-red-200"
              role="alert"
            >
              {{ configError }}
            </p>
            <textarea
              v-model="configDraft"
              class="native-input mt-4 min-h-72 font-mono text-xs"
              spellcheck="false"
              aria-label="Desired server configuration JSON"
            />
            <p v-if="configContainsRedactedValue" class="mt-3 text-xs text-amber-200">
              Secret fields are redacted in reads. Replace each [redacted] value with the reviewed
              secret reference before applying configuration.
            </p>
            <div class="mt-4 flex flex-wrap gap-2">
              <UButton
                variant="outline"
                :loading="desiredStateActionBusy === 'config-preview'"
                :disabled="!configRead || desiredStateActionBusy !== ''"
                @click="previewConfig"
                >Preview changes</UButton
              >
              <UButton
                :loading="desiredStateActionBusy === 'config-apply'"
                :disabled="
                  !configRead || configContainsRedactedValue || desiredStateActionBusy !== ''
                "
                @click="applyConfig"
                >Apply configuration</UButton
              >
            </div>
          </section>
          <section class="panel p-5">
            <h2 class="section-title">Preview</h2>
            <p v-if="!configPreview" class="page-copy mt-3">
              Preview uses the authoritative plugin and has no side effects.
            </p>
            <template v-else>
              <p class="mt-3 text-sm">
                Outcome: <span class="text-emerald-200">{{ configPreview.outcome }}</span>
              </p>
              <div v-if="configPreview.diff.length" class="mt-4 space-y-2 text-xs">
                <div
                  v-for="entry in configPreview.diff"
                  :key="`${entry.path}-${entry.change}`"
                  class="rounded-lg border border-white/8 p-3"
                >
                  <span class="font-mono text-emerald-200">{{ entry.path }}</span>
                  <span class="muted ml-2">{{ entry.change }}</span>
                </div>
              </div>
              <p v-else class="muted mt-4 text-xs">No changes detected.</p>
            </template>
          </section>
        </template>
      </div>
      <div v-else-if="activeTab === 'Mods'" class="panel p-5">
        <template v-if="data.isDemo.value">
          <div class="flex justify-between">
            <div>
              <h2 class="section-title">Desired mod set</h2>
              <p class="page-copy">
                Dependencies, load order, compatibility, and provenance are resolved by the plugin.
              </p>
            </div>
            <UButton variant="outline" icon="i-lucide-plus">Plan changes</UButton>
          </div>
          <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="mod in [
                ['Better Tracers', '1.8.2'],
                ['Night Ops Framework', '3.1.0'],
                ['Task Force Mattock', '2.4.1'],
              ]"
              :key="mod[0]"
              class="rounded-xl border border-white/8 p-4"
            >
              <div class="flex justify-between">
                <p class="text-sm font-medium">{{ mod[0] }}</p>
                <StatusBadge status="active" />
              </div>
              <p class="muted mt-2 text-xs">Resolved {{ mod[1] }} · Workbench</p>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="section-title">Desired and resolved mods</h2>
              <p class="page-copy">
                Desired revision {{ modsRead?.desiredRevision ?? '—' }} · resolved revision
                {{ modsRead?.resolvedRevision ?? '—' }}
              </p>
            </div>
            <StatusBadge v-if="modsRead" :status="modsRead.state" />
          </div>
          <p
            v-if="modsError"
            class="mt-4 rounded-lg bg-red-400/8 p-3 text-sm text-red-200"
            role="alert"
          >
            {{ modsError }}
          </p>
          <p
            v-if="modsRead?.error"
            class="mt-4 rounded-lg bg-amber-400/8 p-3 text-sm text-amber-100"
          >
            {{ modsRead.error }}
          </p>
          <textarea
            v-model="modsDraft"
            class="native-input mt-4 min-h-48 font-mono text-xs"
            spellcheck="false"
            aria-label="Desired server mods JSON"
          />
          <div class="mt-4 flex flex-wrap gap-2">
            <UButton
              variant="outline"
              :loading="desiredStateActionBusy === 'mods-plan'"
              :disabled="!modsRead || !configRead || desiredStateActionBusy !== ''"
              @click="planMods"
              >Plan changes</UButton
            >
            <UButton
              :loading="desiredStateActionBusy === 'mods-sync'"
              :disabled="!modsRead || !configRead || desiredStateActionBusy !== ''"
              @click="syncMods"
              >Sync mods</UButton
            >
          </div>
          <div v-if="modsRead?.resolvedMods.length" class="mt-5">
            <h3 class="text-sm font-medium text-white">Resolved records</h3>
            <pre class="mt-3 overflow-auto rounded-lg bg-[#050c0a] p-4 text-xs text-[#aec0bb]">{{
              JSON.stringify(modsRead.resolvedMods, null, 2)
            }}</pre>
          </div>
        </template>
      </div>
      <div v-else-if="activeTab === 'Players / Status'" class="panel overflow-hidden">
        <table v-if="data.isDemo.value" class="data-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Session</th>
              <th>Ping</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="player in [
                ['EchoSeven', 'Authenticated', '44 ms', '36m'],
                ['Northstar', 'Authenticated', '51 ms', '18m'],
                ['Nomad', 'Guest', '72 ms', '6m'],
              ]"
              :key="player[0]"
            >
              <td class="font-medium text-white">{{ player[0] }}</td>
              <td>{{ player[1] }}</td>
              <td>{{ player[2] }}</td>
              <td>{{ player[3] }}</td>
            </tr>
          </tbody>
        </table>
        <EmptyState
          v-else
          title="Player status unavailable"
          description="The current inventory contract does not report connected players or query latency."
          icon="i-lucide-users"
        />
      </div>
      <div v-else-if="activeTab === 'Logs'" class="panel overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-white/8 p-3">
          <select
            v-model="logComponent"
            class="native-select w-auto text-xs"
            aria-label="Filter log component"
          >
            <option value="">All components</option>
            <option value="agent">Agent</option>
            <option value="cloudflared">Cloudflared</option>
            <option value="traefik">Traefik</option>
            <option value="docker">Docker</option>
            <option value="game">Game process</option>
            <option value="installer">Installer</option>
            <option value="updater">Updater</option>
            <option value="plugin-health">Plugin health</option>
            <option value="provider-workflow">Provider workflow</option>
          </select>
          <select
            v-model="logLevel"
            class="native-select w-auto text-xs"
            aria-label="Filter log level"
          >
            <option value="">All levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
          <UButton size="xs" variant="ghost" :loading="logsLoading" @click="loadLogArchives()"
            >Refresh archives</UButton
          >
          <UButton
            size="xs"
            variant="outline"
            :disabled="data.isDemo.value || liveLogsConnected"
            @click="startLiveLogs"
            >Follow live</UButton
          >
          <UButton v-if="liveLogsConnected" size="xs" variant="ghost" @click="closeLiveLogs"
            >Stop</UButton
          >
          <span
            class="ml-auto flex items-center gap-2 text-xs"
            :class="liveLogsConnected ? 'text-emerald-300' : 'text-[#7f9991]'"
          >
            <span
              class="status-dot"
              :class="liveLogsConnected ? 'animate-pulse bg-emerald-300' : 'bg-slate-400'"
            />
            {{ liveLogsConnected ? 'Live' : 'Archives' }}
          </span>
        </div>
        <p
          v-if="logsError"
          class="m-4 rounded-lg bg-red-400/8 p-3 text-sm text-red-200"
          role="alert"
        >
          {{ logsError }}
        </p>
        <div v-if="logArchives.length" class="border-b border-white/8 p-3">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs font-medium text-white">Immutable archived batches</p>
            <UButton
              v-if="logCursor"
              size="xs"
              variant="ghost"
              :loading="logsLoading"
              @click="loadLogArchives(true)"
              >Load more</UButton
            >
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <UButton
              v-for="archive in logArchives"
              :key="archive.id"
              size="xs"
              variant="outline"
              :loading="archiveLoadingId === archive.id"
              @click="loadLogArchive(archive.id)"
              >{{ new Date(archive.firstTimestamp).toLocaleString() }} ·
              {{ archive.entryCount }} entries</UButton
            >
          </div>
        </div>
        <div class="min-h-80 space-y-1 bg-[#050c0a] p-5 font-mono text-xs text-[#9db2ac]">
          <p
            v-for="entry in visibleLogEntries"
            :key="`${entry.nodeId}:${entry.sequence}:${entry.timestamp}`"
          >
            {{ entry.timestamp }} [{{ entry.component }}] {{ entry.level.toUpperCase() }} ·
            {{ entry.message }}
          </p>
          <p v-if="!logsLoading && visibleLogEntries.length === 0" class="text-[#7f9991]">
            {{
              data.isDemo.value
                ? 'Demo mode does not fabricate telemetry logs.'
                : 'Choose an archived batch or follow the live stream.'
            }}
          </p>
        </div>
      </div>
      <div v-else-if="activeTab === 'Console'" class="panel overflow-hidden">
        <template v-if="data.isDemo.value">
          <div class="border-b border-white/8 p-4">
            <h2 class="section-title">Plugin console</h2>
            <p class="page-copy">
              Game commands only. Arbitrary host shell access is never exposed.
            </p>
          </div>
          <div class="min-h-64 bg-[#050c0a] p-5 font-mono text-xs">
            <p class="text-emerald-300">Connected to {{ server.name }} RCON</p>
            <p v-for="line in sent" :key="line" class="mt-2 text-[#aec0bb]">{{ line }}</p>
          </div>
          <form class="flex border-t border-white/8 p-3" @submit.prevent="sendCommand">
            <span class="px-2 py-2 text-emerald-300">›</span
            ><input
              v-model="consoleCommand"
              class="native-input rounded-r-none font-mono text-sm"
              placeholder="Enter a supported game command"
            /><UButton type="submit" class="rounded-l-none">Send</UButton>
          </form>
        </template>
        <EmptyState
          v-else
          title="Game console unavailable"
          description="The current API does not expose an RCON session. No connection has been opened."
          icon="i-lucide-terminal-square"
        />
      </div>
      <div v-else-if="activeTab === 'Backups'" class="panel overflow-hidden">
        <table class="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Size</th>
              <th>Consistency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="backup in data.backups.value.filter((item) => item.serverId === server.id)"
              :key="backup.id"
            >
              <td>{{ new Date(backup.createdAt).toLocaleString() }}</td>
              <td>{{ backup.size ?? 'Not reported' }}</td>
              <td>{{ backup.consistency ?? 'Not reported' }}</td>
              <td><StatusBadge :status="backup.status" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="panel p-6">
        <EmptyState
          :title="`${activeTab} timeline`"
          description="Organization-scoped events and resource history appear here as the control plane reports them."
          icon="i-lucide-history"
        />
      </div>
    </div>
  </div>
  <EmptyState
    v-else-if="!data.isLoading.value"
    title="Game server not found"
    description="The authorized game server inventory does not contain this identifier."
    icon="i-lucide-gamepad-2"
  />
</template>
