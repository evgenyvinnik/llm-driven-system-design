import { test, expect, Page } from '@playwright/test';

/**
 * Login helper function
 */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[name='email']").first().fill('alice@example.com');
  await page.locator("input[name='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  // Wait until the app leaves the login page, i.e. the sign-in request completed
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

test.describe('multi-org-dashboard Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 overview loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('text=Latest conversations')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 conversations loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/conversations?status=escalated');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('[data-conversation] >> nth=0')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 conversation detail loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/conversations?status=escalated');

    // Verify page content loads
    await expect(page.locator('[data-conversation] >> nth=0')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 org switcher loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/agents');

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 viewer in other org loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_harbor/conversations');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('[data-conversation] >> nth=0')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 forbidden deep link loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_harbor/billing');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'forbidden\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 prompt library loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/prompts');

    // Verify page content loads
    await expect(page.locator('text=Return policy tone')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 members loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/settings/members');
    await page.waitForTimeout(600);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 audit log loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/settings/audit');
    await page.waitForTimeout(600);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'audit-table\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 feature flags loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/settings/features');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-flag]')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('12 analytics loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/analytics');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('text=Conversations per day')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('13 export in progress loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/conversations');

    // Verify page content loads
    await expect(page.locator('[data-conversation] >> nth=0')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('14 exports loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_lumen/exports');
    await page.waitForTimeout(4000);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('15 shared link loads correctly', async ({ page }) => {
    await page.goto('/share/demo-lumen-return-policy-link');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('pre')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('16 org not found loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orgs/org_unknown');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[data-testid=\'org-not-found\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
