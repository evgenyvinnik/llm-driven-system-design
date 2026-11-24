import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page, username = 'admin', password = 'password123') {
  await page.goto('/admin');
  await page.locator("input[name='username']").first().fill(username);
  await page.locator("input[name='password']").first().fill(password);
  await page.locator("button[type='submit']").first().click();
  // Signs in in place: wait until the password field is gone
  await expect(page.locator("input[name='password']")).toHaveCount(0, { timeout: 15000 });
}

test.describe('web-crawler Smoke Tests', () => {

  test('01 dashboard loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 domains loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/domains');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 frontier loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/frontier');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 pages loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/pages');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 admin loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
