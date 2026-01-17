/**
 * @fileoverview Type definitions for the Notion-like collaborative editing system.
 * These types define the core data structures used across the backend for pages,
 * blocks, databases, workspaces, and real-time collaboration features.
 */

/**
 * Supported block types in the editor.
 * Each type determines how the block is rendered and what interactions are available.
 */
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

/**
 * Text styling annotations for rich text content.
 * Allows inline formatting within text segments.
 */
export interface Annotation {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
}

/**
 * A segment of rich text content with optional formatting and links.
 * Multiple RichText segments combine to form block content.
 */
export interface RichText {
  text: string;
  annotations?: Annotation;
  link?: string;
}

/**
 * The fundamental unit of content in a page.
 * Blocks form a tree structure where each block can have children.
 * Uses fractional indexing for position to enable O(1) insertions.
 */
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

/**
 * A page within a workspace that can contain blocks or act as a database.
 * Pages form a hierarchical structure via parent_id for nested organization.
 */
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

/**
 * Supported property types for database columns.
 * Each type has specific rendering and validation behavior.
 */
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

/**
 * An option choice for select and multi_select property types.
 * Used in database columns that offer predefined choices.
 */
export interface PropertyOption {
  id: string;
  name: string;
  color: string;
}

/**
 * Defines the structure of a database column/property.
 * The schema determines what data can be stored and how it's displayed.
 */
export interface PropertySchema {
  id: string;
  name: string;
  type: PropertyType;
  options?: PropertyOption[];
}

/**
 * A saved view configuration for a database.
 * Views determine how data is displayed (table, board, list, etc.) and
 * include filters, sorts, and column visibility settings.
 */
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

/**
 * A filter condition applied to database views.
 * Used to show only rows matching specific criteria.
 */
export interface Filter {
  property: string;
  operator: string;
  value: unknown;
}

/**
 * Sort configuration for database views.
 * Determines the order in which rows are displayed.
 */
export interface Sort {
  property: string;
  direction: 'asc' | 'desc';
}

/**
 * Controls visibility and sizing of properties in database views.
 * Allows users to customize which columns are shown.
 */
export interface PropertyVisibility {
  property: string;
  visible: boolean;
  width?: number;
}

/**
 * A single row/entry in a database.
 * Property values are stored as a key-value map matching the database schema.
 */
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

/**
 * A workspace container that groups users and their pages.
 * Workspaces provide the top-level organizational unit for collaboration.
 */
export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * An authenticated user in the system.
 * Users can belong to multiple workspaces and have roles for access control.
 */
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

/**
 * An active user session stored in Redis.
 * Sessions enable stateless authentication across requests.
 */
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

/**
 * Operation types for CRDT-based real-time synchronization.
 * Each operation type is commutative to ensure consistency.
 */
export type OperationType = 'insert' | 'update' | 'delete' | 'move';

/**
 * A single operation in the collaborative editing system.
 * Operations are logged for syncing and conflict resolution via CRDT.
 */
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

/**
 * WebSocket message envelope for real-time communication.
 * All WebSocket messages follow this structure with type-specific payloads.
 */
export interface WSMessage {
  type: 'subscribe' | 'unsubscribe' | 'operation' | 'presence' | 'ack' | 'error' | 'sync';
  payload: unknown;
}

/**
 * User presence information for real-time collaboration.
 * Shows who is viewing a page and their cursor position.
 */
export interface Presence {
  user_id: string;
  user_name: string;
  page_id: string;
  cursor_position?: { block_id: string; offset: number };
  last_seen: number;
}
