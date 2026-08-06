/**
 * Room Management Routes
 *
 * @description Handles room-related endpoints including listing rooms and retrieving
 * message history. Provides REST API endpoints for room discovery and historical
 * message access using the in-memory ring buffer cache.
 * @module adapters/http/room-routes
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import type { ApiResponse } from '../../types/index.js';
import { historyBuffer, roomManager } from '../../core/index.js';
import { httpLogger } from '../../utils/logger.js';
import {
  historyBufferHits,
  historyBufferMisses,
  activeRooms,
} from '../../shared/metrics.js';
import { server } from '../../shared/config.js';

/**
 * Creates an Express router with room management endpoints.
 *
 * @description Sets up routes for room-related operations:
 * - GET /rooms: Lists all available chat rooms
 * - GET /rooms/:room/history: Retrieves the last 10 messages from a room's history buffer
 *
 * The history endpoint uses an in-memory ring buffer cache for fast access,
 * and tracks cache hits/misses via Prometheus metrics.
 *
 * @returns {Router} Express router configured with room management routes
 *
 * @example
 * // Mount room routes on the API path
 * app.use('/api', createRoomRoutes());
 */
export function createRoomRoutes(): Router {
  const router = express.Router();

  // GET /api/rooms - List all available rooms
  router.get('/rooms', async (req: Request, res: Response) => {
    try {
      const rooms = await roomManager.listRooms();
      activeRooms.labels({ instance: server.instanceId }).set(rooms.length);
      res.json({
        success: true,
        data: { rooms },
      } as ApiResponse);
    } catch (error) {
      httpLogger.error({ err: error }, 'List rooms error');
      res.status(500).json({
        success: false,
        error: 'Failed to list rooms',
      } as ApiResponse);
    }
  });

  // GET /api/rooms/:room/history - Get message history for a room
  router.get('/rooms/:room/history', async (req: Request, res: Response) => {
    try {
      const roomName = req.params.room as string;
      const room = await roomManager.getRoom(roomName);

      if (!room) {
        historyBufferMisses.labels({ instance: server.instanceId }).inc();
        res.status(404).json({
          success: false,
          error: 'Room not found',
        } as ApiResponse);
        return;
      }

      const history = historyBuffer.getHistory(roomName);
      historyBufferHits.labels({ instance: server.instanceId }).inc();

      // The history buffer stores the sender as `nickname`, but every live
      // message published by `message-router` carries it as `user` — and the
      // client reads `message.user`. Serving the buffer's shape verbatim meant
      // history messages arrived with `user` undefined, and `MessageList`'s
      // `message.user.charAt(0)` threw, taking down the whole app the moment
      // any room with history was opened. Normalise to the wire format the
      // rest of the system already uses.
      const messages = history.map((m) => ({
        ...m,
        user: (m as { user?: string; nickname?: string }).user
          ?? (m as { nickname?: string }).nickname,
      }));

      res.json({
        success: true,
        data: { messages },
      } as ApiResponse);
    } catch (error) {
      httpLogger.error({ err: error }, 'Get history error');
      res.status(500).json({
        success: false,
        error: 'Failed to get history',
      } as ApiResponse);
    }
  });

  return router;
}
