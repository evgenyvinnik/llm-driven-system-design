import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Redis client connected');
});

// Cache helper functions
export const cache = {
  // Get cached value
  async get(key) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  },

  // Set cached value with TTL (default 1 hour)
  async set(key, value, ttlSeconds = 3600) {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  },

  // Delete cached value
  async del(key) {
    await redis.del(key);
  },

  // Delete multiple keys by pattern
  async delPattern(pattern) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  },

  // Increment a counter
  async incr(key) {
    return await redis.incr(key);
  },

  // Get or set cached value
  async getOrSet(key, fetchFn, ttlSeconds = 3600) {
    const cached = await this.get(key);
    if (cached) return cached;

    const value = await fetchFn();
    await this.set(key, value, ttlSeconds);
    return value;
  }
};

// Session management
export const sessions = {
  async create(userId, token, ttlSeconds = 86400 * 7) {
    await redis.setex(`session:${token}`, ttlSeconds, JSON.stringify({ userId }));
  },

  async get(token) {
    const session = await redis.get(`session:${token}`);
    return session ? JSON.parse(session) : null;
  },

  async destroy(token) {
    await redis.del(`session:${token}`);
  },

  async destroyAllForUser(userId) {
    const keys = await redis.keys(`session:*`);
    for (const key of keys) {
      const session = await redis.get(key);
      if (session) {
        const parsed = JSON.parse(session);
        if (parsed.userId === userId) {
          await redis.del(key);
        }
      }
    }
  }
};
