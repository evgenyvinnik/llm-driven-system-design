#!/usr/bin/env node
/**
 * Screenshot automation script for frontend projects.
 * Uses Playwright to capture screenshots of key screens.
 *
 * Usage:
 *   node scripts/screenshots.mjs <project>                  # Screenshot (frontend must be running)
 *   node scripts/screenshots.mjs --start <project>          # Auto-start frontend, screenshot, then stop
 *   node scripts/screenshots.mjs --start --all              # Auto-screenshot all projects
 *   node scripts/screenshots.mjs --dry-run <project>        # Show what would be captured
 *   node scripts/screenshots.mjs --list                     # List available configs
 *
 * Requirements:
 *   - Playwright installed: npm install playwright
 *   - Frontend dev server must be running (or use --start flag)
 *   - Projects run in Docker - only one at a time (stop previous before starting new)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
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
const shouldStart = args.includes('--start');
const projectArgs = args.filter(arg => !arg.startsWith('--'));

// Track spawned processes for cleanup
const spawnedProcesses = [];

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
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Wait for frontend to be ready
 */
async function waitForFrontend(port, maxWait = 60000) {
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
 * Check if docker-compose is available and Docker is running
 */
function hasDockerCompose(projectDir) {
  return fs.existsSync(path.join(projectDir, 'docker-compose.yml')) ||
         fs.existsSync(path.join(projectDir, 'docker-compose.yaml'));
}

function isDockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start docker-compose services
 * @returns {boolean} true if docker was started by this function
 */
async function startDockerCompose(projectDir, projectName) {
  if (!hasDockerCompose(projectDir)) {
    return false;
  }

  if (!isDockerRunning()) {
    logWarning('Docker is not running, skipping docker-compose');
    return false;
  }

  logStep('DOCKER', `Starting infrastructure for ${projectName}...`);

  try {
    execSync('docker-compose up -d', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    logSuccess('Docker services started');
    // Wait for services to be healthy
    await new Promise(resolve => setTimeout(resolve, 5000));
    return true;
  } catch (error) {
    logWarning(`Docker-compose failed: ${error.message}`);
    return false;
  }
}

/**
 * Stop docker-compose services
 */
function stopDockerCompose(projectDir, projectName) {
  if (!hasDockerCompose(projectDir)) {
    return;
  }

  if (!isDockerRunning()) {
    return;
  }

  logStep('DOCKER', `Stopping infrastructure for ${projectName}...`);

  try {
    execSync('docker-compose down', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    logSuccess('Docker services stopped');
  } catch (error) {
    logWarning(`Docker-compose stop failed: ${error.message}`);
  }
}

/**
 * Install frontend dependencies if needed
 */
async function installDeps(dir, name = 'frontend') {
  const nodeModulesPath = path.join(dir, 'node_modules');

  if (fs.existsSync(nodeModulesPath)) {
    return true;
  }

  logStep('NPM', `Installing ${name} dependencies...`);

  try {
    execSync('npm install', {
      cwd: dir,
      stdio: 'pipe',
    });
    logSuccess(`${name} dependencies installed`);
    return true;
  } catch (error) {
    logError(`npm install failed for ${name}: ${error.message}`);
    return false;
  }
}

/**
 * Start the backend dev server
 */
async function startBackend(projectDir, config) {
  const backendDir = path.join(projectDir, 'backend');

  if (!fs.existsSync(backendDir)) {
    logWarning(`Backend directory not found: ${backendDir}`);
    return null;
  }

  const depsInstalled = await installDeps(backendDir, 'backend');
  if (!depsInstalled) {
    return null;
  }

  // Run migrations if db:migrate script exists
  const pkgJsonPath = path.join(backendDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    if (pkgJson.scripts?.['db:migrate']) {
      logStep('DB', 'Running database migrations...');
      try {
        execSync('npm run db:migrate', {
          cwd: backendDir,
          stdio: 'pipe',
        });
        logSuccess('Migrations complete');
      } catch (error) {
        logWarning(`Migration failed: ${error.message}`);
      }
    }
  }

  logStep('START', 'Starting backend...');

  const child = spawn('npm', ['run', 'dev'], {
    cwd: backendDir,
    stdio: 'pipe',
    detached: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  spawnedProcesses.push({ process: child, name: `${config.name} backend` });

  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('ExperimentalWarning') && msg.toLowerCase().includes('error')) {
      logWarning(`Backend stderr: ${msg}`);
    }
  });

  // Wait for backend to be ready (check port 3000)
  const backendPort = config.backendPort || 3000;
  const backendUrl = `http://localhost:${backendPort}`;
  const startTime = Date.now();
  const maxWait = 30000;

  while (Date.now() - startTime < maxWait) {
    if (await isUrlReachable(backendUrl)) {
      logSuccess(`Backend ready on port ${backendPort}`);
      return child;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logWarning('Backend may not be fully ready, continuing anyway...');
  return child;
}

/**
 * Start the frontend dev server
 */
async function startFrontend(projectDir, config) {
  const frontendDir = path.join(projectDir, 'frontend');

  if (!fs.existsSync(frontendDir)) {
    logError(`Frontend directory not found: ${frontendDir}`);
    return null;
  }

  const depsInstalled = await installFrontendDeps(frontendDir);
  if (!depsInstalled) {
    return null;
  }

  logStep('START', `Starting frontend on port ${config.frontendPort}...`);

  const child = spawn('npm', ['run', 'dev'], {
    cwd: frontendDir,
    stdio: 'pipe',
    detached: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  spawnedProcesses.push({ process: child, name: `${config.name} frontend` });

  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('ExperimentalWarning') && msg.toLowerCase().includes('error')) {
      logWarning(`Frontend stderr: ${msg}`);
    }
  });

  const ready = await waitForFrontend(config.frontendPort, 60000);

  if (ready) {
    logSuccess(`Frontend ready on port ${config.frontendPort}`);
    return child;
  } else {
    logError('Frontend failed to start within 60 seconds');
    return null;
  }
}

/**
 * Stop all spawned processes
 */
function cleanup() {
  for (const { process: child, name } of spawnedProcesses) {
    if (child && !child.killed) {
      logStep('STOP', `Stopping ${name}...`);
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Process may have already exited
      }
    }
  }
  spawnedProcesses.length = 0;
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  log('\nInterrupted, cleaning up...', 'yellow');
  cleanup();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

process.on('exit', () => {
  cleanup();
});

/**
 * Capture screenshots using Playwright
 */
async function captureWithPlaywright(config, outputDir) {
  const baseUrl = `http://localhost:${config.frontendPort}`;

  logStep('BROWSER', 'Launching Chrome...');

  let browser;
  try {
    // Use installed Chrome via channel option (more stable on macOS)
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });
  } catch (error) {
    logError(`Failed to launch browser: ${error.message}`);
    logWarning('Make sure Google Chrome is installed');
    return { success: false, captured: 0, failed: config.screens.length };
  }

  const context = await browser.newContext({
    viewport: {
      width: config.viewport?.width || 1280,
      height: config.viewport?.height || 720,
    },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  let successCount = 0;
  let failCount = 0;
  let isLoggedIn = false;

  // Login function for authenticated screens
  async function ensureLoggedIn() {
    if (!config.auth?.enabled || isLoggedIn) return;

    const auth = config.auth;
    logStep('AUTH', 'Logging in...');

    try {
      await page.goto(`${baseUrl}${auth.loginUrl}`, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for and fill username/email field
      const usernameSelector = auth.usernameSelector || 'input[name="username"], input[name="email"], input[type="email"], input[type="text"]';
      await page.waitForSelector(usernameSelector, { timeout: 10000 });
      await page.fill(usernameSelector, auth.credentials.username || auth.credentials.email);

      // Fill password field
      const passwordSelector = auth.passwordSelector || 'input[name="password"], input[type="password"]';
      await page.fill(passwordSelector, auth.credentials.password);

      // Click submit
      const submitSelector = auth.submitSelector || 'button[type="submit"]';
      await page.click(submitSelector);

      // Wait for success indicator or navigation
      if (auth.successIndicator) {
        await page.waitForSelector(auth.successIndicator, { timeout: 10000 });
      } else {
        await page.waitForLoadState('networkidle');
      }

      logSuccess('Login successful');
      isLoggedIn = true;
    } catch (error) {
      logError(`Login failed: ${error.message}`);
      throw error;
    }
  }

  // Capture each screen
  for (const screen of config.screens) {
    try {
      // Handle auth if needed
      if (!screen.skipAuth && config.auth?.enabled) {
        await ensureLoggedIn();
      }

      logStep('CAPTURE', `${screen.name} (${screen.path})`);

      await page.goto(`${baseUrl}${screen.path}`, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for specific selector if specified
      if (screen.waitFor) {
        try {
          // Handle comma-separated selectors (try first one that exists)
          const selectors = screen.waitFor.split(',').map(s => s.trim());
          let found = false;
          for (const selector of selectors) {
            try {
              await page.waitForSelector(selector, { timeout: 5000 });
              found = true;
              break;
            } catch {
              // Try next selector
            }
          }
          if (!found) {
            logWarning(`Selector not found: ${screen.waitFor}`);
          }
        } catch {
          logWarning(`Selector not found: ${screen.waitFor}`);
        }
      }

      // Additional delay if specified
      if (screen.delay) {
        await page.waitForTimeout(screen.delay);
      }

      // Take screenshot
      const screenshotPath = path.join(outputDir, `${screen.name}.png`);
      await page.screenshot({
        path: screenshotPath,
        fullPage: screen.fullPage || false,
      });

      logSuccess(`Saved: ${screen.name}.png`);
      successCount++;
    } catch (error) {
      logError(`Failed: ${screen.name} - ${error.message}`);
      failCount++;
    }
  }

  await browser.close();

  log(`Results: ${successCount} captured, ${failCount} failed`, 'cyan');

  return { success: failCount === 0, captured: successCount, failed: failCount };
}

/**
 * Process a single project
 */
async function processProject(config) {
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

  let frontendProcess = null;

  // Auto-start mode
  if (shouldStart) {
    await startDockerCompose(projectDir, config.name);

    const alreadyRunning = await isUrlReachable(`http://localhost:${config.frontendPort}`);
    if (alreadyRunning) {
      logSuccess(`Frontend already running on port ${config.frontendPort}`);
    } else {
      frontendProcess = await startFrontend(projectDir, config);
      if (!frontendProcess) {
        return { project: config.name, success: false, reason: 'Failed to start frontend' };
      }
    }
  } else {
    const frontendReady = await isUrlReachable(`http://localhost:${config.frontendPort}`);
    if (!frontendReady) {
      logError(`Frontend not running on port ${config.frontendPort}`);
      logWarning(`Start with: cd ${config.name}/frontend && npm run dev`);
      logWarning(`Or use --start flag: node scripts/screenshots.mjs --start ${config.name}`);
      return { project: config.name, success: false, reason: 'Frontend not running' };
    }
    logSuccess(`Frontend detected on port ${config.frontendPort}`);
  }

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  if (isDryRun) {
    log('\nDry run - would capture:', 'yellow');
    config.screens.forEach(screen => {
      log(`  • ${screen.name} (${screen.path})`, 'dim');
    });
    return { project: config.name, success: true, captured: 0, failed: 0 };
  }

  // Capture screenshots using Playwright
  const result = await captureWithPlaywright(config, outputDir);

  // Stop frontend if we started it
  if (frontendProcess && !frontendProcess.killed) {
    logStep('STOP', `Stopping ${config.name} frontend...`);
    try {
      if (process.platform !== 'win32') {
        process.kill(-frontendProcess.pid, 'SIGTERM');
      } else {
        frontendProcess.kill('SIGTERM');
      }
      const idx = spawnedProcesses.findIndex(p => p.process === frontendProcess);
      if (idx >= 0) spawnedProcesses.splice(idx, 1);
    } catch {}
  }

  if (result.success) {
    log(`\nScreenshots saved to: ${config.name}/screenshots/`, 'dim');
  }

  return {
    project: config.name,
    success: result.success,
    captured: result.captured,
    failed: result.failed,
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
    log('  node scripts/screenshots.mjs <project>             # Screenshot (frontend must be running)');
    log('  node scripts/screenshots.mjs --start <project>     # Auto-start frontend, screenshot, then stop');
    log('  node scripts/screenshots.mjs --start --all         # Auto-screenshot all projects');
    log('  node scripts/screenshots.mjs --list                # List available configs');
    log('  node scripts/screenshots.mjs --dry-run <project>   # Show what would be captured');
    log('\nAvailable projects: ' + configs.map(c => c.name).join(', '), 'dim');
    return;
  }

  if (isDryRun) {
    log('DRY RUN MODE - No screenshots will be saved\n', 'yellow');
  }

  const results = [];

  for (const config of projectsToProcess) {
    const result = await processProject(config);
    results.push(result);
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
