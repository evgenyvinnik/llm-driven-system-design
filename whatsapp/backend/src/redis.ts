import IORedis from 'ioredis';
import { config } from './config.js';

// IORedis is exported as default in the module
const Redis = IORedis.default || IORedis;

/**
 * Main Redis client for general operations.
 * Used for session storage, presence tracking, and caching.
 */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
});

/**
 * Redis subscriber client for pub/sub messaging.
 * Separate client required because Redis pub/sub mode prevents other operations.
 * Receives cross-server messages for distributed WebSocket delivery.
 */
export const redisSub = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

/**
 * Redis publisher client for pub/sub messaging.
 * Sends messages to other server instances for cross-server WebSocket delivery.
 */
export const redisPub = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err: Error) => {
  console.error('Redis error:', err);
});

/**
 * Redis key generators for consistent key naming across the application.
 * Centralizes key format to prevent naming collisions and enable easy debugging.
 */
export const KEYS = {
  /** Session key mapping user to their connected server */
  session: (userId: string) => `session:${userId}`,
  /** User presence information (online/offline status) */
  presence: (userId: string) => `presence:${userId}`,
  /** Typing indicator with auto-expiry */
  typing: (conversationId: string, userId: string) => `typing:${conversationId}:${userId}`,
  /** Pending messages queue for offline users */
  pending: (userId: string) => `pending:${userId}`,
  /** Pub/sub channel for cross-server message routing */
  serverChannel: (serverId: string) => `server:${serverId}`,
  /** Set of members in a group conversation for fast lookups */
  groupMembers: (groupId: string) => `group:${groupId}:members`,
};
