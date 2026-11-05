import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests. Needs the stack running with the scenario simulated
 * (npm run db:seed, npm run dev, npm run simulate in backend/).
 */
async function login(page: Page, username = 'alice') {
  await page.goto('/login');
  await page.locator("input[name='username']").first().fill(username);
  await page.locator("input[name='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

async function noErrorBoundary(page: Page) {
  await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  await expect(page.locator('text=Error boundary')).not.toBeVisible();
}

test.describe('railcar-health Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('02 alert queue loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/alerts');
    await expect(page.locator("ul[aria-label='Alerts']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('03 trains load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/trains');
    await expect(page.locator("table[aria-label='Trains']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('04 yard queue loads correctly', async ({ page }) => {
    await login(page, 'bob');
    await page.goto('/yard');
    await expect(page.locator("ul[aria-label='Work orders']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('05 detector health loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/detectors');
    await expect(page.locator("table[aria-label='Detectors']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('06 reliability page loads correctly', async ({ page }) => {
    await login(page, 'carol');
    await page.goto('/admin');
    await expect(page.locator("table[aria-label='Precision by tier']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });
});
