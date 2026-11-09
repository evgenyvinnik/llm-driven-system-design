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

test.describe('yard-switch-lists Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 board loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/board');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'board\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 replan diff loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/plans/latest-replan');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'plan-diff\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 plans overrides loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/plans');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Plan versions\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 compare loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Small instances\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 metrics loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/metrics');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Shift metrics\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 holds loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/holds');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Holds\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 simulator loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/simulator');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'sim-clock\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 crew loads correctly', async ({ page }) => {
    await login(page, 'dave', 'password123');
    await page.goto('/crew');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'crew-view\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
