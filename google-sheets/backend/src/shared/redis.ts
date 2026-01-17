import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Primary Redis client for general operations (caching, session storage).
 * Used for publishing messages to Redis pub/sub channels.
 */
export const redis = new Redis.default(redisUrl);

/**
 * Dedicated Redis client for pub/sub subscriptions.
 * Requires a separate connection because Redis clients in subscribe mode
 * cannot execute regular commands.
 */
export const redisSub = new Redis.default(redisUrl);

redis.on('error', (err: Error) => {
  console.error('Redis error:', err);
});

redisSub.on('error', (err: Error) => {
  console.error('Redis subscriber error:', err);
});

/**
 * Retrieves a session from Redis by session ID.
 * Sessions are used to maintain user authentication state across requests.
 *
 * @param sessionId - The unique identifier for the session
 * @returns The session data object if found, null otherwise
 */
export async function getSession(sessionId: string) {
  const data = await redis.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

/**
 * Stores a session in Redis with an optional TTL.
 * Creates or updates the session data for the given session ID.
 *
 * @param sessionId - The unique identifier for the session
 * @param data - The session data object to store
 * @param ttlSeconds - Time-to-live in seconds (default: 86400 = 24 hours)
 */
export async function setSession(sessionId: string, data: object, ttlSeconds = 86400) {
  await redis.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
}

/**
 * Deletes a session from Redis.
 * Called during logout or session invalidation.
 *
 * @param sessionId - The unique identifier for the session to delete
 */
export async function deleteSession(sessionId: string) {
  await redis.del(`session:${sessionId}`);
}

/**
 * Publishes a message to a spreadsheet-specific Redis channel.
 * Enables real-time collaboration by broadcasting changes to all server instances.
 * Each server instance subscribes to relevant channels to relay updates to connected clients.
 *
 * @param spreadsheetId - The unique identifier of the spreadsheet
 * @param message - The message object to broadcast (will be JSON-stringified)
 */
export function publishToSpreadsheet(spreadsheetId: string, message: object) {
  redis.publish(`spreadsheet:${spreadsheetId}`, JSON.stringify(message));
}

/**
 * Subscribes to a spreadsheet-specific Redis channel.
 * Used for receiving real-time updates from other server instances in a multi-server deployment.
 * The callback is invoked for each message received on the channel.
 *
 * @param spreadsheetId - The unique identifier of the spreadsheet to subscribe to
 * @param callback - Function called when a message is received on the channel
 */
export function subscribeToSpreadsheet(spreadsheetId: string, callback: (message: object) => void) {
  redisSub.subscribe(`spreadsheet:${spreadsheetId}`);
  redisSub.on('message', (channel: string, message: string) => {
    if (channel === `spreadsheet:${spreadsheetId}`) {
      try {
        callback(JSON.parse(message));
      } catch (e) {
        console.error('Failed to parse pub/sub message:', e);
      }
    }
  });
}

/**
 * Unsubscribes from a spreadsheet-specific Redis channel.
 * Should be called when no clients are connected to a particular spreadsheet
 * to avoid unnecessary message processing.
 *
 * @param spreadsheetId - The unique identifier of the spreadsheet to unsubscribe from
 */
export function unsubscribeFromSpreadsheet(spreadsheetId: string) {
  redisSub.unsubscribe(`spreadsheet:${spreadsheetId}`);
}
