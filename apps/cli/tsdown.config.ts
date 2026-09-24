import { defineConfig } from 'tsdown'

// Workspace packages export TypeScript source, so the packaged binary must
// bundle them. Registry dependencies stay external and resolve from the
// installed CLI package.
export default defineConfig({
  deps: { alwaysBundle: [/^@gridora\//] },
})
