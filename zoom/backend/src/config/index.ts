import dotenv from 'dotenv';
dotenv.config();

function intFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Application configuration loaded from environment variables with sensible defaults. */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Browser origins allowed to call the API and to open the signaling socket.
  // The socket authenticates by session cookie, so an unchecked Origin would let
  // any page the user visits open a socket as them (cross-site WebSocket hijacking).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'zoom',
    password: process.env.DB_PASSWORD || 'zoom123',
    database: process.env.DB_NAME || 'zoom',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  session: {
    secret: process.env.SESSION_SECRET || 'zoom-session-secret-dev-only',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },

  rateLimit: {
    apiPerWindow: intFromEnv('API_RATE_LIMIT', 100),
    authFailuresPerWindow: intFromEnv('AUTH_RATE_LIMIT', 20),
  },

  ws: {
    // A participant whose socket drops keeps their seat (and role) this long, so a
    // reconnect resumes silently instead of flashing "left / joined" to everyone.
    reconnectGraceMs: intFromEnv('RECONNECT_GRACE_MS', 10_000),
    // Once the last participant is gone, the meeting ends after this long.
    emptyMeetingGraceMs: intFromEnv('EMPTY_MEETING_GRACE_MS', 30_000),
    // Ping interval; a socket that misses one pong is terminated. Without this a
    // closed laptop lid is only noticed when TCP gives up, minutes later.
    heartbeatIntervalMs: intFromEnv('WS_HEARTBEAT_MS', 30_000),
    maxPayloadBytes: 64 * 1024,
  },
};
