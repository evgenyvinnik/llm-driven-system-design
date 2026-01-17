// User types
export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

// Workspace types
export interface Workspace {
  id: string;
  name: string;
  domain: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface WorkspaceMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

// Channel types
export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  topic: string | null;
  description: string | null;
  is_private: boolean;
  is_archived: boolean;
  is_dm: boolean;
  is_member: boolean;
  unread_count: number;
  created_at: string;
}

export interface DMChannel extends Channel {
  other_members: User[];
  last_message: string | null;
  last_message_at: string | null;
}

// Message types
export interface Reaction {
  emoji: string;
  user_id: string;
}

export interface Message {
  id: number;
  workspace_id: string;
  channel_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  thread_ts: number | null;
  content: string;
  attachments: unknown[] | null;
  reply_count: number;
  reactions: Reaction[] | null;
  created_at: string;
  edited_at: string | null;
}

export interface Thread {
  parent: Message;
  replies: Message[];
}

// Search result
export interface SearchResult {
  id: number;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
  highlight?: string[];
  user: {
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
  channel_name: string;
}

// Presence types
export interface PresenceUpdate {
  userId: string;
  status: 'online' | 'away' | 'offline';
  user?: User;
}

// WebSocket message types
export interface WSMessage {
  type: 'message' | 'message_update' | 'message_delete' | 'reaction_add' | 'reaction_remove' | 'typing' | 'presence' | 'connected' | 'pong';
  payload: unknown;
}
