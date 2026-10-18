// Prints each experiment's metrics per arm from data/events.ndjson.
//
//   npm run readout                       # real traffic only
//   npm run readout -- --include-overrides  # also count exposures forced from the Dev toolbar
//
// Locally there is one org, so this shows how the numbers are computed, not a result.
// Clear the event log (Dev toolbar → Data) before a demo run: an org exposed in both variants is
// dropped as contaminated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS, computeReadout } from '../server/lib/readout.js';

const EVENTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'events.ndjson');
const includeOverrides = process.argv.includes('--include-overrides');

if (!fs.existsSync(EVENTS_FILE)) {
  console.log('No events yet: run the app (npm run dev) and click around first.');
  process.exit(0);
}

const events = fs
  .readFileSync(EVENTS_FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const format = (metric, value) => {
  if (value === null) return '—';
  return metric.kind === 'rate' ? `${(value * 100).toFixed(1)}%` : `$${(value / 100).toFixed(2)}`;
};

for (const [experiment, metrics] of Object.entries(METRICS)) {
  const readout = computeReadout(events, experiment, { includeOverrides });
  console.log(`\n${experiment}`);
  console.log(`  left out: ${readout.overridden} overridden exposures, ${readout.contaminated} units seen in both variants`);
  const variants = Object.keys(readout.arms).sort();
  if (variants.length === 0) {
    console.log('  no exposed units');
    continue;
  }
  console.log(`  ${'metric'.padEnd(40)}${variants.map((variant) => `${variant} (n=${readout.arms[variant].exposed})`.padStart(22)).join('')}`);
  for (const metric of metrics) {
    const cells = variants.map((variant) => format(metric, readout.arms[variant].metrics[metric.name].value).padStart(22));
    console.log(`  ${`${metric.role}: ${metric.name}`.padEnd(40)}${cells.join('')}`);
  }
}
