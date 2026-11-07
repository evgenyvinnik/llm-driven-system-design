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

test.describe('document-qa Smoke Tests', () => {

  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 library loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/documents');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Documents\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 ask loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ask');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Answers\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 ask streaming loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ask');
    await page.waitForTimeout(300);

    // Verify page content loads
    await expect(page.locator('form[aria-label=\'Ask\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 citation highlight loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/ask');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Answers\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 document versions loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/documents');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Documents\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('07 document failed loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/documents');
    await page.waitForTimeout(500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Documents\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('08 carol not found loads correctly', async ({ page }) => {
    await login(page, 'carol', 'password123');
    await page.goto('/ask');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('ul[aria-label=\'Answers\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('09 groups loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/groups');
    await page.waitForTimeout(1000);

    // Verify page content loads
    await expect(page.locator('section[aria-label=\'Groups\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('10 globex library loads correctly', async ({ page }) => {
    await login(page, 'bob', 'password123');
    await page.goto('/documents');
    await page.waitForTimeout(1500);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Documents\'] tbody tr:first-child')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('11 ops loads correctly', async ({ page }) => {
    await login(page, 'admin', 'password123');
    await page.goto('/ops');
    await page.waitForTimeout(2000);

    // Verify page content loads
    await expect(page.locator('table[aria-label=\'Jobs by stage\']')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
