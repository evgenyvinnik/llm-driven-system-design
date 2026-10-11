import { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestTotal } from '../services/metrics.js';

/**
 * Records latency and count per route pattern (`/api/messages/:messageId`, not the concrete
 * URL, which would explode label cardinality). SSE streams are skipped: they stay open for
 * minutes and would drown the latency histogram.
 */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/sse')) {
    next();
    return;
  }
  const stopTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched',
      status_code: String(res.statusCode),
    };
    stopTimer(labels);
    httpRequestTotal.inc(labels);
  });
  next();
}
