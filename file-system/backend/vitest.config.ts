import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
