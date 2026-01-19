/**
 * Real-time collaboration handlers for cursor and selection sync.
 *
 * @description Handles presence awareness features for collaborative editing.
 * Broadcasts cursor positions, selection ranges, and user join/leave events
 * to all collaborators in a spreadsheet room. Enables visual feedback of
 * where other users are working.
 *
 * @module websocket/collaboration
 */

import { ExtendedWebSocket, CursorMovePayload, SelectionChangePayload } from './types.js';
import { broadcastToRoom } from './connection-manager.js';
import { wsMessagesSent } from '../shared/metrics.js';

/**
 * Handles cursor movement notifications from clients.
 *
 * @description Broadcasts a user's cursor position to all other collaborators
 * in the same spreadsheet room. Used to display colored cursor indicators
 * showing where each user is currently focused.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket connection that moved its cursor
 * @param {CursorMovePayload} payload - Contains the row and col of the cursor position
 * @returns {void}
 *
 * @example
 * ```typescript
 * // When receiving a CURSOR_MOVE message from client
 * handleCursorMove(ws, { row: 5, col: 3 });
 * // Broadcasts to other users: { type: 'CURSOR_MOVED', userId, name, color, row: 5, col: 3 }
 * ```
 */
export function handleCursorMove(ws: ExtendedWebSocket, payload: CursorMovePayload): void {
  const { row, col } = payload;

  const sentCount = broadcastToRoom(ws.spreadsheetId!, {
    type: 'CURSOR_MOVED',
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
    row,
    col,
  }, ws);

  if (sentCount > 0) {
    wsMessagesSent.labels('CURSOR_MOVED').inc(sentCount);
  }
}

/**
 * Handles selection range changes from clients.
 *
 * @description Broadcasts a user's selection range to all other collaborators
 * in the same spreadsheet room. Used to display colored selection highlights
 * showing what cells each user has selected.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket connection that changed its selection
 * @param {SelectionChangePayload} payload - Contains the selection range object with start/end coordinates
 * @returns {void}
 *
 * @example
 * ```typescript
 * // When receiving a SELECTION_CHANGE message from client
 * handleSelectionChange(ws, {
 *   range: { startRow: 0, startCol: 0, endRow: 5, endCol: 3 }
 * });
 * // Broadcasts selection highlight to other users
 * ```
 */
export function handleSelectionChange(ws: ExtendedWebSocket, payload: SelectionChangePayload): void {
  const { range } = payload;

  const sentCount = broadcastToRoom(ws.spreadsheetId!, {
    type: 'SELECTION_CHANGED',
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
    range,
  }, ws);

  if (sentCount > 0) {
    wsMessagesSent.labels('SELECTION_CHANGED').inc(sentCount);
  }
}

/**
 * Broadcasts that a user has joined the spreadsheet.
 *
 * @description Notifies all existing collaborators that a new user has joined
 * the spreadsheet editing session. Used to update presence indicators and
 * collaborator lists in the UI.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket connection that joined
 * @returns {void}
 *
 * @example
 * ```typescript
 * // After a user successfully joins a room
 * await joinRoom(spreadsheetId, ws);
 * broadcastUserJoined(ws);
 * // Existing users receive: { type: 'USER_JOINED', userId, name, color }
 * ```
 */
export function broadcastUserJoined(ws: ExtendedWebSocket): void {
  const sentCount = broadcastToRoom(ws.spreadsheetId!, {
    type: 'USER_JOINED',
    userId: ws.userId,
    name: ws.userName,
    color: ws.userColor,
  }, ws);

  if (sentCount > 0) {
    wsMessagesSent.labels('USER_JOINED').inc(sentCount);
  }
}

/**
 * Broadcasts that a user has left the spreadsheet.
 *
 * @description Notifies all remaining collaborators that a user has disconnected
 * from the spreadsheet editing session. Used to remove presence indicators
 * and update collaborator lists in the UI.
 *
 * @param {ExtendedWebSocket} ws - The WebSocket connection that left
 * @returns {void}
 *
 * @example
 * ```typescript
 * // When a user disconnects
 * ws.on('close', async () => {
 *   broadcastUserLeft(ws);
 *   await leaveRoom(ws);
 * });
 * // Remaining users receive: { type: 'USER_LEFT', userId }
 * ```
 */
export function broadcastUserLeft(ws: ExtendedWebSocket): void {
  if (!ws.spreadsheetId) return;

  const sentCount = broadcastToRoom(ws.spreadsheetId, {
    type: 'USER_LEFT',
    userId: ws.userId,
  });

  if (sentCount > 0) {
    wsMessagesSent.labels('USER_LEFT').inc(sentCount);
  }
}
