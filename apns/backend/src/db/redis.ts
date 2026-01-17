import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redis.on("connect", () => {
  console.log("Connected to Redis");
});

// Rate limiting
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }

  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
  };
}

// Device connection tracking
export async function setDeviceConnected(
  deviceId: string,
  serverId: string
): Promise<void> {
  await redis.hset("device:connections", deviceId, serverId);
  await redis.expire("device:connections", 3600); // 1 hour TTL
}

export async function getDeviceServer(deviceId: string): Promise<string | null> {
  return redis.hget("device:connections", deviceId);
}

export async function removeDeviceConnection(deviceId: string): Promise<void> {
  await redis.hdel("device:connections", deviceId);
}

// Pub/Sub for notification delivery across servers
export async function publishNotification(
  channel: string,
  message: unknown
): Promise<void> {
  await redis.publish(channel, JSON.stringify(message));
}

export function subscribeToNotifications(
  channel: string,
  callback: (message: unknown) => void
): Redis {
  const subscriber = redis.duplicate();
  subscriber.subscribe(channel);
  subscriber.on("message", (ch, message) => {
    if (ch === channel) {
      try {
        callback(JSON.parse(message));
      } catch (error) {
        console.error("Failed to parse notification message:", error);
      }
    }
  });
  return subscriber;
}

// Session management
export async function setSession(
  token: string,
  data: unknown,
  ttlSeconds: number
): Promise<void> {
  await redis.setex(`session:${token}`, ttlSeconds, JSON.stringify(data));
}

export async function getSession<T>(token: string): Promise<T | null> {
  const data = await redis.get(`session:${token}`);
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}

// Priority queues for notifications
export async function enqueueNotification(
  priority: number,
  notification: unknown
): Promise<void> {
  const queue = `notification:queue:${priority}`;
  await redis.lpush(queue, JSON.stringify(notification));
}

export async function dequeueNotification(
  priority: number
): Promise<unknown | null> {
  const queue = `notification:queue:${priority}`;
  const data = await redis.rpop(queue);
  if (!data) return null;
  return JSON.parse(data);
}

// Stats tracking
export async function incrementStat(key: string): Promise<void> {
  await redis.incr(`stats:${key}`);
}

export async function getStat(key: string): Promise<number> {
  const value = await redis.get(`stats:${key}`);
  return value ? parseInt(value, 10) : 0;
}

export async function checkConnection(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error("Redis connection failed:", error);
    return false;
  }
}

export default redis;
