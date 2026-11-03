import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[name='username']").first().fill('alice');
  await page.locator("input[name='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  // Wait until the app leaves the login page, i.e. the sign-in request completed
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

test.describe('in-app-assistant Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 mail loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/mail');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Messages\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 thread summary loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/mail?m=m_off1');

    // Verify page content loads
    await expect(page.locator('h2')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 doc assistant loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/docs/doc_offsite');

    // Verify page content loads
    await expect(page.locator('[data-paragraph=\'p_3\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 injection confirmation loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/mail');

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Messages\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 calendar loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/calendar');

    // Verify page content loads
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 settings loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await page.waitForTimeout(600);

    // Verify page content loads
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 ops loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('text=Recent turns')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
