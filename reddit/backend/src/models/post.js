import { query } from '../db/index.js';
import { calculateHotScore } from '../utils/ranking.js';

export const createPost = async (subredditId, authorId, title, content, url) => {
  const now = new Date();
  const hotScore = calculateHotScore(0, 0, now);

  const result = await query(
    `INSERT INTO posts (subreddit_id, author_id, title, content, url, hot_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [subredditId, authorId, title, content, url, hotScore]
  );
  return result.rows[0];
};

export const findPostById = async (id) => {
  const result = await query(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.id = $1`,
    [id]
  );
  return result.rows[0];
};

export const listPostsBySubreddit = async (subredditId, sort = 'hot', limit = 25, offset = 0) => {
  let orderBy;
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

  const result = await query(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     WHERE p.subreddit_id = $1
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [subredditId, limit, offset]
  );
  return result.rows;
};

export const listAllPosts = async (sort = 'hot', limit = 25, offset = 0) => {
  let orderBy;
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

  const result = await query(
    `SELECT p.*, u.username as author_username, s.name as subreddit_name
     FROM posts p
     LEFT JOIN users u ON p.author_id = u.id
     JOIN subreddits s ON p.subreddit_id = s.id
     ORDER BY ${orderBy}
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
};

export const listPostsByUser = async (userId, limit = 25, offset = 0) => {
  const result = await query(
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

export const updatePostScore = async (postId, upvotes, downvotes) => {
  const score = upvotes - downvotes;
  const post = await findPostById(postId);
  if (!post) return null;

  const hotScore = calculateHotScore(upvotes, downvotes, new Date(post.created_at));

  await query(
    `UPDATE posts SET upvotes = $1, downvotes = $2, score = $3, hot_score = $4 WHERE id = $5`,
    [upvotes, downvotes, score, hotScore, postId]
  );
};

export const deletePost = async (postId) => {
  await query(`DELETE FROM posts WHERE id = $1`, [postId]);
};
