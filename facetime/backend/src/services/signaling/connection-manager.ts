/**
 * Connection Manager - Handles WebSocket client tracking and utilities.
 *
 * Manages:
 * - Client connection maps
 * - User-to-client lookups
 * - Ring timeout tracking
 * - Call creation time tracking
 * - Message sending utilities
 */

import { WebSocket } from 'ws';
import type { WebSocketMessage } from '../../types/index.js';
import type { ConnectedClient } from './types.js';

/** Map of clientId to ConnectedClient for all active WebSocket connections */
const clients = new Map<string, ConnectedClient>();

/** Map of userId to Set of clientIds for quick user-to-connection lookup */
const userClients = new Map<string, Set<string>>();

/** Map of callId to timeout handle for ring timeout management */
const ringTimeouts = new Map<string, NodeJS.Timeout>();

/** Map of callId to creation timestamp for setup latency tracking */
const callCreationTimes = new Map<string, number>();

// --- Client Management ---

/**
 * Retrieves a connected client by their unique client ID.
 *
 * @description Looks up a client in the active connections map.
 *
 * @param clientId - The unique identifier for the WebSocket connection
 * @returns The ConnectedClient if found, undefined otherwise
 */
export function getClient(clientId: string): ConnectedClient | undefined {
  return clients.get(clientId);
}

/**
 * Registers a new connected client in the tracking map.
 *
 * @description Stores the client information for later lookups and message routing.
 *
 * @param clientId - The unique identifier for the WebSocket connection
 * @param client - The connected client data to store
 * @returns void
 */
export function setClient(clientId: string, client: ConnectedClient): void {
  clients.set(clientId, client);
}

/**
 * Removes a client from the tracking map.
 *
 * @description Called during client disconnection cleanup.
 *
 * @param clientId - The unique identifier for the WebSocket connection to remove
 * @returns true if the client was found and removed, false otherwise
 */
export function deleteClient(clientId: string): boolean {
  return clients.delete(clientId);
}

/**
 * Returns the complete map of all connected clients.
 *
 * @description Used for operations that need to iterate over all connections,
 * such as heartbeat checking.
 *
 * @returns Map of clientId to ConnectedClient for all active connections
 */
export function getAllClients(): Map<string, ConnectedClient> {
  return clients;
}

/**
 * Returns the total number of connected clients.
 *
 * @description Useful for monitoring and stats endpoints.
 *
 * @returns The count of active WebSocket connections
 */
export function getClientCount(): number {
  return clients.size;
}

// --- User-Client Lookup ---

/**
 * Gets all client IDs associated with a specific user.
 *
 * @description A user can be connected from multiple devices simultaneously.
 * This returns all active connection IDs for a given user.
 *
 * @param userId - The user ID to look up
 * @returns Set of clientIds for this user, or undefined if user has no connections
 */
export function getUserClientIds(userId: string): Set<string> | undefined {
  return userClients.get(userId);
}

/**
 * Associates a client connection with a user.
 *
 * @description Called during registration to enable user-based message routing.
 * Creates a new Set if this is the user's first connection.
 *
 * @param userId - The user ID to associate
 * @param clientId - The client connection ID to add
 * @returns void
 */
export function addUserClient(userId: string, clientId: string): void {
  if (!userClients.has(userId)) {
    userClients.set(userId, new Set());
  }
  userClients.get(userId)!.add(clientId);
}

/**
 * Removes a client connection from a user's connection set.
 *
 * @description Called during disconnection. If this was the user's last
 * connection, removes the user from the map entirely.
 *
 * @param userId - The user ID to update
 * @param clientId - The client connection ID to remove
 * @returns void
 */
export function removeUserClient(userId: string, clientId: string): void {
  const clientIds = userClients.get(userId);
  if (clientIds) {
    clientIds.delete(clientId);
    if (clientIds.size === 0) {
      userClients.delete(userId);
    }
  }
}

/**
 * Returns the complete user-to-clients mapping.
 *
 * @description Used for debugging and monitoring purposes.
 *
 * @returns Map of userId to Set of clientIds
 */
export function getAllUserClients(): Map<string, Set<string>> {
  return userClients;
}

// --- Ring Timeout Management ---

/**
 * Stores a ring timeout for a call.
 *
 * @description When a call is initiated, a timeout is set. If no callee
 * answers within the timeout period, the call is marked as missed.
 *
 * @param callId - The unique identifier of the call
 * @param timeout - The NodeJS Timeout handle to store
 * @returns void
 */
export function setRingTimeout(callId: string, timeout: NodeJS.Timeout): void {
  ringTimeouts.set(callId, timeout);
}

/**
 * Retrieves the ring timeout for a call.
 *
 * @description Used to check if a timeout exists for a specific call.
 *
 * @param callId - The unique identifier of the call
 * @returns The timeout handle if found, undefined otherwise
 */
export function getRingTimeout(callId: string): NodeJS.Timeout | undefined {
  return ringTimeouts.get(callId);
}

/**
 * Clears and removes the ring timeout for a call.
 *
 * @description Called when a call is answered, declined, or ended to prevent
 * the timeout from firing. Safely handles cases where no timeout exists.
 *
 * @param callId - The unique identifier of the call
 * @returns void
 */
export function clearRingTimeout(callId: string): void {
  const timeout = ringTimeouts.get(callId);
  if (timeout) {
    clearTimeout(timeout);
    ringTimeouts.delete(callId);
  }
}

// --- Call Creation Time Tracking ---

/**
 * Stores the creation timestamp for a call.
 *
 * @description Used to calculate call setup latency when the call is answered.
 * The latency metric helps monitor system performance.
 *
 * @param callId - The unique identifier of the call
 * @param time - Unix timestamp in milliseconds when the call was created
 * @returns void
 */
export function setCallCreationTime(callId: string, time: number): void {
  callCreationTimes.set(callId, time);
}

/**
 * Retrieves the creation timestamp for a call.
 *
 * @description Used when a call is answered to calculate setup latency.
 *
 * @param callId - The unique identifier of the call
 * @returns The creation timestamp in milliseconds, or undefined if not found
 */
export function getCallCreationTime(callId: string): number | undefined {
  return callCreationTimes.get(callId);
}

/**
 * Removes the creation timestamp for a call.
 *
 * @description Called after latency is calculated or when a call ends
 * without being answered.
 *
 * @param callId - The unique identifier of the call
 * @returns true if the entry was found and removed, false otherwise
 */
export function deleteCallCreationTime(callId: string): boolean {
  return callCreationTimes.delete(callId);
}

// --- Message Sending ---

/**
 * Sends a message to a connected WebSocket client.
 *
 * @description Serializes the message to JSON and adds a timestamp before sending.
 * Safely checks that the connection is open before attempting to send.
 *
 * @param ws - The WebSocket connection to send to
 * @param message - The WebSocket message object to send
 * @returns void
 */
export function sendToClient(ws: WebSocket, message: WebSocketMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: Date.now() }));
  }
}

/**
 * Sends a message to all connected devices of a specific user.
 *
 * @description Iterates through all active connections for a user and sends
 * the message to each device. Optionally excludes a specific device (useful
 * when the sender is also the recipient on another device).
 *
 * @param userId - The user ID whose devices should receive the message
 * @param message - The WebSocket message object to send
 * @param excludeDeviceId - Optional device ID to exclude from message delivery
 * @returns void
 */
export function sendToUser(
  userId: string,
  message: WebSocketMessage,
  excludeDeviceId?: string
): void {
  const clientIds = userClients.get(userId);
  if (clientIds) {
    for (const clientId of clientIds) {
      const client = clients.get(clientId);
      if (client && (!excludeDeviceId || client.deviceId !== excludeDeviceId)) {
        sendToClient(client.ws, message);
      }
    }
  }
}

/**
 * Returns a list of currently online users with their device counts.
 *
 * @description Aggregates connection data for monitoring purposes.
 * Used by the stats endpoint to display active user sessions.
 *
 * @returns Array of objects containing userId and the number of connected devices
 */
export function getOnlineUsers(): { userId: string; deviceCount: number }[] {
  const users: { userId: string; deviceCount: number }[] = [];
  for (const [userId, clientIds] of userClients) {
    users.push({ userId, deviceCount: clientIds.size });
  }
  return users;
}
