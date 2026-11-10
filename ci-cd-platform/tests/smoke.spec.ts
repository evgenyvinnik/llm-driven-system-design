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

test.describe('ci-cd-platform Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 repositories loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/repos');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Repositories\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 runs loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/repos/repo_webapp');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Runs\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 run success dag loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_success');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('svg[aria-label=\'Job graph\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 run failed skipped loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_failed');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('svg[aria-label=\'Job graph\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 run rerun attempts loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_rerun');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('svg[aria-label=\'Job graph\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 job attempt history loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_rerun/jobs/job_run_demo_rerun_test');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Attempts\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 run waiting approval loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_waiting');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[data-approval=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 run needs attention loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_attention');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[data-attention=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 job needs attention loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_attention/jobs/job_run_demo_attention_deploy');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[data-attention=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 job lease expired loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_lease/jobs/job_run_demo_lease_long-build');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Attempts\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('12 run fork withheld loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_fork');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Fork notice\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('13 job fork logs loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_fork/jobs/job_run_demo_fork_test');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Attempts\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('14 job masked logs loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_secrets/jobs/job_run_demo_secrets_print');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Attempts\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('15 run invalid loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runs/run_demo_invalid');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Workflow errors\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('16 secrets loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/repos/repo_webapp/secrets');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Secrets\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('17 environments loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/repos/repo_webapp/environments');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[aria-label=\'Environments\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('18 runners loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/runners');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Runners\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('19 ops loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ops');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Repository concurrency\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('20 fixture panel loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/fixtures');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Deliveries\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('21 carol read only loads correctly', async ({ page }) => {
    await login(page, 'carol', 'password123');
    await page.goto('/runs/run_demo_attention');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('[data-attention=\'true\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('22 bob other org loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/repos');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Repositories\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('23 admin ops loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/ops');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Repository concurrency\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
