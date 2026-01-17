#!/usr/bin/env node

/**
 * Update all project READMEs with SLOC stats
 *
 * Usage:
 *   node scripts/update-readme-sloc.mjs              # Dry run (show what would change)
 *   node scripts/update-readme-sloc.mjs --apply      # Apply changes
 *   node scripts/update-readme-sloc.mjs scale-ai     # Update specific project only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ignoredDirs = new Set([
  '.git',
  '.claude',
  'node_modules',
  'scripts',
]);

function getSloc(projectPath) {
  try {
    const result = execSync(`node ${path.join(__dirname, 'sloc.mjs')} "${projectPath}" --summary`, {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    return result.trim();
  } catch {
    return null;
  }
}

function getSlocOneLine(projectPath) {
  try {
    const result = execSync(`node ${path.join(__dirname, 'sloc.mjs')} "${projectPath}" --json`, {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    const data = JSON.parse(result);
    return `${data.total.toLocaleString('en-US')} SLOC, ${data.files} files`;
  } catch {
    return null;
  }
}

function hasImplementation(projectPath) {
  const fullPath = path.join(repoRoot, projectPath);
  return (
    fs.existsSync(path.join(fullPath, 'docker-compose.yml')) ||
    fs.existsSync(path.join(fullPath, 'backend')) ||
    fs.existsSync(path.join(fullPath, 'frontend'))
  );
}

function updateReadme(projectPath, dryRun) {
  const readmePath = path.join(repoRoot, projectPath, 'README.md');

  if (!fs.existsSync(readmePath)) {
    return { status: 'skipped', reason: 'no README.md' };
  }

  if (!hasImplementation(projectPath)) {
    return { status: 'skipped', reason: 'design only' };
  }

  const sloc = getSloc(projectPath);
  const slocOneLine = getSlocOneLine(projectPath);
  if (!sloc) {
    return { status: 'skipped', reason: 'no source files' };
  }

  let content = fs.readFileSync(readmePath, 'utf8');

  // Match existing stats section (table format or old single-line format)
  // Table format: ## Codebase Stats followed by table rows until next section or end
  const tableStatsRegex = /## Codebase Stats\n\n\| Metric \| Value \|\n\|[-]+\|[-]+\|\n(?:\|[^\n]+\|\n)+\n?/;
  // Old single-line format
  const oldStatsRegex = /## Codebase Stats\n\n\*\*[\d,]+ SLOC\*\*[^\n]+\n+/;

  const hasTableStats = tableStatsRegex.test(content);
  const hasOldStats = oldStatsRegex.test(content);

  const newStats = `## Codebase Stats\n\n${sloc}\n\n`;

  if (hasTableStats) {
    const newContent = content.replace(tableStatsRegex, newStats);
    if (newContent === content) {
      return { status: 'unchanged', sloc: slocOneLine };
    }
    if (!dryRun) {
      fs.writeFileSync(readmePath, newContent);
    }
    return { status: 'updated', sloc: slocOneLine };
  }

  if (hasOldStats) {
    const newContent = content.replace(oldStatsRegex, newStats);
    if (!dryRun) {
      fs.writeFileSync(readmePath, newContent);
    }
    return { status: 'updated', sloc: slocOneLine };
  }

  // Find insertion point (after first heading and description)
  const lines = content.split('\n');
  let insertIndex = -1;

  // Find first ## heading after the title
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && i > 0) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex === -1) {
    return { status: 'skipped', reason: 'no section headings found' };
  }

  // Insert stats section before first ## heading
  lines.splice(insertIndex, 0, newStats);
  const newContent = lines.join('\n');

  if (!dryRun) {
    fs.writeFileSync(readmePath, newContent);
  }
  return { status: 'added', sloc: slocOneLine };
}

function main() {
  const args = process.argv.slice(2);
  const applyChanges = args.includes('--apply');
  const projectFilter = args.find(arg => !arg.startsWith('--'));

  const dryRun = !applyChanges;

  if (dryRun) {
    console.log('DRY RUN - use --apply to make changes\n');
  }

  const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  const projects = entries
    .filter(e => e.isDirectory() && !ignoredDirs.has(e.name) && !e.name.startsWith('.'))
    .map(e => e.name)
    .filter(name => !projectFilter || name === projectFilter)
    .sort();

  if (projectFilter && !projects.includes(projectFilter)) {
    console.error(`Project not found: ${projectFilter}`);
    process.exit(1);
  }

  const results = { added: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const project of projects) {
    const result = updateReadme(project, dryRun);
    results[result.status === 'added' || result.status === 'updated' || result.status === 'unchanged'
      ? result.status : 'skipped']++;

    const icon = {
      added: '➕',
      updated: '✏️',
      unchanged: '✓',
      skipped: '⏭️',
    }[result.status];

    const info = result.sloc || result.reason || '';
    console.log(`${icon} ${project.padEnd(25)} ${result.status.padEnd(10)} ${info}`);
  }

  console.log(`\nSummary: ${results.added} added, ${results.updated} updated, ${results.unchanged} unchanged, ${results.skipped} skipped`);
}

main();
