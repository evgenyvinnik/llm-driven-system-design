export interface User {
  id: string;
  username: string;
  email?: string;
  display_name: string;
  avatar_url: string | null;
  status?: 'online' | 'offline';
  last_seen?: string;
}

export interface Device {
  id: string;
  device_name: string;
  device_type: string;
  is_active: boolean;
  last_active: string;
}

export interface Participant extends User {
  role: 'admin' | 'member';
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  role: 'admin' | 'member';
  muted: boolean;
  last_message: Message | null;
  unread_count: number;
  participants: Participant[];
}

export interface Reaction {
  id: string;
  user_id: string;
  reaction: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'image' | 'video' | 'file' | 'system';
  reply_to_id: string | null;
  edited_at: string | null;
  created_at: string;
  sender_username: string;
  sender_display_name: string;
  sender_avatar_url: string | null;
  reactions: Reaction[] | null;
  reply_to: {
    id: string;
    content: string;
    sender_id: string;
  } | null;
  // Client-side properties
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  clientMessageId?: string;
}

export interface ReadReceipt {
  user_id: string;
  last_read_message_id: string;
  last_read_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface TypingUser {
  userId: string;
  username: string;
  displayName: string;
}

export interface AuthState {
  user: User | null;
  deviceId: string | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}
