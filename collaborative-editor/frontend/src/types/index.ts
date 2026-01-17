/**
 * @fileoverview Type definitions for the collaborative editor frontend.
 *
 * These types mirror the backend types for consistency across the application.
 * They define the data structures used for:
 * - Operational Transformation (OT) operations
 * - User and document models
 * - WebSocket communication protocol
 */

// ============================================================================
// Operation Types for Operational Transformation
// ============================================================================

/**
 * Retain operation - skip over characters without modifying them.
 */
export interface RetainOp {
  /** Number of characters to retain (skip) */
  retain: number;
}

/**
 * Insert operation - add new text at the current position.
 */
export interface InsertOp {
  /** The string to insert */
  insert: string;
  /** Optional formatting attributes for rich text */
  attributes?: Record<string, unknown>;
}

/**
 * Delete operation - remove characters at the current position.
 */
export interface DeleteOp {
  /** Number of characters to delete */
  delete: number;
}

/**
 * Union type for all operation components.
 */
export type Op = RetainOp | InsertOp | DeleteOp;

/**
 * Complete operation data structure for serialization.
 */
export interface OperationData {
  /** Sequence of operation components */
  ops: Op[];
  /** Length of the document before applying this operation */
  baseLength: number;
  /** Length of the document after applying this operation */
  targetLength: number;
}

// ============================================================================
// Domain Models
// ============================================================================

/**
 * User entity representing a collaborator.
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** Login username */
  username: string;
  /** Display name shown in the UI */
  displayName: string;
  /** Hex color code for presence indicators */
  color: string;
}

/**
 * Document entity representing a collaborative text document.
 * Note: createdAt and updatedAt are strings (ISO format) in the frontend.
 */
export interface Document {
  /** Unique document identifier */
  id: string;
  /** Document title */
  title: string;
  /** ID of the user who created this document */
  ownerId: string;
  /** ISO timestamp when the document was created */
  createdAt: string;
  /** ISO timestamp of the last modification */
  updatedAt: string;
}

// ============================================================================
// Presence Types
// ============================================================================

/**
 * Information about a connected client for presence display.
 */
export interface ClientInfo {
  /** Unique identifier for this browser session */
  clientId: string;
  /** ID of the authenticated user */
  userId: string;
  /** User's display name */
  displayName: string;
  /** User's assigned color for presence UI */
  color: string;
  /** Current cursor position, if known */
  cursor: CursorPosition | null;
  /** Current text selection, if any */
  selection: SelectionRange | null;
}

/**
 * Cursor position in the document.
 */
export interface CursorPosition {
  /** Zero-based character index in the document */
  index: number;
  /** Length of selection (0 for just a caret) */
  length?: number;
}

/**
 * Text selection range.
 */
export interface SelectionRange {
  /** Start index of the selection */
  start: number;
  /** End index of the selection */
  end: number;
}

// ============================================================================
// WebSocket Protocol Types
// ============================================================================

/**
 * All possible WebSocket message types.
 */
export type WSMessageType =
  | 'init'
  | 'operation'
  | 'ack'
  | 'cursor'
  | 'selection'
  | 'client_join'
  | 'client_leave'
  | 'resync'
  | 'error';

/**
 * Base WebSocket message interface.
 */
export interface WSMessage {
  /** Message type identifier */
  type: WSMessageType;
  /** Additional payload fields */
  [key: string]: unknown;
}

/**
 * Initial state message sent to clients on connection.
 */
export interface InitMessage extends WSMessage {
  type: 'init';
  /** Assigned client ID for this session */
  clientId: string;
  /** Current document version */
  version: number;
  /** Current document content */
  content: string;
  /** List of currently connected clients */
  clients: Array<[string, ClientInfo]>;
}

/**
 * Operation message for sending/receiving edits.
 */
export interface OperationMessage extends WSMessage {
  type: 'operation';
  /** Version this operation was based on */
  version: number;
  /** The operation data */
  operation: OperationData;
  /** ID of the client that sent this (set by server when broadcasting) */
  clientId?: string;
}

/**
 * Acknowledgment message from server.
 */
export interface AckMessage extends WSMessage {
  type: 'ack';
  /** Server-assigned version for the acknowledged operation */
  version: number;
}

/**
 * Cursor position update message.
 */
export interface CursorMessage extends WSMessage {
  type: 'cursor';
  /** New cursor position */
  position: CursorPosition;
  /** ID of the client whose cursor moved (set by server) */
  clientId?: string;
}

/**
 * Selection update message.
 */
export interface SelectionMessage extends WSMessage {
  type: 'selection';
  /** New selection range */
  selection: SelectionRange;
  /** ID of the client whose selection changed (set by server) */
  clientId?: string;
}

/**
 * Client join notification.
 */
export interface ClientJoinMessage extends WSMessage {
  type: 'client_join';
  /** New client's session ID */
  clientId: string;
  /** New client's user ID */
  userId: string;
  /** New client's display name */
  displayName: string;
  /** New client's assigned color */
  color: string;
}

/**
 * Client leave notification.
 */
export interface ClientLeaveMessage extends WSMessage {
  type: 'client_leave';
  /** ID of the client that left */
  clientId: string;
}

/**
 * Resync message for error recovery.
 */
export interface ResyncMessage extends WSMessage {
  type: 'resync';
  /** Current server version */
  version: number;
  /** Current document content */
  content: string;
}

/**
 * Error message for reporting problems.
 */
export interface ErrorMessage extends WSMessage {
  type: 'error';
  /** Human-readable error description */
  message: string;
}
