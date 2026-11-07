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

test.describe('llm-eval-dashboard Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 runs loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Runs\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 run errored rescored loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_triage_v1');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Cases\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 run samples loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_triage_v2');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Cases\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 compare improvement loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare?a=run_triage_v1&b=run_triage_v2&scorer=sc_contains');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Verdict\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 compare not significant loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare?a=run_triage_v2&b=run_triage_v3&scorer=sc_exact');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Verdict\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 compare mixed datasets loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare?a=run_triage_v2_ds1&b=run_triage_v2&scorer=sc_exact');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Verdict\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 compare scorer mismatch loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare?a=run_triage_v2&b=run_triage_v3&scorer=sc_regex');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Verdict\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 compare confounded loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/compare?a=run_triage_v2&b=run_triage_v3_large&scorer=sc_exact');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Verdict\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 rescored orders loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_orders_v1');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Cases\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 annotation queue loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/annotate/run_status_v1');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Agreement\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('12 dataset diff loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/datasets/ds_triage');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Version diff\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('13 prompt versions loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/prompts/pr_triage');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Prompt versions\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('14 scorers loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/scorers');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Scorers\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('15 mock model loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/system');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Mock model\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('16 globex runs loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/runs');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Runs\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
