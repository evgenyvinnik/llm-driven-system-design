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

export interface Page {
  id: string;
  name: string;
  objects: string[];
}

export interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
  selectedPage?: string;
}

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

export interface PresenceState {
  userId: string;
  userName: string;
  userColor: string;
  cursor?: { x: number; y: number };
  selection: string[];
  viewport?: { x: number; y: number; zoom: number };
  lastActive: number;
}

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

export type Tool = 'select' | 'rectangle' | 'ellipse' | 'text' | 'hand';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
