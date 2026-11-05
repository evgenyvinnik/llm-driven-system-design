import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests: each page renders with the seeded data. Run with the stack up
 * (docker-compose, db:migrate, db:seed, backend `npm run dev`).
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
}

test.describe('locomotive-fueling Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('02 fleet loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/fleet');
    await expect(page.locator("table[aria-label='Trains'] tbody tr").first()).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('03 train plan loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/trains/T01');
    await expect(page.locator('text=Fuel plan v').first()).toBeVisible({ timeout: 15000 });
    await noErrorBoundary(page);
  });

  test('04 orders loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orders');
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('05 anomalies loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/anomalies');
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('06 prices loads correctly', async ({ page }) => {
    await login(page, 'carol');
    await page.goto('/prices');
    await expect(page.locator("table[aria-label='Fuel options']")).toBeVisible({ timeout: 10000 });
    await noErrorBoundary(page);
  });

  test('07 crew view loads correctly', async ({ page }) => {
    await login(page, 'bob');
    await expect(page.locator("[data-testid='crew-card']")).toBeVisible({ timeout: 15000 });
    await noErrorBoundary(page);
  });
});
