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

test.describe('experimentation-platform Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 flags loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Flags and experiments\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 editor loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags/checkout_cta');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'kill-switch\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 ramp preview loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags/checkout_cta');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'kill-switch\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 results lift loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags/checkout_cta/results');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Exposed analysis\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 results srm loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags/shipping_banner/results');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'srm-warning\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 results assigned vs exposed loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/flags/rewards_teaser/results');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Exposed analysis\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 live clients loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/clients');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'SDK clients\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 audit loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/audit');
    await page.waitForTimeout(1200);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Audit entries\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 viewer read only loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/flags/checkout_cta');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'kill-switch\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
