// User types
export interface User {
  id: string;
  username: string;
  display_name: string;
  profile_picture_url?: string;
  created_at: string;
  presence?: PresenceInfo;
}

// Presence
export interface PresenceInfo {
  status: 'online' | 'offline';
  last_seen: number;
}

// Conversation types
export interface Conversation {
  id: string;
  name?: string;
  is_group: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
  participants?: ConversationParticipant[];
  last_message?: Message;
  unread_count?: number;
}

export interface ConversationParticipant {
  id: string;
  user_id: string;
  role: 'admin' | 'member';
  user?: User;
}

// Message types
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'image' | 'video' | 'file';
  media_url?: string;
  created_at: string;
  status?: MessageStatus;
  sender?: User;
  clientMessageId?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload: unknown;
  clientMessageId?: string;
}

export interface WSMessageAck {
  type: 'message_ack';
  payload: {
    clientMessageId: string;
    messageId: string;
    status: string;
    createdAt: string;
  };
}

export interface WSDeliveryReceipt {
  type: 'delivery_receipt' | 'read_receipt';
  payload: {
    messageId: string;
    messageIds?: string[];
    recipientId: string;
    status: 'delivered' | 'read';
    timestamp: string;
  };
}

export interface WSTypingEvent {
  type: 'typing' | 'stop_typing';
  payload: {
    conversationId: string;
    userId: string;
  };
}

export interface WSPresenceEvent {
  type: 'presence';
  payload: {
    userId: string;
    status: 'online' | 'offline';
    timestamp: number;
  };
}

export interface WSIncomingMessage {
  type: 'message';
  payload: Message & {
    conversation?: {
      id: string;
      name?: string;
      is_group: boolean;
    };
  };
}
