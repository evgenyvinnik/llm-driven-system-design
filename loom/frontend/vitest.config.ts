import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't run the router code generator.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
