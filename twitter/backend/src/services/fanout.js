import pool from '../db/pool.js';
import redis from '../db/redis.js';
import dotenv from 'dotenv';

dotenv.config();

const CELEBRITY_THRESHOLD = parseInt(process.env.CELEBRITY_THRESHOLD) || 10000;
const TIMELINE_CACHE_SIZE = parseInt(process.env.TIMELINE_CACHE_SIZE) || 800;

/**
 * Fanout a tweet to followers' timelines using hybrid push/pull strategy
 * - For normal users (< CELEBRITY_THRESHOLD followers): Push to all follower timelines
 * - For celebrities: Skip push, will be pulled at read time
 */
export async function fanoutTweet(tweetId, authorId) {
  try {
    // Check if author is a celebrity
    const authorResult = await pool.query(
      'SELECT is_celebrity, follower_count FROM users WHERE id = $1',
      [authorId]
    );

    if (authorResult.rows.length === 0) {
      console.error(`Author ${authorId} not found for fanout`);
      return;
    }

    const { is_celebrity: isCelebrity, follower_count: followerCount } = authorResult.rows[0];

    // Skip fanout for celebrities (they will be pulled at read time)
    if (isCelebrity) {
      console.log(`Skipping fanout for celebrity ${authorId} with ${followerCount} followers`);
      return;
    }

    // Get all followers
    const followersResult = await pool.query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [authorId]
    );

    const followers = followersResult.rows.map(r => r.follower_id);

    if (followers.length === 0) {
      console.log(`No followers to fanout tweet ${tweetId} from user ${authorId}`);
      return;
    }

    console.log(`Fanning out tweet ${tweetId} to ${followers.length} followers`);

    // Use Redis pipeline for efficient bulk writes
    const pipeline = redis.pipeline();

    for (const followerId of followers) {
      const timelineKey = `timeline:${followerId}`;
      // Push tweet ID to the front of the follower's timeline
      pipeline.lpush(timelineKey, tweetId.toString());
      // Trim to keep only the most recent tweets
      pipeline.ltrim(timelineKey, 0, TIMELINE_CACHE_SIZE - 1);
    }

    // Also add to author's own timeline
    const authorTimelineKey = `timeline:${authorId}`;
    pipeline.lpush(authorTimelineKey, tweetId.toString());
    pipeline.ltrim(authorTimelineKey, 0, TIMELINE_CACHE_SIZE - 1);

    await pipeline.exec();

    console.log(`Fanout complete for tweet ${tweetId}`);
  } catch (error) {
    console.error(`Fanout failed for tweet ${tweetId}:`, error);
    // In production, this would go to a retry queue
  }
}

/**
 * Get list of celebrity users that a user follows
 */
export async function getFollowedCelebrities(userId) {
  const result = await pool.query(
    `SELECT u.id FROM users u
     JOIN follows f ON f.following_id = u.id
     WHERE f.follower_id = $1 AND u.is_celebrity = true`,
    [userId]
  );
  return result.rows.map(r => r.id);
}

/**
 * Remove a tweet from all timelines (for deletion)
 * Note: This is expensive at scale - in production, we'd use lazy deletion
 */
export async function removeTweetFromTimelines(tweetId, authorId) {
  try {
    // Get all followers
    const followersResult = await pool.query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [authorId]
    );

    const followers = followersResult.rows.map(r => r.follower_id);

    const pipeline = redis.pipeline();

    for (const followerId of followers) {
      pipeline.lrem(`timeline:${followerId}`, 0, tweetId.toString());
    }

    // Also remove from author's timeline
    pipeline.lrem(`timeline:${authorId}`, 0, tweetId.toString());

    await pipeline.exec();
  } catch (error) {
    console.error(`Failed to remove tweet ${tweetId} from timelines:`, error);
  }
}
