import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[name='email'], input[type='email']").first().fill('alice@example.com');
  await page.locator("input[name='password'], input[type='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  // Wait for navigation after login
  await page.waitForURL(/(?!.*login).*/);
}

test.describe('bitly Smoke Tests', () => {

  test('01 login page loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 home page loads correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 dashboard with urls loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('h1:has-text(\'Dashboard\')')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 admin overview loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
