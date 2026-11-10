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

test.describe('settings-service Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 preferences loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('[data-ready=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 preferences globex dark loads correctly', async ({ page }) => {
    await login(page, 'dave', 'password123');
    await page.goto('/settings');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('[data-ready=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 two devices loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/devices');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('[data-device=\'laptop\'] [data-live=\'live\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 same key conflict loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/devices');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-device=\'laptop\'] [data-live=\'live\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 lost response loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/devices');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-device=\'laptop\'] [data-live=\'live\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 org policy loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/admin');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Org policy\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 catalog loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/catalog');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Setting definitions\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
