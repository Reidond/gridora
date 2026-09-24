import { defineConfig } from 'tsdown'

// Workspace packages export TypeScript sources, so the smoke CLI bundles them.
// Only published npm dependencies such as `effect` stay external.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  outDir: 'dist',
  dts: false,
  deps: { alwaysBundle: [/^@gridora\//] },
})
