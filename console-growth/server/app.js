import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachContext } from './lib/context.js';
import { ApiError } from './lib/errors.js';
import orgRoutes from './routes/org.js';
import keyRoutes from './routes/keys.js';
import workbenchRoutes from './routes/workbench.js';
import usageRoutes from './routes/usage.js';
import billingRoutes from './routes/billing.js';
import experimentRoutes from './routes/experiments.js';
import eventRoutes from './routes/events.js';
import devRoutes from './routes/dev.js';

const CLIENT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', attachContext);
  for (const routes of [orgRoutes, keyRoutes, workbenchRoutes, usageRoutes, billingRoutes, experimentRoutes, eventRoutes, devRoutes]) {
    app.use('/api', routes);
  }
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', 'No such endpoint.')));

  // `npm start` serves the built client from the same port.
  if (process.env.NODE_ENV === 'production' && fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { type: err.type, message: err.message } });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: { type: 'invalid_json', message: 'Request body is not valid JSON.' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { type: 'internal_error', message: 'Something went wrong.' } });
  });

  return app;
}
