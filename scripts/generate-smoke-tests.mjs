#!/usr/bin/env node
/**
 * Generate Playwright smoke tests for frontend projects.
 * Uses existing screenshot configs to create per-project test files.
 *
 * Usage:
 *   node scripts/generate-smoke-tests.mjs              # Generate for all projects
 *   node scripts/generate-smoke-tests.mjs bitly        # Generate for specific project
 *   node scripts/generate-smoke-tests.mjs --list       # List available configs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configDir = path.join(__dirname, 'screenshot-configs');

// CLI argument parsing
const args = process.argv.slice(2);
const isList = args.includes('--list');
const projectArgs = args.filter(arg => !arg.startsWith('--'));

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logWarning(message) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

/**
 * Load all available project configurations
 */
function loadConfigs() {
  if (!fs.existsSync(configDir)) {
    return [];
  }

  return fs.readdirSync(configDir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const configPath = path.join(configDir, file);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { ...config, _file: file };
    });
}

/**
 * Generate playwright.config.ts content
 */
function generatePlaywrightConfig(config) {
  const viewport = config.viewport || { width: 1280, height: 800 };

  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:${config.frontendPort || 5173}',
    trace: 'on-first-retry',
    headless: true,
    viewport: { width: ${viewport.width}, height: ${viewport.height} },
  },
  // webServer is conditionally enabled:
  // - Disabled when SKIP_WEBSERVER=1 (when run via 'npm run test:smoke')
  // - Enabled when running 'npm run test:e2e' directly in the project
  ...(process.env.SKIP_WEBSERVER ? {} : {
    webServer: {
      command: 'npm run dev',
      url: 'http://localhost:${config.frontendPort || 5173}',
      reuseExistingServer: true,
      timeout: 120000,
      cwd: './frontend',
    },
  }),
});
`;
}

/**
 * Generate smoke.spec.ts content
 */
function generateSmokeTests(config) {
  const lines = [];

  lines.push(`import { test, expect, Page } from '@playwright/test';`);
  lines.push('');

  // Add auth helper if needed
  if (config.auth?.enabled) {
    const creds = config.auth.credentials || {};
    const usernameValue = creds.username || creds.email || 'alice@example.com';
    const usernameSelector = config.auth.usernameSelector || "input[name='email'], input[name='username'], input[type='email']";
    const passwordSelector = config.auth.passwordSelector || "input[name='password'], input[type='password']";
    const submitSelector = config.auth.submitSelector || "button[type='submit']";

    lines.push(`/**`);
    lines.push(` * Login helper function`);
    lines.push(` */`);
    lines.push(`async function login(page: Page) {`);
    lines.push(`  await page.goto('${config.auth.loginUrl || '/login'}');`);
    lines.push(`  await page.locator("${usernameSelector}").first().fill('${usernameValue}');`);
    lines.push(`  await page.locator("${passwordSelector}").first().fill('${creds.password || 'password123'}');`);
    lines.push(`  await page.locator("${submitSelector}").first().click();`);
    lines.push(`  // Wait for navigation after login`);
    lines.push(`  await page.waitForURL(/(?!.*login).*/);`);
    lines.push(`}`);
    lines.push('');
  }

  lines.push(`test.describe('${config.name} Smoke Tests', () => {`);

  // Generate a test for each screen
  for (const screen of config.screens || []) {
    const testName = screen.name.replace(/-/g, ' ');
    const needsAuth = config.auth?.enabled && !screen.skipAuth;
    const waitForSelector = (screen.waitFor?.split(',')[0]?.trim() || 'main').replace(/'/g, "\\'");

    lines.push('');
    lines.push(`  test('${testName} loads correctly', async ({ page }) => {`);

    if (needsAuth) {
      lines.push(`    await login(page);`);
    }

    lines.push(`    await page.goto('${screen.path}');`);

    // Wait for selector if specified
    if (screen.delay) {
      lines.push(`    await page.waitForTimeout(${screen.delay});`);
    }

    lines.push('');
    lines.push(`    // Verify page content loads`);
    lines.push(`    await expect(page.locator('${waitForSelector}')).toBeVisible({ timeout: 10000 });`);
    lines.push('');
    lines.push(`    // Verify no React error boundary`);
    lines.push(`    await expect(page.locator('text=Something went wrong')).not.toBeVisible();`);
    lines.push(`    await expect(page.locator('text=Error boundary')).not.toBeVisible();`);

    lines.push(`  });`);
  }

  lines.push('');
  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Update or create package.json with test scripts
 */
function updatePackageJson(projectDir, config) {
  const pkgPath = path.join(projectDir, 'package.json');

  let pkg;
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } else {
    // Create minimal package.json for test running
    pkg = {
      name: `${config.name}-tests`,
      private: true,
      scripts: {},
      devDependencies: {},
    };
  }

  // Add test scripts
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['test:e2e'] = 'playwright test';
  pkg.scripts['test:e2e:ui'] = 'playwright test --ui';

  // Add devDependencies
  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies['@playwright/test'] = '^1.49.0';

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return true;
}

/**
 * Generate tests for a single project
 */
function generateForProject(config) {
  const projectDir = path.join(repoRoot, config.name);

  // Check if project exists
  if (!fs.existsSync(projectDir)) {
    logError(`Project directory not found: ${config.name}`);
    return false;
  }

  // Check if frontend exists
  const frontendDir = path.join(projectDir, 'frontend');
  if (!fs.existsSync(frontendDir)) {
    logWarning(`No frontend directory in ${config.name}, skipping`);
    return false;
  }

  log(`\nGenerating tests for ${config.name}...`, 'cyan');

  // Create tests directory
  const testsDir = path.join(projectDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });

  // Generate smoke.spec.ts
  const smokeTestContent = generateSmokeTests(config);
  const smokeTestPath = path.join(testsDir, 'smoke.spec.ts');
  fs.writeFileSync(smokeTestPath, smokeTestContent);
  logSuccess(`Created ${config.name}/tests/smoke.spec.ts`);

  // Generate playwright.config.ts
  const playwrightConfigContent = generatePlaywrightConfig(config);
  const playwrightConfigPath = path.join(projectDir, 'playwright.config.ts');
  fs.writeFileSync(playwrightConfigPath, playwrightConfigContent);
  logSuccess(`Created ${config.name}/playwright.config.ts`);

  // Update package.json
  if (updatePackageJson(projectDir, config)) {
    logSuccess(`Created/updated ${config.name}/package.json with test scripts`);
  }

  return true;
}

/**
 * Main function
 */
async function main() {
  console.log('\n🧪 Playwright Smoke Test Generator\n');

  // Load configurations
  const configs = loadConfigs();

  if (configs.length === 0) {
    logError('No screenshot configurations found in scripts/screenshot-configs/');
    process.exit(1);
  }

  // List mode
  if (isList) {
    log('Available configurations:', 'cyan');
    configs.forEach(config => {
      log(`  • ${config.name} (${config.screens?.length || 0} screens)`);
    });
    return;
  }

  // Determine which projects to process
  let projectsToProcess;
  if (projectArgs.length > 0) {
    projectsToProcess = configs.filter(c => projectArgs.includes(c.name));
    const notFound = projectArgs.filter(p => !configs.find(c => c.name === p));
    if (notFound.length > 0) {
      logError(`Configuration not found for: ${notFound.join(', ')}`);
      log('Available: ' + configs.map(c => c.name).join(', '), 'dim');
      process.exit(1);
    }
  } else {
    projectsToProcess = configs;
  }

  let successCount = 0;
  let skipCount = 0;

  for (const config of projectsToProcess) {
    const result = generateForProject(config);
    if (result) {
      successCount++;
    } else {
      skipCount++;
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  log('Summary', 'cyan');
  console.log('═'.repeat(60));
  log(`Generated: ${successCount} projects`, 'green');
  if (skipCount > 0) {
    log(`Skipped: ${skipCount} projects (no frontend)`, 'yellow');
  }

  console.log('\nTo run tests for a project:');
  log('  cd <project>', 'dim');
  log('  npm install', 'dim');
  log('  npx playwright install', 'dim');
  log('  npm run test:e2e', 'dim');
}

main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});
