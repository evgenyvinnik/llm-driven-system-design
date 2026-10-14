import { redis, getCounter } from '../utils/redis.js';

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

/**
 * Checks every counter first and increments them only if none would exceed its
 * limit, in one Lua call. Fixed windows: EXPIRE is set on the first increment
 * (and repaired for any legacy key left without a TTL), atomically with INCR.
 *
 * KEYS: counter keys. ARGV: limit and window seconds for each key, in pairs.
 * Returns {0} when admitted, or {index, current, ttl} for the first full key.
 */
const ADMIT_ALL_OR_NOTHING = `
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[(i - 1) * 2 + 1])
  local current = tonumber(redis.call('GET', key) or '0')
  if current + 1 > limit then
    return {i, current, redis.call('TTL', key)}
  end
end
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  local value = redis.call('INCR', key)
  if value == 1 or redis.call('TTL', key) == -1 then
    redis.call('EXPIRE', key, window)
  end
end
return {0}
`;

interface CounterSpec {
  key: string;
  limit: number;
  window: number;
  reason: 'user_limit' | 'global_limit';
  channel: string;
}

/** Enforces per-user and global rate limits across push, email, and SMS channels. */
export class RateLimiter {
  /**
   * Admits a send on all `channels` or on none. The old version incremented
   * counters one channel at a time, so a request rejected on email had already
   * spent the user's push budget, and a crash between INCR and EXPIRE left a
   * counter with no TTL that rate-limited the user forever.
   */
  async checkLimit(userId: string, channels: string[]): Promise<RateLimitResult> {
    const specs: CounterSpec[] = [];
    for (const channel of new Set(channels)) {
      const user = LIMITS.user[channel];
      const global = LIMITS.global[channel];
      if (user) {
        specs.push({ key: `ratelimit:user:${userId}:${channel}`, limit: user.count, window: user.window, reason: 'user_limit', channel });
      }
      if (global) {
        specs.push({ key: `ratelimit:global:${channel}`, limit: global.count, window: global.window, reason: 'global_limit', channel });
      }
    }
    if (specs.length === 0) {
      return { limited: false };
    }

    const args = specs.flatMap((spec) => [String(spec.limit), String(spec.window)]);
    const reply = (await redis.eval(
      ADMIT_ALL_OR_NOTHING,
      specs.length,
      ...specs.map((spec) => spec.key),
      ...args
    )) as number[];

    const index = Number(reply[0]);
    if (index === 0) {
      return { limited: false };
    }

    const spec = specs[index - 1];
    const ttl = Number(reply[2]);
    return {
      limited: true,
      reason: spec.reason,
      channel: spec.channel,
      limit: spec.limit,
      current: Number(reply[1]),
      retryAfter: ttl > 0 ? ttl : spec.window,
    };
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
