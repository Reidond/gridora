import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-23',
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  ssr: false,
  app: {
    head: {
      title: 'Gridora Console',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'description', content: 'Operate game servers across providers with confidence.' },
        { name: 'theme-color', content: '#07110f' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? '',
      dataMode: process.env.NUXT_PUBLIC_DATA_MODE ?? 'api',
      accessCompletionUrl: process.env.NUXT_PUBLIC_ACCESS_COMPLETION_URL ?? '',
    },
  },
  nitro: {
    preset: 'cloudflare_module',
    cloudflare: { nodeCompat: true },
    prerender: { routes: ['/sign-in', '/sign-up'] },
  },
  typescript: { strict: true },
})
