import { test, expect, Page } from '@playwright/test';

/** Log in with the seeded demo user (login form is pre-filled, but we set it explicitly). */
async function login(page: Page) {
  await page.goto('/login');
  await page.locator("input[name='email'], input[type='email']").first().fill('alice@example.com');
  await page.locator("input[name='password'], input[type='password']").first().fill('password123');
  await page.locator("button[type='submit']").first().click();
  await page.waitForURL(/(?!.*login).*/);
}

test.describe('splitwise Smoke Tests', () => {
  test('01 login loads correctly', async ({ page }) => {
    await page.goto('/login');
    await page.waitForTimeout(500);
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('02 dashboard loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('03 groups loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/groups');
    await page.waitForTimeout(1000);
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('04 group detail loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/groups/11111111-1111-1111-1111-111111111111');
    await page.waitForTimeout(1200);
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });

  test('05 activity loads correctly', async ({ page }) => {
    await login(page);
    await page.goto('/activity');
    await page.waitForTimeout(1000);
    await expect(page.locator('main')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
  });
});
