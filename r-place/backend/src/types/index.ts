/**
 * Represents a single pixel placement event.
 * Used for real-time updates and historical logging.
 */
export interface PixelEvent {
  /** X coordinate on the canvas (0-indexed from left). */
  x: number;
  /** Y coordinate on the canvas (0-indexed from top). */
  y: number;
  /** Color index from the palette (0-15). */
  color: number;
  /** Unique identifier of the user who placed the pixel. */
  userId: string;
  /** Unix timestamp in milliseconds when the pixel was placed. */
  timestamp: number;
}

/**
 * Represents an authenticated user in the system.
 */
export interface User {
  /** Unique user identifier (UUID). */
  id: string;
  /** Display name chosen by the user. */
  username: string;
  /** User role determining permissions. */
  role: 'user' | 'admin';
}

/**
 * Represents an active user session.
 * Sessions are stored in PostgreSQL and validated on each request.
 */
export interface Session {
  /** Unique session identifier (UUID). */
  id: string;
  /** Reference to the user who owns this session. */
  userId: string;
  /** Timestamp when the session expires. */
  expiresAt: Date;
}

/**
 * Represents a point-in-time snapshot of the canvas.
 * Used for timelapse generation and disaster recovery.
 */
export interface CanvasSnapshot {
  /** Auto-incrementing snapshot identifier. */
  id: number;
  /** Timestamp when the snapshot was captured. */
  capturedAt: Date;
  /** Gzip-compressed canvas data as a binary buffer. */
  canvasData: Buffer;
  /** Total number of pixel events at the time of snapshot. */
  pixelCount: number;
}

/**
 * Represents a user's cooldown status for pixel placement.
 */
export interface CooldownStatus {
  /** Whether the user is allowed to place a pixel now. */
  canPlace: boolean;
  /** Seconds remaining until the user can place another pixel. */
  remainingSeconds: number;
}

/**
 * Generic WebSocket message structure for client-server communication.
 */
export interface WebSocketMessage {
  /** Message type indicating the kind of data being sent. */
  type: 'canvas' | 'pixel' | 'pixels' | 'cooldown' | 'error' | 'connected';
  /** Payload data, structure depends on the message type. */
  data?: unknown;
}

/**
 * Request body for placing a pixel on the canvas.
 */
export interface PlacePixelRequest {
  /** X coordinate where the pixel should be placed. */
  x: number;
  /** Y coordinate where the pixel should be placed. */
  y: number;
  /** Color index from the palette to use. */
  color: number;
}

/**
 * Response from the pixel placement API.
 */
export interface PlacePixelResponse {
  /** Whether the pixel was successfully placed. */
  success: boolean;
  /** Unix timestamp when the user can place another pixel. */
  nextPlacement?: number;
  /** Error message if the placement failed. */
  error?: string;
}
