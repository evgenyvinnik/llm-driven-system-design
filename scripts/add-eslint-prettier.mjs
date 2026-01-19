#!/usr/bin/env node

/**
 * Script to add ESLint and Prettier to all frontend and backend projects
 * that are missing them.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Projects to skip (not real projects)
const skipDirs = ['node_modules', 'scripts', '20forms-20designs', 'mcplator', 'mdreader'];

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
    const updated = updateFrontendPackage(frontendPkg, project);
    if (updated) frontendUpdates++;
  }

  // Update backend
  if (fs.existsSync(backendPkg)) {
    const updated = updateBackendPackage(backendPkg, project);
    if (updated) backendUpdates++;
  }
}

console.log(`\nSummary:`);
console.log(`  Frontends updated: ${frontendUpdates}`);
console.log(`  Backends updated: ${backendUpdates}`);

function updateFrontendPackage(pkgPath, project) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.error(`  Error reading ${pkgPath}: ${e.message}`);
    return false;
  }

  let modified = false;

  // Ensure scripts object exists
  if (!pkg.scripts) pkg.scripts = {};

  // Add format script if missing
  if (!pkg.scripts.format) {
    pkg.scripts.format = 'prettier --write src/**/*.{ts,tsx,css}';
    modified = true;
  }

  // Add lint script if missing
  if (!pkg.scripts.lint) {
    pkg.scripts.lint = 'eslint .';
    modified = true;
  }

  // Ensure devDependencies exists
  if (!pkg.devDependencies) pkg.devDependencies = {};

  // Add prettier if missing
  if (!pkg.devDependencies.prettier) {
    pkg.devDependencies.prettier = '^3.4.2';
    modified = true;
  }

  // Add eslint if missing
  if (!pkg.devDependencies.eslint) {
    pkg.devDependencies.eslint = '^9.17.0';
    pkg.devDependencies['@eslint/js'] = '^9.17.0';
    pkg.devDependencies['eslint-plugin-react-hooks'] = '^5.1.0';
    pkg.devDependencies['eslint-plugin-react-refresh'] = '^0.4.16';
    pkg.devDependencies['globals'] = '^15.14.0';
    pkg.devDependencies['typescript-eslint'] = '^8.18.2';
    modified = true;
  }

  if (modified) {
    // Sort devDependencies alphabetically
    pkg.devDependencies = sortObjectKeys(pkg.devDependencies);

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated frontend: ${project}`);
  }

  return modified;
}

function updateBackendPackage(pkgPath, project) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.error(`  Error reading ${pkgPath}: ${e.message}`);
    return false;
  }

  let modified = false;

  // Ensure scripts object exists
  if (!pkg.scripts) pkg.scripts = {};

  // Check if it's TypeScript or JavaScript backend
  const isTypeScript = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
  const ext = isTypeScript ? 'ts' : 'js';

  // Add format script if missing
  if (!pkg.scripts.format) {
    pkg.scripts.format = `prettier --write src/**/*.${ext}`;
    modified = true;
  }

  // Add lint script if missing
  if (!pkg.scripts.lint) {
    pkg.scripts.lint = `eslint src/**/*.${ext}`;
    modified = true;
  }

  // Ensure devDependencies exists
  if (!pkg.devDependencies) pkg.devDependencies = {};

  // Add prettier if missing
  if (!pkg.devDependencies.prettier) {
    pkg.devDependencies.prettier = '^3.4.2';
    modified = true;
  }

  // Add eslint if missing
  if (!pkg.devDependencies.eslint) {
    pkg.devDependencies.eslint = '^9.17.0';
    modified = true;
  }

  // Add TypeScript ESLint if TypeScript project and missing
  if (isTypeScript) {
    if (!pkg.devDependencies['@typescript-eslint/eslint-plugin']) {
      pkg.devDependencies['@typescript-eslint/eslint-plugin'] = '^8.18.2';
      modified = true;
    }
    if (!pkg.devDependencies['@typescript-eslint/parser']) {
      pkg.devDependencies['@typescript-eslint/parser'] = '^8.18.2';
      modified = true;
    }
  }

  if (modified) {
    // Sort devDependencies alphabetically
    pkg.devDependencies = sortObjectKeys(pkg.devDependencies);

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated backend: ${project}`);
  }

  return modified;
}

function sortObjectKeys(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = obj[key];
      return sorted;
    }, {});
}
