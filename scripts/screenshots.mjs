#!/usr/bin/env node
/**
 * Screenshot automation script for frontend projects.
 * Uses Playwright to capture screenshots of key screens.
 *
 * Usage:
 *   node scripts/screenshots.mjs <project>                  # Screenshot (frontend must be running)
 *   node scripts/screenshots.mjs --start <project>          # Full automated workflow
 *   node scripts/screenshots.mjs --start --all              # Auto-screenshot all projects
 *   node scripts/screenshots.mjs --dry-run <project>        # Show what would be captured
 *   node scripts/screenshots.mjs --list                     # List available configs
 *
 * Automated Workflow (--start flag):
 *   1. Stop Docker containers (clean slate)
 *   2. Start Docker services (PostgreSQL, Redis, etc.)
 *   3. Setup database (run init.sql + seed.sql if exists)
 *   4. Start backend server (if backendRequired in config)
 *   5. Start frontend dev server
 *   6. Capture screenshots using Playwright
 *   7. Stop frontend, backend, and Docker services
 *
 * Requirements:
 *   - Playwright installed: npm install playwright
 *   - Docker Desktop running (for projects with docker-compose.yml)
 *   - Frontend dev server must be running (or use --start flag)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { webkit } from 'playwright';

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
 * Kill any process using a specific port
 */
function killProcessOnPort(port) {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Find process ID using the port
      const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
      if (result) {
        const pids = result.split('\n');
        pids.forEach(pid => {
          try {
            execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
          } catch {}
        });
        logSuccess(`Killed process on port ${port}`);
      }
    } else if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
      const lines = result.split('\n');
      const pids = new Set();
      lines.forEach(line => {
        const match = line.match(/\s+(\d+)\s*$/);
        if (match) pids.add(match[1]);
      });
      pids.forEach(pid => {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
        } catch {}
      });
      logSuccess(`Killed process on port ${port}`);
    }
  } catch (error) {
    // No process found on port, which is fine
  }
}

/**
 * Stop docker-compose services
 */
async function stopDockerCompose(projectDir, projectName, waitAfterStop = false) {
  if (!hasDockerCompose(projectDir)) {
    return true;
  }

  if (!isDockerRunning()) {
    return true;
  }

  logStep('DOCKER', `Stopping infrastructure for ${projectName}...`);

  try {
    // Use -v flag to remove volumes (ensures clean database state)
    // Use --remove-orphans to clean up any orphaned containers
    execSync('docker-compose down -v --remove-orphans', {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 60000, // 60 second timeout
    });
    logSuccess('Docker services stopped (volumes removed)');

    // Wait for containers to fully stop and ports to be released
    if (waitAfterStop) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    return true;
  } catch (error) {
    logWarning(`Docker-compose stop failed: ${error.message}`);
    // Try force stop if normal stop fails
    try {
      execSync('docker-compose kill', {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 30000,
      });
      execSync('docker-compose down -v --remove-orphans', {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {}
    return true;
  }
}

/**
 * Stop all docker-compose projects in the repository
 * This is useful when running --all mode to ensure clean state between projects
 */
async function stopAllDockerProjects() {
  if (!isDockerRunning()) {
    return;
  }

  logStep('CLEANUP', 'Stopping all Docker containers from previous runs...');

  const configs = loadConfigs();
  for (const config of configs) {
    const projectDir = path.join(repoRoot, config.name);
    if (hasDockerCompose(projectDir)) {
      try {
        execSync('docker-compose down -v --remove-orphans', {
          cwd: projectDir,
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch {
        // Ignore errors, just try to stop what we can
      }
    }
  }

  // Also kill any containers using common ports
  try {
    // Stop all containers that might be using our ports
    const commonPorts = [5432, 6379, 9000, 5672, 15672, 9200, 8123];
    for (const port of commonPorts) {
      try {
        // Find docker containers using this port
        const result = execSync(`docker ps -q --filter "publish=${port}"`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
        if (result) {
          execSync(`docker stop ${result}`, { stdio: 'pipe', timeout: 10000 });
        }
      } catch {}
    }
  } catch {}

  // Wait for ports to be released
  await new Promise(resolve => setTimeout(resolve, 2000));
  logSuccess('Docker cleanup complete');
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
 * Wait for Redis to be ready (if redis service exists)
 */
async function waitForRedis(projectDir) {
  // Check if redis service exists in docker-compose
  try {
    const result = execSync('docker-compose config --services', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (!result.includes('redis')) {
      return true; // No Redis service, skip
    }
  } catch {
    return true; // Can't check services, assume no Redis
  }

  logStep('REDIS', 'Waiting for Redis to be ready...');
  for (let i = 0; i < 15; i++) {
    try {
      execSync('docker-compose exec -T redis redis-cli ping', {
        cwd: projectDir,
        stdio: 'pipe',
      });
      logSuccess('Redis ready');
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  logWarning('Redis not ready after 15 seconds');
  return false;
}

/**
 * Setup database: run migrations, then seed.
 *
 * Order matters. Migrations must run BEFORE seeding: some projects' init.sql
 * recreates tables, which would wipe seed data if seeding ran first.
 *
 * Seeding uses backend/db-seed/seed.sql when present, and otherwise falls back
 * to the project's own seed script (db:seed / seed). Without that fallback,
 * projects that seed via TypeScript never get any data, and every login-based
 * screenshot fails with "Invalid credentials".
 *
 * Note: init.sql is also applied by PostgreSQL on first startup when the project
 * mounts it into docker-entrypoint-initdb.d.
 */
async function setupDatabase(projectDir, projectName, config) {
  if (!config.backendRequired) {
    return true;
  }

  const backendDir = path.join(projectDir, 'backend');
  const seedSqlPath = path.join(backendDir, 'db-seed', 'seed.sql');
  const pkgJsonPath = path.join(backendDir, 'package.json');

  let scripts = {};
  if (fs.existsSync(pkgJsonPath)) {
    try {
      scripts = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).scripts || {};
    } catch {
      scripts = {};
    }
  }
  const seedScript = ['db:seed', 'seed'].find(s => scripts[s]);

  if (!fs.existsSync(seedSqlPath) && !seedScript && !scripts['db:migrate']) {
    return true; // Nothing to migrate or seed
  }

  // Get database name from config or use project name
  const dbName = config.dbName || projectName.replace(/-/g, '_');
  const dbUser = config.dbUser || projectName.replace(/-/g, '_');

  // Wait for PostgreSQL to be ready with retries
  logStep('DATABASE', 'Waiting for database to be ready...');
  let dbReady = false;
  for (let i = 0; i < 15; i++) {
    try {
      execSync(`docker-compose exec -T postgres pg_isready -U ${dbUser}`, {
        cwd: projectDir,
        stdio: 'pipe',
      });
      dbReady = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  if (!dbReady) {
    logWarning('Database not ready after 15 seconds');
    return false;
  }

  // pg_isready can report ready while the docker-entrypoint-initdb.d schema
  // scripts are STILL running (Postgres accepts local-socket connections during
  // init). For projects that load their schema via the initdb.d mount rather
  // than a db:migrate script, seeding here would hit tables that don't exist yet
  // — and because psql without ON_ERROR_STOP exits 0 on SQL errors, that failure
  // is silent and login later fails with "Invalid credentials". So when there's
  // no migrate step, wait until the public schema actually has tables.
  if (!scripts['db:migrate']) {
    for (let i = 0; i < 30; i++) {
      try {
        const out = execSync(
          `docker-compose exec -T postgres psql -U ${dbUser} -d ${dbName} -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"`,
          { cwd: projectDir, stdio: 'pipe' }
        ).toString().trim();
        if (parseInt(out, 10) > 0) break;
      } catch {
        // psql not reachable yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Backend deps are needed for both migrate and TypeScript seed scripts.
  if ((scripts['db:migrate'] || seedScript) && !fs.existsSync(path.join(backendDir, 'node_modules'))) {
    await installDeps(backendDir, 'backend');
  }

  // Migrations FIRST — an init.sql that recreates tables would otherwise wipe the seed.
  // Retry: pg_isready (checked above via the container socket) can pass while the host
  // TCP port mapping isn't fully up yet, so the first migrate can hit ECONNRESET/
  // ECONNREFUSED. Retrying a few times makes migrate robust to that startup race.
  if (scripts['db:migrate']) {
    logStep('DB', 'Running database migrations...');
    let migrated = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        execSync('npm run db:migrate', { cwd: backendDir, stdio: 'pipe' });
        logSuccess('Migrations complete');
        migrated = true;
        break;
      } catch (error) {
        if (attempt === 5) {
          logWarning(`Migration failed after ${attempt} attempts: ${error.message}`);
        } else {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    void migrated;
  }

  // Run the project's own seed script when seed.sql is missing, or when seed.sql
  // exists but seeds no user rows (several projects keep reference data in SQL and
  // create their users in TypeScript — without this, login screenshots fail).
  const hasSeedSql = fs.existsSync(seedSqlPath);
  const seedSqlHasUsers = hasSeedSql
    && /INSERT\s+INTO\s+(users|accounts|app_users)\b/i.test(fs.readFileSync(seedSqlPath, 'utf-8'));
  const runSeedScript = Boolean(seedScript) && !seedSqlHasUsers;

  if (!hasSeedSql) {
    if (!runSeedScript) {
      return true; // Nothing to seed
    }
    logStep('DATABASE', `Seeding database (npm run ${seedScript})...`);
    try {
      execSync(`npm run ${seedScript}`, { cwd: backendDir, stdio: 'pipe' });
      logSuccess('Database seeded');
      return true;
    } catch (error) {
      logWarning(`Database seeding failed (npm run ${seedScript}): ${error.message}`);
      return false;
    }
  }

  logStep('DATABASE', 'Seeding database...');

  // Retry seeding a few times (in case database just became ready).
  // ON_ERROR_STOP=1 makes psql exit non-zero on SQL errors; without it, a seed
  // that hits a missing table (initdb.d race) or a bad row exits 0 and the
  // failure is silent — reported as "seeded" while no user rows exist.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Use cat to pipe the seed file into psql (shell redirection doesn't work with docker exec)
      execSync(`cat backend/db-seed/seed.sql | docker-compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ${dbUser} -d ${dbName}`, {
        cwd: projectDir,
        stdio: 'pipe',
      });
      logSuccess('Database seeded');

      // seed.sql carries reference data only for some projects; their users come
      // from the TypeScript seeder, so run it too.
      if (runSeedScript) {
        logStep('DATABASE', `Seeding users (npm run ${seedScript})...`);
        try {
          execSync(`npm run ${seedScript}`, { cwd: backendDir, stdio: 'pipe' });
          logSuccess('User seed complete');
        } catch (error) {
          logWarning(`User seeding failed (npm run ${seedScript}): ${error.message}`);
        }
      }
      return true;
    } catch (error) {
      if (attempt === 5) {
        logWarning(`Database seeding failed after ${attempt} attempts: ${error.message}`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return false;
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
 * Determine the port the backend actually listens on.
 *
 * Most projects run their API on 3001 because that is what their Vite dev-server
 * proxy targets; a few use 3000 or something else entirely (scalable-api: 8080).
 * Guessing wrong makes the readiness probe time out silently and the browser then
 * drives a backend that isn't up yet, which surfaces as "Request failed" on login.
 *
 * Precedence: explicit config → PORT= in the backend `dev` script → Vite proxy
 * target → 3000.
 */
function resolveBackendPort(config, backendDir, projectDir) {
  if (config.backendPort) return config.backendPort;

  const pkgPath = path.join(backendDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const devScript = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.dev || '';
      const match = devScript.match(/PORT=(\d+)/);
      if (match) return parseInt(match[1], 10);
    } catch {
      // Malformed package.json — fall through to the proxy/default.
    }
  }

  for (const name of ['vite.config.ts', 'vite.config.js']) {
    const vitePath = path.join(projectDir, 'frontend', name);
    if (!fs.existsSync(vitePath)) continue;
    const match = fs.readFileSync(vitePath, 'utf8').match(/target:\s*['"`]http:\/\/localhost:(\d+)/);
    if (match) return parseInt(match[1], 10);
  }

  return 3000;
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

  // Migrations already ran in setupDatabase(), before seeding.

  logStep('START', 'Starting backend...');

  const child = spawn('npm', ['run', 'dev'], {
    cwd: backendDir,
    stdio: 'pipe',
    detached: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  spawnedProcesses.push({ process: child, name: `${config.name} backend` });

  // Capture the backend's full output to a file. When a backend dies during startup
  // the only symptom the harness otherwise shows is "may not be fully ready" followed
  // by Vite proxy errors, which says nothing about the actual cause — the stack trace
  // scrolls past in a stream we were filtering for the word "error".
  // Kept out of screenshots/ deliberately: that directory is committed documentation,
  // and writing a debug log there left a stray backend-startup.log in every project
  // the harness had ever run against.
  const backendLogPath = path.join(projectDir, '.screenshot-logs', 'backend-startup.log');
  fs.mkdirSync(path.dirname(backendLogPath), { recursive: true });
  const backendLog = fs.createWriteStream(backendLogPath, { flags: 'w' });
  child.stdout.on('data', (data) => backendLog.write(data));

  child.stderr.on('data', (data) => {
    backendLog.write(data);
    const msg = data.toString().trim();
    if (msg && !msg.includes('ExperimentalWarning') && msg.toLowerCase().includes('error')) {
      logWarning(`Backend stderr: ${msg}`);
    }
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      logError(`Backend exited with code ${code} - see ${backendLogPath}`);
    }
  });

  // Wait for the backend to be ready on the port it actually binds. Many projects
  // run their API on 3001 (the port their Vite proxy targets), so a hardcoded 3000
  // would never become reachable and the browser would drive an unready backend.
  const backendPort = resolveBackendPort(config, backendDir, projectDir);
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

  const depsInstalled = await installDeps(frontendDir, 'frontend');
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

  logStep('BROWSER', 'Launching WebKit...');

  let browser;
  try {
    browser = await webkit.launch({
      headless: true,
    });
  } catch (error) {
    logError(`Failed to launch browser: ${error.message}`);
    logWarning('Run: npx playwright install webkit');
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
  // Tracks which identity is currently authenticated, so a screen can request a
  // different role (multi-sided apps: customer vs driver vs restaurant) and we
  // only re-login when the identity actually changes.
  let currentLoginId = null;

  async function ensureLoggedIn(overrideCreds) {
    if (!config.auth?.enabled) return;

    const auth = config.auth;
    const creds = overrideCreds || auth.credentials;
    const credId = creds.username || creds.email;

    // Already authenticated as the right identity — nothing to do.
    if (isLoggedIn && currentLoginId === credId) return;

    // Switching identities: clear the existing session so the new login sticks.
    if (isLoggedIn && currentLoginId !== credId) {
      logStep('AUTH', `Switching login to ${credId}...`);
      await page.context().clearCookies();
      await page.goto(`${baseUrl}${auth.loginUrl}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
      isLoggedIn = false;
    } else {
      logStep('AUTH', 'Logging in...');
    }

    try {
      await page.goto(`${baseUrl}${auth.loginUrl}`, { waitUntil: 'networkidle', timeout: 30000 });

      // Some apps have no login *route* — the form lives in a modal opened from a
      // header button (twitch). Click it open before looking for the fields.
      if (auth.openSelector) {
        await page.click(auth.openSelector, { timeout: 10000 });
        await page.waitForTimeout(500);
      }

      // Wait for and fill username/email field
      const usernameSelector = auth.usernameSelector || 'input[name="username"], input[name="email"], input[type="email"], input[type="text"]';
      await page.waitForSelector(usernameSelector, { timeout: 10000 });
      await page.fill(usernameSelector, creds.username || creds.email);

      // Fill password field (optional - some apps only need username/nickname)
      if (creds.password && auth.passwordSelector !== false) {
        const passwordSelector = auth.passwordSelector || 'input[name="password"], input[type="password"]';
        await page.fill(passwordSelector, creds.password);
      }

      // Submit the login form. A bare `button[type="submit"]` is ambiguous: many
      // of these apps render a header search form whose submit button comes first
      // in the DOM, so a global click hits Search, not Sign in — no request fires
      // and the page just sits on the login form. So submit the form the password
      // field actually belongs to: press Enter inside it (triggers that form's
      // submit handler), and fall back to a scoped/global button click only if the
      // field isn't in a form.
      const submitSelector = auth.submitSelector || 'button[type="submit"]';
      const passwordForSubmit = creds.password && auth.passwordSelector !== false
        ? (auth.passwordSelector || 'input[name="password"], input[type="password"]')
        : null;

      async function submitLogin() {
        if (passwordForSubmit) {
          const pw = await page.$(passwordForSubmit);
          const ownerForm = pw && (await pw.evaluateHandle(el => el.closest('form')));
          if (ownerForm && (await ownerForm.evaluate(f => !!f))) {
            // Prefer this form's own submit button; else just press Enter in the field.
            const formSubmit = await ownerForm.asElement().$('button[type="submit"], input[type="submit"]');
            if (formSubmit) return formSubmit.click();
            return page.press(passwordForSubmit, 'Enter');
          }
        }
        return page.click(submitSelector);
      }

      // Wait for navigation after submitting (login typically redirects)
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
        submitLogin()
      ]);

      // Additional wait for any client-side routing/state updates
      await page.waitForTimeout(1500);

      // Check for error banners. Red text is also used for ordinary UI (a "0" stat,
      // a Logout button), so only treat prose-like text as an actual error message.
      const errorElement = await page.$('.text-red-600, .text-red-700, .bg-red-50');
      if (errorElement) {
        const errorText = ((await errorElement.textContent()) || '').trim();
        if (errorText.length > 3 && !/^\d+$/.test(errorText)) {
          logError(`Login error banner: ${errorText}`);
        }
      }

      // Verify login worked. A URL check alone is unreliable: plenty of apps log in
      // without navigating — the login form is a panel on the page (r-place), or
      // loginUrl is "/" which every URL trivially "includes" (scalable-api). The
      // reliable signal is that the credential field is gone once we're authenticated.
      const currentUrl = page.url();
      const passwordSelector = auth.passwordSelector || 'input[name="password"], input[type="password"]';
      const credentialFieldGone =
        auth.passwordSelector === false ? false : !(await page.$(passwordSelector));
      const navigatedAway = auth.loginUrl !== '/' && !currentUrl.includes(auth.loginUrl);

      if (credentialFieldGone || navigatedAway) {
        logSuccess(`Login successful - now at ${currentUrl}`);
      } else {
        logWarning('Login form still present after submit - login may have failed');
        await page.screenshot({ path: path.join(outputDir, 'debug-login-failed.png') });
        logWarning('Saved debug screenshot: debug-login-failed.png');
      }

      isLoggedIn = true;
      currentLoginId = credId;
    } catch (error) {
      logError(`Login failed: ${error.message}`);
      throw error;
    }
  }

  // Capture each screen
  for (const screen of config.screens) {
    try {
      // Handle auth if needed. A screen may set `loginAs` (its own credentials
      // object) to be captured under a different identity — essential for
      // multi-sided apps where customer, driver, and restaurant see different UIs.
      if (!screen.skipAuth && config.auth?.enabled) {
        await ensureLoggedIn(screen.loginAs);
      }

      logStep('CAPTURE', `${screen.name} (${screen.path})`);

      // `networkidle` is the right default, but it can never fire on a page that
      // deliberately holds a connection open — Server-Sent Events streams and
      // long-poll endpoints keep a request in flight for the life of the page.
      // Falling back to `domcontentloaded` lets those pages be captured instead
      // of failing outright; the per-screen `waitFor`/`delay` below is what
      // actually establishes that the content has rendered.
      try {
        await page.goto(`${baseUrl}${screen.path}`, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (navError) {
        if (!/Timeout/i.test(navError.message)) throw navError;
        logWarning('networkidle timed out (long-lived connection?) - falling back to domcontentloaded');
        await page.goto(`${baseUrl}${screen.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

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

      // Type into inputs before capturing. Some UI is driven by a store fed
      // from a text field rather than by the URL — a search page whose results
      // live in component state has no route to navigate to, so without this it
      // can only ever be screenshotted in its empty state.
      //
      // Click a selector before capturing. Needed for UI that lives in local
      // component state rather than a route (modals, slide-over detail panels),
      // which otherwise can never be screenshotted.
      //
      // This runs BEFORE `fill`: the field you want to type into is very often
      // inside the thing the click opens (a search modal, a filter popover), so
      // filling first would just miss it and warn.
      if (screen.click) {
        const clicks = Array.isArray(screen.click) ? screen.click : [screen.click];
        for (const selector of clicks) {
          try {
            await page.waitForSelector(selector, { timeout: 5000 });
            await page.click(selector);
            await page.waitForTimeout(screen.clickDelay || 600);
          } catch {
            logWarning(`Click target not found: ${selector}`);
          }
        }
      }

      // `fill` is an object of { selector: value }, applied in order. Pressing
      // Enter afterwards is left to `pressEnter` so forms that submit on a
      // button and forms that submit on Enter are both expressible.
      if (screen.fill) {
        for (const [selector, value] of Object.entries(screen.fill)) {
          try {
            await page.waitForSelector(selector, { timeout: 5000 });
            await page.fill(selector, String(value));
            await page.waitForTimeout(screen.fillDelay || 400);
          } catch {
            logWarning(`Fill target not found: ${selector}`);
          }
        }
      }

      // Press Enter in a field, for forms that submit on keypress rather than
      // via a clickable button.
      if (screen.pressEnter) {
        try {
          await page.press(screen.pressEnter, 'Enter');
          await page.waitForTimeout(screen.pressEnterDelay || 1500);
        } catch {
          logWarning(`pressEnter target not found: ${screen.pressEnter}`);
        }
      }

      // `steps` is the general form: an ordered list of interactions applied
      // exactly as written. `click`/`fill`/`pressEnter` above each run as a
      // whole block, which cannot express a flow that alternates between them —
      // fill an address, click Set, fill another, click Set again. Anything
      // reachable only through such a sequence was previously uncapturable.
      //
      //   "steps": [
      //     { "fill": "#pickup", "value": "100 Main St" },
      //     { "click": "button:has-text('Set')" },
      //     { "press": "#pickup", "key": "Enter" },
      //     { "wait": 1500 }
      //   ]
      //
      // Each step takes an optional "delay" (ms) applied after it.
      if (Array.isArray(screen.steps)) {
        for (const step of screen.steps) {
          try {
            if (step.wait) {
              await page.waitForTimeout(step.wait);
              continue;
            }
            // Locators rather than page.fill/click by selector string, because
            // locators support .nth() — several of these forms have repeated
            // controls (two "Set" buttons, one per address field) that a bare
            // selector cannot disambiguate.
            const target = step.fill ?? step.click ?? step.press;
            const locator = step.nth === undefined
              ? page.locator(target).first()
              : page.locator(target).nth(step.nth);
            await locator.waitFor({ state: 'visible', timeout: 8000 });
            if (step.fill !== undefined) {
              await locator.fill(String(step.value ?? ''));
            } else if (step.click !== undefined) {
              await locator.click();
            } else if (step.press !== undefined) {
              await locator.press(step.key || 'Enter');
            }
            await page.waitForTimeout(step.delay || 600);
          } catch {
            const target = step.fill || step.click || step.press;
            logWarning(`Step target not found: ${target}`);
          }
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
  let backendProcess = null;
  let dockerStarted = false;

  // Auto-start mode
  if (shouldStart) {
    // Step 1: Kill any processes on frontend/backend ports (clean slate)
    logStep('CLEANUP', 'Killing processes on ports...');
    killProcessOnPort(config.frontendPort);
    if (config.backendRequired && config.backendPort) {
      killProcessOnPort(config.backendPort);
    }

    // Step 2: Stop any existing docker containers (clean slate)
    await stopDockerCompose(projectDir, config.name);

    // Step 3: Start docker-compose services
    dockerStarted = await startDockerCompose(projectDir, config.name);

    // Step 3.5: Wait for Redis to be ready (if applicable)
    if (config.backendRequired) {
      await waitForRedis(projectDir);
    }

    // Step 4: Setup database (seed.sql)
    const dbSetup = await setupDatabase(projectDir, config.name, config);
    if (!dbSetup && config.backendRequired) {
      logWarning('Database setup failed, continuing anyway...');
    }

    // Step 5: Start backend if required
    if (config.backendRequired) {
      backendProcess = await startBackend(projectDir, config);
      if (!backendProcess) {
        await stopDockerCompose(projectDir, config.name);
        return { project: config.name, success: false, reason: 'Failed to start backend' };
      }
    }

    // Step 6: Start frontend
    frontendProcess = await startFrontend(projectDir, config);
    if (!frontendProcess) {
      await stopDockerCompose(projectDir, config.name);
      return { project: config.name, success: false, reason: 'Failed to start frontend' };
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
    // Cleanup
    if (dockerStarted) {
      stopDockerCompose(projectDir, config.name);
    }
    return { project: config.name, success: true, captured: 0, failed: 0 };
  }

  // Capture screenshots using Playwright
  const result = await captureWithPlaywright(config, outputDir);

  // Cleanup: Stop everything in reverse order
  if (shouldStart) {
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

    // Stop backend if we started it
    if (backendProcess && !backendProcess.killed) {
      logStep('STOP', `Stopping ${config.name} backend...`);
      try {
        if (process.platform !== 'win32') {
          process.kill(-backendProcess.pid, 'SIGTERM');
        } else {
          backendProcess.kill('SIGTERM');
        }
        const idx = spawnedProcesses.findIndex(p => p.process === backendProcess);
        if (idx >= 0) spawnedProcesses.splice(idx, 1);
      } catch {}
    }

    // Stop docker-compose if we started it
    // Wait after stop when running --all to ensure ports are released for next project
    if (dockerStarted) {
      await stopDockerCompose(projectDir, config.name, isAll);
    }

    // Extra cleanup: kill any remaining processes on the ports
    if (isAll) {
      killProcessOnPort(config.frontendPort);
      if (config.backendPort) {
        killProcessOnPort(config.backendPort);
      }
    }
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

  // When running --all with --start, stop all Docker containers first for a clean slate
  if (isAll && shouldStart) {
    await stopAllDockerProjects();
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
