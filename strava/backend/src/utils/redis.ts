import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redisClient: Redis | null = null;

export function createClient(): Redis {
  if (redisClient) return redisClient;

  redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  redisClient.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });

  redisClient.on('connect', () => {
    console.log('Connected to Redis');
  });

  return redisClient;
}

export function getClient(): Redis {
  if (!redisClient) {
    return createClient();
  }
  return redisClient;
}

export interface LeaderboardResult {
  isPR: boolean;
  rank: number | null;
}

export interface LeaderboardEntry {
  userId: string;
  elapsedTime: number;
  rank: number;
}

export interface UserRankResult {
  rank: number;
  elapsedTime: number;
}

// Leaderboard operations
export async function updateLeaderboard(
  segmentId: string,
  userId: string,
  elapsedTime: number
): Promise<LeaderboardResult> {
  const client = getClient();
  const lbKey = `leaderboard:${segmentId}`;
  const prKey = `pr:${userId}:${segmentId}`;

  // Check if this is a personal record
  const currentPr = await client.get(prKey);

  if (currentPr === null || elapsedTime < parseInt(currentPr)) {
    // New PR
    await client.set(prKey, elapsedTime);
    // Update leaderboard (sorted set, lower time = better)
    await client.zadd(lbKey, elapsedTime, userId);

    // Get rank (0-indexed)
    const rank = await client.zrank(lbKey, userId);
    return { isPR: true, rank: rank !== null ? rank + 1 : null };
  }

  return { isPR: false, rank: null };
}

export async function getLeaderboard(segmentId: string, limit: number = 10): Promise<LeaderboardEntry[]> {
  const client = getClient();
  const lbKey = `leaderboard:${segmentId}`;

  // Get top performers (lowest times first)
  const results = await client.zrange(lbKey, 0, limit - 1, 'WITHSCORES');

  const leaderboard: LeaderboardEntry[] = [];
  for (let i = 0; i < results.length; i += 2) {
    leaderboard.push({
      userId: results[i],
      elapsedTime: parseInt(results[i + 1]),
      rank: Math.floor(i / 2) + 1
    });
  }

  return leaderboard;
}

export async function getUserRank(segmentId: string, userId: string): Promise<UserRankResult | null> {
  const client = getClient();
  const lbKey = `leaderboard:${segmentId}`;

  const rank = await client.zrank(lbKey, userId);
  if (rank === null) return null;

  const score = await client.zscore(lbKey, userId);
  return { rank: rank + 1, elapsedTime: parseInt(score || '0') };
}

// Feed operations
export async function addToFeed(followerId: string, activityId: string, timestamp: number): Promise<void> {
  const client = getClient();
  const feedKey = `feed:${followerId}`;

  await client.zadd(feedKey, timestamp, activityId);
  // Trim to keep last 1000 items
  await client.zremrangebyrank(feedKey, 0, -1001);
}

export async function getFeed(userId: string, limit: number = 20, before: number | null = null): Promise<string[]> {
  const client = getClient();
  const feedKey = `feed:${userId}`;

  let activityIds: string[];
  if (before) {
    activityIds = await client.zrevrangebyscore(
      feedKey,
      before,
      '-inf',
      'LIMIT', 0, limit
    );
  } else {
    activityIds = await client.zrevrange(feedKey, 0, limit - 1);
  }

  return activityIds;
}

export interface CachedUserData {
  id: string;
  username: string;
  email: string;
  profile_photo?: string;
  bio?: string;
  location?: string;
  role: string;
  [key: string]: unknown;
}

// Session cache
export async function cacheUser(userId: string, userData: CachedUserData, ttl: number = 1800): Promise<void> {
  const client = getClient();
  await client.setex(`user:${userId}`, ttl, JSON.stringify(userData));
}

export async function getCachedUser(userId: string): Promise<CachedUserData | null> {
  const client = getClient();
  const data = await client.get(`user:${userId}`);
  return data ? JSON.parse(data) : null;
}
