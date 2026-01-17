/**
 * @fileoverview Redis service for caching, pub/sub, and presence tracking.
 * Provides separate clients for general operations, publishing, and subscribing.
 * Handles user presence with TTL-based automatic cleanup and typing indicators.
 */

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Main Redis client for general cache and key-value operations.
 */
export const redis = new Redis(redisUrl);

/**
 * Dedicated Redis client for publishing messages to channels.
 * Separated from the main client to avoid blocking during pub/sub operations.
 */
export const publisher = new Redis(redisUrl);

/**
 * Creates a new Redis subscriber client for receiving pub/sub messages.
 * Each WebSocket connection should create its own subscriber instance.
 * @returns New Redis client configured for subscription operations
 */
export function createSubscriber(): Redis {
  return new Redis(redisUrl);
}

/** TTL in seconds for presence keys - users marked offline after this period without activity */
const PRESENCE_TTL = 60;

/**
 * Sets a user's presence status in Redis with automatic expiration.
 * The key will expire after PRESENCE_TTL seconds, marking the user offline.
 * @param workspaceId - The workspace the user is active in
 * @param userId - The user's unique identifier
 * @param status - Current presence status ('online' or 'away')
 */
export async function setPresence(workspaceId: string, userId: string, status: 'online' | 'away'): Promise<void> {
  const key = `presence:${workspaceId}:${userId}`;
  const value = JSON.stringify({ status, lastSeen: Date.now() });
  await redis.setex(key, PRESENCE_TTL, value);
}

/**
 * Retrieves a user's current presence status from Redis.
 * @param workspaceId - The workspace to check presence in
 * @param userId - The user's unique identifier
 * @returns Presence object with status and lastSeen timestamp, or null if not found
 */
export async function getPresence(workspaceId: string, userId: string): Promise<{ status: string; lastSeen: number } | null> {
  const key = `presence:${workspaceId}:${userId}`;
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

/**
 * Removes a user's presence key from Redis.
 * Called when a user disconnects to immediately mark them offline.
 * @param workspaceId - The workspace the user was active in
 * @param userId - The user's unique identifier
 */
export async function removePresence(workspaceId: string, userId: string): Promise<void> {
  const key = `presence:${workspaceId}:${userId}`;
  await redis.del(key);
}

/**
 * Gets a list of all online user IDs in a workspace.
 * Scans for presence keys and extracts user IDs from the key pattern.
 * @param workspaceId - The workspace to check for online users
 * @returns Array of user IDs currently showing as online
 */
export async function getOnlineUsers(workspaceId: string): Promise<string[]> {
  const keys = await redis.keys(`presence:${workspaceId}:*`);
  return keys.map(k => k.split(':')[2]);
}

/**
 * Publishes a message to a user's personal channel for WebSocket delivery.
 * Used for sending real-time updates to specific users.
 * @param userId - The target user's unique identifier
 * @param message - The message payload to send (will be JSON stringified)
 */
export async function publishToUser(userId: string, message: unknown): Promise<void> {
  await publisher.publish(`user:${userId}:messages`, JSON.stringify(message));
}

/**
 * Publishes a message to a channel's pub/sub channel.
 * Not currently used - messages are published to individual users instead.
 * @param channelId - The target channel's unique identifier
 * @param message - The message payload to send (will be JSON stringified)
 */
export async function publishToChannel(channelId: string, message: unknown): Promise<void> {
  await publisher.publish(`channel:${channelId}`, JSON.stringify(message));
}

/** TTL in seconds for typing indicator keys */
const TYPING_TTL = 5;

/**
 * Sets a typing indicator for a user in a channel.
 * The indicator automatically expires after TYPING_TTL seconds.
 * @param channelId - The channel where the user is typing
 * @param userId - The user's unique identifier
 */
export async function setTyping(channelId: string, userId: string): Promise<void> {
  const key = `typing:${channelId}:${userId}`;
  await redis.setex(key, TYPING_TTL, '1');
}

/**
 * Gets a list of user IDs currently typing in a channel.
 * Scans for typing keys and extracts user IDs from the key pattern.
 * @param channelId - The channel to check for typing users
 * @returns Array of user IDs currently typing
 */
export async function getTypingUsers(channelId: string): Promise<string[]> {
  const keys = await redis.keys(`typing:${channelId}:*`);
  return keys.map(k => k.split(':')[2]);
}
