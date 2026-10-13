import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The PostgreSQL integration suite shares one database; run files one at a time.
    fileParallelism: false,
    env: {
      // Tests assert on behavior, not log lines.
      LOG_LEVEL: 'silent',
    },
  },
});
