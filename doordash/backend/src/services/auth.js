import { query } from '../db.js';
import redisClient from '../redis.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

export async function createSession(userId) {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

  // Store in PostgreSQL for persistence
  await query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, userId, expiresAt]
  );

  // Also cache in Redis for fast lookup
  await redisClient.set(
    `session:${sessionId}`,
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() }),
    { EX: SESSION_TTL }
  );

  return sessionId;
}

export async function getSession(sessionId) {
  // Try Redis first
  const cached = await redisClient.get(`session:${sessionId}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) {
      return session;
    }
    // Session expired, clean up
    await deleteSession(sessionId);
    return null;
  }

  // Fall back to PostgreSQL
  const result = await query(
    'SELECT user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const session = {
    userId: result.rows[0].user_id,
    expiresAt: result.rows[0].expires_at.toISOString(),
  };

  // Re-cache in Redis
  await redisClient.set(`session:${sessionId}`, JSON.stringify(session), {
    EX: SESSION_TTL,
  });

  return session;
}

export async function deleteSession(sessionId) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  await redisClient.del(`session:${sessionId}`);
}

export async function getUserById(userId) {
  const result = await query(
    'SELECT id, email, name, phone, role, created_at FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

export async function getUserByEmail(email) {
  const result = await query(
    'SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0] || null;
}

export async function createUser(email, password, name, phone, role = 'customer') {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, name, phone, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, phone, role, created_at`,
    [email, passwordHash, name, phone, role]
  );
  return result.rows[0];
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

// Get driver profile for a user
export async function getDriverByUserId(userId) {
  const result = await query(
    `SELECT d.*, u.name, u.email, u.phone
     FROM drivers d
     JOIN users u ON d.user_id = u.id
     WHERE d.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// Create driver profile
export async function createDriverProfile(userId, vehicleType, licensePlate) {
  const result = await query(
    `INSERT INTO drivers (user_id, vehicle_type, license_plate)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, vehicleType, licensePlate]
  );
  return result.rows[0];
}
