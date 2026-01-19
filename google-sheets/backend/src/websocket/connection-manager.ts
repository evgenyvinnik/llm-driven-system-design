/**
 * Connection manager for WebSocket room management.
 *
 * @description Handles the lifecycle of WebSocket connections including room creation,
 * user joining/leaving, color assignment for presence indicators, and broadcasting
 * messages to room members. Maintains an in-memory map of active rooms and their clients.
 *
 * @module websocket/connection-manager
 */

import { WebSocket } from 'ws';
import { ExtendedWebSocket, Room, COLORS, Collaborator } from './types.js';
import { createChildLogger } from '../shared/logger.js';
import { wsConnectionsActive } from '../shared/metrics.js';
import {
  setCachedCollaborator,
  removeCachedCollaborator,
} from '../shared/cache.js';

/** Logger for connection management */
const connLogger = createChildLogger({ component: 'connection-manager' });

/**
 * In-memory mapping of spreadsheet IDs to their active rooms.
 * Each room contains all connected WebSocket clients.
 */
const rooms = new Map<string, Room>();

/** Color index for cycling through collaborator colors */
let colorIndex = 0;

/**
 * Returns the next available color from the color palette.
 *
 * @description Cycles through the predefined color palette to assign visually
 * distinct colors to collaborators. Each call increments the internal color
 * index, ensuring sequential users get different colors.
 *
 * @returns {string} A hex color code (e.g., '#FF6B6B') for the user's presence indicator
 *
 * @example
 * ```typescript
 * const userColor = getNextColor(); // '#FF6B6B'
 * const nextUserColor = getNextColor(); // '#4ECDC4'
 * ```
 */
export function getNextColor(): string {
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

/**
 * Gets or creates a room for a spreadsheet.
 *
 * @description Retrieves an existing room for the given spreadsheet ID, or creates
 * a new empty room if one doesn't exist. Rooms are used to group WebSocket
 * connections editing the same spreadsheet.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @returns {Room} The room object containing a Set of connected clients
 *
 * @example
 * ```typescript
 * const room = getOrCreateRoom('spreadsheet-123');
 * room.clients.add(ws);
 * ```
 */
export function getOrCreateRoom(spreadsheetId: string): Room {
  if (!rooms.has(spreadsheetId)) {
    rooms.set(spreadsheetId, { clients: new Set() });
  }
  return rooms.get(spreadsheetId)!;
}

/**
 * Gets a room for a spreadsheet if it exists.
 *
 * @description Retrieves an existing room without creating one if it doesn't exist.
 * Useful for checking if a room has active collaborators before broadcasting.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @returns {Room | undefined} The room object if it exists, undefined otherwise
 *
 * @example
 * ```typescript
 * const room = getRoom('spreadsheet-123');
 * if (room) {
 *   console.log(`${room.clients.size} users are editing`);
 * }
 * ```
 */
export function getRoom(spreadsheetId: string): Room | undefined {
  return rooms.get(spreadsheetId);
}

/**
 * Adds a client to a room.
 *
 * @description Joins a WebSocket client to the specified spreadsheet room.
 * Updates Prometheus metrics for active connections, caches the collaborator
 * information in Redis for multi-server sync, and logs the join event.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @param {ExtendedWebSocket} ws - The WebSocket client joining the room
 * @returns {Promise<void>} Resolves when the client has been added and cached
 *
 * @example
 * ```typescript
 * ws.userId = 'user-123';
 * ws.userName = 'Alice';
 * ws.userColor = '#FF6B6B';
 * await joinRoom('spreadsheet-456', ws);
 * ```
 */
export async function joinRoom(spreadsheetId: string, ws: ExtendedWebSocket): Promise<void> {
  const room = getOrCreateRoom(spreadsheetId);
  room.clients.add(ws);

  // Update metrics
  wsConnectionsActive.inc();

  // Cache collaborator info
  await setCachedCollaborator(spreadsheetId, ws.userId!, {
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
  });

  connLogger.info(
    { userId: ws.userId, userName: ws.userName, spreadsheetId },
    'User joined room'
  );
}

/**
 * Removes a client from a room and cleans up empty rooms.
 *
 * @description Handles client disconnection by removing the WebSocket from its room,
 * updating Prometheus metrics, removing the collaborator from Redis cache, and
 * cleaning up the room if it becomes empty.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket client leaving the room
 * @returns {Promise<void>} Resolves when cleanup is complete
 *
 * @example
 * ```typescript
 * ws.on('close', async () => {
 *   await leaveRoom(ws);
 * });
 * ```
 */
export async function leaveRoom(ws: ExtendedWebSocket): Promise<void> {
  if (!ws.spreadsheetId) return;

  // Update metrics
  wsConnectionsActive.dec();

  const room = rooms.get(ws.spreadsheetId);
  if (room) {
    room.clients.delete(ws);

    // Remove from collaborator cache
    if (ws.userId) {
      await removeCachedCollaborator(ws.spreadsheetId, ws.userId);
    }

    // Clean up empty rooms
    if (room.clients.size === 0) {
      rooms.delete(ws.spreadsheetId);
    }
  }

  connLogger.info(
    { userId: ws.userId, userName: ws.userName, spreadsheetId: ws.spreadsheetId },
    'User left room'
  );
}

/**
 * Gets the list of collaborators in a room, excluding a specific client.
 *
 * @description Retrieves information about all active collaborators in a room.
 * Typically used to send the list of existing collaborators to a newly joined user,
 * excluding the user themselves from the list.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @param {ExtendedWebSocket} [excludeWs] - Optional client to exclude from the list
 * @returns {Collaborator[]} Array of collaborator information objects
 *
 * @example
 * ```typescript
 * // Get all other collaborators when a user joins
 * const collaborators = getRoomCollaborators('spreadsheet-123', ws);
 * ws.send(JSON.stringify({ type: 'COLLABORATORS', collaborators }));
 * ```
 */
export function getRoomCollaborators(
  spreadsheetId: string,
  excludeWs?: ExtendedWebSocket
): Collaborator[] {
  const collaborators: Collaborator[] = [];
  const room = rooms.get(spreadsheetId);

  if (room) {
    for (const client of room.clients) {
      if (client !== excludeWs && client.userId) {
        collaborators.push({
          userId: client.userId,
          name: client.userName,
          color: client.userColor,
        });
      }
    }
  }

  return collaborators;
}

/**
 * Broadcasts a message to all clients in a spreadsheet room.
 *
 * @description Sends a message to all connected clients in the specified room.
 * Optionally excludes a specific client (typically the sender to avoid echo).
 * Only sends to clients with an open WebSocket connection.
 *
 * @param {string} spreadsheetId - The spreadsheet room to broadcast to
 * @param {any} message - The message object to send (will be JSON-stringified)
 * @param {ExtendedWebSocket} [exclude] - Optional WebSocket connection to exclude from broadcast
 * @returns {number} The number of clients the message was sent to
 *
 * @example
 * ```typescript
 * const sentCount = broadcastToRoom('spreadsheet-123', {
 *   type: 'CELL_UPDATED',
 *   row: 5,
 *   col: 2,
 *   value: 'Hello'
 * }, senderWs);
 * console.log(`Broadcast to ${sentCount} clients`);
 * ```
 */
export function broadcastToRoom(
  spreadsheetId: string,
  message: any,
  exclude?: ExtendedWebSocket
): number {
  const room = rooms.get(spreadsheetId);
  if (!room) return 0;

  const data = JSON.stringify(message);
  let sentCount = 0;

  for (const client of room.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
      sentCount++;
    }
  }

  return sentCount;
}

/**
 * Gets the number of clients in a room.
 *
 * @description Returns the count of currently connected clients in the specified room.
 * Useful for monitoring and displaying the number of active collaborators.
 *
 * @param {string} spreadsheetId - The unique identifier of the spreadsheet
 * @returns {number} The number of connected clients (0 if room doesn't exist)
 *
 * @example
 * ```typescript
 * const count = getRoomSize('spreadsheet-123');
 * console.log(`${count} users currently editing`);
 * ```
 */
export function getRoomSize(spreadsheetId: string): number {
  const room = rooms.get(spreadsheetId);
  return room ? room.clients.size : 0;
}
