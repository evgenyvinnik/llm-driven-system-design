import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { LOG_LEVEL: 'silent' },
    // Integration tests share one Postgres/Redis; never run files in parallel
    fileParallelism: false,
  },
});
