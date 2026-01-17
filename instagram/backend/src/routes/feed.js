import { Router } from 'express';
import { query } from '../services/db.js';
import { timelineGet, cacheGet, cacheSet } from '../services/redis.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get home feed
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { cursor, limit = 20 } = req.query;
    const offset = cursor ? parseInt(cursor) : 0;

    // Get post IDs from Redis timeline cache
    const postIds = await timelineGet(userId, offset, parseInt(limit));

    if (postIds.length === 0) {
      // If no cached timeline, generate from database
      let queryText = `
        SELECT p.*, u.username, u.display_name, u.profile_picture_url
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id IN (
          SELECT following_id FROM follows WHERE follower_id = $1
          UNION
          SELECT $1
        )
      `;
      const params = [userId];

      queryText += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit) + 1);

      const result = await query(queryText, params);

      const hasMore = result.rows.length > limit;
      const posts = result.rows.slice(0, limit);

      // Get media for each post
      const postsWithMedia = await Promise.all(
        posts.map(async (post) => {
          const mediaResult = await query(
            'SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index',
            [post.id]
          );

          // Check if current user liked/saved
          const likeCheck = await query(
            'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
            [userId, post.id]
          );
          const savedCheck = await query(
            'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
            [userId, post.id]
          );

          return {
            id: post.id,
            userId: post.user_id,
            username: post.username,
            displayName: post.display_name,
            profilePictureUrl: post.profile_picture_url,
            caption: post.caption,
            location: post.location,
            likeCount: post.like_count,
            commentCount: post.comment_count,
            createdAt: post.created_at,
            isLiked: likeCheck.rows.length > 0,
            isSaved: savedCheck.rows.length > 0,
            media: mediaResult.rows.map((m) => ({
              id: m.id,
              mediaType: m.media_type,
              mediaUrl: m.media_url,
              thumbnailUrl: m.thumbnail_url,
              filterApplied: m.filter_applied,
              width: m.width,
              height: m.height,
              orderIndex: m.order_index,
            })),
          };
        })
      );

      return res.json({
        posts: postsWithMedia,
        nextCursor: hasMore ? offset + limit : null,
      });
    }

    // Fetch posts from database using cached IDs
    const postResult = await query(
      `SELECT p.*, u.username, u.display_name, u.profile_picture_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = ANY($1)`,
      [postIds]
    );

    // Order by the timeline order
    const postsMap = new Map(postResult.rows.map((p) => [p.id, p]));
    const orderedPosts = postIds.map((id) => postsMap.get(id)).filter(Boolean);

    // Get media and user-specific data for each post
    const postsWithMedia = await Promise.all(
      orderedPosts.map(async (post) => {
        const mediaResult = await query(
          'SELECT * FROM post_media WHERE post_id = $1 ORDER BY order_index',
          [post.id]
        );

        const likeCheck = await query(
          'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
          [userId, post.id]
        );
        const savedCheck = await query(
          'SELECT 1 FROM saved_posts WHERE user_id = $1 AND post_id = $2',
          [userId, post.id]
        );

        return {
          id: post.id,
          userId: post.user_id,
          username: post.username,
          displayName: post.display_name,
          profilePictureUrl: post.profile_picture_url,
          caption: post.caption,
          location: post.location,
          likeCount: post.like_count,
          commentCount: post.comment_count,
          createdAt: post.created_at,
          isLiked: likeCheck.rows.length > 0,
          isSaved: savedCheck.rows.length > 0,
          media: mediaResult.rows.map((m) => ({
            id: m.id,
            mediaType: m.media_type,
            mediaUrl: m.media_url,
            thumbnailUrl: m.thumbnail_url,
            filterApplied: m.filter_applied,
            width: m.width,
            height: m.height,
            orderIndex: m.order_index,
          })),
        };
      })
    );

    res.json({
      posts: postsWithMedia,
      nextCursor: postIds.length === limit ? offset + limit : null,
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Explore page - discover new content
router.get('/explore', optionalAuth, async (req, res) => {
  try {
    const userId = req.session?.userId;
    const { cursor, limit = 24 } = req.query;

    // Get popular posts (not from followed users)
    let queryText = `
      SELECT p.id, p.like_count, p.comment_count, p.created_at,
             (SELECT media_url FROM post_media WHERE post_id = p.id ORDER BY order_index LIMIT 1) as thumbnail,
             (SELECT COUNT(*) FROM post_media WHERE post_id = p.id) as media_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE u.is_private = false
    `;
    const params = [];

    // Exclude posts from users we already follow
    if (userId) {
      params.push(userId);
      queryText += ` AND p.user_id NOT IN (
        SELECT following_id FROM follows WHERE follower_id = $${params.length}
      ) AND p.user_id != $${params.length}`;
    }

    if (cursor) {
      params.push(cursor);
      queryText += ` AND p.created_at < $${params.length}`;
    }

    // Order by engagement score (simple: likes + comments) and recency
    queryText += ` ORDER BY (p.like_count + p.comment_count * 2) DESC, p.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) + 1);

    const result = await query(queryText, params);

    const hasMore = result.rows.length > limit;
    const posts = result.rows.slice(0, limit);

    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        thumbnail: p.thumbnail,
        likeCount: p.like_count,
        commentCount: p.comment_count,
        mediaCount: parseInt(p.media_count),
        createdAt: p.created_at,
      })),
      nextCursor: hasMore ? posts[posts.length - 1].created_at : null,
    });
  } catch (error) {
    console.error('Get explore error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
