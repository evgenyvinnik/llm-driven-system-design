/**
 * @fileoverview Redis client configuration and session/presence management.
 * Redis is used for session storage (enabling stateless auth) and real-time
 * presence tracking (showing who is viewing each page).
 */

import Redis from 'ioredis';

/**
 * Redis client instance for the application.
 * Includes automatic retry logic with exponential backoff.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) {
      console.error('Redis connection failed after 3 retries');
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

/** Key prefix for session tokens in Redis */
export const SESSION_PREFIX = 'session:';

/** Session TTL in seconds (7 days) */
export const SESSION_TTL = 60 * 60 * 24 * 7;

/** Key prefix for presence data in Redis */
export const PRESENCE_PREFIX = 'presence:';

/** Presence TTL in seconds (1 minute, refreshed on activity) */
export const PRESENCE_TTL = 60;

/**
 * Stores a session token with associated user ID in Redis.
 * Used during login/registration to create authenticated sessions.
 * @param token - The unique session token
 * @param userId - The ID of the authenticated user
 */
export async function setSession(token: string, userId: string): Promise<void> {
  await redis.setex(`${SESSION_PREFIX}${token}`, SESSION_TTL, userId);
}

/**
 * Retrieves the user ID associated with a session token.
 * Returns null if the session has expired or doesn't exist.
 * @param token - The session token to look up
 * @returns The user ID if session is valid, null otherwise
 */
export async function getSession(token: string): Promise<string | null> {
  return redis.get(`${SESSION_PREFIX}${token}`);
}

/**
 * Removes a session token from Redis, effectively logging out the user.
 * @param token - The session token to invalidate
 */
export async function deleteSession(token: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${token}`);
}

/**
 * Updates presence data for a user viewing a specific page.
 * Presence data is stored in a hash map keyed by page ID.
 * @param pageId - The page being viewed
 * @param userId - The user viewing the page
 * @param data - JSON string containing presence information
 */
export async function setPresence(pageId: string, userId: string, data: string): Promise<void> {
  await redis.hset(`${PRESENCE_PREFIX}${pageId}`, userId, data);
  await redis.expire(`${PRESENCE_PREFIX}${pageId}`, PRESENCE_TTL);
}

/**
 * Gets all presence data for users viewing a specific page.
 * @param pageId - The page to get presence data for
 * @returns A map of userId to JSON presence data strings
 */
export async function getPresence(pageId: string): Promise<Record<string, string>> {
  return redis.hgetall(`${PRESENCE_PREFIX}${pageId}`);
}

/**
 * Removes a user's presence from a page (when they navigate away).
 * @param pageId - The page the user was viewing
 * @param userId - The user who left
 */
export async function removePresence(pageId: string, userId: string): Promise<void> {
  await redis.hdel(`${PRESENCE_PREFIX}${pageId}`, userId);
}

export default redis;
