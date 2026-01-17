/**
 * Connection routes for the LinkedIn clone.
 * Manages the professional network graph - connection requests,
 * acceptance/rejection, and network analysis (PYMK, mutual connections).
 *
 * @module routes/connections
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as connectionService from '../services/connectionService.js';
import { requireAuth } from '../middleware/auth.js';
import { connectionRequestRateLimit, readRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
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

// Get my connections
router.get('/', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

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
    const { userId, message } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot connect with yourself' });
      return;
    }

    const request = await connectionService.sendConnectionRequest(
      req.session.userId!,
      userId,
      message
    );

    // Track metrics
    connectionRequestsTotal.inc();

    // Publish notification event
    const notificationEvent: NotificationEvent = {
      type: 'notification.connection_request',
      recipientId: userId,
      actorId: req.session.userId!,
      entityId: request.id,
      idempotencyKey: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);

    // Audit log
    await logConnectionEvent(
      AuditEventType.CONNECTION_REQUEST_SENT,
      req.session.userId!,
      userId,
      req.ip || 'unknown'
    );

    logger.info(
      { fromUserId: req.session.userId, toUserId: userId },
      'Connection request sent'
    );

    res.status(201).json({ request });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error({ error, userId: req.session.userId }, 'Send request error');
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Accept connection request
router.post('/requests/:id/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = parseInt(req.params.id);

    // Get request details before accepting (for notification)
    const pendingRequests = await connectionService.getPendingRequests(req.session.userId!);
    const request = pendingRequests.find(r => r.id === requestId);

    await connectionService.acceptConnectionRequest(requestId, req.session.userId!);

    // Track metrics
    connectionsCreatedTotal.inc();

    if (request) {
      // Publish connection event for PYMK recalculation
      const connectionEvent: ConnectionEvent = {
        type: 'connection.created',
        userId: request.from_user_id,
        connectedUserId: req.session.userId!,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.PYMK_COMPUTE, connectionEvent);

      // Publish notification to the requester
      const notificationEvent: NotificationEvent = {
        type: 'notification.connection_accepted',
        recipientId: request.from_user_id,
        actorId: req.session.userId!,
        idempotencyKey: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      await publishToQueue(QUEUES.NOTIFICATIONS, notificationEvent);

      // Audit log
      await logConnectionEvent(
        AuditEventType.CONNECTION_REQUEST_ACCEPTED,
        req.session.userId!,
        request.from_user_id,
        req.ip || 'unknown'
      );
    }

    logger.info(
      { requestId, userId: req.session.userId },
      'Connection request accepted'
    );

    res.json({ message: 'Connection accepted' });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error({ error, userId: req.session.userId }, 'Accept request error');
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// Reject connection request
router.post('/requests/:id/reject', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = parseInt(req.params.id);

    // Get request details before rejecting (for audit)
    const pendingRequests = await connectionService.getPendingRequests(req.session.userId!);
    const request = pendingRequests.find(r => r.id === requestId);

    await connectionService.rejectConnectionRequest(requestId, req.session.userId!);

    if (request) {
      await logConnectionEvent(
        AuditEventType.CONNECTION_REQUEST_REJECTED,
        req.session.userId!,
        request.from_user_id,
        req.ip || 'unknown'
      );
    }

    logger.info(
      { requestId, userId: req.session.userId },
      'Connection request rejected'
    );

    res.json({ message: 'Connection rejected' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Reject request error');
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Remove connection
router.delete('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const connectedUserId = parseInt(req.params.userId);

    await connectionService.removeConnection(req.session.userId!, connectedUserId);

    // Track metrics
    connectionsRemovedTotal.inc();

    // Publish connection removed event for PYMK recalculation
    const connectionEvent: ConnectionEvent = {
      type: 'connection.removed',
      userId: req.session.userId!,
      connectedUserId,
      idempotencyKey: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    await publishToQueue(QUEUES.PYMK_COMPUTE, connectionEvent);

    // Audit log
    await logConnectionEvent(
      AuditEventType.CONNECTION_REMOVED,
      req.session.userId!,
      connectedUserId,
      req.ip || 'unknown'
    );

    logger.info(
      { userId: req.session.userId, connectedUserId },
      'Connection removed'
    );

    res.json({ message: 'Connection removed' });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Remove connection error');
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

// Get connection degree with a user
router.get('/degree/:userId', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const degree = await connectionService.getConnectionDegree(
      req.session.userId!,
      parseInt(req.params.userId)
    );
    res.json({ degree });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get degree error');
    res.status(500).json({ error: 'Failed to get connection degree' });
  }
});

// Get mutual connections
router.get('/mutual/:userId', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const mutualIds = await connectionService.getMutualConnections(
      req.session.userId!,
      parseInt(req.params.userId)
    );

    const users = await connectionService.getConnectionsWithData(
      req.session.userId!,
      0,
      100
    );

    const mutualSet = new Set(mutualIds);
    const mutualConnections = users.filter(u => mutualSet.has(u.id));

    res.json({ mutual_connections: mutualConnections });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get mutual connections error');
    res.status(500).json({ error: 'Failed to get mutual connections' });
  }
});

// Get second-degree connections
router.get('/second-degree', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const secondDegree = await connectionService.getSecondDegreeConnections(req.session.userId!);
    res.json({ connections: secondDegree.slice(0, 50) });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get second-degree error');
    res.status(500).json({ error: 'Failed to get second-degree connections' });
  }
});

// Get PYMK (People You May Know)
router.get('/pymk', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const pymk = await connectionService.getPeopleYouMayKnow(req.session.userId!, limit);
    res.json({ people: pymk });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get PYMK error');
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

export default router;
