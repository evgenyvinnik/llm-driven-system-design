import { test, expect, Page } from '@playwright/test';

/** Signs in as alice (security engineer) and waits until the app leaves the login page. */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[name='username']").first().fill('alice');
  await page.locator("input[name='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15000 });
}

test.describe('storage-remediation Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator("form").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('02 posture loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/posture');
    await expect(page.locator("text=Controls").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('03 findings loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/findings?control=SA-02');
    await expect(page.locator("table[aria-label='Findings']").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('04 campaigns loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/campaigns');
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('05 exceptions loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/exceptions');
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('06 controls loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/controls');
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('07 audit loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/audit');
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });
});
