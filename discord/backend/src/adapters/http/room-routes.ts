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

      // Normalise the buffer's internal shape to the wire format the rest of
      // the system already speaks (`message-router.formatMessageJson`: `user`
      // + `timestamp`). The buffer stores the DB row, which names these
      // `nickname` and `createdAt`, and serving that verbatim broke the client
      // twice over: `MessageList` does `message.user.charAt(0)`, so history
      // threw and took down the whole app the moment any populated room was
      // opened; and `new Date(message.timestamp)` on an absent field rendered
      // "Invalid Date" against every message.
      const messages = history.map((m) => {
        const raw = m as {
          user?: string;
          nickname?: string;
          timestamp?: Date | string;
          createdAt?: Date | string;
        };
        const ts = raw.timestamp ?? raw.createdAt;
        return {
          ...m,
          user: raw.user ?? raw.nickname,
          timestamp: ts instanceof Date ? ts.toISOString() : ts,
        };
      });

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
