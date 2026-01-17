import { createClient, type RedisClientType } from 'redis';
import type { ClientInfo, CursorPosition, SelectionRange } from '../types/index.js';

// Redis client for presence and real-time data
let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });

    await redisClient.connect();
  }
  return redisClient;
}

export const presence = {
  /**
   * Add a client to a document's presence list
   */
  async addClient(documentId: string, client: ClientInfo): Promise<void> {
    const redis = await getRedisClient();
    const key = `presence:${documentId}`;
    await redis.hSet(key, client.clientId, JSON.stringify(client));
    await redis.expire(key, 3600); // 1 hour TTL
  },

  /**
   * Remove a client from a document's presence list
   */
  async removeClient(documentId: string, clientId: string): Promise<void> {
    const redis = await getRedisClient();
    const key = `presence:${documentId}`;
    await redis.hDel(key, clientId);
  },

  /**
   * Get all clients present in a document
   */
  async getClients(documentId: string): Promise<Map<string, ClientInfo>> {
    const redis = await getRedisClient();
    const key = `presence:${documentId}`;
    const data = await redis.hGetAll(key);

    const clients = new Map<string, ClientInfo>();
    for (const [clientId, clientJson] of Object.entries(data)) {
      try {
        clients.set(clientId, JSON.parse(clientJson));
      } catch {
        // Skip invalid entries
      }
    }
    return clients;
  },

  /**
   * Update a client's cursor position
   */
  async updateCursor(
    documentId: string,
    clientId: string,
    cursor: CursorPosition
  ): Promise<void> {
    const redis = await getRedisClient();
    const key = `presence:${documentId}`;
    const clientJson = await redis.hGet(key, clientId);

    if (clientJson) {
      const client: ClientInfo = JSON.parse(clientJson);
      client.cursor = cursor;
      await redis.hSet(key, clientId, JSON.stringify(client));
    }
  },

  /**
   * Update a client's selection
   */
  async updateSelection(
    documentId: string,
    clientId: string,
    selection: SelectionRange | null
  ): Promise<void> {
    const redis = await getRedisClient();
    const key = `presence:${documentId}`;
    const clientJson = await redis.hGet(key, clientId);

    if (clientJson) {
      const client: ClientInfo = JSON.parse(clientJson);
      client.selection = selection;
      await redis.hSet(key, clientId, JSON.stringify(client));
    }
  },

  /**
   * Clear all presence data for a document (useful for cleanup)
   */
  async clearDocument(documentId: string): Promise<void> {
    const redis = await getRedisClient();
    await redis.del(`presence:${documentId}`);
  },
};

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
