/**
 * Type definitions for the Figma clone collaborative design platform.
 * These types define the core data structures for design objects, files,
 * real-time collaboration, and WebSocket communication.
 */

/**
 * Represents a design object on the canvas.
 * Supports basic shapes (rectangle, ellipse), text, frames, groups, and images.
 * Each object has position, dimensions, styling, and visibility properties.
 */
// Design object types
export interface DesignObject {
  id: string;
  type: 'rectangle' | 'ellipse' | 'text' | 'frame' | 'group' | 'image';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  parentId?: string;
  children?: string[];
  // Text-specific properties
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  textAlign?: 'left' | 'center' | 'right';
  // Image-specific properties
  imageUrl?: string;
}

/**
 * Represents a page within a design file.
 * Pages organize objects and maintain z-order through the objects array.
 */
export interface Page {
  id: string;
  name: string;
  objects: string[]; // Object IDs in z-order
}

/**
 * Contains the complete canvas state for a design file.
 * Stores all objects, pages, and the currently selected page.
 * Serialized as JSONB in PostgreSQL for efficient storage and querying.
 */
export interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
  selectedPage?: string;
}

/**
 * Represents a design file with metadata and canvas content.
 * The core entity for organizing collaborative design work.
 */
// File and version types
export interface DesignFile {
  id: string;
  name: string;
  project_id?: string;
  owner_id?: string;
  team_id?: string;
  thumbnail_url?: string;
  canvas_data: CanvasData;
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a saved version/snapshot of a design file.
 * Enables version history, restore functionality, and auto-save recovery.
 */
export interface FileVersion {
  id: string;
  file_id: string;
  version_number: number;
  name?: string;
  canvas_data: CanvasData;
  created_by?: string;
  created_at: Date;
  is_auto_save: boolean;
}

/**
 * Represents a user in the system.
 * Contains identity and role information for access control.
 */
// User and presence types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'user' | 'admin';
}

/**
 * Represents a collaborator's presence state in a file.
 * Tracks cursor position, selection, viewport, and activity for real-time collaboration.
 * Stored in Redis with TTL for automatic cleanup on disconnect.
 */
export interface PresenceState {
  userId: string;
  userName: string;
  userColor: string;
  cursor?: { x: number; y: number };
  selection: string[];
  viewport?: { x: number; y: number; zoom: number };
  lastActive: number;
}

/**
 * Represents a single edit operation for CRDT-based conflict resolution.
 * Operations are stored for history and can be replayed for synchronization.
 * Uses Lamport timestamps for causal ordering across distributed clients.
 */
// Operation types for CRDT
export interface Operation {
  id: string;
  fileId: string;
  userId: string;
  operationType: 'create' | 'update' | 'delete' | 'move';
  objectId: string;
  propertyPath?: string;
  oldValue?: unknown;
  newValue?: unknown;
  timestamp: number;
  clientId: string;
}

/**
 * Enumeration of WebSocket message types for the real-time protocol.
 * Defines the communication contract between clients and the server.
 */
// WebSocket message types
export type WSMessageType =
  | 'operation'
  | 'presence'
  | 'subscribe'
  | 'unsubscribe'
  | 'sync'
  | 'ack'
  | 'error';

/**
 * Generic WebSocket message structure for client-server communication.
 * All messages include a type and payload, with optional metadata.
 */
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  fileId?: string;
  userId?: string;
  timestamp?: number;
}

/**
 * Represents a comment on a design file.
 * Comments can be attached to specific objects or canvas positions.
 * Supports threaded replies through parent_id.
 */
// Comment types
export interface Comment {
  id: string;
  file_id: string;
  user_id: string;
  object_id?: string;
  position_x?: number;
  position_y?: number;
  content: string;
  parent_id?: string;
  resolved: boolean;
  created_at: Date;
  updated_at: Date;
}
