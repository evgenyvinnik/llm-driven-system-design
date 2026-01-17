/**
 * @fileoverview TypeScript type definitions for the Slack backend.
 * Contains interfaces for all domain entities (users, workspaces, channels, messages)
 * as well as API request/response types and WebSocket message formats.
 */

/**
 * Represents a registered user in the system.
 * Users can belong to multiple workspaces and participate in channels.
 */
export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a workspace (tenant) in the multi-tenant architecture.
 * Each workspace is isolated and contains its own channels, members, and messages.
 */
export interface Workspace {
  id: string;
  name: string;
  domain: string;
  settings: WorkspaceSettings;
  created_at: Date;
  updated_at: Date;
}

/**
 * Configuration settings for a workspace.
 */
export interface WorkspaceSettings {
  /** Channel IDs that new members are automatically added to */
  default_channels?: string[];
  /** Whether workspace members can invite new users */
  allow_invites?: boolean;
}

/**
 * Association between a user and a workspace with their role.
 */
export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: Date;
}

/**
 * Represents a channel within a workspace.
 * Channels can be public, private, or direct message conversations.
 * The is_dm flag distinguishes DM channels from regular channels.
 */
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

/**
 * Association between a user and a channel.
 * Tracks when the user joined and their last read timestamp for unread counts.
 */
export interface ChannelMember {
  channel_id: string;
  user_id: string;
  joined_at: Date;
  last_read_at: Date | null;
}

/**
 * Represents a message in a channel or thread.
 * Messages use thread_ts to link replies to their parent message.
 * The id field uses BIGSERIAL for ordering and pagination.
 */
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

/**
 * File or link attachment on a message.
 */
export interface MessageAttachment {
  type: 'file' | 'image' | 'link';
  url: string;
  name?: string;
  size?: number;
}

/**
 * Emoji reaction on a message.
 * Each user can add one reaction per emoji per message.
 */
export interface Reaction {
  message_id: number;
  user_id: string;
  emoji: string;
  created_at: Date;
}

/**
 * Direct message conversation container.
 * Groups multiple users for one-on-one or group DM conversations.
 */
export interface DirectMessage {
  id: string;
  workspace_id: string;
  created_at: Date;
}

/**
 * Association between a user and a direct message conversation.
 */
export interface DirectMessageMember {
  dm_id: string;
  user_id: string;
}

/**
 * User presence status stored in Redis with TTL for automatic cleanup.
 * Used for showing online/away/offline indicators in the UI.
 */
export interface PresenceStatus {
  user_id: string;
  status: 'online' | 'away' | 'offline';
  last_seen: Date;
}

/**
 * WebSocket message envelope for real-time communication.
 * All WebSocket messages are JSON-encoded with a type discriminator.
 */
export interface WSMessage {
  type: 'message' | 'message_update' | 'message_delete' | 'reaction_add' | 'reaction_remove' | 'typing' | 'presence' | 'channel_update';
  payload: unknown;
}

/**
 * Payload structure for new message WebSocket events.
 */
export interface WSMessagePayload {
  message: Message;
  user: Pick<User, 'id' | 'username' | 'display_name' | 'avatar_url'>;
  reactions?: Array<{ emoji: string; count: number; users: string[] }>;
}

/**
 * Request body for creating a new workspace.
 */
export interface CreateWorkspaceRequest {
  name: string;
  domain: string;
}

/**
 * Request body for creating a new channel.
 */
export interface CreateChannelRequest {
  name: string;
  topic?: string;
  description?: string;
  is_private?: boolean;
}

/**
 * Request body for sending a new message.
 */
export interface SendMessageRequest {
  content: string;
  thread_ts?: number;
  attachments?: MessageAttachment[];
}

/**
 * Request body for updating an existing message.
 */
export interface UpdateMessageRequest {
  content: string;
}

/**
 * Query parameters for message search.
 */
export interface SearchMessagesRequest {
  query: string;
  channel_id?: string;
  user_id?: string;
  from_date?: string;
  to_date?: string;
}

/**
 * Extends express-session with application-specific session data.
 * Stores the authenticated user ID and currently selected workspace.
 */
declare module 'express-session' {
  interface SessionData {
    userId: string;
    workspaceId: string;
  }
}
