import { query } from '../config/database.js';
import { getCache, setCache, cacheKeys } from '../config/redis.js';

interface VisibilitySet {
  fingerprints: string[];
  userId: string;
  friendIds: string[];
  updatedAt: string;
}

// Get user's visibility fingerprints - what posts they can see
export async function getUserVisibilitySet(userId: string): Promise<VisibilitySet> {
  // Try cache first
  const cached = await getCache<VisibilitySet>(cacheKeys.userVisibility(userId));
  if (cached) {
    return cached;
  }

  // Compute visibility set
  const fingerprints: string[] = [];

  // Everyone can see public posts
  fingerprints.push('PUBLIC');

  // Can see own private posts
  fingerprints.push(`PRIVATE:${userId}`);

  // Can see friends' posts (friends visibility)
  fingerprints.push(`FRIENDS:${userId}`);

  // Get all accepted friends
  interface FriendRow {
    friend_id: string;
  }

  const friends = await query<FriendRow>(
    `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
    [userId]
  );

  const friendIds = friends.map((f) => f.friend_id);

  // Can see friends' friends-only posts
  for (const friendId of friendIds) {
    fingerprints.push(`FRIENDS:${friendId}`);
  }

  const visibilitySet: VisibilitySet = {
    fingerprints,
    userId,
    friendIds,
    updatedAt: new Date().toISOString(),
  };

  // Cache for 5 minutes (visibility can change when friendships change)
  await setCache(cacheKeys.userVisibility(userId), visibilitySet, 300);

  return visibilitySet;
}

// Invalidate user's visibility cache (call when friendships change)
export async function invalidateVisibilityCache(userId: string): Promise<void> {
  const { deleteCache } = await import('../config/redis.js');
  await deleteCache(cacheKeys.userVisibility(userId));
}

// Get friend IDs for a user
export async function getUserFriendIds(userId: string): Promise<string[]> {
  interface FriendRow {
    friend_id: string;
  }

  const friends = await query<FriendRow>(
    `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
    [userId]
  );

  return friends.map((f) => f.friend_id);
}

// Check if two users are friends
export async function areUsersFriends(userId1: string, userId2: string): Promise<boolean> {
  interface CountRow {
    count: string;
  }

  const result = await query<CountRow>(
    `SELECT COUNT(*) as count FROM friendships
     WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'`,
    [userId1, userId2]
  );

  return parseInt(result[0].count, 10) > 0;
}
