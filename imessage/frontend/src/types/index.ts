/**
 * Represents a user in the messaging system.
 * Contains identity and profile information.
 */
export interface User {
  /** Unique identifier (UUID) */
  id: string;
  /** Unique username for login and mentions */
  username: string;
  /** Email address (only visible to the user themselves) */
  email?: string;
  /** User's display name shown in conversations */
  display_name: string;
  /** URL to user's profile picture */
  avatar_url: string | null;
  /** Online/offline presence status */
  status?: 'online' | 'offline';
  /** ISO timestamp of last activity */
  last_seen?: string;
}

/**
 * Represents a device registered to a user.
 * Supports multi-device sync and security management.
 */
export interface Device {
  /** Unique device identifier (UUID) */
  id: string;
  /** Human-readable device name (e.g., "iPhone 15 Pro") */
  device_name: string;
  /** Device type category (e.g., "mobile", "desktop", "web") */
  device_type: string;
  /** Whether the device is currently allowed to access the account */
  is_active: boolean;
  /** ISO timestamp of last activity from this device */
  last_active: string;
}

/**
 * A user's role within a conversation.
 * Extends User with conversation-specific permissions.
 */
export interface Participant extends User {
  /** Role determining permissions: admin can manage group, member is standard */
  role: 'admin' | 'member';
}

/**
 * Represents a conversation (direct or group chat).
 * Contains metadata and the most recent message for list display.
 */
export interface Conversation {
  /** Unique conversation identifier (UUID) */
  id: string;
  /** Conversation type: direct (1:1) or group */
  type: 'direct' | 'group';
  /** Group name (null for direct conversations) */
  name: string | null;
  /** Group avatar URL (null for direct conversations) */
  avatar_url: string | null;
  /** ISO timestamp when conversation was created */
  created_at: string;
  /** ISO timestamp of last activity */
  updated_at: string;
  /** Current user's role in this conversation */
  role: 'admin' | 'member';
  /** Whether notifications are muted for this conversation */
  muted: boolean;
  /** Most recent message for preview (null if no messages) */
  last_message: Message | null;
  /** Number of unread messages for the current user */
  unread_count: number;
  /** List of participants in the conversation */
  participants: Participant[];
}

/**
 * Represents an emoji reaction on a message.
 */
export interface Reaction {
  /** Unique reaction identifier (UUID) */
  id: string;
  /** User who added this reaction */
  user_id: string;
  /** The emoji or reaction string */
  reaction: string;
}

/**
 * Represents a message in a conversation.
 * Includes sender info, content, and metadata for display.
 */
export interface Message {
  /** Unique message identifier (UUID); a client ID until the server confirms */
  id: string;
  /** Parent conversation identifier */
  conversation_id: string;
  /**
   * Position in the conversation, assigned by the server (1, 2, 3, ...).
   * Absent on optimistic messages that the server has not accepted yet.
   */
  seq?: number;
  /** User who sent this message */
  sender_id: string;
  /** Message text or content */
  content: string;
  /** Type of content for rendering */
  content_type: 'text' | 'image' | 'video' | 'file' | 'system';
  /** Message ID being replied to (for threads) */
  reply_to_id: string | null;
  /** ISO timestamp if message was edited (null if not) */
  edited_at: string | null;
  /** ISO timestamp if the message was deleted (tombstone) */
  deleted_at?: string | null;
  /** ISO timestamp when message was created */
  created_at: string;
  /** Sender's username (denormalized for display) */
  sender_username: string;
  /** Sender's display name (denormalized for display) */
  sender_display_name: string;
  /** Sender's avatar URL (denormalized for display) */
  sender_avatar_url: string | null;
  /** List of reactions on this message */
  reactions: Reaction[] | null;
  /** Preview of the message being replied to */
  reply_to: {
    id: string;
    content: string;
    sender_id: string;
  } | null;
  /**
   * Delivery state of the current user's own messages: 'sending' until the
   * server acks, then 'sent', 'delivered' (a recipient device acknowledged
   * it) and 'read' (a recipient's read watermark passed it).
   */
  status?: MessageStatus | null;
  /** Client-generated ID, reused on every retry of this send */
  clientMessageId?: string;
  /** Server copy of clientMessageId */
  client_message_id?: string | null;
}

/** Delivery states in the order a message moves through them ('failed' is terminal until retried). */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Represents a read receipt showing who has read messages in a conversation.
 */
export interface ReadReceipt {
  /** User who read the messages */
  user_id: string;
  /** Read watermark: every message at or below this seq is read */
  last_read_seq: number;
  /** ISO timestamp when they read it */
  last_read_at: string;
  /** User's username for display */
  username: string;
  /** User's display name for display */
  display_name: string;
  /** User's avatar for display */
  avatar_url: string | null;
}

/**
 * Represents a user who is currently typing in a conversation.
 * Used for typing indicator display.
 */
export interface TypingUser {
  /** User ID of the typing user */
  userId: string;
  /** Username for display */
  username: string;
  /** Display name for user-friendly output */
  displayName: string;
}

/**
 * Authentication state for the client application.
 * Mirrors the structure in authStore for type safety.
 */
export interface AuthState {
  /** Currently authenticated user */
  user: User | null;
  /** Current device identifier */
  deviceId: string | null;
  /** JWT authentication token */
  token: string | null;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether auth check is in progress */
  isLoading: boolean;
}

/** Lifecycle of the client's WebSocket connection, shown in the UI. */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Generic WebSocket message structure.
 * The type field determines the message format and handling.
 * Additional fields vary by message type.
 */
export interface WebSocketMessage {
  /** Message type for routing (e.g., 'new_message', 'typing', 'reaction_update') */
  type: string;
  /** Additional payload fields vary by type */
  [key: string]: unknown;
}
