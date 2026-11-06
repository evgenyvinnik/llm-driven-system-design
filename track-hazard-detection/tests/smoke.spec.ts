import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests. Need the stack running with the scenario simulated
 * (npm run db:seed, npm run dev, npm run simulate in backend/).
 */
async function login(page: Page, username = 'carol') {
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

test.describe('track-hazard-detection Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('02 operator board loads correctly', async ({ page }) => {
    await login(page, 'alice');
    await page.goto('/board');
    await expect(page.locator("section[aria-label='Canyon Subdivision']")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("section[aria-label='Prairie Subdivision']")).toBeVisible();
    await noErrorBoundary(page);
  });

  test('03 alert queue loads correctly', async ({ page }) => {
    await login(page, 'dan');
    await page.goto('/alerts');
    await expect(page.locator("ul[aria-label='Alerts']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('04 speed restrictions load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/restrictions');
    await expect(page.locator("table[aria-label='Speed restrictions']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('05 latency budget loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/latency');
    await expect(page.locator("table[aria-label='Lane latency']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('06 event log loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/events');
    await expect(page.locator("table[aria-label='Event log']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('07 streams and DLQ load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ops');
    await expect(page.locator("table[aria-label='Consumer groups']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('08 hazard detail opens from the board', async ({ page }) => {
    await login(page);
    await page.goto('/board');
    await page.locator("ul[aria-label='Active hazards'] a").first().click();
    await expect(page.locator("table[aria-label='Event timeline']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });
});
