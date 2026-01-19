import {
  WSMessage,
  WSChatMessage,
  WSTypingMessage,
  WSReadReceiptMessage,
} from '../types/index.js';
import { checkWebSocketRateLimit } from '../shared/rateLimiter.js';
import { AuthenticatedSocket } from './types.js';
import { sendToSocket } from './connection-manager.js';
import { handleChatMessage } from './chat-handler.js';
import { handleTyping, handleReadReceipt } from './typing-handler.js';

/**
 * Message Handler Module
 *
 * @description Routes incoming WebSocket messages to appropriate specialized handlers.
 * Acts as the central dispatcher for all WebSocket message types.
 * Applies rate limiting to prevent spam and abuse.
 *
 * @module message-handler
 */

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 *
 * @description Central dispatcher for all WebSocket message types. Performs
 * rate limiting checks before processing messages. Supported message types:
 *
 * - `message` - Chat message to send (rate limited)
 * - `typing` / `stop_typing` - Typing indicator events (rate limited, silently dropped when exceeded)
 * - `read_receipt` - Mark messages as read
 *
 * Unknown message types receive an error response.
 *
 * @param socket - The authenticated WebSocket connection that sent the message
 * @param message - The parsed WebSocket message to route
 * @returns Promise that resolves when message handling is complete
 *
 * @example
 * ```typescript
 * socket.on('message', async (data) => {
 *   try {
 *     const message: WSMessage = JSON.parse(data.toString());
 *     await handleWebSocketMessage(socket, message);
 *   } catch (error) {
 *     sendToSocket(socket, { type: 'error', payload: { message: 'Invalid message format' } });
 *   }
 * });
 * ```
 */
export async function handleWebSocketMessage(
  socket: AuthenticatedSocket,
  message: WSMessage
): Promise<void> {
  const userId = socket.userId;

  switch (message.type) {
    case 'message': {
      // Apply rate limiting
      const rateCheck = await checkWebSocketRateLimit(userId, 'message');
      if (!rateCheck.allowed) {
        sendToSocket(socket, {
          type: 'error',
          payload: {
            code: 'RATE_LIMITED',
            message: `Too many messages. Please wait ${Math.ceil(rateCheck.resetIn / 1000)} seconds.`,
            remaining: rateCheck.remaining,
          },
        });
        return;
      }
      await handleChatMessage(socket, message as WSChatMessage);
      break;
    }

    case 'typing':
    case 'stop_typing': {
      // Apply rate limiting for typing events
      const rateCheck = await checkWebSocketRateLimit(userId, 'typing');
      if (!rateCheck.allowed) {
        return; // Silently drop typing events when rate limited
      }
      await handleTyping(socket, message as WSTypingMessage);
      break;
    }

    case 'read_receipt':
      await handleReadReceipt(socket, message as WSReadReceiptMessage);
      break;

    default:
      sendToSocket(socket, {
        type: 'error',
        payload: { message: `Unknown message type: ${message.type}` },
      });
  }
}
