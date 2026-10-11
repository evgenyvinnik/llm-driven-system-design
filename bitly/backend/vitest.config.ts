import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    env: {
      // Tests are offline and assert on behavior, not log lines.
      LOG_LEVEL: 'silent',
    },
  },
});
