import { query } from '../db.js';
import redisClient from '../redis.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

export const createSession = async (userId) => {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

  // Store in Redis for fast lookup
  await redisClient.setEx(
    `session:${sessionId}`,
    SESSION_TTL,
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() })
  );

  // Also store in PostgreSQL for persistence
  await query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, userId, expiresAt]
  );

  return { sessionId, expiresAt };
};

export const getSession = async (sessionId) => {
  // Try Redis first
  const cached = await redisClient.get(`session:${sessionId}`);
  if (cached) {
    return JSON.parse(cached);
  }

  // Fallback to PostgreSQL
  const result = await query(
    'SELECT user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const session = {
    userId: result.rows[0].user_id,
    expiresAt: result.rows[0].expires_at,
  };

  // Cache in Redis
  await redisClient.setEx(
    `session:${sessionId}`,
    SESSION_TTL,
    JSON.stringify(session)
  );

  return session;
};

export const deleteSession = async (sessionId) => {
  await redisClient.del(`session:${sessionId}`);
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
};

export const hashPassword = async (password) => {
  return bcrypt.hash(password, 10);
};

export const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};
