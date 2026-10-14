import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      LOG_LEVEL: 'silent',
      LOG_PRETTY_PRINT: 'false',
      CRAWLER_DOMAIN_DELAY_MS: '0',
    },
  },
});
