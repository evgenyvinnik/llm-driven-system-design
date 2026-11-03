import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts', 'node_modules', 'dist'],
    env: { LOG_LEVEL: 'silent' },
  },
})
