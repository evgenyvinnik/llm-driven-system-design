import { Router, Request, Response } from 'express';
import { pool, redis } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import { calculatePostScore } from '../services/fanout.js';

const router = Router();

const CELEBRITY_THRESHOLD = 10000;

// Get personalized feed
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string | undefined;

    // Step 1: Get pre-computed feed items from database
    let feedQuery = `
      SELECT fi.post_id, fi.score, fi.created_at as feed_created_at
      FROM feed_items fi
      WHERE fi.user_id = $1
    `;

    const feedParams: (string | number)[] = [userId];
    let paramIndex = 2;

    if (cursor) {
      feedQuery += ` AND fi.created_at < $${paramIndex++}`;
      feedParams.push(cursor);
    }

    feedQuery += ` ORDER BY fi.created_at DESC LIMIT $${paramIndex}`;
    feedParams.push(limit * 3); // Fetch more to allow for filtering and ranking

    const feedItemsResult = await pool.query(feedQuery, feedParams);
    const feedPostIds = feedItemsResult.rows.map((r: { post_id: string }) => r.post_id);

    // Step 2: Get celebrity posts (for users we follow who are celebrities)
    const celebrityPostIds: string[] = [];

    // Get celebrities the user follows
    const celebritiesResult = await pool.query(
      `SELECT u.id FROM users u
       JOIN friendships f ON f.following_id = u.id
       WHERE f.follower_id = $1 AND f.status = 'active'
       AND (u.is_celebrity = true OR u.follower_count >= $2)`,
      [userId, CELEBRITY_THRESHOLD]
    );

    for (const celeb of celebritiesResult.rows) {
      // Try Redis cache first
      const cachedPosts = await redis.zrevrange(
        `celebrity_posts:${celeb.id}`,
        0,
        9
      );

      if (cachedPosts.length > 0) {
        celebrityPostIds.push(...cachedPosts);
      } else {
        // Fallback to database
        const celebPostsResult = await pool.query(
          `SELECT id FROM posts
           WHERE author_id = $1 AND is_deleted = false
           ORDER BY created_at DESC
           LIMIT 10`,
          [celeb.id]
        );
        celebrityPostIds.push(...celebPostsResult.rows.map((r: { id: string }) => r.id));
      }
    }

    // Step 3: Merge and deduplicate post IDs
    const allPostIds = [...new Set([...feedPostIds, ...celebrityPostIds])];

    if (allPostIds.length === 0) {
      // No feed items, return empty or popular posts
      const popularResult = await pool.query(
        `SELECT p.*, u.id as author_id, u.username as author_username,
                u.display_name as author_display_name, u.avatar_url as author_avatar_url,
                u.is_celebrity as author_is_celebrity
         FROM posts p
         JOIN users u ON p.author_id = u.id
         WHERE p.is_deleted = false AND p.privacy = 'public'
         ORDER BY p.like_count DESC, p.created_at DESC
         LIMIT $1`,
        [limit]
      );

      const posts = popularResult.rows.map((p: {
        id: string;
        content: string;
        image_url: string | null;
        post_type: string;
        privacy: string;
        like_count: number;
        comment_count: number;
        share_count: number;
        created_at: Date;
        updated_at: Date;
        author_id: string;
        author_username: string;
        author_display_name: string;
        author_avatar_url: string | null;
        author_is_celebrity: boolean;
      }) => ({
        id: p.id,
        content: p.content,
        image_url: p.image_url,
        post_type: p.post_type,
        privacy: p.privacy,
        like_count: p.like_count,
        comment_count: p.comment_count,
        share_count: p.share_count,
        created_at: p.created_at,
        updated_at: p.updated_at,
        is_liked: false,
        author: {
          id: p.author_id,
          username: p.author_username,
          display_name: p.author_display_name,
          avatar_url: p.author_avatar_url,
          is_celebrity: p.author_is_celebrity,
        },
      }));

      res.json({
        posts,
        cursor: null,
        has_more: false,
      });
      return;
    }

    // Step 4: Fetch full post data
    const postsResult = await pool.query(
      `SELECT p.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url,
              u.is_celebrity as author_is_celebrity
       FROM posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.id = ANY($1) AND p.is_deleted = false`,
      [allPostIds]
    );

    // Step 5: Get affinity scores for ranking
    const authorIds = [...new Set(postsResult.rows.map((p: { author_id: string }) => p.author_id))];
    const affinityResult = await pool.query(
      `SELECT target_user_id, score FROM affinity_scores
       WHERE user_id = $1 AND target_user_id = ANY($2)`,
      [userId, authorIds]
    );

    const affinityMap = new Map<string, number>();
    for (const row of affinityResult.rows) {
      affinityMap.set(row.target_user_id, row.score);
    }

    // Step 6: Check which posts the user has liked
    const likesResult = await pool.query(
      `SELECT post_id FROM likes WHERE user_id = $1 AND post_id = ANY($2)`,
      [userId, allPostIds]
    );
    const likedPostIds = new Set(likesResult.rows.map((r: { post_id: string }) => r.post_id));

    // Step 7: Calculate scores and rank posts
    const scoredPosts = postsResult.rows.map((p: {
      id: string;
      content: string;
      image_url: string | null;
      post_type: string;
      privacy: string;
      like_count: number;
      comment_count: number;
      share_count: number;
      created_at: Date;
      updated_at: Date;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
      author_is_celebrity: boolean;
    }) => {
      const affinityScore = affinityMap.get(p.author_id) || 0;
      const score = calculatePostScore(
        {
          created_at: p.created_at,
          like_count: p.like_count,
          comment_count: p.comment_count,
          share_count: p.share_count,
        },
        affinityScore
      );

      return {
        id: p.id,
        content: p.content,
        image_url: p.image_url,
        post_type: p.post_type,
        privacy: p.privacy,
        like_count: p.like_count,
        comment_count: p.comment_count,
        share_count: p.share_count,
        created_at: p.created_at,
        updated_at: p.updated_at,
        is_liked: likedPostIds.has(p.id),
        author: {
          id: p.author_id,
          username: p.author_username,
          display_name: p.author_display_name,
          avatar_url: p.author_avatar_url,
          is_celebrity: p.author_is_celebrity,
        },
        _score: score,
      };
    });

    // Sort by score (ranking)
    scoredPosts.sort((a: { _score: number }, b: { _score: number }) => b._score - a._score);

    // Apply diversity: don't show more than 3 consecutive posts from same author
    const diversifiedPosts: typeof scoredPosts = [];
    const authorCounts = new Map<string, number>();
    const MAX_CONSECUTIVE = 3;

    for (const post of scoredPosts) {
      const authorId = post.author.id;
      const count = authorCounts.get(authorId) || 0;

      if (count < MAX_CONSECUTIVE) {
        diversifiedPosts.push(post);
        authorCounts.set(authorId, count + 1);
      }

      if (diversifiedPosts.length >= limit + 1) break;
    }

    // Step 8: Prepare response
    const resultPosts = diversifiedPosts.slice(0, limit).map(({ _score, ...post }) => post);
    const hasMore = diversifiedPosts.length > limit;
    const nextCursor = hasMore && resultPosts.length > 0
      ? resultPosts[resultPosts.length - 1].created_at
      : null;

    res.json({
      posts: resultPosts,
      cursor: nextCursor,
      has_more: hasMore,
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get trending/explore feed (public posts)
router.get('/explore', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    // Get popular public posts from the last 7 days
    const result = await pool.query(
      `SELECT p.*, u.id as author_id, u.username as author_username,
              u.display_name as author_display_name, u.avatar_url as author_avatar_url,
              u.is_celebrity as author_is_celebrity
       FROM posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.is_deleted = false
         AND p.privacy = 'public'
         AND p.created_at > NOW() - INTERVAL '7 days'
       ORDER BY (p.like_count + p.comment_count * 2 + p.share_count * 3) DESC, p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const posts = result.rows.map((p: {
      id: string;
      content: string;
      image_url: string | null;
      post_type: string;
      privacy: string;
      like_count: number;
      comment_count: number;
      share_count: number;
      created_at: Date;
      updated_at: Date;
      author_id: string;
      author_username: string;
      author_display_name: string;
      author_avatar_url: string | null;
      author_is_celebrity: boolean;
    }) => ({
      id: p.id,
      content: p.content,
      image_url: p.image_url,
      post_type: p.post_type,
      privacy: p.privacy,
      like_count: p.like_count,
      comment_count: p.comment_count,
      share_count: p.share_count,
      created_at: p.created_at,
      updated_at: p.updated_at,
      is_liked: false,
      author: {
        id: p.author_id,
        username: p.author_username,
        display_name: p.author_display_name,
        avatar_url: p.author_avatar_url,
        is_celebrity: p.author_is_celebrity,
      },
    }));

    res.json({
      posts,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    console.error('Get explore feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
