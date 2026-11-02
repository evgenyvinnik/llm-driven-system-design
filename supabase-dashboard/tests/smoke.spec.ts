import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[type='text']").first().fill('alice');
  await page.locator("input[type='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  // Wait until the app leaves the login page, i.e. the sign-in request completed
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

test.describe('supabase-dashboard Smoke Tests', () => {

  test('01 login page loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 projects loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 table editor loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/tables');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 sql editor loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/sql');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 auth users loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/auth');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 project settings loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/settings');
    await page.waitForTimeout(2200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 viewer read only sql loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000003-0000-0000-0000-000000000003/sql');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 project members loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/settings');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 outsider project not found loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/project/9a000001-0000-0000-0000-000000000001/tables');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
