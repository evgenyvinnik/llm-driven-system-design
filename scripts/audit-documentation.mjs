#!/usr/bin/env node
/** Read-only structural checks; implementation accuracy and interview quality need human review. */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = [
  'README.md',
  'architecture.md',
  'system-design-answer-frontend.md',
  'system-design-answer-backend.md',
  'system-design-answer-fullstack.md',
];
const requested = process.argv.slice(2).filter((arg) => arg !== '--json');
const projects = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  try {
    await readFile(path.join(root, entry.name, 'architecture.md'), 'utf8');
    projects.push(entry.name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const unknown = requested.filter((name) => !projects.includes(name));
if (unknown.length) throw new Error(`Unknown project(s): ${unknown.join(', ')}`);

const report = [];
for (const project of projects.sort()) {
  if (requested.length && !requested.includes(project)) continue;
  const files = [];
  for (const name of targets) {
    let source;
    try {
      source = await readFile(path.join(root, project, name), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ name, findings: ['Missing file'] });
      continue;
    }
    const lines = source.trimEnd().split('\n');
    const findings = [];
    const interview = name.startsWith('system-design-answer-');
    let fence = null;
    for (const [index, line] of lines.entries()) {
      const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (delimiter) {
        if (!fence) {
          fence = { char: delimiter[1][0], length: delimiter[1].length, line: index + 1 };
          if (interview && delimiter[2].trim()) findings.push(`L${index + 1}: tagged interview fence`);
        } else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
          fence = null;
        }
        continue;
      }
      if (interview && fence && /\b(?:const\s+\w+\s*=|function\s+\w+\s*\(|CREATE TABLE|import\s+.+\s+from\s+|className=|return\s*\(|interface\s+\w+\s*\{)/.test(line)) {
        findings.push(`L${index + 1}: possible implementation code inside diagram`);
      }
    }
    if (fence) findings.push(`L${fence.line}: unclosed fence`);
    if (interview && (lines.length < 350 || lines.length > 550)) {
      findings.push('Outside suggested 350–550 lines; review pacing, do not pad');
    }
    files.push({ name, lines: lines.length, words: source.split(/\s+/).filter(Boolean).length, findings });
  }
  report.push({ project, files });
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.length} projects, ${report.reduce((sum, project) => sum + project.files.length, 0)} files. Structural scan only; see DOCUMENTATION_REVIEW.md for source review status.`);
  for (const { project, files } of report) {
    for (const file of files) {
      if (requested.length || file.findings.length) {
        console.log(`${project}/${file.name}: ${file.lines ?? 'missing'} lines, ${file.words ?? 0} words`);
        for (const finding of file.findings) console.log(`  ${finding}`);
      }
    }
  }
}
