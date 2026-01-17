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

export interface Page {
  id: string;
  name: string;
  objects: string[]; // Object IDs in z-order
}

export interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
  selectedPage?: string;
}

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

// User and presence types
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  role: 'user' | 'admin';
}

export interface PresenceState {
  userId: string;
  userName: string;
  userColor: string;
  cursor?: { x: number; y: number };
  selection: string[];
  viewport?: { x: number; y: number; zoom: number };
  lastActive: number;
}

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

// WebSocket message types
export type WSMessageType =
  | 'operation'
  | 'presence'
  | 'subscribe'
  | 'unsubscribe'
  | 'sync'
  | 'ack'
  | 'error';

export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  fileId?: string;
  userId?: string;
  timestamp?: number;
}

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
