#!/usr/bin/env node

/**
 * SLOC Counter for System Design Projects
 *
 * Counts source lines of code (non-empty lines) across project directories.
 *
 * Usage:
 *   node scripts/sloc.mjs                    # Count entire repo
 *   node scripts/sloc.mjs scale-ai           # Count specific project
 *   node scripts/sloc.mjs scale-ai/backend   # Count specific subdirectory
 *   node scripts/sloc.mjs --json             # Output as JSON
 *   node scripts/sloc.mjs --summary          # Output summary only (for README embedding)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const includedExtensions = new Set([
  // JavaScript/TypeScript
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  // Styles
  '.css',
  '.scss',
  '.less',
  '.sass',
  // Markup & Data
  '.html',
  '.htm',
  '.json',
  '.yaml',
  '.yml',
  // Documentation
  '.md',
  '.mdx',
  // SQL
  '.sql',
  // Config
  '.env',
  '.env.example',
  // Docker
  '.dockerfile',
  // Python (for ML training scripts)
  '.py',
  // Go
  '.go',
  // Rust
  '.rs',
  // Shell
  '.sh',
  '.bash',
]);

const ignoredDirectories = new Set([
  '.cache',
  '.git',
  '.husky',
  '.idea',
  '.next',
  '.pnpm-store',
  '.svelte-kit',
  '.tamagui',
  '.turbo',
  '.vercel',
  '.vitepress',
  '.vscode',
  '.yarn',
  '.claude',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'storybook-static',
  'temp',
  'tmp',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
]);

const ignoredFiles = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.DS_Store',
  'Thumbs.db',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isBinary(buffer) {
  return buffer.includes(0);
}

function countFileLines(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (isBinary(buffer)) return 0;
    const text = buffer.toString('utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .length;
  } catch {
    return 0;
  }
}

function walk(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { total: 0, perExtension: new Map(), files: 0 };
  }

  let total = 0;
  let files = 0;
  const perExtension = new Map();

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      const result = walk(fullPath);
      total += result.total;
      files += result.files;
      for (const [ext, count] of result.perExtension.entries()) {
        perExtension.set(ext, (perExtension.get(ext) ?? 0) + count);
      }
    } else {
      if (ignoredFiles.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!includedExtensions.has(ext)) continue;
      const count = countFileLines(fullPath);
      total += count;
      files += 1;
      perExtension.set(ext, (perExtension.get(ext) ?? 0) + count);
    }
  }

  return { total, perExtension, files };
}

function formatNumber(num) {
  return num.toLocaleString('en-US');
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const summaryOutput = args.includes('--summary');
  const pathArgs = args.filter(arg => !arg.startsWith('--'));

  const rootArg = pathArgs[0];
  const repoRoot = path.resolve(__dirname, '..');
  const root = rootArg ? path.resolve(repoRoot, rootArg) : repoRoot;

  if (!fs.existsSync(root)) {
    console.error(`Error: Path does not exist: ${root}`);
    process.exit(1);
  }

  const { total, perExtension, files } = walk(root);
  const sorted = [...perExtension.entries()].sort((a, b) => b[1] - a[1]);

  if (jsonOutput) {
    const result = {
      path: root,
      total,
      files,
      byExtension: Object.fromEntries(sorted),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (summaryOutput) {
    // Table format for embedding in READMEs
    console.log('| Metric | Value |');
    console.log('|--------|-------|');
    console.log(`| Total SLOC | ${formatNumber(total)} |`);
    console.log(`| Source Files | ${formatNumber(files)} |`);
    for (const [ext, count] of sorted.slice(0, 5)) {
      console.log(`| ${ext} | ${formatNumber(count)} |`);
    }
    return;
  }

  console.log(`\nSLOC Analysis: ${root}\n`);
  console.log('Extension'.padEnd(12) + 'Lines'.padStart(10) + '  %'.padStart(8));
  console.log('-'.repeat(32));

  for (const [ext, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`${ext.padEnd(12)}${formatNumber(count).padStart(10)}  ${pct.padStart(6)}%`);
  }

  console.log('-'.repeat(32));
  console.log(`${'Total'.padEnd(12)}${formatNumber(total).padStart(10)}`);
  console.log(`${'Files'.padEnd(12)}${formatNumber(files).padStart(10)}`);
}

main();
