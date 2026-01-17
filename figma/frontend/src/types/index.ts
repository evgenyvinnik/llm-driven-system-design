/**
 * Type definitions for the Figma clone frontend application.
 * These types mirror the backend types and define the client-side data structures
 * for design objects, files, real-time collaboration, and WebSocket communication.
 */

/**
 * Represents a design object on the canvas.
 * Supports basic shapes (rectangle, ellipse), text, frames, groups, and images.
 * Each object has position, dimensions, styling, and visibility properties.
 */
// Design object types - matching backend
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
  objects: string[];
}

/**
 * Contains the complete canvas state for a design file.
 * Stores all objects, pages, and the currently selected page.
 */
export interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
  selectedPage?: string;
}

/**
 * Represents a design file with metadata and canvas content.
 * Includes active user count for real-time collaboration display.
 */
export interface DesignFile {
  id: string;
  name: string;
  project_id?: string;
  owner_id?: string;
  team_id?: string;
  thumbnail_url?: string;
  canvas_data: CanvasData;
  created_at: string;
  updated_at: string;
  activeUsers?: number;
}

/**
 * Represents a saved version/snapshot of a design file.
 * Used for version history display and restore functionality.
 */
export interface FileVersion {
  id: string;
  file_id: string;
  version_number: number;
  name?: string;
  canvas_data: CanvasData;
  created_by?: string;
  created_at: string;
  is_auto_save: boolean;
}

/**
 * Represents a collaborator's presence state in a file.
 * Tracks cursor position, selection, and viewport for real-time collaboration UI.
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
 * Sent to the server and broadcast to other clients.
 */
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
 */
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
 */
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  fileId?: string;
  userId?: string;
  timestamp?: number;
}

/**
 * Available tool types for the canvas editor.
 * Determines cursor behavior and interaction mode.
 */
export type Tool = 'select' | 'rectangle' | 'ellipse' | 'text' | 'hand';

/**
 * Represents the canvas viewport state.
 * Controls pan and zoom for navigating large designs.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
