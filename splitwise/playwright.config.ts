import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  // webServer is conditionally enabled:
  // - Disabled when SKIP_WEBSERVER=1 (when run via 'npm run test:smoke')
  // - Enabled when running 'npm run test:e2e' directly in the project
  ...(process.env.SKIP_WEBSERVER ? {} : {
    webServer: {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120000,
      cwd: './frontend',
    },
  }),
});
