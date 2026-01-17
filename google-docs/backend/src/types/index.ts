// User types
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

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  avatar_color: string;
  role: 'user' | 'admin';
}

// Session types
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// Document types
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

export interface DocumentContent {
  type: 'doc';
  content: DocumentNode[];
}

export interface DocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
  text?: string;
  marks?: Mark[];
}

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

// Permission types
export type PermissionLevel = 'view' | 'comment' | 'edit';

export interface DocumentPermission {
  id: string;
  document_id: string;
  user_id: string | null;
  email: string | null;
  permission_level: PermissionLevel;
  created_at: Date;
}

// Version types
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
export type OperationType = 'insert' | 'delete' | 'retain' | 'format';

export interface TextOperation {
  type: 'insert';
  position: number;
  text: string;
  attrs?: Record<string, unknown>;
}

export interface DeleteOperation {
  type: 'delete';
  position: number;
  length: number;
}

export interface RetainOperation {
  type: 'retain';
  length: number;
}

export interface FormatOperation {
  type: 'format';
  position: number;
  length: number;
  mark: string;
  value: boolean | string;
}

export type Operation = TextOperation | DeleteOperation | RetainOperation | FormatOperation;

export interface OperationRecord {
  id: string;
  document_id: string;
  version_number: number;
  operation: Operation[];
  user_id: string | null;
  created_at: Date;
}

// Comment types
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
export type SuggestionType = 'insert' | 'delete' | 'replace';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

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

export interface CursorPosition {
  position: number;
}

export interface SelectionRange {
  start: number;
  end: number;
}

export interface PresenceState {
  user_id: string;
  name: string;
  color: string;
  cursor: CursorPosition | null;
  selection: SelectionRange | null;
  last_active: number;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Document with additional info
export interface DocumentWithPermission extends Document {
  permission_level: PermissionLevel;
  owner?: UserPublic;
}

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
