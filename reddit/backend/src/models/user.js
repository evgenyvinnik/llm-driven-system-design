import { query } from '../db/index.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import redis from '../db/redis.js';

export const createUser = async (username, email, password) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email, karma_post, karma_comment, role, created_at`,
    [username, email, passwordHash]
  );
  return result.rows[0];
};

export const findUserByUsername = async (username) => {
  const result = await query(
    `SELECT id, username, email, password_hash, karma_post, karma_comment, role, created_at
     FROM users WHERE username = $1`,
    [username]
  );
  return result.rows[0];
};

export const findUserById = async (id) => {
  const result = await query(
    `SELECT id, username, email, karma_post, karma_comment, role, created_at
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0];
};

export const verifyPassword = async (password, passwordHash) => {
  return bcrypt.compare(password, passwordHash);
};

export const createSession = async (userId) => {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt]
  );

  // Cache in Redis
  await redis.setex(`session:${sessionId}`, 7 * 24 * 60 * 60, JSON.stringify({ userId, expiresAt }));

  return sessionId;
};

export const getSession = async (sessionId) => {
  // Try Redis first
  const cached = await redis.get(`session:${sessionId}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) {
      return session;
    }
  }

  // Fallback to database
  const result = await query(
    `SELECT user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > NOW()`,
    [sessionId]
  );

  if (result.rows[0]) {
    const session = {
      userId: result.rows[0].user_id,
      expiresAt: result.rows[0].expires_at,
    };
    // Re-cache
    await redis.setex(`session:${sessionId}`, 7 * 24 * 60 * 60, JSON.stringify(session));
    return session;
  }

  return null;
};

export const deleteSession = async (sessionId) => {
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  await redis.del(`session:${sessionId}`);
};

export const updateUserKarma = async (userId) => {
  await query(`
    UPDATE users u
    SET
      karma_post = COALESCE((SELECT SUM(score) FROM posts WHERE author_id = u.id), 0),
      karma_comment = COALESCE((SELECT SUM(score) FROM comments WHERE author_id = u.id), 0)
    WHERE u.id = $1
  `, [userId]);
};
