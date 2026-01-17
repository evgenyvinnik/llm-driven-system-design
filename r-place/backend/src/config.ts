/**
 * Canvas configuration constants.
 * Defines the dimensions of the collaborative pixel canvas.
 */

/** Width of the canvas in pixels. */
export const CANVAS_WIDTH = 500;

/** Height of the canvas in pixels. */
export const CANVAS_HEIGHT = 500;

/** Total number of pixels in the canvas (width * height). */
export const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;

/**
 * Rate limiting configuration.
 * Controls how often users can place pixels to prevent abuse.
 */

/** Cooldown period in seconds between pixel placements per user. */
export const COOLDOWN_SECONDS = 30; // 30 seconds for dev, 300 for production

/**
 * Color palette for the canvas.
 * 16 colors matching the original r/place palette.
 * Each color is represented as a hex string, indexed 0-15.
 */
export const COLOR_PALETTE = [
  '#FFFFFF', // 0 - White
  '#E4E4E4', // 1 - Light Gray
  '#888888', // 2 - Gray
  '#222222', // 3 - Dark Gray/Black
  '#FFA7D1', // 4 - Pink
  '#E50000', // 5 - Red
  '#E59500', // 6 - Orange
  '#A06A42', // 7 - Brown
  '#E5D900', // 8 - Yellow
  '#94E044', // 9 - Light Green
  '#02BE01', // 10 - Green
  '#00D3DD', // 11 - Cyan
  '#0083C7', // 12 - Blue
  '#0000EA', // 13 - Dark Blue
  '#CF6EE4', // 14 - Light Purple
  '#820080', // 15 - Purple
];

/** Array of valid color indices (0 through palette length - 1). */
export const VALID_COLORS = Array.from({ length: COLOR_PALETTE.length }, (_, i) => i);

/**
 * Redis key patterns for data storage.
 * Centralizes all Redis key definitions to avoid magic strings.
 */
export const REDIS_KEYS = {
  /** Key for storing the current canvas state as a byte array. */
  CANVAS: 'canvas:current',
  /**
   * Generates a cooldown key for a specific user.
   * @param userId - The unique identifier of the user.
   * @returns The Redis key for the user's cooldown status.
   */
  COOLDOWN: (userId: string) => `cooldown:${userId}`,
  /** Pub/sub channel for broadcasting pixel updates across server instances. */
  PIXEL_CHANNEL: 'pixel_updates',
};

/** Interval in milliseconds between automatic canvas snapshots for timelapse generation. */
export const SNAPSHOT_INTERVAL_MS = 60000; // 1 minute
