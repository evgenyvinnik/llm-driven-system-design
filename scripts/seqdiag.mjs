#!/usr/bin/env node
/**
 * Renders a plain-text sequence diagram with Unicode box-drawing characters, so flow
 * diagrams in architecture.md and the interview answers stay aligned.
 *
 * Usage: node scripts/seqdiag.mjs spec.txt    (or pipe the spec on stdin)
 *
 * Spec format, one statement per line:
 *   participants: Browser | Link API | Redis | PostgreSQL
 *   Browser -> Link API: POST /api/v1/links       request (arrow points right or left)
 *   Link API --> Browser: 201 {short_url}         response; drawn the same, label says what returns
 *   Link API -> Link API: pick random code        local step, written beside the lifeline (it may cross
 *                                                  neighbouring lifelines; flips left near the edge)
 *   -- after the 302 is sent --                   divider across all lifelines
 *   # comment                                     ignored
 * Steps are numbered automatically; prefix a label with "!" to leave it unnumbered.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(process.argv[2] ?? 0, 'utf8');
const participants = [];
const steps = [];
let number = 0;

for (const raw of source.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  if (line.startsWith('participants:')) {
    participants.push(...line.slice('participants:'.length).split('|').map((name) => name.trim()));
    continue;
  }
  const divider = line.match(/^--\s*(.*?)\s*--$/);
  if (divider) {
    steps.push({ kind: 'divider', text: divider[1] });
    continue;
  }
  const message = line.match(/^(.+?)\s*(-->|->)\s*(.+?)\s*:\s*(.*)$/);
  if (!message) throw new Error(`Cannot parse: ${line}`);
  const [, from, , to, rawLabel] = message;
  const a = participants.indexOf(from);
  const b = participants.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`Unknown participant in: ${line}`);
  const unnumbered = rawLabel.startsWith('!');
  const text = unnumbered ? rawLabel.slice(1).trim() : rawLabel;
  const label = unnumbered ? text : `${++number} ${text}`;
  steps.push({ kind: a === b ? 'local' : 'message', from: a, to: b, label });
}
if (participants.length < 2) throw new Error('Declare at least two participants');

// Lifeline columns: start from name widths, then widen gaps until every label fits.
const x = [];
participants.forEach((name, i) => {
  const half = Math.ceil(name.length / 2);
  x.push(i === 0 ? half : x[i - 1] + Math.ceil(participants[i - 1].length / 2) + half + 3);
});
const need = (left, right, width) => {
  const shortfall = x[left] + width - x[right];
  if (shortfall > 0) for (let i = right; i < x.length; i++) x[i] += shortfall;
};
const spans = steps
  .filter((step) => step.kind !== 'divider')
  .map((step) => {
    // Local steps may run across lifelines to their right instead of widening the diagram.
    if (step.kind === 'local') return null;
    return { left: Math.min(step.from, step.to), right: Math.max(step.from, step.to), width: step.label.length + 4 };
  })
  .filter(Boolean)
  .sort((p, q) => p.right - p.left - (q.right - q.left));
for (const span of spans) need(span.left, span.right, span.width);

// A local note that would run past the last lifeline is written to the left of its own instead.
const last = x[x.length - 1];
for (const step of steps) {
  if (step.kind !== 'local') continue;
  const fitsRight = x[step.from] + step.label.length + 3 <= last;
  step.left = !fitsRight && x[step.from] - step.label.length - 3 >= 0;
}
const overhang = Math.max(
  0,
  ...steps.filter((s) => s.kind === 'local' && !s.left).map((s) => x[s.from] + s.label.length + 3 - last),
);
const width = last + 1 + overhang;
const blank = () => {
  const row = Array(width).fill(' ');
  for (const col of x) row[col] = '│';
  return row;
};
const put = (row, col, text) => {
  for (const [offset, char] of [...text].entries()) row[col + offset] = char;
};
const out = [];

const header = Array(width).fill(' ');
participants.forEach((name, i) => put(header, Math.max(0, x[i] - Math.floor(name.length / 2)), name));
out.push(header, blank());

for (const step of steps) {
  if (step.kind === 'divider') {
    const row = blank();
    for (let col = x[0]; col <= x[x.length - 1]; col++) row[col] = '·';
    const text = ` ${step.text} `;
    put(row, Math.max(x[0] + 1, Math.floor((x[0] + x[x.length - 1] - text.length) / 2)), text);
    out.push(row);
    continue;
  }
  if (step.kind === 'local') {
    const row = blank();
    if (step.left) put(row, x[step.from] - step.label.length - 3, ` ${step.label} `);
    else put(row, x[step.from] + 2, `${step.label} `);
    out.push(row);
    continue;
  }
  const left = Math.min(step.from, step.to);
  const right = Math.max(step.from, step.to);
  const labelRow = blank();
  for (let i = left + 1; i < right; i++) labelRow[x[i]] = ' ';
  put(labelRow, x[left] + 2, step.label);
  const arrowRow = blank();
  for (let col = x[left] + 1; col < x[right]; col++) arrowRow[col] = '─';
  if (step.to > step.from) arrowRow[x[right] - 1] = '▶';
  else arrowRow[x[left] + 1] = '◀';
  out.push(labelRow, arrowRow);
}
out.push(blank());

const rendered = out.map((row) => row.join('').trimEnd());
const widest = Math.max(...rendered.map((row) => row.length));
console.log(rendered.join('\n'));
if (widest > 100) console.error(`warning: diagram is ${widest} columns wide; shorten labels (max 100)`);
