export interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

export interface PixelEvent {
  x: number;
  y: number;
  color: number;
  userId: string;
  timestamp: number;
}

export interface CooldownStatus {
  canPlace: boolean;
  remainingSeconds: number;
  nextPlacement: number;
}

export interface CanvasConfig {
  width: number;
  height: number;
  colors: string[];
  cooldownSeconds: number;
}

export interface WebSocketMessage {
  type: 'canvas' | 'pixel' | 'pixels' | 'cooldown' | 'error' | 'connected' | 'pong';
  data?: unknown;
}
