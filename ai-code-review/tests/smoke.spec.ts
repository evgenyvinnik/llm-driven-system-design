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

test.describe('ai-code-review Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 pr queue loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Pull requests\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 injection refused loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/23');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Gate checklist\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 approval invalidated by push loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/30');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Timeline\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 rename evades path check loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/13');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Gate checklist\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 safe docs approved loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/7');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Gate checklist\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 secret read denied loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/27');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Tool requests\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 malformed fails closed loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/32');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Gate checklist\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 human approval invalidated loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/web-app/37');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Timeline\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 observe shadow loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prs/acme/payments-api/3');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Gate checklist\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 escalation queue loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/escalations');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Escalations\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('12 audit log loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/audit');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Audit log\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('13 evaluation loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/evaluation');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Model only\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('14 settings promoted loads correctly', async ({ page }) => {
    await login(page, 'carol', 'password123');
    await page.goto('/settings?repo=repo_web');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Promotion checks\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('15 settings demoted loads correctly', async ({ page }) => {
    await login(page, 'carol', 'password123');
    await page.goto('/settings?repo=repo_mob');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Promotion checks\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('16 fixture panel loads correctly', async ({ page }) => {
    await login(page, 'carol', 'password123');
    await page.goto('/fixtures');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Mock model\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('17 other org loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/prs');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Pull requests\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
