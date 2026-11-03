import { defineConfig } from 'vitest/config'

/**
 * Integration tests run against the real PostgreSQL and Valkey from
 * docker-compose (migrated; seed data not required, the tests build their own
 * orgs). Point DATABASE_URL / REDIS_URL elsewhere if the default ports are taken.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.int.test.ts'],
    env: { LOG_LEVEL: 'silent' },
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
