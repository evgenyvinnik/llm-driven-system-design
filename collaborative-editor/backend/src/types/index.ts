/**
 * @fileoverview Type definitions for OT-based collaborative editing.
 *
 * This module defines the core data structures used throughout the collaborative
 * editor system, including operation types for Operational Transformation (OT),
 * user and document models, and WebSocket message protocols.
 */

// ============================================================================
// Operation Types for Operational Transformation
// ============================================================================

/**
 * Retain operation - skip over characters without modifying them.
 * Used in OT to indicate portions of the document that remain unchanged.
 */
export interface RetainOp {
  /** Number of characters to retain (skip) */
  retain: number;
}

/**
 * Insert operation - add new text at the current position.
 * The inserted text becomes part of the document at the cursor location.
 */
export interface InsertOp {
  /** The string to insert */
  insert: string;
  /** Optional formatting attributes for rich text (future extension) */
  attributes?: Record<string, unknown>;
}

/**
 * Delete operation - remove characters at the current position.
 * Removes the specified number of characters from the document.
 */
export interface DeleteOp {
  /** Number of characters to delete */
  delete: number;
}

/**
 * Union type for all operation components.
 * An operation sequence consists of a series of these components.
 */
export type Op = RetainOp | InsertOp | DeleteOp;

/**
 * Complete operation data structure for serialization.
 * Represents a text transformation that can be applied to a document.
 */
export interface OperationData {
  /** Sequence of operation components (retain, insert, delete) */
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
 * User entity representing a collaborator in the system.
 * Each user has a unique color for presence visualization.
 */
export interface User {
  /** Unique user identifier (UUID) */
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
 * Documents are the primary unit of collaboration.
 */
export interface Document {
  /** Unique document identifier (UUID) */
  id: string;
  /** Document title */
  title: string;
  /** ID of the user who created this document */
  ownerId: string;
  /** Timestamp when the document was created */
  createdAt: Date;
  /** Timestamp of the last modification */
  updatedAt: Date;
}

/**
 * Document snapshot for efficient state recovery.
 * Snapshots are taken periodically to avoid replaying the entire operation log.
 */
export interface DocumentSnapshot {
  /** ID of the document this snapshot belongs to */
  documentId: string;
  /** Version number at the time of snapshot */
  version: number;
  /** Full document content at this version */
  content: string;
  /** Timestamp when this snapshot was created */
  createdAt: Date;
}

/**
 * Persisted operation record in the operation log.
 * Every operation is stored for history and conflict resolution.
 */
export interface OperationRecord {
  /** Unique operation identifier */
  id: string;
  /** ID of the document this operation applies to */
  documentId: string;
  /** Server-assigned sequential version number */
  version: number;
  /** ID of the client session that sent this operation */
  clientId: string;
  /** ID of the user who performed this operation */
  userId: string;
  /** The operation data */
  operation: OperationData;
  /** Timestamp when the operation was received */
  createdAt: Date;
}

// ============================================================================
// Presence and Cursor Types
// ============================================================================

/**
 * Information about a connected client for presence display.
 * Tracks each collaborator's identity and cursor position.
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
 * Represents where a user's caret is located.
 */
export interface CursorPosition {
  /** Zero-based character index in the document */
  index: number;
  /** Length of selection (0 for just a caret) */
  length?: number;
}

/**
 * Text selection range.
 * Represents a highlighted portion of the document.
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
 * Defines the protocol vocabulary for real-time communication.
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
 * All messages must have a type field.
 */
export interface WSMessage {
  /** Message type identifier */
  type: WSMessageType;
  /** Additional payload fields */
  [key: string]: unknown;
}

/**
 * Initial state message sent to clients on connection.
 * Provides everything needed to initialize the editor.
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
 * Used bidirectionally between client and server.
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
 * Confirms an operation was accepted and provides the assigned version.
 */
export interface AckMessage extends WSMessage {
  type: 'ack';
  /** Server-assigned version for the acknowledged operation */
  version: number;
}

/**
 * Cursor position update message.
 * Broadcasts cursor movements to other clients.
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
 * Broadcasts text selection changes to other clients.
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
 * Broadcast when a new collaborator connects to the document.
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
 * Broadcast when a collaborator disconnects from the document.
 */
export interface ClientLeaveMessage extends WSMessage {
  type: 'client_leave';
  /** ID of the client that left */
  clientId: string;
}

/**
 * Resync message for error recovery.
 * Sent when OT fails and the client needs to resync from scratch.
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
 * Informs the client of issues that occurred on the server.
 */
export interface ErrorMessage extends WSMessage {
  type: 'error';
  /** Human-readable error description */
  message: string;
}
