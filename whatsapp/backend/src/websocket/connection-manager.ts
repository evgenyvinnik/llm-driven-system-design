import { WebSocket } from 'ws';
import { AuthenticatedSocket } from './types.js';

/**
 * Connection Manager Module
 *
 * @description Manages the in-memory map of userId to their active WebSocket connection
 * on this server. Used for local message delivery before falling back to
 * Redis pub/sub for cross-server communication.
 *
 * This module provides the core connection tracking functionality for the
 * WebSocket server, enabling efficient message routing to locally connected users.
 *
 * @module connection-manager
 */

/**
 * Map of userId to their active WebSocket connection on this server.
 * @internal
 */
const connections = new Map<string, AuthenticatedSocket>();

/**
 * Stores a user's WebSocket connection in the local connection map.
 *
 * @description Registers an authenticated WebSocket connection for a user.
 * If the user already has a connection, it will be replaced (last connection wins).
 * Call this after successful authentication during WebSocket handshake.
 *
 * @param userId - The unique identifier of the authenticated user
 * @param socket - The authenticated WebSocket connection to store
 * @returns void
 *
 * @example
 * ```typescript
 * socket.userId = session.userId;
 * socket.isAlive = true;
 * addConnection(session.userId, socket);
 * ```
 */
export function addConnection(userId: string, socket: AuthenticatedSocket): void {
  connections.set(userId, socket);
}

/**
 * Removes a user's WebSocket connection from the local connection map.
 *
 * @description Unregisters a user's connection, typically called when the
 * WebSocket closes or the user disconnects. Safe to call even if the user
 * has no active connection.
 *
 * @param userId - The unique identifier of the user to remove
 * @returns void
 *
 * @example
 * ```typescript
 * socket.on('close', () => {
 *   removeConnection(socket.userId);
 * });
 * ```
 */
export function removeConnection(userId: string): void {
  connections.delete(userId);
}

/**
 * Gets a user's WebSocket connection if they're connected to this server.
 *
 * @description Retrieves the active WebSocket connection for a user.
 * Returns undefined if the user is not connected to this server instance
 * (they may be connected to a different server or offline).
 *
 * @param userId - The unique identifier of the user to look up
 * @returns The AuthenticatedSocket if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const socket = getConnection(recipientId);
 * if (socket) {
 *   sendToSocket(socket, message);
 * } else {
 *   // Route through Redis to other servers
 * }
 * ```
 */
export function getConnection(userId: string): AuthenticatedSocket | undefined {
  return connections.get(userId);
}

/**
 * Returns the number of active WebSocket connections on this server.
 *
 * @description Provides a count of currently connected users for health checks,
 * load monitoring, and metrics. This count is specific to this server instance.
 *
 * @returns The count of connected users on this server
 *
 * @example
 * ```typescript
 * app.get('/health', (req, res) => {
 *   res.json({
 *     status: 'ok',
 *     connections: getConnectionCount()
 *   });
 * });
 * ```
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Iterates over all active connections on this server.
 *
 * @description Returns an iterator over all [userId, socket] pairs.
 * Useful for broadcasting messages to all connected users (e.g., presence updates).
 *
 * @returns Iterator of [userId, socket] entries
 *
 * @example
 * ```typescript
 * for (const [userId, socket] of getAllConnections()) {
 *   if (socket.readyState === WebSocket.OPEN) {
 *     socket.send(JSON.stringify(broadcastMessage));
 *   }
 * }
 * ```
 */
export function getAllConnections(): IterableIterator<[string, AuthenticatedSocket]> {
  return connections.entries();
}

/**
 * Safely sends a message to a WebSocket connection.
 *
 * @description Serializes and sends a message object to a WebSocket.
 * Checks the connection state before sending to avoid errors on closed connections.
 * The message is JSON-serialized before transmission.
 *
 * @param socket - The WebSocket to send the message to
 * @param message - The message object to serialize and send
 * @returns void
 *
 * @example
 * ```typescript
 * sendToSocket(socket, {
 *   type: 'message',
 *   payload: { content: 'Hello!', timestamp: Date.now() }
 * });
 * ```
 */
export function sendToSocket(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/**
 * Sends a message to a user if they're connected to this server.
 *
 * @description Attempts to deliver a message to a user via their local connection.
 * Combines connection lookup and message sending in one operation.
 * Returns a boolean indicating whether the message was sent.
 *
 * @param userId - The unique identifier of the recipient user
 * @param message - The message object to send
 * @returns true if the message was sent successfully, false if the user is not connected locally
 *
 * @example
 * ```typescript
 * const delivered = sendToUser(recipientId, {
 *   type: 'message',
 *   payload: chatMessage
 * });
 *
 * if (!delivered) {
 *   // User not on this server, route via Redis
 *   await publishToRecipientServer(recipientId, chatMessage);
 * }
 * ```
 */
export function sendToUser(userId: string, message: unknown): boolean {
  const socket = connections.get(userId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
