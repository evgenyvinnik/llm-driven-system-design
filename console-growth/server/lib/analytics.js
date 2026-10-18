// Server-side analytics. Every event, whether it was sent by the client (POST /api/events) or
// emitted by the server, goes through track(). Events are kept in memory for the Dev toolbar's
// live stream and appended to data/events.ndjson, which is what an analysis would read.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_EVENTS_IN_MEMORY = 5_000;
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.ndjson');
const writeToDisk = process.env.NODE_ENV !== 'test';

const events = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);
let sequence = 0;

if (writeToDisk) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Record an event.
 * @param {string} event   Event name, snake_case. `$`-prefixed names are reserved for the framework.
 * @param {object} props   Event properties.
 * @param {object} context { userId, orgId, sessionId, source: 'server' | 'client', path }
 */
export function track(event, props = {}, context = {}) {
  sequence += 1;
  const record = {
    id: `evt_${Date.now().toString(36)}_${sequence}`,
    event,
    ts: new Date().toISOString(),
    source: context.source ?? 'server',
    userId: context.userId ?? null,
    orgId: context.orgId ?? null,
    sessionId: context.sessionId ?? null,
    path: context.path ?? null,
    props,
  };
  events.push(record);
  if (events.length > MAX_EVENTS_IN_MEMORY) events.shift();
  if (writeToDisk) fs.appendFile(EVENTS_FILE, `${JSON.stringify(record)}\n`, () => {});
  emitter.emit('event', record);
  return record;
}

export function getEvents({ limit = 200, event } = {}) {
  const matching = event ? events.filter((record) => record.event === event) : events;
  return matching.slice(-limit);
}

export function clearEvents() {
  events.length = 0;
}

export function subscribe(listener) {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
