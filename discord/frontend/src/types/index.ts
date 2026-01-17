/**
 * Frontend Type Definitions
 *
 * Type definitions for the Baby Discord frontend application.
 * These types mirror the backend API contracts for type-safe communication.
 */

/**
 * Represents a user in the chat system.
 */
export interface User {
  /** Unique database identifier */
  id: number;
  /** Display name shown in messages */
  nickname: string;
}

/**
 * Summary information about a chat room.
 * Used in room listings and sidebar.
 */
export interface Room {
  /** Room name used for joining */
  name: string;
  /** Number of currently active members */
  memberCount: number;
  /** ISO timestamp when room was created */
  createdAt: string;
}

/**
 * Represents a chat message for display.
 */
export interface Message {
  /** Database ID (optional for system messages) */
  id?: number;
  /** Room where message was sent */
  room: string;
  /** Sender nickname */
  user: string;
  /** Message text content */
  content: string;
  /** ISO timestamp when sent */
  timestamp: string;
  /** Alternative ID field from API */
  messageId?: number;
}

/**
 * Active user session returned from connect endpoint.
 */
export interface Session {
  /** Session token for authenticating API requests */
  sessionId: string;
  /** User's database ID */
  userId: number;
  /** User's display name */
  nickname: string;
  /** Room the user is currently in, null if not in a room */
  currentRoom: string | null;
}

/**
 * Standard API response wrapper.
 * All backend endpoints return this structure.
 * @template T - Type of the data payload
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request succeeded */
  success: boolean;
  /** Optional success or informational message */
  message?: string;
  /** Response data payload */
  data?: T;
  /** Error message if success is false */
  error?: string;
}
