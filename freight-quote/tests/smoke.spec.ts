import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests. Needs the stack running and seeded
 * (npm run db:migrate && npm run db:seed && npm run dev in backend/).
 */
async function login(page: Page, username = 'ada') {
  await page.goto('/login');
  await page.locator("input[name='username']").first().fill(username);
  await page.locator("input[name='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

async function noErrorBoundary(page: Page) {
  await expect(page.locator('text=Something went wrong')).not.toBeVisible();
}

test.describe('freight-quote Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('02 customer portal loads and quotes', async ({ page }) => {
    await login(page, 'pat');
    await expect(page.locator("form[aria-label='Request a quote']")).toBeVisible({ timeout: 10000 });
    await page.locator("form[aria-label='Request a quote'] button[type='submit']").click();
    await expect(page.locator("section[aria-label='Price components']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('03 operations page loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ops');
    await expect(page.locator("section[aria-label='Network capacity']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('04 event log loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/events');
    await expect(page.locator("table[aria-label='Events']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('05 streams and DLQ load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/streams');
    await expect(page.locator("table[aria-label='Consumer lag']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('06 analytics loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/analytics');
    await expect(page.locator("table[aria-label='Latency by dependency']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });
});
