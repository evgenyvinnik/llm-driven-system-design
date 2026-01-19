/**
 * Call Response Handler - Manages call response operations.
 *
 * Handles:
 * - Call answering
 * - Call declining
 * - Call ending
 */

import { query } from '../../db/index.js';
import { setCallState, getCallState } from '../redis.js';
import type { WebSocketMessage } from '../../types/index.js';
import type { ConnectedClient } from './types.js';
import { logCallEvent, logAudit } from '../../shared/logger.js';
import { callsAnswered, callSetupLatency } from '../../shared/metrics.js';
import {
  sendToClient,
  getUserClientIds,
  getClient,
  clearRingTimeout,
  getCallCreationTime,
  deleteCallCreationTime,
} from './connection-manager.js';
import { endCall } from './room-manager.js';

/**
 * Handles when a callee answers an incoming call.
 *
 * @description Processes a call answer with the following steps:
 * 1. Validates callId is provided and call exists in ringing state
 * 2. Clears the ring timeout to prevent missed call processing
 * 3. Calculates and records call setup latency for metrics
 * 4. Updates call state to 'connected' in PostgreSQL
 * 5. Updates participant record with device info and join time
 * 6. Updates Redis call state with new participant
 * 7. Records Prometheus metrics for answered calls
 * 8. Logs call event and audit trail
 * 9. Sends call_end with 'answered_elsewhere' to answerer's other devices
 * 10. Notifies the initiator that the call was answered
 * 11. Confirms answer success to the answering device
 *
 * @param client - The answering callee's connected client
 * @param message - Message containing the callId to answer
 * @returns Promise that resolves when the answer is processed
 * @throws Never throws - errors are sent as WebSocket messages to the client
 */
export async function handleCallAnswer(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId } = message;

  if (!callId) {
    sendToClient(client.ws, {
      type: 'error',
      data: { message: 'callId is required' },
    });
    return;
  }

  const callState = await getCallState(callId);
  if (!callState || callState.state !== 'ringing') {
    sendToClient(client.ws, {
      type: 'error',
      data: { message: 'Call not found or not ringing' },
    });
    return;
  }

  // Clear ring timeout
  clearRingTimeout(callId);

  // Calculate setup latency
  const createdAt = getCallCreationTime(callId);
  if (createdAt) {
    const setupLatencySeconds = (Date.now() - createdAt) / 1000;
    callSetupLatency.observe(
      { call_type: callState.callType as string },
      setupLatencySeconds
    );
    deleteCallCreationTime(callId);
  }

  // Update call state in database
  await query(
    `UPDATE calls SET state = 'connected', started_at = NOW() WHERE id = $1`,
    [callId]
  );

  // Update participant
  await query(
    `UPDATE call_participants
     SET state = 'connected', device_id = $1, joined_at = NOW()
     WHERE call_id = $2 AND user_id = $3`,
    [client.deviceId, callId, client.userId]
  );

  // Update Redis state
  const participants = (callState.participants as { userId: string; deviceId: string }[]) || [];
  participants.push({ userId: client.userId, deviceId: client.deviceId });
  await setCallState(callId, {
    ...callState,
    state: 'connected',
    participants,
    answeredAt: Date.now(),
  });

  // Track metrics
  callsAnswered.inc({ call_type: callState.callType as string });

  // Log call event
  logCallEvent(callId, 'answered', {
    answeredBy: client.userId,
    deviceId: client.deviceId,
    ringDurationMs: createdAt ? Date.now() - createdAt : undefined,
  });

  // Audit log
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'call.answered',
    actor: { userId: client.userId, deviceId: client.deviceId },
    resource: { type: 'call', id: callId },
    outcome: 'success',
  });

  // Stop ringing on other devices of the same user
  const userClientIds = getUserClientIds(client.userId);
  if (userClientIds) {
    for (const userClientId of userClientIds) {
      const userClient = getClient(userClientId);
      if (userClient && userClient.deviceId !== client.deviceId) {
        sendToClient(userClient.ws, {
          type: 'call_end',
          callId,
          data: { reason: 'answered_elsewhere' },
        });
      }
    }
  }

  // Notify initiator that call was answered
  const initiatorClientIds = getUserClientIds(callState.initiatorId as string);
  if (initiatorClientIds) {
    for (const initiatorClientId of initiatorClientIds) {
      const initiatorClient = getClient(initiatorClientId);
      if (initiatorClient && initiatorClient.deviceId === callState.initiatorDeviceId) {
        sendToClient(initiatorClient.ws, {
          type: 'call_answer',
          callId,
          data: {
            userId: client.userId,
            deviceId: client.deviceId,
          },
        });
      }
    }
  }

  // Confirm to answerer
  sendToClient(client.ws, {
    type: 'call_answer',
    callId,
    data: {
      success: true,
      participants: participants.map((p) => p.userId),
    },
  });
}

/**
 * Handles when a callee declines an incoming call.
 *
 * @description Processes a call decline with the following steps:
 * 1. Validates call exists in call state
 * 2. Updates the declining participant's state to 'declined' in database
 * 3. Logs the decline event for analytics
 * 4. Checks if all callees have declined
 * 5. If all declined, ends the call with 'declined' reason
 * 6. Notifies the initiator about the decline (and whether all declined)
 *
 * For group calls, the call continues ringing for other callees until
 * someone answers or all decline.
 *
 * @param client - The declining callee's connected client
 * @param message - Message containing the callId to decline
 * @returns Promise that resolves when the decline is processed
 */
export async function handleCallDecline(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId } = message;

  if (!callId) return;

  const callState = await getCallState(callId);
  if (!callState) return;

  // Update participant state
  await query(
    `UPDATE call_participants SET state = 'declined' WHERE call_id = $1 AND user_id = $2`,
    [callId, client.userId]
  );

  // Log call event
  logCallEvent(callId, 'declined', {
    declinedBy: client.userId,
  });

  // Check if all callees declined
  const calleeIds = callState.calleeIds as string[];
  const remainingCallees = await query<{ user_id: string; state: string }>(
    `SELECT user_id, state FROM call_participants
     WHERE call_id = $1 AND user_id = ANY($2) AND state = 'ringing'`,
    [callId, calleeIds]
  );

  if (remainingCallees.length === 0) {
    // All declined, end the call
    await endCall(callId, 'declined');
  }

  // Notify initiator
  const initiatorClientIds = getUserClientIds(callState.initiatorId as string);
  if (initiatorClientIds) {
    for (const initiatorClientId of initiatorClientIds) {
      const initiatorClient = getClient(initiatorClientId);
      if (initiatorClient) {
        sendToClient(initiatorClient.ws, {
          type: 'call_decline',
          callId,
          data: {
            userId: client.userId,
            allDeclined: remainingCallees.length === 0,
          },
        });
      }
    }
  }
}

/**
 * Handles when a participant ends an active call.
 *
 * @description Triggers complete call termination for all participants.
 * This can be called by any participant (initiator or callee) to end
 * the call. The endCall function handles all cleanup including database
 * updates, Redis state cleanup, and participant notifications.
 *
 * @param client - The connected client requesting to end the call
 * @param message - Message containing the callId to end
 * @returns Promise that resolves when the call end is initiated
 */
export async function handleCallEnd(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId } = message;

  if (!callId) return;

  client.log.info({ callId }, 'Call end requested');
  await endCall(callId, 'ended');
}
