import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Main Redis client for general operations
export const redis = new Redis(redisUrl);

// Publisher client for pub/sub
export const publisher = new Redis(redisUrl);

// Create a new subscriber client (call this for each subscription)
export function createSubscriber(): Redis {
  return new Redis(redisUrl);
}

// Presence helpers
const PRESENCE_TTL = 60; // seconds

export async function setPresence(workspaceId: string, userId: string, status: 'online' | 'away'): Promise<void> {
  const key = `presence:${workspaceId}:${userId}`;
  const value = JSON.stringify({ status, lastSeen: Date.now() });
  await redis.setex(key, PRESENCE_TTL, value);
}

export async function getPresence(workspaceId: string, userId: string): Promise<{ status: string; lastSeen: number } | null> {
  const key = `presence:${workspaceId}:${userId}`;
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

export async function removePresence(workspaceId: string, userId: string): Promise<void> {
  const key = `presence:${workspaceId}:${userId}`;
  await redis.del(key);
}

export async function getOnlineUsers(workspaceId: string): Promise<string[]> {
  const keys = await redis.keys(`presence:${workspaceId}:*`);
  return keys.map(k => k.split(':')[2]);
}

// Pub/sub helpers
export async function publishToUser(userId: string, message: unknown): Promise<void> {
  await publisher.publish(`user:${userId}:messages`, JSON.stringify(message));
}

export async function publishToChannel(channelId: string, message: unknown): Promise<void> {
  await publisher.publish(`channel:${channelId}`, JSON.stringify(message));
}

// Typing indicator helpers
const TYPING_TTL = 5; // seconds

export async function setTyping(channelId: string, userId: string): Promise<void> {
  const key = `typing:${channelId}:${userId}`;
  await redis.setex(key, TYPING_TTL, '1');
}

export async function getTypingUsers(channelId: string): Promise<string[]> {
  const keys = await redis.keys(`typing:${channelId}:*`);
  return keys.map(k => k.split(':')[2]);
}
