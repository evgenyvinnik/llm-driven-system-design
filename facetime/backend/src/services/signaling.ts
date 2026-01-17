/**
 * WebSocket Signaling Service for FaceTime.
 *
 * Handles real-time call signaling including:
 * - Device registration and presence
 * - Call initiation with idempotency
 * - Answer/decline/end call flows
 * - WebRTC offer/answer/ICE candidate exchange
 *
 * Features:
 * - Idempotency for call initiation (prevents duplicate calls)
 * - Circuit breaker for database operations
 * - Prometheus metrics for call quality monitoring
 * - Structured logging for debugging
 */

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/index.js';
import {
  setUserOnline,
  setUserOffline,
  setCallState,
  getCallState,
  deleteCallState,
} from './redis.js';
import type {
  User,
  WebSocketMessage,
  CallInitiateData,
} from '../types/index.js';

// Shared modules
import {
  logger,
  createWebSocketLogger,
  logCallEvent,
  logAudit,
  logSignalingEvent,
} from '../shared/logger.js';
import {
  callsInitiated,
  callsAnswered,
  callsEnded,
  callDuration,
  callSetupLatency,
  activeCalls,
  activeConnections,
  connectionsTotal,
  connectionErrors,
  signalingLatency,
  signalingErrors,
} from '../shared/metrics.js';
import { withCircuitBreaker } from '../shared/circuit-breaker.js';
import {
  checkIdempotencyKey,
  storeIdempotencyKey,
  checkICECandidateDedup,
  generateICECandidateHash,
} from '../shared/idempotency.js';
import {
  updatePresence,
  removePresence,
  getCachedUserProfile,
  setCachedUserProfile,
} from '../shared/cache.js';

/**
 * Simplified user profile for signaling operations.
 */
interface UserProfile {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

/**
 * Represents a connected WebSocket client for signaling.
 * Tracks the socket connection, user identity, device info,
 * and last heartbeat for connection health monitoring.
 */
interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  deviceType: string;
  lastPing: number;
  log: ReturnType<typeof createWebSocketLogger>;
}

/** Map of clientId to ConnectedClient for all active WebSocket connections */
const clients = new Map<string, ConnectedClient>();

/** Map of userId to Set of clientIds for quick user-to-connection lookup */
const userClients = new Map<string, Set<string>>();

/** Map of callId to timeout handle for ring timeout management */
const ringTimeouts = new Map<string, NodeJS.Timeout>();

/** Map of callId to creation timestamp for setup latency tracking */
const callCreationTimes = new Map<string, number>();

/**
 * Initializes WebSocket signaling server with event handlers.
 * This is the core of the real-time communication system, handling
 * client registration, call signaling, and WebRTC offer/answer exchange.
 *
 * @param wss - The WebSocket server instance to configure
 */
export function setupWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = uuidv4();
    const clientLog = createWebSocketLogger(clientId);

    clientLog.info('WebSocket client connected');
    connectionsTotal.inc();
    activeConnections.inc();

    let currentClient: ConnectedClient | null = null;

    ws.on('message', async (data: Buffer) => {
      const messageStart = Date.now();
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        const messageType = message.type;

        if (currentClient) {
          currentClient.log.debug({ messageType }, 'Received message');
        } else {
          clientLog.debug({ messageType }, 'Received message');
        }

        switch (message.type) {
          case 'register':
            currentClient = await handleRegister(ws, clientId, message, clientLog);
            break;

          case 'call_initiate':
            if (currentClient) {
              await handleCallInitiate(currentClient, message);
            }
            break;

          case 'call_answer':
            if (currentClient) {
              await handleCallAnswer(currentClient, message);
            }
            break;

          case 'call_decline':
            if (currentClient) {
              await handleCallDecline(currentClient, message);
            }
            break;

          case 'call_end':
            if (currentClient) {
              await handleCallEnd(currentClient, message);
            }
            break;

          case 'offer':
          case 'answer':
          case 'ice_candidate':
            if (currentClient) {
              await handleSignaling(currentClient, message);
            }
            break;

          case 'ping':
            if (currentClient) {
              currentClient.lastPing = Date.now();
              sendToClient(currentClient.ws, { type: 'pong' });
            }
            break;
        }

        // Track signaling latency
        signalingLatency.observe({ message_type: message.type }, (Date.now() - messageStart) / 1000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        clientLog.error({ error }, 'Error processing message');
        signalingErrors.inc({ error_type: 'processing_error' });
        sendToClient(ws, {
          type: 'error',
          data: { message: 'Failed to process message', detail: errorMessage },
        });
      }
    });

    ws.on('close', async () => {
      clientLog.info('WebSocket client disconnected');
      activeConnections.dec();
      if (currentClient) {
        await handleDisconnect(clientId, currentClient);
      }
    });

    ws.on('error', (error) => {
      clientLog.error({ error }, 'WebSocket error');
      connectionErrors.inc({ error_type: 'connection_error' });
    });
  });

  // Heartbeat check every 30 seconds
  setInterval(() => {
    const now = Date.now();
    const timeout = 60000; // 60 seconds

    for (const [clientId, client] of clients) {
      if (now - client.lastPing > timeout) {
        client.log.warn('Client timed out');
        client.ws.terminate();
        handleDisconnect(clientId, client);
      }
    }
  }, 30000);
}

/**
 * Handles client registration when a user connects via WebSocket.
 * Verifies user exists, creates client tracking entry, updates presence
 * in Redis, and records the device in the database.
 *
 * Uses circuit breaker for database operations to prevent cascade failures.
 *
 * @param ws - The WebSocket connection
 * @param clientId - Unique ID for this connection
 * @param message - The registration message containing userId and deviceId
 * @param log - Logger instance for this client
 * @returns The created ConnectedClient or null if registration failed
 */
async function handleRegister(
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

  clients.set(clientId, client);

  // Add to user lookup
  if (!userClients.has(userId)) {
    userClients.set(userId, new Set());
  }
  userClients.get(userId)!.add(clientId);

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
 * Extended call initiate data with idempotency key.
 */
interface CallInitiateDataWithIdempotency extends CallInitiateData {
  idempotencyKey?: string;
}

/**
 * Handles call initiation from a caller to one or more callees.
 * Implements idempotency to prevent duplicate call creation.
 * Creates call record in database, stores state in Redis,
 * rings all callee devices, and sets a 30-second ring timeout.
 *
 * @param client - The caller's connected client
 * @param message - Message containing calleeIds, callType, and optional idempotencyKey
 */
async function handleCallInitiate(
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
  callCreationTimes.set(callId, callCreatedAt);

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
    const calleeClientIds = userClients.get(calleeId);
    if (calleeClientIds) {
      for (const calleeClientId of calleeClientIds) {
        const calleeClient = clients.get(calleeClientId);
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
  ringTimeouts.set(callId, timeout);

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

/**
 * Handles when a callee answers an incoming call.
 * Updates call state to connected, notifies the initiator,
 * and stops ringing on the answerer's other devices.
 *
 * @param client - The answering callee's connected client
 * @param message - Message containing the callId
 */
async function handleCallAnswer(
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
  const timeout = ringTimeouts.get(callId);
  if (timeout) {
    clearTimeout(timeout);
    ringTimeouts.delete(callId);
  }

  // Calculate setup latency
  const createdAt = callCreationTimes.get(callId);
  if (createdAt) {
    const setupLatencySeconds = (Date.now() - createdAt) / 1000;
    callSetupLatency.observe(
      { call_type: callState.callType as string },
      setupLatencySeconds
    );
    callCreationTimes.delete(callId);
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
  const userClientIds = userClients.get(client.userId);
  if (userClientIds) {
    for (const userClientId of userClientIds) {
      const userClient = clients.get(userClientId);
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
  const initiatorClientIds = userClients.get(callState.initiatorId as string);
  if (initiatorClientIds) {
    for (const initiatorClientId of initiatorClientIds) {
      const initiatorClient = clients.get(initiatorClientId);
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
 * Updates participant state and notifies the initiator.
 * If all callees decline, ends the call.
 *
 * @param client - The declining callee's connected client
 * @param message - Message containing the callId
 */
async function handleCallDecline(
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
  const initiatorClientIds = userClients.get(callState.initiatorId as string);
  if (initiatorClientIds) {
    for (const initiatorClientId of initiatorClientIds) {
      const initiatorClient = clients.get(initiatorClientId);
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
 * Triggers call termination for all participants.
 *
 * @param client - The connected client ending the call
 * @param message - Message containing the callId
 */
async function handleCallEnd(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId } = message;

  if (!callId) return;

  client.log.info({ callId }, 'Call end requested');
  await endCall(callId, 'ended');
}

/**
 * Terminates a call and notifies all participants.
 * Updates database records, cleans up Redis state,
 * and calculates call duration for ended calls.
 *
 * @param callId - Unique identifier of the call to end
 * @param reason - Reason for ending: 'ended', 'missed', or 'declined'
 */
async function endCall(callId: string, reason: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState) return;

  // Clear ring timeout
  const timeout = ringTimeouts.get(callId);
  if (timeout) {
    clearTimeout(timeout);
    ringTimeouts.delete(callId);
  }

  // Clean up creation time tracking
  callCreationTimes.delete(callId);

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
    const userClientIds = userClients.get(userId);
    if (userClientIds) {
      for (const userClientId of userClientIds) {
        const userClient = clients.get(userClientId);
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
 * Handles ring timeout when no callee answers within 30 seconds.
 * Ends the call with 'missed' status if still ringing.
 *
 * @param callId - Unique identifier of the timed-out call
 */
async function handleRingTimeout(callId: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState || callState.state !== 'ringing') return;

  logger.info({ callId }, 'Call ring timeout');
  logCallEvent(callId, 'missed', { reason: 'ring_timeout' });
  await endCall(callId, 'missed');
}

/**
 * Forwards WebRTC signaling messages between call participants.
 * Routes offer, answer, and ICE candidate messages to enable
 * peer-to-peer connection establishment.
 *
 * ICE candidates are deduplicated to handle network retries.
 *
 * @param client - The sender's connected client
 * @param message - The signaling message to forward
 */
async function handleSignaling(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId, type, data } = message;

  if (!callId) return;

  const callState = await getCallState(callId);
  if (!callState) return;

  // Deduplicate ICE candidates
  if (type === 'ice_candidate' && data) {
    const candidateData = data as { candidate?: string };
    if (candidateData.candidate) {
      const hash = generateICECandidateHash(callId, client.deviceId, candidateData.candidate);
      const isNew = await checkICECandidateDedup(callId, hash);
      if (!isNew) {
        // Duplicate candidate, skip forwarding
        return;
      }
    }
  }

  // Log signaling event
  logSignalingEvent(callId, type, client.userId);

  // Forward signaling message to other participants
  const participants = callState.participants as { userId: string; deviceId: string }[];

  for (const participant of participants) {
    if (participant.userId !== client.userId || participant.deviceId !== client.deviceId) {
      const participantClientIds = userClients.get(participant.userId);
      if (participantClientIds) {
        for (const participantClientId of participantClientIds) {
          const participantClient = clients.get(participantClientId);
          if (participantClient && participantClient.deviceId === participant.deviceId) {
            sendToClient(participantClient.ws, {
              type,
              callId,
              userId: client.userId,
              data,
            });
          }
        }
      }
    }
  }
}

/**
 * Cleans up when a WebSocket client disconnects.
 * Removes from tracking maps, updates Redis presence,
 * and marks device as inactive in database.
 *
 * @param clientId - The unique ID of the disconnecting client
 * @param client - The disconnecting client's data
 */
async function handleDisconnect(clientId: string, client: ConnectedClient): Promise<void> {
  // Remove from clients map
  clients.delete(clientId);

  // Remove from user lookup
  const userClientIds = userClients.get(client.userId);
  if (userClientIds) {
    userClientIds.delete(clientId);
    if (userClientIds.size === 0) {
      userClients.delete(client.userId);
    }
  }

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

/**
 * Sends a message to a connected WebSocket client.
 * Adds timestamp and handles serialization.
 *
 * @param ws - The WebSocket connection to send to
 * @param message - The message to send
 */
function sendToClient(ws: WebSocket, message: WebSocketMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: Date.now() }));
  }
}

/**
 * Returns a list of currently online users with their device counts.
 * Used by the stats endpoint to monitor active connections.
 *
 * @returns Array of objects with userId and deviceCount
 */
export function getOnlineUsers(): { userId: string; deviceCount: number }[] {
  const users: { userId: string; deviceCount: number }[] = [];
  for (const [userId, clientIds] of userClients) {
    users.push({ userId, deviceCount: clientIds.size });
  }
  return users;
}

/**
 * Returns the total number of connected WebSocket clients.
 * Used by the stats endpoint to monitor server load.
 *
 * @returns Total count of active WebSocket connections
 */
export function getClientCount(): number {
  return clients.size;
}
