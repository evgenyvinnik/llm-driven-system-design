/**
 * Type definitions for Baby Discord
 *
 * This module contains all shared TypeScript interfaces and types used across
 * the Baby Discord application. Types are organized by domain: core entities,
 * session management, commands, messaging, and API contracts.
 */

/**
 * Represents a registered user in the system.
 * Users are created when someone connects with a new nickname and persist across sessions.
 */
export interface User {
  /** Unique database identifier for the user */
  id: number;
  /** Display name shown in chat messages */
  nickname: string;
  /** Timestamp when the user first connected */
  createdAt: Date;
}

/**
 * Represents a chat room where users can send messages.
 * Rooms are the primary grouping mechanism for conversations.
 */
export interface Room {
  /** Unique database identifier for the room */
  id: number;
  /** Room name used for joining (lowercase, alphanumeric) */
  name: string;
  /** User ID of the room creator, null if system-created */
  createdBy: number | null;
  /** Timestamp when the room was created */
  createdAt: Date;
}

/**
 * Represents a chat message stored in the database.
 * Messages are persisted for history and include denormalized fields for display.
 */
export interface Message {
  /** Unique database identifier for the message */
  id: number;
  /** ID of the room where the message was sent */
  roomId: number;
  /** ID of the user who sent the message, null for system messages */
  userId: number | null;
  /** The message text content */
  content: string;
  /** Timestamp when the message was sent */
  createdAt: Date;
  /** Denormalized sender nickname for display without join queries */
  nickname?: string;
  /** Denormalized room name for display without join queries */
  roomName?: string;
}

/**
 * Represents a user's membership in a room.
 * This is a join table entry tracking which users belong to which rooms.
 */
export interface RoomMember {
  /** ID of the room */
  roomId: number;
  /** ID of the member user */
  userId: number;
  /** Timestamp when the user joined the room */
  joinedAt: Date;
}

/**
 * Transport protocol used for the connection.
 * Baby Discord supports both raw TCP (for netcat) and HTTP (for browsers).
 */
export type TransportType = 'tcp' | 'http';

/**
 * Represents an active user session.
 * Sessions track connected users and provide transport-agnostic message delivery.
 * A user can have multiple sessions (e.g., multiple browser tabs).
 */
export interface Session {
  /** Unique identifier for this session (UUID) */
  sessionId: string;
  /** ID of the authenticated user */
  userId: number;
  /** Current display name of the user */
  nickname: string;
  /** Name of the room the user is currently in, null if not in a room */
  currentRoom: string | null;
  /** Protocol used for this connection */
  transport: TransportType;
  /** Callback to send a message to this session (transport-specific) */
  sendMessage: (msg: string) => void;
  /** Timestamp when the session was created */
  createdAt: Date;
}

/**
 * All supported command types.
 * Commands are prefixed with / in the input (e.g., /help, /join).
 */
export type CommandType =
  | 'help'
  | 'nick'
  | 'list'
  | 'quit'
  | 'create'
  | 'join'
  | 'rooms'
  | 'leave'
  | 'message'
  | 'dm';

/**
 * Result of parsing user input into a structured command.
 * Used by the CommandParser to normalize input from both TCP and HTTP clients.
 */
export interface ParsedCommand {
  /** The identified command type */
  type: CommandType;
  /** Command arguments (everything after the command name) */
  args: string[];
  /** Original raw input string */
  raw: string;
}

/**
 * Result of executing a command.
 * Contains response message and optional broadcast/data payloads.
 */
export interface CommandResult {
  /** Whether the command executed successfully */
  success: boolean;
  /** Response message to send to the user */
  message: string;
  /** Optional broadcast configuration for room-wide notifications */
  broadcast?: {
    /** Target room for the broadcast */
    room: string;
    /** Message content to broadcast */
    content: string;
    /** Whether to exclude the sender from receiving the broadcast */
    excludeSender?: boolean;
  };
  /** Optional additional data (e.g., user lists, room info) */
  data?: Record<string, unknown>;
}

/**
 * Represents a chat message for real-time delivery.
 * This is the format used for broadcasting messages to connected clients.
 */
export interface ChatMessage {
  /** Name of the room where the message was sent */
  room: string;
  /** Nickname of the message sender */
  user: string;
  /** Message text content */
  content: string;
  /** When the message was sent */
  timestamp: Date;
  /** Database ID if the message was persisted */
  messageId?: number;
}

/**
 * Represents a presence change event (user joining/leaving).
 * Used to notify room members of membership changes.
 */
export interface PresenceUpdate {
  /** Type of presence change */
  type: 'join' | 'leave' | 'nick_change';
  /** Room where the change occurred */
  room: string;
  /** User affected by the change */
  user: string;
  /** Previous nickname (for nick_change events) */
  oldNick?: string;
}

/**
 * Message format for Redis pub/sub cross-instance communication.
 * Enables horizontal scaling by routing messages between server instances.
 */
export interface PubSubMessage {
  /** Type of message being published */
  type: 'chat' | 'presence' | 'system';
  /** ID of the server instance that originated the message */
  instanceId: string;
  /** The actual message payload */
  payload: ChatMessage | PresenceUpdate | { message: string };
  /** Target room for the message */
  room: string;
  /** Unix timestamp of when the message was published */
  timestamp: number;
}

// ============================================================================
// API Types - Request/Response contracts for HTTP endpoints
// ============================================================================

/**
 * Request body for POST /api/connect.
 * Authenticates a user with a nickname.
 */
export interface ConnectRequest {
  /** Desired nickname (2-50 chars, alphanumeric with _ and -) */
  nickname: string;
}

/**
 * Response data for successful connection.
 * Contains session credentials for subsequent API calls.
 */
export interface ConnectResponse {
  /** Session token for authenticating further requests */
  sessionId: string;
  /** Database ID of the user */
  userId: number;
  /** Assigned nickname (may differ from request if taken) */
  nickname: string;
}

/**
 * Request body for POST /api/command.
 * Executes a slash command.
 */
export interface CommandRequest {
  /** Session token from connect response */
  sessionId: string;
  /** Command string (e.g., "/join general") */
  command: string;
}

/**
 * Request body for POST /api/message.
 * Sends a chat message to the current room.
 */
export interface MessageRequest {
  /** Session token from connect response */
  sessionId: string;
  /** Message content to send */
  content: string;
}

/**
 * Summary information about a room.
 * Used in room listings.
 */
export interface RoomInfo {
  /** Room name */
  name: string;
  /** Number of users currently in the room */
  memberCount: number;
  /** When the room was created */
  createdAt: Date;
}

/**
 * Standard API response wrapper.
 * All HTTP endpoints return this structure for consistency.
 * @template T - Type of the data payload
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request succeeded */
  success: boolean;
  /** Optional message (success or informational) */
  message?: string;
  /** Response data payload */
  data?: T;
  /** Error message if success is false */
  error?: string;
}
