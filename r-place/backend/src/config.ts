// Canvas configuration
export const CANVAS_WIDTH = 500;
export const CANVAS_HEIGHT = 500;
export const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT;

// Rate limiting (in seconds)
export const COOLDOWN_SECONDS = 30; // 30 seconds for dev, 300 for production

// Color palette (16 colors like original r/place)
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

export const VALID_COLORS = Array.from({ length: COLOR_PALETTE.length }, (_, i) => i);

// Redis keys
export const REDIS_KEYS = {
  CANVAS: 'canvas:current',
  COOLDOWN: (userId: string) => `cooldown:${userId}`,
  PIXEL_CHANNEL: 'pixel_updates',
};

// Snapshot interval (in milliseconds)
export const SNAPSHOT_INTERVAL_MS = 60000; // 1 minute
