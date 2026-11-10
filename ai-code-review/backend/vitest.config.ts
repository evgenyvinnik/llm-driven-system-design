import { defineConfig } from 'vitest/config'

// Integration tests run against a real PostgreSQL, in their own database, so they
// never touch seeded data. Without a reachable server they are skipped.
const base = process.env.DATABASE_URL || 'postgresql://review:review_password@localhost:5432/ai_code_review'
const testUrl = process.env.TEST_DATABASE_URL || base.replace(/\/[^/?]+(\?.*)?$/, '/ai_code_review_test$1')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { LOG_LEVEL: 'silent', DATABASE_URL: testUrl, MOCK_TTFT_MS: '0', MOCK_TOKENS_PER_SECOND: '5000' },
    globalSetup: ['./src/test-support/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
})
