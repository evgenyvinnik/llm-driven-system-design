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

test.describe('zoom Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(600);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 dashboard loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 schedule loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/schedule');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 history loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/history');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 meeting lobby loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/meeting/abc-defg-hij');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 in meeting loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/meeting/abc-defg-hij');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('button:has-text(\'Join Meeting\')')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 host controls loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/meeting/abc-defg-hij');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('button:has-text(\'Join Meeting\')')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 breakout rooms loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/meeting/abc-defg-hij');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('button:has-text(\'Join Meeting\')')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 waiting room loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/meeting/bob-wait-rom');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('button:has-text(\'Join Meeting\')')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
