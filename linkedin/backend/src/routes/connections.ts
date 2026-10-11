/**
 * Connection routes for the LinkedIn clone.
 * Manages the professional network graph - connection requests,
 * acceptance/rejection, and network analysis (PYMK, mutual connections).
 *
 * Every mutation is idempotent: repeating it returns the current state with
 * `changed: false` instead of an error, so clients can retry safely. Events and
 * audit entries are emitted only when something actually changed.
 *
 * @module routes/connections
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as connectionService from '../services/connectionService.js';
import { getPeopleYouMayKnow } from '../services/pymkService.js';
import { getUsersByIds } from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';
import { connectionRequestRateLimit, readRateLimit, writeRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { parseId, sendApiError, ApiError } from '../utils/errors.js';
import {
  connectionRequestsTotal,
  connectionsCreatedTotal,
  connectionsRemovedTotal,
} from '../utils/metrics.js';
import {
  publishToQueue,
  QUEUES,
  ConnectionEvent,
  NotificationEvent,
} from '../utils/rabbitmq.js';
import {
  logConnectionEvent,
  AuditEventType,
} from '../utils/audit.js';

const router = Router();

/** LinkedIn caps invitation notes at 300 characters. */
const MAX_INVITATION_MESSAGE = 300;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const value = parseInt(raw as string);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

async function publishConnectionCreated(userId: number, connectedUserId: number, actorId: number, recipientId: number) {
  const connectionEvent: ConnectionEvent = {
    type: 'connection.created',
    userId,
    connectedUserId,
    idempotencyKey: uuidv4(),
    timestamp: new Date().toISOString(),
  };
  await publishToQueue(QUEUES.PYMK_COMPUTE, connectionEvent);

  const notificationEvent: NotificationEvent = {
    type: 'notification.connection_accepted',
    recipientId,
    actorId,
    idempotencyKey: uuidv4(),
    timestamp: new Date().toISOString(),
  };
  await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);
}

// Get my connections
router.get('/', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const limit = clampLimit(req.query.limit, 20, 100);

    const connections = await connectionService.getConnectionsWithData(
      req.session.userId!,
      offset,
      limit
    );

    res.json({ connections });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get connections error');
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

// Get pending connection requests
router.get('/requests', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const requests = await connectionService.getPendingRequests(req.session.userId!);
    res.json({ requests });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get requests error');
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Send connection request (with stricter rate limiting)
router.post('/request', requireAuth, connectionRequestRateLimit, async (req: Request, res: Response) => {
  try {
    const fromUserId = req.session.userId!;
    const toUserId = parseId(req.body?.userId, 'userId');
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : undefined;
    if (message && message.length > MAX_INVITATION_MESSAGE) {
      throw new ApiError(400, 'message_too_long', `Message must be at most ${MAX_INVITATION_MESSAGE} characters`);
    }

    const { outcome, request } = await connectionService.sendConnectionRequest(fromUserId, toUserId, message);

    if (outcome === 'sent') {
      connectionRequestsTotal.inc();
      const notificationEvent: NotificationEvent = {
        type: 'notification.connection_request',
        recipientId: toUserId,
        actorId: fromUserId,
        entityId: request.id,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);
      await logConnectionEvent(AuditEventType.CONNECTION_REQUEST_SENT, fromUserId, toUserId, req.ip || 'unknown');
    } else if (outcome === 'accepted_reverse') {
      connectionsCreatedTotal.inc();
      await publishConnectionCreated(toUserId, fromUserId, fromUserId, toUserId);
      await logConnectionEvent(AuditEventType.CONNECTION_REQUEST_ACCEPTED, fromUserId, toUserId, req.ip || 'unknown');
    }

    logger.info({ fromUserId, toUserId, outcome }, 'Connection request handled');

    res.status(outcome === 'sent' ? 201 : 200).json({
      request,
      outcome,
      status: outcome === 'accepted_reverse' ? 'connected' : 'pending_sent',
    });
  } catch (error: unknown) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Send request error');
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Accept connection request
router.post('/requests/:id/accept', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const requestId = parseId(req.params.id);

    const { request, changed } = await connectionService.acceptConnectionRequest(requestId, userId);

    if (changed) {
      connectionsCreatedTotal.inc();
      await publishConnectionCreated(request.from_user_id, userId, userId, request.from_user_id);
      await logConnectionEvent(AuditEventType.CONNECTION_REQUEST_ACCEPTED, userId, request.from_user_id, req.ip || 'unknown');
    }

    logger.info({ requestId, userId, changed }, 'Connection request accepted');

    res.json({ message: 'Connection accepted', request, changed });
  } catch (error: unknown) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Accept request error');
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// Reject connection request
router.post('/requests/:id/reject', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const requestId = parseId(req.params.id);

    const { request, changed } = await connectionService.rejectConnectionRequest(requestId, userId);

    if (changed) {
      await logConnectionEvent(AuditEventType.CONNECTION_REQUEST_REJECTED, userId, request.from_user_id, req.ip || 'unknown');
    }

    logger.info({ requestId, userId, changed }, 'Connection request rejected');

    res.json({ message: 'Connection rejected', request, changed });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Reject request error');
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Withdraw an invitation I sent
router.post('/requests/:id/withdraw', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const requestId = parseId(req.params.id);

    const { request, changed } = await connectionService.withdrawConnectionRequest(requestId, userId);

    logger.info({ requestId, userId, changed }, 'Connection request withdrawn');

    res.json({ message: 'Invitation withdrawn', request, changed });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Withdraw request error');
    res.status(500).json({ error: 'Failed to withdraw request' });
  }
});

// Remove connection
router.delete('/:userId', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const connectedUserId = parseId(req.params.userId, 'userId');

    const removed = await connectionService.removeConnection(userId, connectedUserId);

    if (removed) {
      connectionsRemovedTotal.inc();

      // Publish connection removed event for PYMK recalculation
      const connectionEvent: ConnectionEvent = {
        type: 'connection.removed',
        userId,
        connectedUserId,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.PYMK_COMPUTE, connectionEvent);

      await logConnectionEvent(AuditEventType.CONNECTION_REMOVED, userId, connectedUserId, req.ip || 'unknown');
    }

    logger.info({ userId, connectedUserId, removed }, 'Connection removal handled');

    res.json({ message: removed ? 'Connection removed' : 'Not connected', removed });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Remove connection error');
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

// How the viewer relates to another member: degree, invitation state, mutual count, path
router.get('/degree/:userId', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const relationship = await connectionService.getRelationship(
      req.session.userId!,
      parseId(req.params.userId, 'userId')
    );
    res.json(relationship);
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Get degree error');
    res.status(500).json({ error: 'Failed to get connection degree' });
  }
});

// Get mutual connections
router.get('/mutual/:userId', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const mutualIds = await connectionService.getMutualConnections(
      req.session.userId!,
      parseId(req.params.userId, 'userId')
    );
    const mutualConnections = await getUsersByIds(mutualIds.slice(0, 100));

    res.json({ mutual_connections: mutualConnections, total: mutualIds.length });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error, userId: req.session.userId }, 'Get mutual connections error');
    res.status(500).json({ error: 'Failed to get mutual connections' });
  }
});

// Get second-degree connections
router.get('/second-degree', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const secondDegree = await connectionService.getSecondDegreeConnections(req.session.userId!, 50);
    res.json({ connections: secondDegree });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get second-degree error');
    res.status(500).json({ error: 'Failed to get second-degree connections' });
  }
});

// Get PYMK (People You May Know)
router.get('/pymk', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const limit = clampLimit(req.query.limit, 10, 50);
    const pymk = await getPeopleYouMayKnow(req.session.userId!, limit);
    res.json({ people: pymk });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get PYMK error');
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

export default router;
