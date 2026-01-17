import redis, { redisPub, redisSub } from '../db/redis.js';
import type { PresenceState } from '../types/index.js';

// Presence data TTL (30 seconds)
const PRESENCE_TTL = 30;

// Random colors for user cursors
const CURSOR_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#84CC16', '#22C55E',
  '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6',
  '#A855F7', '#D946EF', '#EC4899', '#F43F5E',
];

export class PresenceService {
  private subscribers = new Map<string, Set<(presence: PresenceState[]) => void>>();

  constructor() {
    this.setupSubscriber();
  }

  private setupSubscriber() {
    redisSub.on('message', async (channel, message) => {
      if (channel.startsWith('presence:')) {
        const fileId = channel.replace('presence:', '');
        const callbacks = this.subscribers.get(fileId);
        if (callbacks && callbacks.size > 0) {
          const presence = await this.getFilePresence(fileId);
          callbacks.forEach(cb => cb(presence));
        }
      }
    });
  }

  // Get a color for a user
  getColorForUser(userId: string): string {
    // Use hash of userId to get consistent color
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash) + userId.charCodeAt(i);
      hash = hash & hash;
    }
    return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
  }

  // Update presence for a user in a file
  async updatePresence(fileId: string, presence: PresenceState): Promise<void> {
    const key = `presence:${fileId}:${presence.userId}`;
    await redis.setex(key, PRESENCE_TTL, JSON.stringify(presence));

    // Publish update
    await redisPub.publish(`presence:${fileId}`, JSON.stringify(presence));
  }

  // Remove presence for a user
  async removePresence(fileId: string, userId: string): Promise<void> {
    const key = `presence:${fileId}:${userId}`;
    await redis.del(key);

    // Publish removal
    await redisPub.publish(`presence:${fileId}`, JSON.stringify({ userId, removed: true }));
  }

  // Get all presence data for a file
  async getFilePresence(fileId: string): Promise<PresenceState[]> {
    const pattern = `presence:${fileId}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length === 0) return [];

    const values = await redis.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v) as PresenceState);
  }

  // Subscribe to presence updates for a file
  subscribeToFile(fileId: string, callback: (presence: PresenceState[]) => void): () => void {
    if (!this.subscribers.has(fileId)) {
      this.subscribers.set(fileId, new Set());
      redisSub.subscribe(`presence:${fileId}`);
    }

    this.subscribers.get(fileId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscribers.get(fileId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscribers.delete(fileId);
          redisSub.unsubscribe(`presence:${fileId}`);
        }
      }
    };
  }

  // Touch presence to keep it alive
  async touchPresence(fileId: string, userId: string): Promise<void> {
    const key = `presence:${fileId}:${userId}`;
    const exists = await redis.exists(key);
    if (exists) {
      await redis.expire(key, PRESENCE_TTL);
    }
  }
}

export const presenceService = new PresenceService();
