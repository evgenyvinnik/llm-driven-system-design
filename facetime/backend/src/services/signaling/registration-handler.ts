/**
 * Registration Handler - Handles WebSocket client registration.
 *
 * Manages:
 * - User verification
 * - Device registration
 * - Presence updates
 */

import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { query, queryOne } from '../../db/index.js';
import { setUserOnline, setUserOffline } from '../redis.js';
import type { User, WebSocketMessage } from '../../types/index.js';
import type { ConnectedClient, UserProfile } from './types.js';
import {
  createWebSocketLogger,
  logAudit,
} from '../../shared/logger.js';
import { withCircuitBreaker } from '../../shared/circuit-breaker.js';
import {
  updatePresence,
  removePresence,
  getCachedUserProfile,
  setCachedUserProfile,
} from '../../shared/cache.js';
import {
  sendToClient,
  setClient,
  deleteClient,
  addUserClient,
  removeUserClient,
} from './connection-manager.js';

/**
 * Handles client registration when a user connects via WebSocket.
 *
 * @description Performs the complete registration flow for a new WebSocket connection:
 * 1. Validates the userId is provided
 * 2. Looks up user profile from cache (with database fallback using circuit breaker)
 * 3. Creates client tracking entry with device information
 * 4. Updates Redis presence for real-time online status
 * 5. Records device in database for device management
 * 6. Logs audit trail for security monitoring
 * 7. Sends success response with user profile data
 *
 * Uses circuit breaker pattern for database operations to prevent cascade failures
 * when the database is under stress or unavailable.
 *
 * @param ws - The WebSocket connection to register
 * @param clientId - Unique ID generated for this connection
 * @param message - The registration message containing userId, deviceId, and deviceType
 * @param log - Logger instance scoped to this client for debugging
 * @returns The created ConnectedClient if successful, null if registration failed
 * @throws Never throws - errors are sent as WebSocket messages and null is returned
 */
export async function handleRegister(
  ws: WebSocket,
  clientId: string,
  message: WebSocketMessage,
  log: ReturnType<typeof createWebSocketLogger>
): Promise<ConnectedClient | null> {
  const { userId, deviceId, data } = message;
  const deviceType = (data as { deviceType?: string })?.deviceType || 'desktop';

  if (!userId) {
    sendToClient(ws, {
      type: 'error',
      data: { message: 'userId is required' },
    });
    return null;
  }

  // Check cache first for user profile
  const cachedUser = await getCachedUserProfile(userId);
  let userProfile: UserProfile | null = cachedUser ? {
    id: cachedUser.id,
    username: cachedUser.username,
    display_name: cachedUser.display_name,
    avatar_url: cachedUser.avatar_url,
  } : null;

  if (!userProfile) {
    // Cache miss - fetch from database with circuit breaker
    try {
      const dbUser = await withCircuitBreaker(
        'db-user-lookup',
        async () => queryOne<User>('SELECT * FROM users WHERE id = $1', [userId]),
        [userId, deviceId],
        null // Fallback to null if circuit is open
      );

      if (!dbUser) {
        sendToClient(ws, {
          type: 'error',
          data: { message: 'User not found' },
        });
        return null;
      }

      // Cache the user profile
      userProfile = {
        id: dbUser.id,
        username: dbUser.username,
        display_name: dbUser.display_name,
        avatar_url: dbUser.avatar_url,
      };
      await setCachedUserProfile(userId, userProfile);
    } catch (error) {
      log.error({ error }, 'Failed to lookup user');
      sendToClient(ws, {
        type: 'error',
        data: { message: 'Service temporarily unavailable' },
      });
      return null;
    }
  }

  const finalDeviceId = deviceId || uuidv4();
  const clientLogger = createWebSocketLogger(clientId, userId, finalDeviceId);

  const client: ConnectedClient = {
    ws,
    userId,
    deviceId: finalDeviceId,
    deviceType,
    lastPing: Date.now(),
    log: clientLogger,
  };

  setClient(clientId, client);
  addUserClient(userId, clientId);

  // Update Redis presence (write-through)
  await Promise.all([
    setUserOnline(userId, finalDeviceId),
    updatePresence(userId, finalDeviceId, deviceType),
  ]);

  // Update device last_seen in database (fire-and-forget with circuit breaker)
  withCircuitBreaker(
    'db-device-upsert',
    async () => query(
      `INSERT INTO user_devices (id, user_id, device_name, device_type, is_active, last_seen)
       VALUES ($1, $2, $3, $4, true, NOW())
       ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), is_active = true`,
      [finalDeviceId, userId, `${deviceType} Device`, deviceType]
    )
  ).catch((err) => clientLogger.error({ err }, 'Failed to update device record'));

  // Audit log for device registration
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'device.registered',
    actor: { userId, deviceId: finalDeviceId },
    resource: { type: 'device', id: finalDeviceId },
    outcome: 'success',
    details: { deviceType },
  });

  sendToClient(ws, {
    type: 'register',
    data: {
      success: true,
      userId,
      deviceId: finalDeviceId,
      user: {
        id: userProfile.id,
        username: userProfile.username,
        display_name: userProfile.display_name,
        avatar_url: userProfile.avatar_url,
      },
    },
  });

  clientLogger.info('User registered');
  return client;
}

/**
 * Cleans up when a WebSocket client disconnects.
 *
 * @description Performs complete cleanup of a disconnected client:
 * - Removes client from the active connections map
 * - Removes client from user-to-clients lookup
 * - Updates Redis presence to mark device offline
 * - Marks device as inactive in the database (fire-and-forget)
 *
 * Database operations use circuit breaker and are non-blocking to ensure
 * fast cleanup even if the database is slow or unavailable.
 *
 * @param clientId - The unique ID of the disconnecting client
 * @param client - The disconnecting client's data including userId and deviceId
 * @returns Promise that resolves when cleanup is complete
 */
export async function handleDisconnect(clientId: string, client: ConnectedClient): Promise<void> {
  // Remove from clients map
  deleteClient(clientId);

  // Remove from user lookup
  removeUserClient(client.userId, clientId);

  // Update Redis presence
  await Promise.all([
    setUserOffline(client.userId, client.deviceId),
    removePresence(client.userId, client.deviceId),
  ]);

  // Update device in database (fire-and-forget with circuit breaker)
  withCircuitBreaker(
    'db-device-offline',
    async () => query(
      `UPDATE user_devices SET is_active = false, last_seen = NOW() WHERE id = $1`,
      [client.deviceId]
    )
  ).catch((err) => client.log.error({ err }, 'Failed to update device offline status'));

  client.log.info('Client disconnected and cleaned up');
}
