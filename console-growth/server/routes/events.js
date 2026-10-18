import { Router } from 'express';
import { getEvents, subscribe, track } from '../lib/analytics.js';
import { trackingContext } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';

const router = Router();
// Client events are snake_case. `$`-prefixed names (like $exposure) are reserved for the
// framework and can't be sent from the browser.
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_PROPS_BYTES = 4_096;

router.post('/events', (req, res) => {
  const { event, props = {}, path = null } = req.body ?? {};
  if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
    throw badRequest('event must be a snake_case name of up to 64 characters.');
  }
  if (typeof props !== 'object' || props === null || Array.isArray(props)) throw badRequest('props must be an object.');
  if (JSON.stringify(props).length > MAX_PROPS_BYTES) throw badRequest('props are too large.');
  track(event, props, { ...trackingContext(req), source: 'client', path });
  res.status(202).end();
});

router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1_000);
  res.json({ events: getEvents({ limit, event: req.query.event }) });
});

// Live stream for the Dev toolbar: the last 50 events, then everything new as it happens.
router.get('/events/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (record) => res.write(`data: ${JSON.stringify(record)}\n\n`);
  getEvents({ limit: 50 }).forEach(send);
  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
