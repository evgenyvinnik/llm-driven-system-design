/**
 * Type definitions for the Google Docs clone frontend.
 * Mirrors backend types but with string dates (from JSON serialization).
 */

// User types
/** User data received from API (excludes sensitive fields like password_hash) */
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_color: string;
  role: 'user' | 'admin';
}

// Document types
/** Main document entity with ProseMirror content */
export interface Document {
  id: string;
  title: string;
  owner_id: string;
  current_version: number;
  content: DocumentContent;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  permission_level?: PermissionLevel;
  owner?: User;
}

/** ProseMirror document content structure */
export interface DocumentContent {
  type: 'doc';
  content: DocumentNode[];
}

/** A node in the ProseMirror document tree */
export interface DocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
  text?: string;
  marks?: Mark[];
}

/** Text formatting mark (bold, italic, etc.) */
export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

// Permission types
/** Access levels for document permissions */
export type PermissionLevel = 'view' | 'comment' | 'edit';

/** Permission grant record for document sharing */
export interface DocumentPermission {
  id: string;
  document_id: string;
  user_id: string | null;
  email: string | null;
  permission_level: PermissionLevel;
  name?: string;
  avatar_color?: string;
}

// Document list item
/** Lightweight document representation for list views */
export interface DocumentListItem {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  owner_avatar_color: string;
  permission_level: PermissionLevel;
  updated_at: string;
  created_at: string;
}

// Version types
/** Document version snapshot for history */
export interface DocumentVersion {
  id: string;
  version_number: number;
  is_named: boolean;
  name: string | null;
  created_at: string;
  created_by_name?: string;
  avatar_color?: string;
  content?: DocumentContent;
}

// Comment types
/** Comment or reply on a document */
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
  created_at: string;
  updated_at: string;
  author?: User;
  replies?: Comment[];
}

// Suggestion types
/** Types of edit suggestions */
export type SuggestionType = 'insert' | 'delete' | 'replace';

/** Status of a suggestion */
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
  created_at: string;
  updated_at: string;
  author?: User;
}

// Presence types
/** User presence information for real-time collaboration */
export interface PresenceState {
  user_id: string;
  name: string;
  color: string;
  cursor: { position: number } | null;
  selection: { start: number; end: number } | null;
  last_active?: number;
}

// WebSocket message types
/** All possible WebSocket message types */
export type WSMessageType =
  | 'CONNECTED'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'OPERATION'
  | 'ACK'
  | 'SYNC'
  | 'PRESENCE'
  | 'CURSOR'
  | 'ERROR';

/** WebSocket message payload for real-time communication */
export interface WSMessage {
  type: WSMessageType;
  doc_id?: string;
  version?: number;
  operation?: Operation[];
  cursor?: { position: number };
  selection?: { start: number; end: number };
  error?: string;
  code?: string;
  data?: unknown;
}

// Operation types
/** OT operation union type for insert, delete, retain, and format */
export type Operation =
  | { type: 'insert'; position: number; text: string; attrs?: Record<string, unknown> }
  | { type: 'delete'; position: number; length: number }
  | { type: 'retain'; length: number }
  | { type: 'format'; position: number; length: number; mark: string; value: boolean | string };

// API Response types
/** Standard API response wrapper for all endpoints */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
