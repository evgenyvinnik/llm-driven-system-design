// User types
export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

// Workspace types
export interface Workspace {
  id: string;
  name: string;
  domain: string;
  settings: WorkspaceSettings;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceSettings {
  default_channels?: string[];
  allow_invites?: boolean;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: Date;
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
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelMember {
  channel_id: string;
  user_id: string;
  joined_at: Date;
  last_read_at: Date | null;
}

// Message types
export interface Message {
  id: number;
  workspace_id: string;
  channel_id: string;
  user_id: string;
  thread_ts: number | null;
  content: string;
  attachments: MessageAttachment[] | null;
  reply_count: number;
  created_at: Date;
  edited_at: Date | null;
}

export interface MessageAttachment {
  type: 'file' | 'image' | 'link';
  url: string;
  name?: string;
  size?: number;
}

// Reaction types
export interface Reaction {
  message_id: number;
  user_id: string;
  emoji: string;
  created_at: Date;
}

// Direct message types
export interface DirectMessage {
  id: string;
  workspace_id: string;
  created_at: Date;
}

export interface DirectMessageMember {
  dm_id: string;
  user_id: string;
}

// Presence types
export interface PresenceStatus {
  user_id: string;
  status: 'online' | 'away' | 'offline';
  last_seen: Date;
}

// WebSocket message types
export interface WSMessage {
  type: 'message' | 'message_update' | 'message_delete' | 'reaction_add' | 'reaction_remove' | 'typing' | 'presence' | 'channel_update';
  payload: unknown;
}

export interface WSMessagePayload {
  message: Message;
  user: Pick<User, 'id' | 'username' | 'display_name' | 'avatar_url'>;
  reactions?: Array<{ emoji: string; count: number; users: string[] }>;
}

// API request/response types
export interface CreateWorkspaceRequest {
  name: string;
  domain: string;
}

export interface CreateChannelRequest {
  name: string;
  topic?: string;
  description?: string;
  is_private?: boolean;
}

export interface SendMessageRequest {
  content: string;
  thread_ts?: number;
  attachments?: MessageAttachment[];
}

export interface UpdateMessageRequest {
  content: string;
}

export interface SearchMessagesRequest {
  query: string;
  channel_id?: string;
  user_id?: string;
  from_date?: string;
  to_date?: string;
}

// Session types
declare module 'express-session' {
  interface SessionData {
    userId: string;
    workspaceId: string;
  }
}
