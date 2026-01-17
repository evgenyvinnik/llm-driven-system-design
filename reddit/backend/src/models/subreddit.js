import { query } from '../db/index.js';

export const createSubreddit = async (name, title, description, createdBy) => {
  const result = await query(
    `INSERT INTO subreddits (name, title, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name.toLowerCase(), title, description, createdBy]
  );
  return result.rows[0];
};

export const findSubredditByName = async (name) => {
  const result = await query(
    `SELECT s.*, u.username as creator_username
     FROM subreddits s
     LEFT JOIN users u ON s.created_by = u.id
     WHERE s.name = $1`,
    [name.toLowerCase()]
  );
  return result.rows[0];
};

export const findSubredditById = async (id) => {
  const result = await query(
    `SELECT s.*, u.username as creator_username
     FROM subreddits s
     LEFT JOIN users u ON s.created_by = u.id
     WHERE s.id = $1`,
    [id]
  );
  return result.rows[0];
};

export const listSubreddits = async (limit = 25, offset = 0) => {
  const result = await query(
    `SELECT s.*, u.username as creator_username
     FROM subreddits s
     LEFT JOIN users u ON s.created_by = u.id
     ORDER BY s.subscriber_count DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
};

export const searchSubreddits = async (searchQuery, limit = 25) => {
  const result = await query(
    `SELECT s.*, u.username as creator_username
     FROM subreddits s
     LEFT JOIN users u ON s.created_by = u.id
     WHERE s.name ILIKE $1 OR s.title ILIKE $1 OR s.description ILIKE $1
     ORDER BY s.subscriber_count DESC
     LIMIT $2`,
    [`%${searchQuery}%`, limit]
  );
  return result.rows;
};

export const subscribe = async (userId, subredditId) => {
  await query(
    `INSERT INTO subscriptions (user_id, subreddit_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, subredditId]
  );

  // Update subscriber count
  await query(
    `UPDATE subreddits SET subscriber_count = subscriber_count + 1 WHERE id = $1`,
    [subredditId]
  );
};

export const unsubscribe = async (userId, subredditId) => {
  const result = await query(
    `DELETE FROM subscriptions WHERE user_id = $1 AND subreddit_id = $2`,
    [userId, subredditId]
  );

  if (result.rowCount > 0) {
    await query(
      `UPDATE subreddits SET subscriber_count = GREATEST(subscriber_count - 1, 0) WHERE id = $1`,
      [subredditId]
    );
  }
};

export const isSubscribed = async (userId, subredditId) => {
  const result = await query(
    `SELECT 1 FROM subscriptions WHERE user_id = $1 AND subreddit_id = $2`,
    [userId, subredditId]
  );
  return result.rows.length > 0;
};

export const getUserSubscriptions = async (userId) => {
  const result = await query(
    `SELECT s.*
     FROM subreddits s
     JOIN subscriptions sub ON s.id = sub.subreddit_id
     WHERE sub.user_id = $1
     ORDER BY s.name`,
    [userId]
  );
  return result.rows;
};
