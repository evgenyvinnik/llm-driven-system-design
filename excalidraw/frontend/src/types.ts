export type Tool = 'select' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'freehand' | 'text';

export interface Point {
  x: number;
  y: number;
}

export interface ExcalidrawElement {
  id: string;
  type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'freehand' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Point[];
  text?: string;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  opacity: number;
  fontSize?: number;
  version: number;
  isDeleted: boolean;
  createdBy: string;
  updatedAt: number;
}

export interface Cursor {
  /** Per-connection ID: two tabs of one account are two cursors. */
  clientId: string;
  userId: string;
  username: string;
  x: number;
  y: number;
  color: string;
}

export interface ViewState {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Drawing {
  id: string;
  title: string;
  ownerId: string;
  ownerUsername?: string;
  ownerDisplayName?: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  isPublic: boolean;
  permission?: string;
  elementCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Collaborator {
  userId: string;
  username: string;
  displayName: string;
  permission: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}
