/**
 * Call Initiate Handler - Handles call initiation logic.
 *
 * Manages:
 * - Call creation with idempotency
 * - Database and Redis state setup
 * - Ringing callee devices
 * - Ring timeout scheduling
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../db/index.js';
import { setCallState } from '../redis.js';
import type { User, WebSocketMessage } from '../../types/index.js';
import type { ConnectedClient, UserProfile, CallInitiateDataWithIdempotency } from './types.js';
import { logCallEvent, logAudit } from '../../shared/logger.js';
import {
  callsInitiated,
  activeCalls,
  signalingErrors,
} from '../../shared/metrics.js';
import { withCircuitBreaker } from '../../shared/circuit-breaker.js';
import { checkIdempotencyKey, storeIdempotencyKey } from '../../shared/idempotency.js';
import { getCachedUserProfile } from '../../shared/cache.js';
import {
  sendToClient,
  getUserClientIds,
  getClient,
  setRingTimeout,
  setCallCreationTime,
} from './connection-manager.js';
import { handleRingTimeout } from './room-manager.js';

/**
 * Handles call initiation from a caller to one or more callees.
 *
 * @description Orchestrates the complete call initiation flow:
 * 1. Validates callee list is provided
 * 2. Checks idempotency key to prevent duplicate calls (returns existing call if duplicate)
 * 3. Creates call record in PostgreSQL with circuit breaker protection
 * 4. Adds initiator as first participant
 * 5. Stores call state in Redis for fast signaling lookups
 * 6. Records Prometheus metrics for call analytics
 * 7. Logs call event and audit trail
 * 8. Sends call_ring notification to all callee devices
 * 9. Sets 30-second ring timeout
 * 10. Confirms call creation to the initiator
 *
 * Supports both 1:1 calls and group calls (2+ callees).
 *
 * @param client - The caller's connected client containing user and device info
 * @param message - Message containing calleeIds, callType, and optional idempotencyKey
 * @returns Promise that resolves when call initiation is complete
 * @throws Never throws - errors are sent as WebSocket messages to the client
 */
export async function handleCallInitiate(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const data = message.data as CallInitiateDataWithIdempotency;
  const { calleeIds, callType, idempotencyKey } = data;

  if (!calleeIds || calleeIds.length === 0) {
    sendToClient(client.ws, {
      type: 'error',
      data: { message: 'calleeIds is required' },
    });
    return;
  }

  // Check idempotency - prevent duplicate call creation
  if (idempotencyKey) {
    const idempotencyResult = await checkIdempotencyKey(idempotencyKey);
    if (idempotencyResult.isDuplicate && idempotencyResult.existingCallId) {
      client.log.info(
        { idempotencyKey, existingCallId: idempotencyResult.existingCallId },
        'Duplicate call initiation prevented'
      );

      // Return existing call instead of creating duplicate
      sendToClient(client.ws, {
        type: 'call_initiate',
        callId: idempotencyResult.existingCallId,
        data: {
          success: true,
          calleeIds,
          callType,
          deduplicated: true,
        },
      });
      return;
    }
  }

  const callId = uuidv4();
  const isGroup = calleeIds.length > 1;
  const callCreatedAt = Date.now();

  // Track call creation time for setup latency
  setCallCreationTime(callId, callCreatedAt);

  // Store idempotency key BEFORE creating call (for crash safety)
  if (idempotencyKey) {
    await storeIdempotencyKey(idempotencyKey, callId);
  }

  try {
    // Create call in database with circuit breaker
    await withCircuitBreaker(
      'db-call-create',
      async () => query(
        `INSERT INTO calls (id, initiator_id, call_type, state, max_participants, created_at)
         VALUES ($1, $2, $3, 'ringing', $4, NOW())`,
        [callId, client.userId, isGroup ? 'group' : callType, calleeIds.length + 1]
      )
    );

    // Add initiator as participant
    await withCircuitBreaker(
      'db-participant-add',
      async () => query(
        `INSERT INTO call_participants (call_id, user_id, device_id, state, is_initiator, joined_at)
         VALUES ($1, $2, $3, 'connected', true, NOW())`,
        [callId, client.userId, client.deviceId]
      )
    );
  } catch (error) {
    client.log.error({ error, callId }, 'Failed to create call in database');
    signalingErrors.inc({ error_type: 'db_error' });
    sendToClient(client.ws, {
      type: 'error',
      data: { message: 'Failed to create call' },
    });
    return;
  }

  // Store call state in Redis
  await setCallState(callId, {
    id: callId,
    initiatorId: client.userId,
    initiatorDeviceId: client.deviceId,
    calleeIds,
    callType,
    state: 'ringing',
    participants: [{ userId: client.userId, deviceId: client.deviceId }],
    createdAt: callCreatedAt,
  });

  // Track metrics
  callsInitiated.inc({ call_type: isGroup ? 'group' : callType });
  activeCalls.inc({ call_type: isGroup ? 'group' : callType });

  // Log call event
  logCallEvent(callId, 'initiated', {
    initiator: client.userId,
    participants: calleeIds.length,
    callType,
    idempotencyKey,
  });

  // Audit log
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'call.initiated',
    actor: { userId: client.userId, deviceId: client.deviceId },
    resource: { type: 'call', id: callId },
    outcome: 'success',
    details: { callType, calleeIds, isGroup },
  });

  // Get caller info from cache
  const cachedCaller = await getCachedUserProfile(client.userId);
  let caller: UserProfile | null = cachedCaller ? {
    id: cachedCaller.id,
    username: cachedCaller.username,
    display_name: cachedCaller.display_name,
    avatar_url: cachedCaller.avatar_url,
  } : null;
  if (!caller) {
    const dbCaller = await queryOne<User>(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
      [client.userId]
    );
    if (dbCaller) {
      caller = {
        id: dbCaller.id,
        username: dbCaller.username,
        display_name: dbCaller.display_name,
        avatar_url: dbCaller.avatar_url,
      };
    }
  }

  // Ring all callees
  for (const calleeId of calleeIds) {
    // Add callee as participant
    await query(
      `INSERT INTO call_participants (call_id, user_id, state, is_initiator)
       VALUES ($1, $2, 'ringing', false)`,
      [callId, calleeId]
    );

    // Find all connected devices for this callee
    const calleeClientIds = getUserClientIds(calleeId);
    if (calleeClientIds) {
      for (const calleeClientId of calleeClientIds) {
        const calleeClient = getClient(calleeClientId);
        if (calleeClient) {
          sendToClient(calleeClient.ws, {
            type: 'call_ring',
            callId,
            data: {
              caller: caller || { id: client.userId },
              callType,
              isGroup,
            },
          });
        }
      }
    }
  }

  // Set ring timeout (30 seconds)
  const timeout = setTimeout(async () => {
    await handleRingTimeout(callId);
  }, 30000);
  setRingTimeout(callId, timeout);

  // Confirm to initiator
  sendToClient(client.ws, {
    type: 'call_initiate',
    callId,
    data: {
      success: true,
      calleeIds,
      callType,
    },
  });
}
