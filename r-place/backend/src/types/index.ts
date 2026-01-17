export interface PixelEvent {
  x: number;
  y: number;
  color: number;
  userId: string;
  timestamp: number;
}

export interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface CanvasSnapshot {
  id: number;
  capturedAt: Date;
  canvasData: Buffer;
  pixelCount: number;
}

export interface CooldownStatus {
  canPlace: boolean;
  remainingSeconds: number;
}

export interface WebSocketMessage {
  type: 'canvas' | 'pixel' | 'pixels' | 'cooldown' | 'error' | 'connected';
  data?: unknown;
}

export interface PlacePixelRequest {
  x: number;
  y: number;
  color: number;
}

export interface PlacePixelResponse {
  success: boolean;
  nextPlacement?: number;
  error?: string;
}
