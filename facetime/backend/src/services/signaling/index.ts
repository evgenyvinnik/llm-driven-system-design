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
import type { WebSocketMessage } from '../../types/index.js';
import type { ConnectedClient } from './types.js';

// Shared modules
import { createWebSocketLogger } from '../../shared/logger.js';
import {
  connectionsTotal,
  activeConnections,
  connectionErrors,
  signalingLatency,
  signalingErrors,
} from '../../shared/metrics.js';

// Signaling handlers
import { handleRegister, handleDisconnect } from './registration-handler.js';
import { handleCallInitiate } from './call-initiate-handler.js';
import { handleCallAnswer, handleCallDecline, handleCallEnd } from './call-response-handler.js';
import { handleSignaling } from './signaling-handler.js';
import { sendToClient, getAllClients, getOnlineUsers, getClientCount } from './connection-manager.js';

/**
 * Initializes WebSocket signaling server with event handlers.
 *
 * @description Sets up the complete WebSocket-based signaling infrastructure:
 *
 * **Connection Handling:**
 * - Accepts new WebSocket connections with unique client IDs
 * - Tracks active connections using Prometheus metrics
 * - Handles connection errors and clean disconnection
 *
 * **Message Processing:**
 * - Routes incoming messages to appropriate handlers based on type
 * - Supports: register, call_initiate, call_answer, call_decline, call_end
 * - Supports WebRTC signaling: offer, answer, ice_candidate
 * - Handles ping/pong heartbeats for connection health
 *
 * **Health Monitoring:**
 * - Runs heartbeat check every 30 seconds
 * - Terminates clients that haven't sent a ping in 60 seconds
 * - Records signaling latency metrics for each message type
 *
 * This is the core entry point for real-time communication in the FaceTime system.
 *
 * @param wss - The WebSocket server instance to configure with event handlers
 * @returns void
 */
export function setupWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
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
    const clients = getAllClients();

    for (const [clientId, client] of clients) {
      if (now - client.lastPing > timeout) {
        client.log.warn('Client timed out');
        client.ws.terminate();
        handleDisconnect(clientId, client);
      }
    }
  }, 30000);
}

// Re-export utility functions for external use
export { getOnlineUsers, getClientCount };

// Re-export types
export type { ConnectedClient, UserProfile, CallState } from './types.js';
