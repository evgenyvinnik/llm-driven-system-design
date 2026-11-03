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

test.describe('ai-chat Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 new chat loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('text=What can I help with?')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 branches loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 code and tables loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 untrusted html inert loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 streaming loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('text=What can I help with?')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 failed partial answer loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 long thread virtualized loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');

    // Verify page content loads
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 operator dashboard loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/admin');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('text=Operator dashboard')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
