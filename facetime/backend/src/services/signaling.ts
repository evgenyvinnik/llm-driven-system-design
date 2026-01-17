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
  Call,
  CallParticipant,
  WebSocketMessage,
  CallInitiateData,
  SignalingOffer,
  SignalingAnswer,
  ICECandidate,
} from '../types/index.js';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  deviceType: string;
  lastPing: number;
}

// Store connected clients: Map<clientId, ConnectedClient>
const clients = new Map<string, ConnectedClient>();

// Map userId -> Set<clientId> for quick lookup
const userClients = new Map<string, Set<string>>();

// Ring timeouts: Map<callId, NodeJS.Timeout>
const ringTimeouts = new Map<string, NodeJS.Timeout>();

export function setupWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = uuidv4();
    console.log(`WebSocket client connected: ${clientId}`);

    let currentClient: ConnectedClient | null = null;

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        console.log(`Received message from ${clientId}:`, message.type);

        switch (message.type) {
          case 'register':
            currentClient = await handleRegister(ws, clientId, message);
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
      } catch (error) {
        console.error('Error processing message:', error);
        sendToClient(ws, {
          type: 'error',
          data: { message: 'Failed to process message' },
        });
      }
    });

    ws.on('close', async () => {
      console.log(`WebSocket client disconnected: ${clientId}`);
      if (currentClient) {
        await handleDisconnect(clientId, currentClient);
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
    });
  });

  // Heartbeat check every 30 seconds
  setInterval(() => {
    const now = Date.now();
    const timeout = 60000; // 60 seconds

    for (const [clientId, client] of clients) {
      if (now - client.lastPing > timeout) {
        console.log(`Client ${clientId} timed out`);
        client.ws.terminate();
        handleDisconnect(clientId, client);
      }
    }
  }, 30000);
}

async function handleRegister(
  ws: WebSocket,
  clientId: string,
  message: WebSocketMessage
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

  // Verify user exists
  const user = await queryOne<User>(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );

  if (!user) {
    sendToClient(ws, {
      type: 'error',
      data: { message: 'User not found' },
    });
    return null;
  }

  const finalDeviceId = deviceId || uuidv4();

  const client: ConnectedClient = {
    ws,
    userId,
    deviceId: finalDeviceId,
    deviceType,
    lastPing: Date.now(),
  };

  clients.set(clientId, client);

  // Add to user lookup
  if (!userClients.has(userId)) {
    userClients.set(userId, new Set());
  }
  userClients.get(userId)!.add(clientId);

  // Update Redis presence
  await setUserOnline(userId, finalDeviceId);

  // Update device last_seen in database
  await query(
    `INSERT INTO user_devices (id, user_id, device_name, device_type, is_active, last_seen)
     VALUES ($1, $2, $3, $4, true, NOW())
     ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), is_active = true`,
    [finalDeviceId, userId, `${deviceType} Device`, deviceType]
  );

  sendToClient(ws, {
    type: 'register',
    data: {
      success: true,
      userId,
      deviceId: finalDeviceId,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
    },
  });

  console.log(`User ${userId} registered with device ${finalDeviceId}`);
  return client;
}

async function handleCallInitiate(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const data = message.data as CallInitiateData;
  const { calleeIds, callType } = data;

  if (!calleeIds || calleeIds.length === 0) {
    sendToClient(client.ws, {
      type: 'error',
      data: { message: 'calleeIds is required' },
    });
    return;
  }

  const callId = uuidv4();
  const isGroup = calleeIds.length > 1;

  // Create call in database
  await query(
    `INSERT INTO calls (id, initiator_id, call_type, state, max_participants, created_at)
     VALUES ($1, $2, $3, 'ringing', $4, NOW())`,
    [callId, client.userId, isGroup ? 'group' : callType, calleeIds.length + 1]
  );

  // Add initiator as participant
  await query(
    `INSERT INTO call_participants (call_id, user_id, device_id, state, is_initiator, joined_at)
     VALUES ($1, $2, $3, 'connected', true, NOW())`,
    [callId, client.userId, client.deviceId]
  );

  // Store call state in Redis
  await setCallState(callId, {
    id: callId,
    initiatorId: client.userId,
    initiatorDeviceId: client.deviceId,
    calleeIds,
    callType,
    state: 'ringing',
    participants: [{ userId: client.userId, deviceId: client.deviceId }],
    createdAt: Date.now(),
  });

  // Get caller info
  const caller = await queryOne<User>(
    'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
    [client.userId]
  );

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
              caller: {
                id: caller?.id,
                username: caller?.username,
                display_name: caller?.display_name,
                avatar_url: caller?.avatar_url,
              },
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

  // Update call state
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

async function handleCallEnd(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId } = message;

  if (!callId) return;

  await endCall(callId, 'ended');
}

async function endCall(callId: string, reason: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState) return;

  // Clear ring timeout
  const timeout = ringTimeouts.get(callId);
  if (timeout) {
    clearTimeout(timeout);
    ringTimeouts.delete(callId);
  }

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

  // Notify all participants
  const participants = callState.participants as { userId: string; deviceId: string }[];
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

async function handleRingTimeout(callId: string): Promise<void> {
  const callState = await getCallState(callId);
  if (!callState || callState.state !== 'ringing') return;

  console.log(`Call ${callId} ring timeout`);
  await endCall(callId, 'missed');
}

async function handleSignaling(
  client: ConnectedClient,
  message: WebSocketMessage
): Promise<void> {
  const { callId, type, data } = message;

  if (!callId) return;

  const callState = await getCallState(callId);
  if (!callState) return;

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
  await setUserOffline(client.userId, client.deviceId);

  // Update device in database
  await query(
    `UPDATE user_devices SET is_active = false, last_seen = NOW() WHERE id = $1`,
    [client.deviceId]
  );
}

function sendToClient(ws: WebSocket, message: WebSocketMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: Date.now() }));
  }
}

// Helper to get online users
export function getOnlineUsers(): { userId: string; deviceCount: number }[] {
  const users: { userId: string; deviceCount: number }[] = [];
  for (const [userId, clientIds] of userClients) {
    users.push({ userId, deviceCount: clientIds.size });
  }
  return users;
}

// Helper to get client count
export function getClientCount(): number {
  return clients.size;
}
