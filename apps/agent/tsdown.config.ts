import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node24',
  deps: { alwaysBundle: [/.*/] },
})
