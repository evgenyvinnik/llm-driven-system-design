import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireChannelAccess } from '../middleware/access.js';
import { logger } from '../services/logger.js';
import { addClient } from '../services/sseService.js';

const router = Router();

const HEARTBEAT_MS = 25_000;

/** Stream cursor: undefined when absent, null when malformed. */
function parseCursor(value: unknown): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// GET /api/sse/:channelId?after=<seq> - ordered, resumable event stream for one channel.
// Every event carries `id: <seq>`. When EventSource reconnects it sends the last id it saw as
// Last-Event-ID, which takes precedence over the `after` the stream was first opened with, and
// the server replays everything after it from the channel_events log before going live.
router.get(
  '/:channelId',
  requireAuth,
  requireChannelAccess((req) => req.params.channelId),
  async (req: Request, res: Response) => {
    const channelId = req.channelAccess!.channelId;
    const userId = req.session.userId!;
    const fromHeader = parseCursor(req.get('Last-Event-ID'));
    const fromQuery = parseCursor(req.query.after);
    if (fromHeader === null || fromQuery === null) {
      res.status(400).json({ error: 'Last-Event-ID and after must be non-negative integers' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Reconnect after 3 s rather than the browser default; replay makes the pause lossless.
    res.write('retry: 3000\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ channelId, userId })}\n\n`);

    // Comment lines keep idle connections from being reaped by proxies and load balancers.
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      logger.info({ channelId, userId }, 'SSE connection closed');
    });

    try {
      await addClient(channelId, userId, res, fromHeader ?? fromQuery ?? null);
    } catch (err) {
      // Ending the response makes EventSource reconnect, which retries the replay.
      logger.error({ err, channelId }, 'SSE replay failed');
      res.end();
    }
  },
);

export default router;
