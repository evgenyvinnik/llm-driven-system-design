// Block types
export type BlockType =
  | 'text'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list'
  | 'numbered_list'
  | 'toggle'
  | 'code'
  | 'quote'
  | 'callout'
  | 'divider'
  | 'image'
  | 'video'
  | 'embed'
  | 'table'
  | 'database';

// Rich text annotation
export interface Annotation {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
}

// Rich text segment
export interface RichText {
  text: string;
  annotations?: Annotation;
  link?: string;
}

// Block structure
export interface Block {
  id: string;
  page_id: string;
  parent_block_id: string | null;
  type: BlockType;
  properties: Record<string, unknown>;
  content: RichText[];
  position: string;
  version: number;
  is_collapsed: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// Page structure
export interface Page {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  cover_image: string | null;
  is_database: boolean;
  properties_schema: PropertySchema[];
  position: string;
  is_archived: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// Property types for databases
export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'relation';

// Property option (for select types)
export interface PropertyOption {
  id: string;
  name: string;
  color: string;
}

// Property schema definition
export interface PropertySchema {
  id: string;
  name: string;
  type: PropertyType;
  options?: PropertyOption[];
}

// Database view
export interface DatabaseView {
  id: string;
  page_id: string;
  name: string;
  type: 'table' | 'board' | 'list' | 'calendar' | 'gallery';
  filter: Filter[];
  sort: Sort[];
  group_by: string | null;
  properties_visibility: PropertyVisibility[];
  position: string;
  created_at: Date;
  updated_at: Date;
}

// Filter definition
export interface Filter {
  property: string;
  operator: string;
  value: unknown;
}

// Sort definition
export interface Sort {
  property: string;
  direction: 'asc' | 'desc';
}

// Property visibility
export interface PropertyVisibility {
  property: string;
  visible: boolean;
  width?: number;
}

// Database row
export interface DatabaseRow {
  id: string;
  database_id: string;
  properties: Record<string, unknown>;
  position: string;
  is_archived: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// Workspace
export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// User
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

// Session
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// Operation types for CRDT sync
export type OperationType = 'insert' | 'update' | 'delete' | 'move';

// Operation structure
export interface Operation {
  id: string;
  page_id: string;
  block_id: string;
  type: OperationType;
  data: Record<string, unknown>;
  timestamp: number;
  author_id: string | null;
  created_at: Date;
}

// WebSocket message types
export interface WSMessage {
  type: 'subscribe' | 'unsubscribe' | 'operation' | 'presence' | 'ack' | 'error' | 'sync';
  payload: unknown;
}

// Presence data
export interface Presence {
  user_id: string;
  user_name: string;
  page_id: string;
  cursor_position?: { block_id: string; offset: number };
  last_seen: number;
}
