import { WebSocket } from 'ws';

/**
 * Extended WebSocket interface with user-specific properties.
 * Tracks the authenticated user, connection health, and timing for metrics.
 *
 * @description Extends the base WebSocket with authentication state and
 * connection metadata used for user tracking and heartbeat monitoring.
 *
 * @property userId - The unique identifier of the authenticated user
 * @property isAlive - Flag indicating if the connection responded to the last ping
 * @property connectedAt - Unix timestamp when the connection was established
 *
 * @example
 * ```typescript
 * const socket = ws as AuthenticatedSocket;
 * socket.userId = 'user-123';
 * socket.isAlive = true;
 * socket.connectedAt = Date.now();
 * ```
 */
export interface AuthenticatedSocket extends WebSocket {
  userId: string;
  isAlive: boolean;
  connectedAt: number;
}

/**
 * Redis message types for cross-server communication.
 *
 * @description Enumeration of all message types that can be routed through
 * Redis pub/sub for cross-server WebSocket communication.
 *
 * - `deliver_message` - Route a chat message to a recipient on another server
 * - `forward_typing` - Forward typing indicator to another server
 * - `forward_receipt` - Forward delivery/read receipt to another server
 * - `forward_reaction` - Forward reaction update to another server
 */
export type RedisMessageType =
  | 'deliver_message'
  | 'forward_typing'
  | 'forward_receipt'
  | 'forward_reaction';

/**
 * Base structure for messages routed through Redis pub/sub.
 *
 * @description Common interface for all inter-server messages. Contains the
 * message type discriminator, target recipient, and message payload.
 *
 * @property type - The type of Redis message for routing
 * @property recipientId - The target user ID to receive this message
 * @property payload - The message content (structure varies by type)
 */
export interface RedisMessage {
  type: RedisMessageType;
  recipientId: string;
  payload: unknown;
}

/**
 * Message delivery payload for cross-server chat message routing.
 *
 * @description Extended Redis message for delivering chat messages to users
 * connected to different server instances. Includes sender info and timing
 * data for delivery metrics.
 *
 * @property type - Always 'deliver_message' for this message type
 * @property senderId - The user ID of the message sender
 * @property senderServer - The server ID where the sender is connected
 * @property messageId - The unique identifier of the message being delivered
 * @property sendStartTime - Unix timestamp when send was initiated (for latency tracking)
 * @property payload - The full message object to deliver
 *
 * @example
 * ```typescript
 * const redisMsg: RedisDeliverMessage = {
 *   type: 'deliver_message',
 *   recipientId: 'user-456',
 *   senderId: 'user-123',
 *   senderServer: 'server-1',
 *   messageId: 'msg-789',
 *   sendStartTime: Date.now(),
 *   payload: { content: 'Hello!', ... }
 * };
 * ```
 */
export interface RedisDeliverMessage extends RedisMessage {
  type: 'deliver_message';
  senderId: string;
  senderServer: string;
  messageId: string;
  sendStartTime: number;
  payload: unknown;
}

/**
 * Typing indicator message for cross-server forwarding.
 *
 * @description Routes typing start/stop events to users on other servers.
 * The nested payload structure matches the WebSocket message format.
 *
 * @property type - Always 'forward_typing' for this message type
 * @property payload.type - Either 'typing' or 'stop_typing'
 * @property payload.payload.conversationId - The conversation where typing occurs
 * @property payload.payload.userId - The user who is typing
 */
export interface RedisTypingMessage extends RedisMessage {
  type: 'forward_typing';
  payload: {
    type: 'typing' | 'stop_typing';
    payload: {
      conversationId: string;
      userId: string;
    };
  };
}

/**
 * Receipt message for cross-server delivery/read notification forwarding.
 *
 * @description Routes delivery and read receipts to message senders on other
 * servers. Supports both single message and batch receipt scenarios.
 *
 * @property type - Always 'forward_receipt' for this message type
 * @property payload.type - Either 'delivery_receipt' or 'read_receipt'
 * @property payload.payload.messageId - Primary message ID for the receipt
 * @property payload.payload.messageIds - Optional array of all message IDs being marked
 * @property payload.payload.recipientId - The user who received/read the message
 * @property payload.payload.status - Either 'delivered' or 'read'
 * @property payload.payload.timestamp - When the status change occurred
 */
export interface RedisReceiptMessage extends RedisMessage {
  type: 'forward_receipt';
  payload: {
    type: 'delivery_receipt' | 'read_receipt';
    payload: {
      messageId: string;
      messageIds?: string[];
      recipientId: string;
      status: 'delivered' | 'read';
      timestamp: Date;
    };
  };
}

/**
 * Reaction update message for cross-server forwarding.
 *
 * @description Routes reaction additions/removals to conversation participants
 * on other servers. Payload contains the full reaction update details.
 *
 * @property type - Always 'forward_reaction' for this message type
 * @property payload - The reaction update details to forward
 */
export interface RedisReactionMessage extends RedisMessage {
  type: 'forward_reaction';
  payload: unknown;
}

/**
 * Union type for all Redis message types.
 *
 * @description Discriminated union of all possible Redis pub/sub message types.
 * Use the `type` property to narrow the type for type-safe access to properties.
 *
 * @example
 * ```typescript
 * function processRedisMessage(msg: AnyRedisMessage) {
 *   switch (msg.type) {
 *     case 'deliver_message':
 *       console.log(msg.senderId); // Type-safe access
 *       break;
 *     case 'forward_typing':
 *       console.log(msg.payload.type); // 'typing' | 'stop_typing'
 *       break;
 *   }
 * }
 * ```
 */
export type AnyRedisMessage =
  | RedisDeliverMessage
  | RedisTypingMessage
  | RedisReceiptMessage
  | RedisReactionMessage;
