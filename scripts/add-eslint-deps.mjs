#!/usr/bin/env node

/**
 * Script to add ESLint flat config dependencies to all frontend and backend projects.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Projects to skip (not real projects)
const skipDirs = ['node_modules', 'scripts', '20forms-20designs', 'mcplator', 'mdreader'];

// Dependencies needed for frontend eslint.config.js
const frontendDeps = {
  '@eslint/js': '^9.17.0',
  'globals': '^15.14.0',
  'eslint-plugin-react-hooks': '^5.1.0',
  'eslint-plugin-react-refresh': '^0.4.16',
  'typescript-eslint': '^8.18.2',
};

// Dependencies needed for TypeScript backend eslint.config.js
const backendTsDeps = {
  '@eslint/js': '^9.17.0',
  'globals': '^15.14.0',
  'typescript-eslint': '^8.18.2',
};

// Dependencies needed for JavaScript backend eslint.config.js
const backendJsDeps = {
  '@eslint/js': '^9.17.0',
  'globals': '^15.14.0',
};

// Get all project directories
const projectDirs = fs.readdirSync(rootDir)
  .filter(dir => {
    const fullPath = path.join(rootDir, dir);
    return fs.statSync(fullPath).isDirectory() && !skipDirs.includes(dir);
  });

let frontendUpdates = 0;
let backendUpdates = 0;

for (const project of projectDirs) {
  const frontendPkg = path.join(rootDir, project, 'frontend', 'package.json');
  const backendPkg = path.join(rootDir, project, 'backend', 'package.json');

  // Update frontend
  if (fs.existsSync(frontendPkg)) {
    const updated = addDeps(frontendPkg, frontendDeps, project, 'frontend');
    if (updated) frontendUpdates++;
  }

  // Update backend
  if (fs.existsSync(backendPkg)) {
    const pkg = JSON.parse(fs.readFileSync(backendPkg, 'utf8'));
    const isTypeScript = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
    const deps = isTypeScript ? backendTsDeps : backendJsDeps;
    const updated = addDeps(backendPkg, deps, project, 'backend');
    if (updated) backendUpdates++;
  }
}

console.log(`\nSummary:`);
console.log(`  Frontends updated: ${frontendUpdates}`);
console.log(`  Backends updated: ${backendUpdates}`);

function addDeps(pkgPath, requiredDeps, project, type) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.error(`  Error reading ${pkgPath}: ${e.message}`);
    return false;
  }

  let modified = false;

  // Ensure devDependencies exists
  if (!pkg.devDependencies) pkg.devDependencies = {};

  // Add missing dependencies
  for (const [dep, version] of Object.entries(requiredDeps)) {
    if (!pkg.devDependencies[dep]) {
      pkg.devDependencies[dep] = version;
      modified = true;
    }
  }

  if (modified) {
    // Sort devDependencies alphabetically
    pkg.devDependencies = Object.keys(pkg.devDependencies)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = pkg.devDependencies[key];
        return sorted;
      }, {});

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated ${type}: ${project}`);
  }

  return modified;
}
