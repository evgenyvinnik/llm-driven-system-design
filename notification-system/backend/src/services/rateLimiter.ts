import { redis, incrementCounter, getCounter } from '../utils/redis.js';

interface RateLimitConfig {
  count: number;
  window: number;
}

interface RateLimits {
  user: Record<string, RateLimitConfig>;
  global: Record<string, RateLimitConfig>;
}

export interface RateLimitResult {
  limited: boolean;
  reason?: string;
  channel?: string;
  limit?: number;
  current?: number;
  retryAfter?: number;
}

export interface ChannelUsage {
  used: number;
  limit: number;
  remaining: number;
}

export type UsageByChannel = Record<string, ChannelUsage>;

const LIMITS: RateLimits = {
  // Per-user limits (per hour)
  user: {
    push: { count: 50, window: 3600 },
    email: { count: 10, window: 3600 },
    sms: { count: 5, window: 3600 },
  },
  // Global limits (per minute) - protect downstream services
  global: {
    push: { count: 100000, window: 60 },
    email: { count: 10000, window: 60 },
    sms: { count: 1000, window: 60 },
  },
};

export class RateLimiter {
  async checkLimit(userId: string, channels: string[]): Promise<RateLimitResult> {
    for (const channel of channels) {
      // Check user limit
      const userResult = await this.checkUserLimit(userId, channel);
      if (userResult.limited) {
        return userResult;
      }

      // Check global limit
      const globalResult = await this.checkGlobalLimit(channel);
      if (globalResult.limited) {
        return globalResult;
      }
    }

    return { limited: false };
  }

  async checkUserLimit(userId: string, channel: string): Promise<RateLimitResult> {
    const limit = LIMITS.user[channel];
    if (!limit) return { limited: false };

    const key = `ratelimit:user:${userId}:${channel}`;
    const count = await incrementCounter(key, limit.window);

    if (count > limit.count) {
      return {
        limited: true,
        reason: 'user_limit',
        channel,
        limit: limit.count,
        current: count,
        retryAfter: await this.getTTL(key),
      };
    }

    return { limited: false };
  }

  async checkGlobalLimit(channel: string): Promise<RateLimitResult> {
    const limit = LIMITS.global[channel];
    if (!limit) return { limited: false };

    const key = `ratelimit:global:${channel}`;
    const count = await incrementCounter(key, limit.window);

    if (count > limit.count) {
      return {
        limited: true,
        reason: 'global_limit',
        channel,
        limit: limit.count,
        current: count,
        retryAfter: await this.getTTL(key),
      };
    }

    return { limited: false };
  }

  async getUsage(userId: string): Promise<UsageByChannel> {
    const channels = ['push', 'email', 'sms'];
    const usage: UsageByChannel = {};

    for (const channel of channels) {
      const count = await getCounter(`ratelimit:user:${userId}:${channel}`);
      const limit = LIMITS.user[channel]?.count || 0;
      usage[channel] = {
        used: count,
        limit,
        remaining: Math.max(0, limit - count),
      };
    }

    return usage;
  }

  async getTTL(key: string): Promise<number> {
    return redis.ttl(key);
  }

  async resetUserLimit(userId: string, channel: string | null = null): Promise<void> {
    if (channel) {
      await redis.del(`ratelimit:user:${userId}:${channel}`);
    } else {
      const channels = ['push', 'email', 'sms'];
      for (const ch of channels) {
        await redis.del(`ratelimit:user:${userId}:${ch}`);
      }
    }
  }

  getLimits(): RateLimits {
    return LIMITS;
  }
}

export const rateLimiter = new RateLimiter();
