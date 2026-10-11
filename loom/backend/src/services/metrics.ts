import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

/** HTTP request duration histogram (latency percentiles). */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

/** HTTP request counter for rate calculation. */
export const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/** Presigned part URLs handed out; their rate is the upload traffic going straight to storage. */
export const uploadPartUrlsIssued = new client.Counter({
  name: 'upload_part_urls_issued_total',
  help: 'Presigned multipart part URLs issued',
  registers: [register],
});

/** Upload completion calls by outcome (completed, replayed, incomplete, missing_object). */
export const uploadCompletions = new client.Counter({
  name: 'upload_completions_total',
  help: 'Upload completion requests by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

/** Server-side time to finalize an upload: list parts, stitch, verify, commit. */
export const uploadFinalizeDuration = new client.Histogram({
  name: 'upload_finalize_duration_seconds',
  help: 'Time from the complete request to the video being playable',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/** Abandoned uploads the sweeper marked failed. */
export const uploadsSwept = new client.Counter({
  name: 'uploads_swept_total',
  help: 'Abandoned uploads marked failed by the sweeper',
  registers: [register],
});

/** View tracking calls by result (new, heartbeat, owner_ignored). */
export const viewEvents = new client.Counter({
  name: 'view_events_total',
  help: 'View tracking requests by result',
  labelNames: ['result'],
  registers: [register],
});

/** Records method, matched route pattern (never the raw URL) and status for every request. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // Route patterns keep label cardinality bounded; unmatched paths share one label.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
}

export { register };
