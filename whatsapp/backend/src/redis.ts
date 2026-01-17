import Redis from 'ioredis';
import { config } from './config.js';

// Main Redis client for general operations
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
});

// Subscriber client for pub/sub (cannot use same client for both)
export const redisSub = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

// Publisher client for pub/sub
export const redisPub = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

// Session/Presence keys
export const KEYS = {
  session: (userId: string) => `session:${userId}`,
  presence: (userId: string) => `presence:${userId}`,
  typing: (conversationId: string, userId: string) => `typing:${conversationId}:${userId}`,
  pending: (userId: string) => `pending:${userId}`,
  serverChannel: (serverId: string) => `server:${serverId}`,
  groupMembers: (groupId: string) => `group:${groupId}:members`,
};
