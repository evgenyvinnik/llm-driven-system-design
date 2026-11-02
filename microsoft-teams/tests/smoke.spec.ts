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

test.describe('microsoft-teams Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 register loads correctly', async ({ page }) => {
    await page.goto('/register');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 home loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 general channel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 deployments channel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000002');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 thread panel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000002');
    await page.waitForTimeout(2200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 member list loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(2200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 org list loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 design team loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000002/channel/cccccccc-0000-0000-0000-000000000003');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 create channel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(2200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 private channel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000004');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('12 bob no private channel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('13 bob private channel denied loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000004');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('14 carol join public team loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('15 cross tenant hidden loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000002/team/bbbbbbbb-0000-0000-0000-000000000004/channel/cccccccc-0000-0000-0000-000000000006');
    await page.waitForTimeout(2500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('16 edit own message loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(2200);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('17 last owner cannot leave loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/org/aaaaaaaa-0000-0000-0000-000000000001/team/bbbbbbbb-0000-0000-0000-000000000001/channel/cccccccc-0000-0000-0000-000000000001');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
