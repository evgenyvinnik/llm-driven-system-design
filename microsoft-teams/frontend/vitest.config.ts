import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't run the router plugin (which rewrites routeTree.gen.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
