<script setup lang="ts">
import { useGridoraApi } from '~/services/gridora-api'

useSeoMeta({ title: 'Profile and session' })
const state = useGridoraState()
const api = useGridoraApi()
const session = await useAsyncData('my-access-session', () => api.accessSession())
const expires = computed(() =>
  session.data.value === undefined
    ? 'Unavailable'
    : new Date(session.data.value.expiresAt * 1000).toLocaleString(),
)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="Account"
      title="Profile and session"
      description="Your identity and browser session are established by Cloudflare Access. Gridora does not store a password or a second browser session."
    />
    <section class="panel p-5">
      <h2 class="section-title">User profile</h2>
      <dl class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt class="muted text-xs">Display name</dt>
          <dd class="mt-1">{{ state.currentUser.name }}</dd>
        </div>
        <div>
          <dt class="muted text-xs">Email</dt>
          <dd class="mt-1">{{ state.currentUser.email }}</dd>
        </div>
        <div>
          <dt class="muted text-xs">Gridora identity</dt>
          <dd class="mt-1 font-mono text-xs">{{ state.currentUser.id }}</dd>
        </div>
        <div>
          <dt class="muted text-xs">Profile authority</dt>
          <dd class="mt-1">Cloudflare Access identity provider</dd>
        </div>
      </dl>
      <p class="muted mt-4 text-xs">
        Change your name or email with your configured identity provider. Gridora refreshes these
        claims at authentication.
      </p>
    </section>
    <section class="panel p-5">
      <h2 class="section-title">Current Access session</h2>
      <p v-if="session.pending.value" class="muted mt-3 text-sm">Loading session details…</p>
      <p v-else-if="session.error.value" class="mt-3 text-sm text-red-200">
        Session details could not be loaded.
      </p>
      <dl v-else class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt class="muted text-xs">Provider</dt>
          <dd class="mt-1">Cloudflare Access</dd>
        </div>
        <div>
          <dt class="muted text-xs">Expires</dt>
          <dd class="mt-1">{{ expires }}</dd>
        </div>
        <div>
          <dt class="muted text-xs">Issuer</dt>
          <dd class="mt-1 break-all font-mono text-xs">{{ session.data.value?.issuer }}</dd>
        </div>
        <div>
          <dt class="muted text-xs">Other sessions</dt>
          <dd class="mt-1">Managed by Access; Gridora cannot enumerate them</dd>
        </div>
      </dl>
      <a class="btn-secondary mt-5 inline-flex" href="/cdn-cgi/access/logout"
        >Sign out of this Access session</a
      >
    </section>
  </div>
</template>
