// Checks the environment and fixes what it can: Node version, server and client dependencies,
// and whether the server loads. Prints the load error on its own if it doesn't.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = true;

function check(label, passed, hint) {
  console.log(`${passed ? '✔' : '✖'} ${label}${passed || !hint ? '' : ` — ${hint}`}`);
  if (!passed) ok = false;
}

const major = Number(process.versions.node.split('.')[0]);
check(`Node ${process.versions.node}`, major >= 20, 'Node 20 or newer is required');

for (const [label, dir] of [['server dependencies', PROJECT_DIR], ['client dependencies', path.join(PROJECT_DIR, 'client')]]) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    console.log(`… installing ${label}`);
    execSync('npm install --no-audit --no-fund --ignore-scripts', { cwd: dir, stdio: 'inherit' });
  }
  check(label, fs.existsSync(path.join(dir, 'node_modules')));
}

try {
  process.env.NODE_ENV ??= 'test';
  await import(path.join(PROJECT_DIR, 'server', 'app.js'));
  check('server loads', true);
} catch (error) {
  check('server loads', false, 'see the error below');
  console.error(error);
}

process.exit(ok ? 0 : 1);
