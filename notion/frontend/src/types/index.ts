/**
 * @fileoverview Type definitions for the Notion-like frontend application.
 * Mirrors backend types but with string dates (as received from JSON API).
 */

/**
 * Supported block types in the editor.
 * Each type has specific rendering and interaction behavior.
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
 * Applied inline to text segments.
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
 * A segment of rich text with optional formatting and links.
 * Multiple segments combine to form block content.
 */
export interface RichText {
  text: string;
  annotations?: Annotation;
  link?: string;
}

/**
 * The fundamental content unit in a page.
 * Blocks form a tree and use fractional indexing for ordering.
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
  created_at: string;
  updated_at: string;
}

/**
 * A page within a workspace.
 * Can contain blocks or act as a database with structured data.
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
  created_at: string;
  updated_at: string;
}

/**
 * Supported property types for database columns.
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
 * An option for select and multi_select property types.
 */
export interface PropertyOption {
  id: string;
  name: string;
  color: string;
}

/**
 * Defines a database column's structure and type.
 */
export interface PropertySchema {
  id: string;
  name: string;
  type: PropertyType;
  options?: PropertyOption[];
}

/**
 * A saved view configuration for a database.
 * Controls how data is displayed (table, board, list, etc.).
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
  created_at: string;
  updated_at: string;
}

/**
 * A filter condition for database views.
 */
export interface Filter {
  property: string;
  operator: string;
  value: unknown;
}

/**
 * A sort configuration for database views.
 */
export interface Sort {
  property: string;
  direction: 'asc' | 'desc';
}

/**
 * Controls column visibility and width in database views.
 */
export interface PropertyVisibility {
  property: string;
  visible: boolean;
  width?: number;
}

/**
 * A row entry in a database.
 */
export interface DatabaseRow {
  id: string;
  database_id: string;
  properties: Record<string, unknown>;
  position: string;
  is_archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A workspace containing pages and members.
 */
export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * An authenticated user.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

/**
 * Real-time presence data showing who is viewing a page.
 */
export interface Presence {
  user_id: string;
  user_name: string;
  page_id: string;
  cursor_position?: { block_id: string; offset: number };
  last_seen: number;
}

/**
 * WebSocket message envelope for real-time communication.
 */
export interface WSMessage {
  type: string;
  payload: unknown;
}

/**
 * A single editing operation for real-time sync.
 */
export interface Operation {
  id: string;
  page_id: string;
  block_id: string;
  type: 'insert' | 'update' | 'delete' | 'move';
  data: Record<string, unknown>;
  timestamp: number;
  author_id: string | null;
}
