import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { query, transaction } from '../db.js';
import { setSession, deleteSession, SessionData } from '../redis.js';

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

export async function register(
  username: string,
  email: string,
  password: string,
  displayName?: string,
  deviceName?: string,
  deviceType?: string
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

    // Create device
    const deviceResult = await client.query<Device>(
      `INSERT INTO devices (user_id, device_name, device_type)
       VALUES ($1, $2, $3)
       RETURNING id, device_name, device_type`,
      [user.id, deviceName || 'Web Browser', deviceType || 'web']
    );

    const device = deviceResult.rows[0];

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
  deviceType?: string
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

  // Find or create device
  let deviceResult = await query<Device>(
    `SELECT id, device_name, device_type FROM devices
     WHERE user_id = $1 AND device_name = $2 AND is_active = true`,
    [user.id, deviceName || 'Web Browser']
  );

  let device: Device;
  if (deviceResult.rows.length === 0) {
    deviceResult = await query<Device>(
      `INSERT INTO devices (user_id, device_name, device_type)
       VALUES ($1, $2, $3)
       RETURNING id, device_name, device_type`,
      [user.id, deviceName || 'Web Browser', deviceType || 'web']
    );
  }
  device = deviceResult.rows[0];

  // Update device last active
  await query(
    'UPDATE devices SET last_active = NOW() WHERE id = $1',
    [device.id]
  );

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
  const { password_hash, ...userWithoutPassword } = user;

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

export async function deactivateDevice(userId: string, deviceId: string): Promise<void> {
  // Delete sessions for this device
  await query(
    'DELETE FROM sessions WHERE device_id = $1 AND user_id = $2',
    [deviceId, userId]
  );

  // Mark device as inactive
  await query(
    'UPDATE devices SET is_active = false WHERE id = $1 AND user_id = $2',
    [deviceId, userId]
  );
}
