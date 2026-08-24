import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: {
    alias: {
      '~': new URL('./apps/web/', import.meta.url).pathname,
    },
  },
  fmt: {
    ignorePatterns: [
      '**/.nuxt/**',
      '**/.output/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
      'PRODUCT.md',
      'pnpm-lock.yaml',
    ],
    semi: false,
    singleQuote: true,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: [
      '**/.nuxt/**',
      '**/.output/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'html', 'json-summary'],
    },
    include: [
      'apps/**/*.{test,spec}.ts',
      'packages/**/*.{test,spec}.ts',
      'plugins/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
      'workers/**/*.{test,spec}.ts',
    ],
  },
})
