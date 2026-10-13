import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, transaction } from '../db.js';
import { setSession, deleteSession, SessionData } from '../redis.js';

const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Anything that can run a query: the pool wrapper or a transaction client. */
interface Queryable {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

const SESSION_EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '720');

interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at?: Date;
  password_hash?: string;
}

interface Device {
  id: string;
  device_name: string;
  device_type: string;
  is_active?: boolean;
  last_active?: Date;
  created_at?: Date;
}

interface AuthResult {
  user: User;
  device: Device;
  token: string;
  expiresAt: Date;
}

/**
 * Finds or creates the device row for this (user, installation).
 *
 * WHY: delivery, receipts and the inbox are per device, so two browsers of one
 * user must be two devices, and the same browser must stay one device across
 * logins. The old lookup matched on device_name (a user-agent prefix), which
 * merged every identical browser into one device. The client now sends a
 * random installation ID kept in localStorage; the unique (user_id,
 * install_id) index makes the find-or-create a single atomic upsert. Requests
 * without an installation ID always get a fresh device.
 */
async function upsertDevice(
  client: Queryable,
  userId: string,
  deviceName: string | undefined,
  deviceType: string | undefined,
  installId: string | undefined
): Promise<Device> {
  const validInstallId = installId && INSTALL_ID_PATTERN.test(installId) ? installId : null;
  const result = await client.query<Device>(
    `INSERT INTO devices (user_id, device_name, device_type, install_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, install_id)
       DO UPDATE SET last_active = NOW(), is_active = true, device_name = EXCLUDED.device_name
     RETURNING id, device_name, device_type`,
    [userId, (deviceName || 'Web Browser').slice(0, 100), (deviceType || 'web').slice(0, 50), validInstallId]
  );
  return result.rows[0];
}

export async function register(
  username: string,
  email: string,
  password: string,
  displayName?: string,
  deviceName?: string,
  deviceType?: string,
  installId?: string
): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(password, 12);

  return await transaction(async (client: PoolClient) => {
    // Create user
    const userResult = await client.query<User>(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, avatar_url, created_at`,
      [username, email, passwordHash, displayName || username]
    );

    const user = userResult.rows[0];

    // Create the device this installation will use
    const device = await upsertDevice(client, user.id, deviceName, deviceType, installId);

    // Create session
    const token = uuid();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO sessions (user_id, device_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, device.id, token, expiresAt]
    );

    // Store session in Redis
    const sessionData: SessionData = {
      userId: user.id,
      deviceId: device.id,
      expiresAt: expiresAt.toISOString(),
    };
    await setSession(token, sessionData, SESSION_EXPIRY_HOURS * 60 * 60);

    return {
      user,
      device,
      token,
      expiresAt,
    };
  });
}

export async function login(
  usernameOrEmail: string,
  password: string,
  deviceName?: string,
  deviceType?: string,
  installId?: string
): Promise<AuthResult> {
  // Find user
  const userResult = await query<User & { password_hash: string }>(
    `SELECT id, username, email, password_hash, display_name, avatar_url
     FROM users
     WHERE username = $1 OR email = $1`,
    [usernameOrEmail]
  );

  if (userResult.rows.length === 0) {
    throw new Error('Invalid credentials');
  }

  const user = userResult.rows[0];

  // Verify password
  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    throw new Error('Invalid credentials');
  }

  // Find or create this installation's device (also refreshes last_active)
  const device = await upsertDevice({ query }, user.id, deviceName, deviceType, installId);

  // Create session
  const token = uuid();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

  await query(
    `INSERT INTO sessions (user_id, device_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, device.id, token, expiresAt]
  );

  // Store session in Redis
  const sessionData: SessionData = {
    userId: user.id,
    deviceId: device.id,
    expiresAt: expiresAt.toISOString(),
  };
  await setSession(token, sessionData, SESSION_EXPIRY_HOURS * 60 * 60);

  // Remove password hash from response
  const { password_hash: _ignored, ...userWithoutPassword } = user;

  return {
    user: userWithoutPassword,
    device,
    token,
    expiresAt,
  };
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) {
    await query('DELETE FROM sessions WHERE token = $1', [token]);
    await deleteSession(token);
  }
}

export async function getUserDevices(userId: string): Promise<Device[]> {
  const result = await query<Device>(
    `SELECT id, device_name, device_type, is_active, last_active, created_at
     FROM devices
     WHERE user_id = $1 AND is_active = true
     ORDER BY last_active DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Revokes a device: it stops receiving inbox rows, its pending inbox is
 * dropped, and every session token it holds is deleted from both PostgreSQL
 * and Redis. Authentication reads Redis, so deleting only the SQL rows (as
 * before) left a "revoked" device fully logged in until the token expired.
 * Returns false when the device does not belong to the user.
 */
export async function deactivateDevice(userId: string, deviceId: string): Promise<boolean> {
  return await transaction(async (client: PoolClient) => {
    const device = await client.query(
      'UPDATE devices SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING id',
      [deviceId, userId]
    );
    if (device.rowCount === 0) return false;

    const sessions = await client.query<{ token: string }>(
      'DELETE FROM sessions WHERE device_id = $1 AND user_id = $2 RETURNING token',
      [deviceId, userId]
    );
    await client.query('DELETE FROM device_inbox WHERE device_id = $1', [deviceId]);

    // Inside the transaction on purpose: if Redis fails, the device stays
    // active rather than looking revoked while its tokens still work.
    for (const { token } of sessions.rows) {
      await deleteSession(token);
    }
    return true;
  });
}
