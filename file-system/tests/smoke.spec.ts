import { test, expect, Page } from '@playwright/test';

test.describe('file-system Smoke Tests', () => {

  test('01 root loads correctly', async ({ page }) => {
    await page.goto('/?path=/');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('02 home alice loads correctly', async ({ page }) => {
    await page.goto('/?path=/home/alice');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('03 quota refused loads correctly', async ({ page }) => {
    await page.goto('/?path=/home/dmitri');

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('04 users loads correctly', async ({ page }) => {
    await page.goto('/users');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('05 restore skipped loads correctly', async ({ page }) => {
    await page.goto('/users');

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

  test('06 shared loads correctly', async ({ page }) => {
    await page.goto('/?path=/shared');
    await page.waitForTimeout(800);

    // Verify page content loads
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 });

    // Verify no React error boundary
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('text=Error boundary')).not.toBeVisible();
  });

});
