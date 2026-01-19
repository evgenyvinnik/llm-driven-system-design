import { query } from '../db/index.js';
import { calculateHotScore } from '../utils/ranking.js';
import logger from '../shared/logger.js';
import { postCreatedTotal } from '../shared/metrics.js';

export interface Post {
  id: number;
  subreddit_id: number;
  author_id: number;
  title: string;
  content: string | null;
  url: string | null;
  upvotes: number;
  downvotes: number;
  score: number;
  hot_score: number;
  comment_count: number;
  is_archived: boolean | null;
  archived_at: Date | null;
  created_at: Date;
  author_username?: string;
  subreddit_name?: string;
  userVote?: number;
}

export type SortOption = 'hot' | 'new' | 'top' | 'controversial';

export const createPost = async (
  subredditId: number,
  authorId: number,
  title: string,
  content: string | null,
  url: string | null
): Promise<Post> => {
  const now = new Date();
  const hotScore = calculateHotScore(0, 0, now);

  const result = await query<Post>(
    `INSERT INTO posts (subreddit_id, author_id, title, content, url, hot_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [subredditId, authorId, title, content, url, hotScore]
  );

  const post = result.rows[0];

  // Get subreddit name for metric label
  const subredditResult = await query<{ name: string }>(
    `SELECT name FROM subreddits WHERE id = $1`,
    [subredditId]
  );
  const subredditName = subredditResult.rows[0]?.name || 'unknown';

  // Record metric
  postCreatedTotal.inc({ subreddit: subredditName });

  logger.info({
    postId: post.id,
    subredditId,
    authorId,
  }, 'Post created');

  return post;
};

export const findPostById = async (id: number): Promise<Post | undefined> => {
  const result = await query<Post>(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.id = $1`,
    [id]
  );
  return result.rows[0];
};

export const listPostsBySubreddit = async (
  subredditId: number,
  sort: SortOption = 'hot',
  limit: number = 25,
  offset: number = 0
): Promise<Post[]> => {
  let orderBy: string;
  switch (sort) {
    case 'new':
      orderBy = 'p.created_at DESC';
      break;
    case 'top':
      orderBy = 'p.score DESC, p.created_at DESC';
      break;
    case 'controversial':
      orderBy = `(CASE WHEN p.upvotes = 0 OR p.downvotes = 0 THEN 0
                      ELSE (p.upvotes + p.downvotes) * (LEAST(p.upvotes, p.downvotes)::float / GREATEST(p.upvotes, p.downvotes))
                 END) DESC, p.created_at DESC`;
      break;
    case 'hot':
    default:
      orderBy = 'p.hot_score DESC, p.created_at DESC';
      break;
  }

  const result = await query<Post>(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.subreddit_id = $1 AND (p.is_archived IS NULL OR p.is_archived = FALSE)
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [subredditId, limit, offset]
  );
  return result.rows;
};

export const listAllPosts = async (
  sort: SortOption = 'hot',
  limit: number = 25,
  offset: number = 0
): Promise<Post[]> => {
  let orderBy: string;
  switch (sort) {
    case 'new':
      orderBy = 'p.created_at DESC';
      break;
    case 'top':
      orderBy = 'p.score DESC, p.created_at DESC';
      break;
    case 'controversial':
      orderBy = `(CASE WHEN p.upvotes = 0 OR p.downvotes = 0 THEN 0
                      ELSE (p.upvotes + p.downvotes) * (LEAST(p.upvotes, p.downvotes)::float / GREATEST(p.upvotes, p.downvotes))
                 END) DESC, p.created_at DESC`;
      break;
    case 'hot':
    default:
      orderBy = 'p.hot_score DESC, p.created_at DESC';
      break;
  }

  const result = await query<Post>(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.is_archived IS NULL OR p.is_archived = FALSE
     ORDER BY ${orderBy}
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
};

export const listPostsByUser = async (userId: number, limit: number = 25, offset: number = 0): Promise<Post[]> => {
  const result = await query<Post>(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.author_id = $1
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
};

export const updatePostScore = async (postId: number, upvotes: number, downvotes: number): Promise<void> => {
  const score = upvotes - downvotes;
  const post = await findPostById(postId);
  if (!post) return;

  const hotScore = calculateHotScore(upvotes, downvotes, new Date(post.created_at));

  await query(
    `UPDATE posts SET upvotes = $1, downvotes = $2, score = $3, hot_score = $4 WHERE id = $5`,
    [upvotes, downvotes, score, hotScore, postId]
  );
};

export const deletePost = async (postId: number): Promise<void> => {
  await query(`DELETE FROM posts WHERE id = $1`, [postId]);
  logger.info({ postId }, 'Post deleted');
};

/**
 * Archive old posts based on retention policy.
 * Called by archival worker.
 */
export const archivePosts = async (cutoffDate: Date): Promise<number | null> => {
  const result = await query<{ id: number }>(
    `UPDATE posts
     SET is_archived = TRUE, archived_at = NOW()
     WHERE created_at < $1
       AND (is_archived IS NULL OR is_archived = FALSE)
     RETURNING id`,
    [cutoffDate]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info({
      count: result.rowCount,
      cutoffDate,
    }, 'Posts archived');
  }

  return result.rowCount;
};

/**
 * Get posts to be archived for export.
 */
export const getPostsForArchival = async (cutoffDate: Date, limit: number = 1000): Promise<Post[]> => {
  const result = await query<Post>(
    `SELECT * FROM posts
     WHERE created_at < $1
       AND (is_archived IS NULL OR is_archived = FALSE)
     ORDER BY created_at
     LIMIT $2`,
    [cutoffDate, limit]
  );
  return result.rows;
};
