import { pubClient } from '../redis.js';
import { createLogger } from '../shared/logger.js';
import type { AckedMessage, MessageRow } from './messages.js';

const logger = createLogger('realtime');

/**
 * Cross-instance event bus over Redis pub/sub.
 *
 * Every instance subscribes to every channel and forwards each event to the
 * sockets it holds for the listed users (services/websocket.ts). Publishing
 * happens after the database commit and is best-effort: if it fails, nothing
 * durable is lost, because the device inbox row was written in the same
 * transaction as the message and is drained on the device's next sync.
 */
export const CHANNELS = [
  'messages',
  'typing',
  'presence',
  'read_receipts',
  'delivery_receipts',
  'reactions',
  'control',
] as const;

export type Channel = (typeof CHANNELS)[number];

export interface NewMessageEvent {
  message: MessageRow;
  participantIds: string[];
  /** The socket that sent it already has it; every other socket gets it. */
  senderConnectionId?: string | null;
}

export interface TypingEvent {
  conversationId: string;
  userId: string;
  username: string;
  displayName: string;
  isTyping: boolean;
  participantIds: string[];
}

export interface ReadReceiptEvent {
  conversationId: string;
  userId: string;
  deviceId: string;
  seq: number;
  messageId: string;
  /** Includes the reader: their other devices clear the unread badge. */
  participantIds: string[];
  senderConnectionId?: string | null;
}

export interface DeliveryReceiptEvent {
  conversationId: string;
  messageIds: string[];
  /** Highest seq in this batch. */
  seq: number;
  /** The user whose device received the messages. */
  userId: string;
  deviceId: string;
  /** Only the senders of these messages need to hear about it. */
  targetUserIds: string[];
}

export interface ReactionEvent {
  conversationId: string;
  messageId: string;
  userId: string;
  reaction: string;
  remove: boolean;
  participantIds: string[];
}

export interface PresenceEvent {
  userId: string;
  status: 'online' | 'offline';
  /** Users who share a conversation with userId - nobody else is told. */
  peerIds: string[];
}

export interface ControlEvent {
  type: 'device_revoked';
  userId: string;
  deviceId: string;
}

async function publish(channel: Channel, payload: object): Promise<void> {
  try {
    await pubClient.publish(channel, JSON.stringify(payload));
  } catch (error) {
    logger.warn({ error, channel }, 'Publish failed; durable state is unaffected');
  }
}

export function publishNewMessage(event: NewMessageEvent): Promise<void> {
  return publish('messages', event);
}

export function publishTyping(event: TypingEvent): Promise<void> {
  return publish('typing', event);
}

export function publishReadReceipt(event: ReadReceiptEvent): Promise<void> {
  return publish('read_receipts', event);
}

export function publishReaction(event: ReactionEvent): Promise<void> {
  return publish('reactions', event);
}

export function publishPresence(event: PresenceEvent): Promise<void> {
  return publish('presence', event);
}

export function publishControl(event: ControlEvent): Promise<void> {
  return publish('control', event);
}

/**
 * Turns acknowledged inbox rows into one "delivered" event per conversation,
 * addressed to the senders. A user's own messages arriving on their other
 * devices are skipped: "Delivered" means the other side received it.
 */
export function buildDeliveryReceipts(
  userId: string,
  deviceId: string,
  acked: AckedMessage[]
): DeliveryReceiptEvent[] {
  const byConversation = new Map<string, DeliveryReceiptEvent>();
  for (const row of acked) {
    if (!row.sender_id || row.sender_id === userId) continue;
    let event = byConversation.get(row.conversation_id);
    if (!event) {
      event = {
        conversationId: row.conversation_id,
        messageIds: [],
        seq: 0,
        userId,
        deviceId,
        targetUserIds: [],
      };
      byConversation.set(row.conversation_id, event);
    }
    event.messageIds.push(row.message_id);
    event.seq = Math.max(event.seq, row.seq);
    if (!event.targetUserIds.includes(row.sender_id)) event.targetUserIds.push(row.sender_id);
  }
  return [...byConversation.values()];
}

export async function publishDeliveryReceipts(
  userId: string,
  deviceId: string,
  acked: AckedMessage[]
): Promise<void> {
  for (const event of buildDeliveryReceipts(userId, deviceId, acked)) {
    await publish('delivery_receipts', event);
  }
}
