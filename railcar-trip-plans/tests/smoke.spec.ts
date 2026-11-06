import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests. Needs the stack running with the scenario simulated
 * (npm run db:seed, npm run dev and npm run simulate in backend/).
 */
async function login(page: Page, username = 'olivia') {
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

test.describe('railcar-trip-plans Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('02 shipper sees only their cars', async ({ page }) => {
    await login(page, 'sam');
    await page.goto('/cars');
    await expect(page.locator("table[aria-label='Cars']")).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Prairie Grain Co-op: my cars')).toBeVisible();
    await expect(page.locator('a', { hasText: 'Streams & DLQ' })).toHaveCount(0);
    await noErrorBoundary(page);
  });

  test('03 car detail shows plan versions and the event timeline', async ({ page }) => {
    await login(page, 'sam');
    await page.goto('/cars');
    await page.locator("table[aria-label='Cars'] a").first().click();
    await expect(page.locator("ol[aria-label='Plan versions']")).toBeVisible({ timeout: 10000 });
    await page.getByRole('link', { name: 'Event timeline' }).click();
    await expect(page.locator("table[aria-label='Event timeline']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('04 exceptions board loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/exceptions');
    await expect(page.locator('text=Exceptions board')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('05 replanning sagas load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/replans');
    await expect(page.locator('text=Replanning sagas')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('06 digests load correctly', async ({ page }) => {
    await login(page);
    await page.goto('/notifications');
    await expect(page.locator('text=Shipper digests')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('07 streams and DLQ page loads correctly', async ({ page }) => {
    await login(page, 'alex');
    await page.goto('/streams');
    await expect(page.locator("table[aria-label='Consumer groups']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });
});
