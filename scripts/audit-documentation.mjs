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
// See "Drawing Architecture Diagrams" in CLAUDE.md for the rationale behind these limits.
const MAX_DIAGRAM_WIDTH = 100;
const INTERVIEW_WORDS = { min: 2800, max: 5200 };
const INTERVIEW_MAX_LINES = 650;
const BOX_DRAWING = /[─-╿]/u;
// Characters that render as emoji (double width, font fallback) and break diagram alignment.
const EMOJI = /\p{Emoji_Presentation}|️/u;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** Approximate monospace display width: emoji and CJK take two columns, combining marks none. */
function displayWidth(line) {
  let width = 0;
  for (const char of line) {
    if (/\p{Mn}|‍/u.test(char)) continue;
    width += EMOJI.test(char) || WIDE.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * Finds boxes whose corners or edges don't line up (usually a miscounted border or a
 * double-width character). A ┌ is treated as a box only when an edge continues below it
 * and a ┐ closes its top edge; other corners are connector bends and are ignored.
 */
function brokenBoxes(block) {
  // Index by display column so a double-width character occupies two cells, as rendered.
  const grid = block.lines.map((line) =>
    [...line].flatMap((char) => (/\p{Mn}|‍/u.test(char) ? [] : EMOJI.test(char) || WIDE.test(char) ? [char, ''] : [char])),
  );
  const at = (row, col) => grid[row]?.[col] ?? ' ';
  const problems = [];
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length; col++) {
      const edge = '│├┤┼';
      if (grid[row][col] !== '┌' || !edge.includes(at(row + 1, col))) continue;
      let right = col + 1;
      while (right < grid[row].length && !'┐┌'.includes(grid[row][right])) right++;
      if (at(row, right) !== '┐') continue;
      const end = (c) => {
        let r = row + 1;
        while (r < grid.length && edge.includes(at(r, c))) r++;
        return r;
      };
      const leftEnd = end(col);
      const rightEnd = end(right);
      const closedLeft = at(leftEnd, col) === '└';
      const closedRight = at(rightEnd, right) === '┘';
      // A fan-out connector (┌──┴──┐ with arrows below) never closes; only real boxes do.
      if (!closedLeft && !closedRight) continue;
      const where = `L${block.start + row + 1}`;
      if (!closedLeft || !closedRight || leftEnd !== rightEnd) {
        const misaligned = !closedLeft ? leftEnd : !closedRight ? rightEnd : Math.min(leftEnd, rightEnd);
        problems.push(`${where}: box ${!closedLeft ? 'left' : 'right'} edge misaligned at L${block.start + misaligned + 1}`);
        continue;
      }
      const bottom = leftEnd;
      for (let c = col + 1; c < right; c++) {
        if (!'─┬┴┼▲▼◀▶'.includes(at(bottom, c))) {
          problems.push(`${where}: box bottom edge broken at L${block.start + bottom + 1}`);
          break;
        }
      }
    }
  }
  return problems;
}

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
    let diagrams = 0;
    const flushFence = () => {
      if (!fence.diagram) return;
      diagrams += 1;
      findings.push(...brokenBoxes(fence.block));
      if (fence.width > MAX_DIAGRAM_WIDTH) {
        findings.push(`L${fence.line}: diagram is ${fence.width} columns wide (max ${MAX_DIAGRAM_WIDTH})`);
      }
      if (fence.emoji) findings.push(`L${fence.emoji}: emoji inside diagram breaks alignment`);
    };
    for (const [index, line] of lines.entries()) {
      const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (delimiter) {
        if (!fence) {
          fence = {
            char: delimiter[1][0],
            length: delimiter[1].length,
            line: index + 1,
            width: 0,
            diagram: false,
            emoji: 0,
            block: { start: index + 1, lines: [] },
          };
          if (interview && delimiter[2].trim()) findings.push(`L${index + 1}: tagged interview fence`);
        } else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
          flushFence();
          fence = null;
        }
        continue;
      }
      if (!fence) continue;
      fence.block.lines.push(line);
      if (BOX_DRAWING.test(line)) fence.diagram = true;
      fence.width = Math.max(fence.width, displayWidth(line));
      if (!fence.emoji && EMOJI.test(line)) fence.emoji = index + 1;
      if (interview && /\b(?:const\s+\w+\s*=|function\s+\w+\s*\(|CREATE TABLE|import\s+.+\s+from\s+|className=|return\s*\(|interface\s+\w+\s*\{)/.test(line)) {
        findings.push(`L${index + 1}: possible implementation code inside diagram`);
      }
    }
    if (fence) findings.push(`L${fence.line}: unclosed fence`);
    const words = source.split(/\s+/).filter(Boolean).length;
    if (interview && (words < INTERVIEW_WORDS.min || words > INTERVIEW_WORDS.max || lines.length > INTERVIEW_MAX_LINES)) {
      findings.push(
        `${words} words / ${lines.length} lines; target ${INTERVIEW_WORDS.min}–${INTERVIEW_WORDS.max} words and at most ${INTERVIEW_MAX_LINES} lines (pacing signal, do not pad)`,
      );
    }
    if ((interview || name === 'architecture.md') && diagrams === 0) findings.push('No box-drawing diagram found');
    files.push({ name, lines: lines.length, words, diagrams, findings });
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
        console.log(`${project}/${file.name}: ${file.lines ?? 'missing'} lines, ${file.words ?? 0} words, ${file.diagrams ?? 0} diagrams`);
        for (const finding of file.findings) console.log(`  ${finding}`);
      }
    }
  }
}
