#!/usr/bin/env node
/**
 * Screenshot automation script for frontend projects.
 * Uses Puppeteer in Docker to capture screenshots reliably on macOS.
 *
 * Usage:
 *   node scripts/screenshots.mjs <project>                  # Screenshot (frontend must be running)
 *   node scripts/screenshots.mjs --start <project>          # Auto-start frontend, screenshot, then stop
 *   node scripts/screenshots.mjs --start --all              # Auto-screenshot all projects
 *   node scripts/screenshots.mjs --dry-run <project>        # Show what would be captured
 *   node scripts/screenshots.mjs --list                     # List available configs
 *
 * Requirements:
 *   - Docker must be running
 *   - Frontend dev server must be running (or use --start flag)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configDir = path.join(__dirname, 'screenshot-configs');

// Docker image for Puppeteer
const PUPPETEER_IMAGE = 'ghcr.io/puppeteer/puppeteer:latest';

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
 * Check if Docker is running
 */
function isDockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
 * Check if docker-compose is available
 */
function hasDockerCompose(projectDir) {
  return fs.existsSync(path.join(projectDir, 'docker-compose.yml')) ||
         fs.existsSync(path.join(projectDir, 'docker-compose.yaml'));
}

/**
 * Start docker-compose services
 */
async function startDockerCompose(projectDir, projectName) {
  if (!hasDockerCompose(projectDir)) {
    return true;
  }

  if (!isDockerRunning()) {
    logWarning('Docker is not running, skipping docker-compose');
    return true;
  }

  logStep('DOCKER', `Starting infrastructure for ${projectName}...`);

  try {
    execSync('docker-compose up -d', {
      cwd: projectDir,
      stdio: 'pipe',
    });
    logSuccess('Docker services started');
    await new Promise(resolve => setTimeout(resolve, 3000));
    return true;
  } catch (error) {
    logWarning(`Docker-compose failed: ${error.message}`);
    return true;
  }
}

/**
 * Install frontend dependencies if needed
 */
async function installFrontendDeps(frontendDir) {
  const nodeModulesPath = path.join(frontendDir, 'node_modules');

  if (fs.existsSync(nodeModulesPath)) {
    return true;
  }

  logStep('NPM', 'Installing frontend dependencies...');

  try {
    execSync('npm install', {
      cwd: frontendDir,
      stdio: 'pipe',
    });
    logSuccess('Dependencies installed');
    return true;
  } catch (error) {
    logError(`npm install failed: ${error.message}`);
    return false;
  }
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
 * Generate Puppeteer script for Docker
 */
function generatePuppeteerScript(config, screens) {
  const baseUrl = `http://host.docker.internal:${config.frontendPort}`;

  const screensToCapture = screens.map(screen => ({
    name: screen.name,
    url: `${baseUrl}${screen.path}`,
    waitFor: screen.waitFor || null,
    delay: screen.delay || 500,
    fullPage: screen.fullPage || false,
  }));

  // Helper to escape strings for JavaScript
  const escapeJS = (str) => str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Generate auth logic if needed
  let authCode = '';
  if (config.auth?.enabled) {
    const auth = config.auth;
    const usernameSelector = escapeJS(auth.usernameSelector);
    const passwordSelector = escapeJS(auth.passwordSelector);
    const submitSelector = escapeJS(auth.submitSelector);
    const successIndicator = auth.successIndicator ? escapeJS(auth.successIndicator) : null;
    const username = escapeJS(auth.credentials.username || auth.credentials.email);
    const password = escapeJS(auth.credentials.password);
    const loginUrl = escapeJS(auth.loginUrl);

    authCode = `
    // Perform login
    console.log('Logging in...');
    await page.goto('${baseUrl}${loginUrl}', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('${usernameSelector}', { timeout: 10000 });
    await page.type('${usernameSelector}', '${username}');
    await page.type('${passwordSelector}', '${password}');
    await page.click('${submitSelector}');
    ${successIndicator ? `await page.waitForSelector('${successIndicator}', { timeout: 10000 });` : 'await page.waitForNavigation({ waitUntil: "networkidle0" });'}
    console.log('Login successful');
    `;
  }

  return `
const puppeteer = require('puppeteer');

const screens = ${JSON.stringify(screensToCapture, null, 2)};

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({
    width: ${config.viewport?.width || 1280},
    height: ${config.viewport?.height || 720},
    deviceScaleFactor: 2
  });

  let successCount = 0;
  let failCount = 0;

  try {
    ${authCode}

    for (const screen of screens) {
      try {
        console.log('Capturing: ' + screen.name + ' (' + screen.url + ')');
        await page.goto(screen.url, { waitUntil: 'networkidle0', timeout: 30000 });

        if (screen.waitFor) {
          try {
            await page.waitForSelector(screen.waitFor, { timeout: 10000 });
          } catch (e) {
            console.log('Warning: selector not found: ' + screen.waitFor);
          }
        }

        await new Promise(r => setTimeout(r, screen.delay));

        await page.screenshot({
          path: '/screenshots/' + screen.name + '.png',
          fullPage: screen.fullPage
        });

        console.log('Saved: ' + screen.name + '.png');
        successCount++;
      } catch (e) {
        console.error('Failed: ' + screen.name + ' - ' + e.message);
        failCount++;
      }
    }
  } finally {
    await browser.close();
  }

  console.log('Results: ' + successCount + ' captured, ' + failCount + ' failed');
  process.exit(failCount > 0 ? 1 : 0);
})().catch(e => {
  console.error('Fatal error: ' + e.message);
  process.exit(1);
});
`;
}

/**
 * Capture screenshots using Docker
 */
async function captureWithDocker(config, outputDir) {
  // Filter screens based on auth
  const screens = config.screens.filter(screen => {
    if (!config.auth?.enabled) return true;
    return screen.skipAuth || true; // Include all if auth is configured
  });

  const script = generatePuppeteerScript(config, screens);

  logStep('DOCKER', 'Running Puppeteer in Docker...');

  return new Promise((resolve) => {
    // Pass script via -e flag to avoid module resolution issues
    const dockerArgs = [
      'run', '--rm',
      '-v', `${outputDir}:/screenshots`,
      '--add-host=host.docker.internal:host-gateway',
      PUPPETEER_IMAGE,
      'node', '-e', script
    ];

    const dockerProcess = spawn('docker', dockerArgs, {
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    dockerProcess.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        stdout += line + '\n';
        if (line.startsWith('Saved:')) {
          logSuccess(line);
        } else if (line.startsWith('Failed:')) {
          logError(line);
        } else if (line.startsWith('Warning:')) {
          logWarning(line);
        } else if (line.includes('Capturing:')) {
          logStep('CAPTURE', line.replace('Capturing: ', ''));
        } else if (line.startsWith('Results:')) {
          log(line, 'cyan');
        }
      });
    });

    dockerProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    dockerProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        if (stderr) {
          // Filter out Docker platform warnings
          const filteredStderr = stderr.split('\n')
            .filter(line => !line.includes('WARNING') && !line.includes('requested image'))
            .join('\n').trim();
          if (filteredStderr) logError(filteredStderr);
        }
        resolve({ success: false, stdout, stderr });
      }
    });
  });
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

  // Capture screenshots using Docker
  const result = await captureWithDocker(config, outputDir);

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
    captured: config.screens.length,
    failed: result.success ? 0 : config.screens.length,
  };
}

/**
 * Main function
 */
async function main() {
  console.log('\n📸 Screenshot Automation Tool\n');

  // Check Docker
  if (!isDockerRunning()) {
    logError('Docker is not running. Please start Docker Desktop first.');
    process.exit(1);
  }

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
    log('\nRequirements: Docker must be running', 'dim');
    log('Available projects: ' + configs.map(c => c.name).join(', '), 'dim');
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
