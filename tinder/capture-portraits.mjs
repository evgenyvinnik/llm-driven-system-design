import { webkit } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, 'screenshots');

async function capturePortraits() {
  console.log('Launching browser...');
  const browser = await webkit.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    // 1. Capture login page
    console.log('Capturing login page...');
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('form', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(screenshotsDir, '01-login.png') });
    console.log('✓ Saved 01-login.png');

    // 2. Login as Alice
    console.log('Logging in as alice@example.com...');
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    // Wait for navigation to home page
    await page.waitForURL('http://localhost:5173/', { timeout: 10000 });
    await page.waitForSelector('main', { timeout: 10000 });
    await page.waitForTimeout(2000); // Wait for portraits to render

    // 3. Capture home page with portrait cards
    console.log('Capturing home page with ReignsAvatar portraits...');
    await page.screenshot({ path: path.join(screenshotsDir, '02-home-portraits.png') });
    console.log('✓ Saved 02-home-portraits.png');

    // 4. Navigate to matches
    console.log('Capturing matches page...');
    await page.goto('http://localhost:5173/matches');
    await page.waitForSelector('main', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotsDir, '03-matches.png') });
    console.log('✓ Saved 03-matches.png');

    // 5. Navigate to profile
    console.log('Capturing profile page...');
    await page.goto('http://localhost:5173/profile');
    await page.waitForSelector('main', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(screenshotsDir, '04-profile.png') });
    console.log('✓ Saved 04-profile.png');

    // 6. Navigate to preferences
    console.log('Capturing preferences page...');
    await page.goto('http://localhost:5173/preferences');
    await page.waitForSelector('main', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(screenshotsDir, '05-preferences.png') });
    console.log('✓ Saved 05-preferences.png');

    console.log('\n✅ All screenshots captured successfully!');
    console.log(`📁 Screenshots saved to: ${screenshotsDir}`);

  } catch (error) {
    console.error('Error capturing screenshots:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

capturePortraits().catch(console.error);
