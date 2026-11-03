import { query, getClient } from '../db.js';
import redisClient from '../redis.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

export interface Session {
  userId: number;
  expiresAt: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  phone?: string;
  role: string;
  created_at?: Date;
  password_hash?: string;
}

export interface Driver {
  id: number;
  user_id: number;
  vehicle_type: string;
  license_plate?: string;
  is_active: boolean;
  is_available: boolean;
  current_lat?: number;
  current_lon?: number;
  rating?: number;
  total_deliveries: number;
  name?: string;
  email?: string;
  phone?: string;
}

export async function createSession(userId: number): Promise<string> {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

  // Store in PostgreSQL for persistence
  await query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    userId,
    expiresAt,
  ]);

  // Also cache in Redis for fast lookup
  await redisClient.set(
    `session:${sessionId}`,
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() }),
    { EX: SESSION_TTL }
  );

  return sessionId;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  // Try Redis first
  const cached = await redisClient.get(`session:${sessionId}`);
  if (cached) {
    const session: Session = JSON.parse(cached);
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

  const session: Session = {
    userId: result.rows[0].user_id,
    expiresAt: result.rows[0].expires_at.toISOString(),
  };

  // Re-cache in Redis
  await redisClient.set(`session:${sessionId}`, JSON.stringify(session), {
    EX: SESSION_TTL,
  });

  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  await redisClient.del(`session:${sessionId}`);
}

export async function getUserById(userId: number): Promise<User | null> {
  const result = await query(
    'SELECT id, email, name, phone, role, created_at FROM users WHERE id = $1',
    [userId]
  );
  return (result.rows[0] as User) || null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await query(
    'SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1',
    [email]
  );
  return (result.rows[0] as User) || null;
}

// Self-registration always creates a customer. Other roles are reached only
// through the onboarding functions below, and no HTTP path creates an admin.
export async function createUser(
  email: string,
  password: string,
  name: string,
  phone?: string
): Promise<User> {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, name, phone, role)
     VALUES ($1, $2, $3, $4, 'customer')
     RETURNING id, email, name, phone, role, created_at`,
    [email, passwordHash, name, phone]
  );
  return result.rows[0] as User;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

// Get driver profile for a user
export async function getDriverByUserId(userId: number): Promise<Driver | null> {
  const result = await query(
    `SELECT d.*, u.name, u.email, u.phone
     FROM drivers d
     JOIN users u ON d.user_id = u.id
     WHERE d.user_id = $1`,
    [userId]
  );
  return (result.rows[0] as Driver) || null;
}

// Customer -> driver onboarding: creates the driver profile and switches the role
// in one transaction. Only customers qualify (plus drivers left without a profile
// by the old signup form), so restaurant owners and admins never lose their role.
// Returns null when the user's role does not qualify.
export async function onboardDriver(
  userId: number,
  vehicleType: string,
  licensePlate?: string
): Promise<{ user: User; driver: Driver } | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `UPDATE users SET role = 'driver', updated_at = NOW()
       WHERE id = $1 AND role IN ('customer', 'driver')
       RETURNING id, email, name, phone, role, created_at`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const driverResult = await client.query(
      `INSERT INTO drivers (user_id, vehicle_type, license_plate)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, vehicleType, licensePlate]
    );
    await client.query('COMMIT');
    return { user: userResult.rows[0] as User, driver: driverResult.rows[0] as Driver };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Customer -> restaurant owner onboarding. Returns null unless the user is
// currently a customer.
export async function onboardRestaurantOwner(userId: number): Promise<User | null> {
  const result = await query(
    `UPDATE users SET role = 'restaurant_owner', updated_at = NOW()
     WHERE id = $1 AND role = 'customer'
     RETURNING id, email, name, phone, role, created_at`,
    [userId]
  );
  return (result.rows[0] as User) || null;
}
