import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['utils/**/*.test.ts', 'tests/**/*.test.ts'] },
  resolve: { alias: { '~': new URL('.', import.meta.url).pathname } },
})
