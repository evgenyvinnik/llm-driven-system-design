import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// A separate config so vitest doesn't load the router plugin from vite.config.ts.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
