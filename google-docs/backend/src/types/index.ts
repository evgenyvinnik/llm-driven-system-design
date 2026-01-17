/**
 * Type definitions for the Google Docs clone backend.
 * Defines all domain entities, operation types for OT, and API contracts.
 */

// User types
/** Full user record with authentication data */
export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  avatar_color: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/** User data safe to expose to clients (excludes password) */
export interface UserPublic {
  id: string;
  email: string;
  name: string;
  avatar_color: string;
  role: 'user' | 'admin';
}

// Session types
/** Server-side session record for authenticated users */
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// Document types
/** Main document entity with content stored as ProseMirror JSON */
export interface Document {
  id: string;
  title: string;
  owner_id: string;
  current_version: number;
  content: DocumentContent;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

/** ProseMirror document content structure */
export interface DocumentContent {
  type: 'doc';
  content: DocumentNode[];
}

/** A node in the ProseMirror document tree (paragraph, heading, etc.) */
export interface DocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
  text?: string;
  marks?: Mark[];
}

/** Text formatting mark (bold, italic, link, etc.) */
export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

// Permission types
/** Permission levels for document access */
export type PermissionLevel = 'view' | 'comment' | 'edit';

/** Permission grant record linking user to document with access level */
export interface DocumentPermission {
  id: string;
  document_id: string;
  user_id: string | null;
  email: string | null;
  permission_level: PermissionLevel;
  created_at: Date;
}

// Version types
/** Snapshot of document content at a specific version */
export interface DocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  content: DocumentContent;
  created_by: string | null;
  is_named: boolean;
  name: string | null;
  created_at: Date;
}

// Operation types for OT
/** Possible operation types in Operational Transformation */
export type OperationType = 'insert' | 'delete' | 'retain' | 'format';

/** Insert operation - adds text at a position */
export interface TextOperation {
  type: 'insert';
  position: number;
  text: string;
  attrs?: Record<string, unknown>;
}

/** Delete operation - removes characters at a position */
export interface DeleteOperation {
  type: 'delete';
  position: number;
  length: number;
}

/** Retain operation - skips over characters without modification */
export interface RetainOperation {
  type: 'retain';
  length: number;
}

/** Format operation - applies or removes text formatting */
export interface FormatOperation {
  type: 'format';
  position: number;
  length: number;
  mark: string;
  value: boolean | string;
}

/** Union type for all operation types */
export type Operation = TextOperation | DeleteOperation | RetainOperation | FormatOperation;

/** Persisted operation record for history and replay */
export interface OperationRecord {
  id: string;
  document_id: string;
  version_number: number;
  operation: Operation[];
  user_id: string | null;
  created_at: Date;
}

// Comment types
/** Comment or reply on a document, optionally anchored to text */
export interface Comment {
  id: string;
  document_id: string;
  parent_id: string | null;
  anchor_start: number | null;
  anchor_end: number | null;
  anchor_version: number | null;
  content: string;
  author_id: string;
  resolved: boolean;
  created_at: Date;
  updated_at: Date;
  author?: UserPublic;
  replies?: Comment[];
}

// Suggestion types
/** Types of edit suggestions */
export type SuggestionType = 'insert' | 'delete' | 'replace';

/** Status of a pending suggestion */
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

/** Proposed edit that can be accepted or rejected */
export interface Suggestion {
  id: string;
  document_id: string;
  suggestion_type: SuggestionType;
  anchor_start: number;
  anchor_end: number;
  anchor_version: number;
  original_text: string | null;
  suggested_text: string | null;
  author_id: string;
  status: SuggestionStatus;
  created_at: Date;
  updated_at: Date;
  author?: UserPublic;
}

// WebSocket message types
/** All possible WebSocket message types */
export type WSMessageType =
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'OPERATION'
  | 'ACK'
  | 'SYNC'
  | 'PRESENCE'
  | 'CURSOR'
  | 'ERROR'
  | 'COMMENT_ADD'
  | 'COMMENT_UPDATE'
  | 'COMMENT_DELETE';

/** WebSocket message payload for all real-time communication */
export interface WSMessage {
  type: WSMessageType;
  doc_id?: string;
  version?: number;
  operation?: Operation[];
  cursor?: CursorPosition;
  selection?: SelectionRange;
  error?: string;
  code?: string;
  data?: unknown;
}

/** Cursor position in the document */
export interface CursorPosition {
  position: number;
}

/** Text selection range */
export interface SelectionRange {
  start: number;
  end: number;
}

/** User presence information for real-time collaboration display */
export interface PresenceState {
  user_id: string;
  name: string;
  color: string;
  cursor: CursorPosition | null;
  selection: SelectionRange | null;
  last_active: number;
}

// API Response types
/** Standard API response wrapper */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Document with additional info
/** Document with permission level and owner info for API responses */
export interface DocumentWithPermission extends Document {
  permission_level: PermissionLevel;
  owner?: UserPublic;
}

/** Lightweight document representation for list views */
export interface DocumentListItem {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  owner_avatar_color: string;
  permission_level: PermissionLevel;
  updated_at: Date;
  created_at: Date;
}
