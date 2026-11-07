import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page, username = 'alice', password = 'password123') {
  await page.goto('/login');
  await page.locator("input[name='username']").first().fill(username);
  await page.locator("input[name='password']").first().fill(password);
  await page.locator("button[type='submit']").first().click();
  // Wait until the app leaves the login page, i.e. the sign-in request completed
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

test.describe('webhook-platform Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 endpoints loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/endpoints');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Endpoints\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 endpoint disabled loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/endpoints/ep_acme_audit');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Deliveries\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 delivery retries loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/endpoints/ep_acme_billing');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Deliveries\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 delivery exhausted loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/endpoints/ep_acme_audit');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Deliveries\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 events loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/events');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Events\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 receiver loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/receiver');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Received requests\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 notifications loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/notifications');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Notifications\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 globex endpoints loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/endpoints');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Endpoints\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 ops loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/ops');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Endpoints in flight\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
