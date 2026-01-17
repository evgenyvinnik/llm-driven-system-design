/**
 * Represents a user in the messaging system.
 */
export interface User {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url?: string;
  created_at: Date;
}

/**
 * Represents a conversation (1:1 chat or group).
 * Core entity for organizing messages between participants.
 */
export interface Conversation {
  id: string;
  name?: string;
  is_group: boolean;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
  participants?: ConversationParticipant[];
  last_message?: Message;
  unread_count?: number;
}

/**
 * Represents a user's participation in a conversation.
 * Tracks role (admin/member) for group permission management.
 */
export interface ConversationParticipant {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: Date;
  user?: User;
}

/**
 * Message delivery status progression: sent -> delivered -> read.
 */
export type MessageStatus = 'sent' | 'delivered' | 'read';

/**
 * Represents a chat message in a conversation.
 * Supports text and media content types.
 */
export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'image' | 'video' | 'file';
  media_url?: string;
  created_at: Date;
  status?: MessageStatus;
  sender?: User;
}

/**
 * Tracks delivery status per recipient for a message.
 * Enables read receipts in 1:1 and group chats.
 */
export interface MessageStatusUpdate {
  message_id: string;
  recipient_id: string;
  status: MessageStatus;
  delivered_at?: Date;
  read_at?: Date;
}

/**
 * User online/offline status.
 */
export type PresenceStatus = 'online' | 'offline';

/**
 * Presence information stored in Redis for fast access.
 * Tracks which server a user is connected to for message routing.
 */
export interface PresenceInfo {
  status: PresenceStatus;
  server?: string;
  last_seen: number;
}

/**
 * Types of WebSocket messages exchanged between client and server.
 */
export type WSMessageType =
  | 'message'
  | 'message_ack'
  | 'delivery_receipt'
  | 'read_receipt'
  | 'typing'
  | 'stop_typing'
  | 'presence'
  | 'error'
  | 'conversation_update'
  | 'group_message';

/**
 * Base WebSocket message structure.
 * All WS messages follow this format with type-specific payloads.
 */
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  clientMessageId?: string;
}

/**
 * WebSocket message for sending a chat message.
 * clientMessageId enables optimistic updates and deduplication.
 */
export interface WSChatMessage {
  type: 'message';
  payload: {
    conversationId: string;
    content: string;
    contentType?: 'text' | 'image' | 'video' | 'file';
    mediaUrl?: string;
  };
  clientMessageId: string;
}

/**
 * WebSocket message for typing indicator events.
 */
export interface WSTypingMessage {
  type: 'typing' | 'stop_typing';
  payload: {
    conversationId: string;
  };
}

/**
 * WebSocket message for marking messages as read.
 */
export interface WSReadReceiptMessage {
  type: 'read_receipt';
  payload: {
    conversationId: string;
    messageIds: string[];
  };
}

/**
 * Express session data extension for TypeScript.
 * Adds userId to the session for authentication.
 */
declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}
