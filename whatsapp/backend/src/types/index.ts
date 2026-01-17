// User types
export interface User {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url?: string;
  created_at: Date;
}

// Conversation types
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

export interface ConversationParticipant {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: Date;
  user?: User;
}

// Message types
export type MessageStatus = 'sent' | 'delivered' | 'read';

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

export interface MessageStatusUpdate {
  message_id: string;
  recipient_id: string;
  status: MessageStatus;
  delivered_at?: Date;
  read_at?: Date;
}

// Presence types
export type PresenceStatus = 'online' | 'offline';

export interface PresenceInfo {
  status: PresenceStatus;
  server?: string;
  last_seen: number;
}

// WebSocket message types
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

export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  clientMessageId?: string;
}

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

export interface WSTypingMessage {
  type: 'typing' | 'stop_typing';
  payload: {
    conversationId: string;
  };
}

export interface WSReadReceiptMessage {
  type: 'read_receipt';
  payload: {
    conversationId: string;
    messageIds: string[];
  };
}

// Session types
declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}
