#!/usr/bin/env node
/**
 * Screenshot automation script for frontend projects.
 * Uses Playwright to capture screenshots of key screens.
 *
 * Usage:
 *   node scripts/screenshots.mjs <project>     # Screenshot specific project
 *   node scripts/screenshots.mjs --all         # Screenshot all configured projects
 *   node scripts/screenshots.mjs --dry-run     # Show what would be captured
 *   node scripts/screenshots.mjs --list        # List available configs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configDir = path.join(__dirname, 'screenshot-configs');

// CLI argument parsing
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isAll = args.includes('--all');
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

function logStep(step, message) {
  console.log(`${colors.cyan}[${step}]${colors.reset} ${message}`);
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
 * Check if a URL is reachable
 */
async function isUrlReachable(url, timeout = 5000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok || response.status === 404; // 404 is ok, server is running
  } catch {
    return false;
  }
}

/**
 * Wait for frontend to be ready
 */
async function waitForFrontend(port, maxWait = 30000) {
  const url = `http://localhost:${port}`;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isUrlReachable(url)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return false;
}

/**
 * Perform login if authentication is required
 */
async function performLogin(page, config) {
  if (!config.auth?.enabled) {
    return true;
  }

  const { loginUrl, credentials, usernameSelector, passwordSelector, submitSelector, successIndicator } = config.auth;
  const baseUrl = `http://localhost:${config.frontendPort}`;

  logStep('AUTH', `Logging in as ${credentials.username || credentials.email}...`);

  try {
    await page.goto(`${baseUrl}${loginUrl}`, { waitUntil: 'networkidle' });

    // Fill in credentials
    if (usernameSelector) {
      await page.fill(usernameSelector, credentials.username || credentials.email);
    }
    if (passwordSelector) {
      await page.fill(passwordSelector, credentials.password);
    }

    // Submit the form
    await page.click(submitSelector);

    // Wait for success indicator or navigation
    if (successIndicator) {
      await page.waitForSelector(successIndicator, { timeout: 10000 });
    } else {
      await page.waitForLoadState('networkidle');
    }

    logSuccess('Login successful');
    return true;
  } catch (error) {
    logError(`Login failed: ${error.message}`);
    return false;
  }
}

/**
 * Capture a single screenshot
 */
async function captureScreen(page, screen, config, outputDir) {
  const baseUrl = `http://localhost:${config.frontendPort}`;
  const screenshotPath = path.join(outputDir, `${screen.name}.png`);

  logStep('CAPTURE', `${screen.name} (${screen.path})`);

  try {
    // Navigate to the screen
    await page.goto(`${baseUrl}${screen.path}`, { waitUntil: 'networkidle' });

    // Wait for specific element if specified
    if (screen.waitFor) {
      try {
        await page.waitForSelector(screen.waitFor, { timeout: 10000 });
      } catch {
        logWarning(`Selector "${screen.waitFor}" not found, capturing anyway`);
      }
    }

    // Additional delay for animations/loading
    if (screen.delay) {
      await page.waitForTimeout(screen.delay);
    } else {
      await page.waitForTimeout(500); // Default small delay
    }

    // Take screenshot
    await page.screenshot({
      path: screenshotPath,
      fullPage: screen.fullPage || false,
    });

    logSuccess(`Saved: ${screen.name}.png`);
    return true;
  } catch (error) {
    logError(`Failed: ${error.message}`);
    return false;
  }
}

/**
 * Process a single project
 */
async function processProject(config, browser) {
  const projectDir = path.join(repoRoot, config.name);
  const outputDir = path.join(projectDir, 'screenshots');

  log(`\n${'═'.repeat(60)}`, 'cyan');
  log(`  📸 ${config.name.toUpperCase()}`, 'cyan');
  log(`${'═'.repeat(60)}`, 'cyan');

  // Check if project exists
  if (!fs.existsSync(projectDir)) {
    logError(`Project directory not found: ${config.name}`);
    return { project: config.name, success: false, reason: 'Project not found' };
  }

  // Check if frontend is running
  const frontendReady = await isUrlReachable(`http://localhost:${config.frontendPort}`);
  if (!frontendReady) {
    logError(`Frontend not running on port ${config.frontendPort}`);
    logWarning(`Start with: cd ${config.name}/frontend && npm run dev`);
    return { project: config.name, success: false, reason: 'Frontend not running' };
  }

  logSuccess(`Frontend detected on port ${config.frontendPort}`);

  // Create output directory
  if (!isDryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create browser context
  const context = await browser.newContext({
    viewport: config.viewport || { width: 1280, height: 720 },
    deviceScaleFactor: 2, // Retina screenshots
  });

  const page = await context.newPage();
  let screenshotsTaken = 0;
  let screenshotsFailed = 0;

  try {
    // Handle authentication for screens that need it
    let isAuthenticated = false;

    for (const screen of config.screens) {
      if (isDryRun) {
        log(`  Would capture: ${screen.name} (${screen.path})`, 'dim');
        continue;
      }

      // Login if needed and not already authenticated
      if (!screen.skipAuth && config.auth?.enabled && !isAuthenticated) {
        isAuthenticated = await performLogin(page, config);
        if (!isAuthenticated) {
          logWarning('Continuing with unauthenticated screens only');
        }
      }

      // Skip authenticated screens if login failed
      if (!screen.skipAuth && config.auth?.enabled && !isAuthenticated) {
        logWarning(`Skipping ${screen.name} (requires auth)`);
        screenshotsFailed++;
        continue;
      }

      const success = await captureScreen(page, screen, config, outputDir);
      if (success) {
        screenshotsTaken++;
      } else {
        screenshotsFailed++;
      }
    }
  } finally {
    await context.close();
  }

  if (isDryRun) {
    log(`\nDry run: Would capture ${config.screens.length} screenshots`, 'yellow');
  } else {
    log(`\nResults: ${screenshotsTaken} captured, ${screenshotsFailed} failed`, screenshotsFailed > 0 ? 'yellow' : 'green');
    if (screenshotsTaken > 0) {
      log(`Screenshots saved to: ${config.name}/screenshots/`, 'dim');
    }
  }

  return {
    project: config.name,
    success: screenshotsFailed === 0,
    captured: screenshotsTaken,
    failed: screenshotsFailed,
  };
}

/**
 * Main function
 */
async function main() {
  console.log('\n📸 Screenshot Automation Tool\n');

  // Load configurations
  const configs = loadConfigs();

  if (configs.length === 0) {
    logError('No screenshot configurations found in scripts/screenshot-configs/');
    logWarning('Create a JSON config file for your project first.');
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
  if (isAll) {
    projectsToProcess = configs;
  } else if (projectArgs.length > 0) {
    projectsToProcess = configs.filter(c => projectArgs.includes(c.name));
    const notFound = projectArgs.filter(p => !configs.find(c => c.name === p));
    if (notFound.length > 0) {
      logError(`Configuration not found for: ${notFound.join(', ')}`);
      log('Available: ' + configs.map(c => c.name).join(', '), 'dim');
      process.exit(1);
    }
  } else {
    log('Usage:', 'cyan');
    log('  node scripts/screenshots.mjs <project>     # Screenshot specific project');
    log('  node scripts/screenshots.mjs --all         # Screenshot all projects');
    log('  node scripts/screenshots.mjs --list        # List available configs');
    log('  node scripts/screenshots.mjs --dry-run     # Show what would be captured');
    log('\nAvailable projects: ' + configs.map(c => c.name).join(', '), 'dim');
    return;
  }

  if (isDryRun) {
    log('DRY RUN MODE - No screenshots will be saved\n', 'yellow');
  }

  // Launch browser
  log('Launching browser...', 'dim');
  const browser = await chromium.launch({
    headless: true,
  });

  const results = [];

  try {
    for (const config of projectsToProcess) {
      const result = await processProject(config, browser);
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  log('Summary', 'cyan');
  console.log('═'.repeat(60));

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    log(`✓ Successful: ${successful.map(r => r.project).join(', ')}`, 'green');
  }
  if (failed.length > 0) {
    log(`✗ Failed: ${failed.map(r => `${r.project} (${r.reason || 'errors'})`).join(', ')}`, 'red');
  }

  const totalCaptured = results.reduce((sum, r) => sum + (r.captured || 0), 0);
  const totalFailed = results.reduce((sum, r) => sum + (r.failed || 0), 0);

  if (!isDryRun) {
    log(`\nTotal: ${totalCaptured} screenshots captured, ${totalFailed} failed`, 'cyan');
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});
