import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { addClient } from '../services/sseService.js';
import { subscribeToChannel, unsubscribeFromChannel } from '../services/pubsub.js';
import { requireChannel, respondError } from '../services/accessService.js';

const router = Router();

// GET /api/sse/:channelId - SSE stream for channel
//
// The user comes from the session cookie (requireAuth), never from the URL or
// query string, and the stream only opens for someone who can read the
// channel. Without the membership check any signed-in user could subscribe to
// any channel's live traffic, including private channels in other orgs.
router.get('/:channelId', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  let channelId: string;
  try {
    channelId = (await requireChannel(req.params.channelId, userId)).channelId;
    await subscribeToChannel(channelId);
  } catch (err) {
    // Headers aren't sent yet, so a refusal is an ordinary JSON 404/500 and
    // EventSource stops retrying.
    respondError(res, err, 'Failed to establish SSE connection');
    return;
  }

  // The client may have gone away while we were checking access/subscribing;
  // its 'close' has already fired, so release the subscription now.
  if (req.socket.destroyed) {
    unsubscribeFromChannel(channelId).catch(() => {});
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ channelId, userId })}\n\n`);

  // Add client to SSE manager
  addClient(channelId, userId, res);

  // Keep connection alive with periodic heartbeat
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeatInterval);
    // Release this client's share of the instance's Redis subscription; the
    // last client on a channel unsubscribes, so subscriptions no longer grow
    // for the life of the process.
    unsubscribeFromChannel(channelId).catch((err) =>
      logger.warn({ err, channelId }, 'Failed to release pub/sub subscription'),
    );
    logger.info({ channelId, userId }, 'SSE connection closed');
  });
});

export default router;
