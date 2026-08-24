import '@golar/vue'
import { defineConfig } from 'golar/unstable'

export default defineConfig({
  typecheck: {
    include: [
      'app.vue',
      'components/**/*.vue',
      'layouts/**/*.vue',
      'pages/**/*.vue',
      'plugins/**/*.ts',
      'composables/**/*.ts',
      'middleware/**/*.ts',
      'services/**/*.ts',
      'types/**/*.ts',
      'utils/**/*.ts',
    ],
  },
})
