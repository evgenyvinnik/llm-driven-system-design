/**
 * Room Manager - Handles call room lifecycle and state management.
 *
 * Manages:
 * - Call termination logic
 * - Ring timeout handling
 * - Participant notifications
 * - Call duration tracking
 */

import { query } from '../../db/index.js';
import { getCallState, deleteCallState } from '../redis.js';
import { logCallEvent, logAudit } from '../../shared/logger.js';
import {
  callsEnded,
  callDuration,
  activeCalls,
} from '../../shared/metrics.js';
import {
  clearRingTimeout,
  deleteCallCreationTime,
  getUserClientIds,
  getClient,
  sendToClient,
} from './connection-manager.js';
import { logger } from '../../shared/logger.js';

/**
 * Terminates a call and notifies all participants.
 *
 * @description Performs complete call cleanup including:
 * - Clearing any pending ring timeout
 * - Removing call creation time tracking
 * - Calculating and recording call duration
 * - Updating call state in PostgreSQL database
 * - Recording Prometheus metrics for call analytics
 * - Logging call events and audit trail
 * - Sending call_end notifications to all participants
 * - Cleaning up Redis call state
 *
 * @param callId - Unique identifier of the call to end
 * @param reason - Reason for ending: 'ended' (normal), 'missed' (timeout), or 'declined' (all declined)
 * @returns Promise that resolves when cleanup is complete
 */
export async function endCall(callId: string, reason: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState) return;

  // Clear ring timeout
  clearRingTimeout(callId);

  // Clean up creation time tracking
  deleteCallCreationTime(callId);

  // Calculate duration
  const startedAt = callState.answeredAt as number | undefined;
  const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  // Update database
  await query(
    `UPDATE calls SET state = $1, ended_at = NOW(), duration_seconds = $2 WHERE id = $3`,
    [reason === 'missed' ? 'missed' : reason === 'declined' ? 'declined' : 'ended', duration, callId]
  );

  await query(
    `UPDATE call_participants SET left_at = NOW() WHERE call_id = $1 AND left_at IS NULL`,
    [callId]
  );

  // Track metrics
  const callType = callState.callType as string;
  callsEnded.inc({ call_type: callType, reason });
  activeCalls.dec({ call_type: callType });

  if (duration > 0) {
    callDuration.observe({ call_type: callType }, duration);
  }

  // Log call event
  logCallEvent(callId, 'ended', {
    reason,
    duration,
    callType,
  });

  // Audit log
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'call.ended',
    actor: { userId: callState.initiatorId as string },
    resource: { type: 'call', id: callId },
    outcome: 'success',
    details: { reason, duration },
  });

  // Notify all participants
  const calleeIds = callState.calleeIds as string[];
  const allUserIds = new Set([callState.initiatorId as string, ...calleeIds]);

  for (const userId of allUserIds) {
    const userClientIds = getUserClientIds(userId);
    if (userClientIds) {
      for (const userClientId of userClientIds) {
        const userClient = getClient(userClientId);
        if (userClient) {
          sendToClient(userClient.ws, {
            type: 'call_end',
            callId,
            data: { reason, duration },
          });
        }
      }
    }
  }

  // Clean up Redis
  await deleteCallState(callId);
}

/**
 * Handles ring timeout when no callee answers within the timeout period.
 *
 * @description Called by a scheduled timeout (typically 30 seconds after call initiation).
 * Checks if the call is still in 'ringing' state before marking it as missed.
 * This prevents processing timeouts for calls that have already been answered or declined.
 *
 * @param callId - Unique identifier of the timed-out call
 * @returns Promise that resolves when the timeout is processed
 */
export async function handleRingTimeout(callId: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState || callState.state !== 'ringing') return;

  logger.info({ callId }, 'Call ring timeout');
  logCallEvent(callId, 'missed', { reason: 'ring_timeout' });
  await endCall(callId, 'missed');
}
