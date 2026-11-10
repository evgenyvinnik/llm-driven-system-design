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

test.describe('llm-inference-api Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 console loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/console');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Requests\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 console stream loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/console');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('form[aria-label=\'New request\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 request failed midstream loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/requests/req_seed_0013');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('section[aria-label=\'Lifecycle\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 admin loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/admin');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'backend-b1\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 routing loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/routing');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('section[aria-label=\'Ring\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
