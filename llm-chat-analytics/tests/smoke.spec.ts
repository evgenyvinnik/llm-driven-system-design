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

test.describe('llm-chat-analytics Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 dashboard loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 drilldown loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 cross filter loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur&models=orion-large&features=code_execution&metric=messages');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 not collected loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur&range=28d&metric=abandon_rate');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 backfill pending loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur&range=28d&metric=tokens_per_response');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 small cohorts loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=larkspur&range=24h&models=orion-think&features=image_input&metric=messages');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 kestrel analyst today loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/?org=kestrel&range=today');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'trend\'][data-state=\'ready\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 definitions loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/definitions');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'definitions\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 pipeline loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/pipeline');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'pipeline\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 exports loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/exports');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'exports\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
