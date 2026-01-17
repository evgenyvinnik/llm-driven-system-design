import { v4 as uuid } from 'uuid';
import bcrypt from 'bcrypt';
import { query } from '../db/index.js';
import redis from '../db/redis.js';
import { User, Device } from '../types/index.js';

export class AuthService {
  // Login user
  async login(
    email: string,
    password: string,
    deviceId?: string
  ): Promise<{ success: boolean; sessionId?: string; user?: Partial<User>; error?: string }> {
    const result = await query(
      `SELECT * FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid credentials' };
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return { success: false, error: 'Invalid credentials' };
    }

    // Create session
    const sessionId = uuid();
    const sessionData = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      deviceId: deviceId || null,
    };

    await redis.set(
      `session:${sessionId}`,
      JSON.stringify(sessionData),
      'EX',
      3600 // 1 hour
    );

    // Update device last active
    if (deviceId) {
      await query(
        `UPDATE devices SET last_active_at = NOW() WHERE id = $1 AND user_id = $2`,
        [deviceId, user.id]
      );
    }

    return {
      success: true,
      sessionId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  // Register new user
  async register(
    email: string,
    password: string,
    name: string
  ): Promise<{ success: boolean; user?: Partial<User>; error?: string }> {
    // Check if user exists
    const existing = await query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return { success: false, error: 'Email already registered' };
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuid();

    await query(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'user')`,
      [userId, email.toLowerCase(), passwordHash, name]
    );

    return {
      success: true,
      user: {
        id: userId,
        email: email.toLowerCase(),
        name,
        role: 'user',
      },
    };
  }

  // Logout
  async logout(sessionId: string): Promise<void> {
    await redis.del(`session:${sessionId}`);
  }

  // Get current user
  async getCurrentUser(sessionId: string): Promise<User | null> {
    const sessionData = await redis.get(`session:${sessionId}`);
    if (!sessionData) {
      return null;
    }

    const session = JSON.parse(sessionData);
    const result = await query(
      `SELECT id, email, name, role, created_at FROM users WHERE id = $1`,
      [session.userId]
    );

    return result.rows[0] || null;
  }

  // Register a device
  async registerDevice(
    userId: string,
    deviceName: string,
    deviceType: 'iphone' | 'apple_watch' | 'ipad'
  ): Promise<Device> {
    const deviceId = uuid();
    const secureElementId = `SE_${uuid().replace(/-/g, '').substring(0, 16)}`;

    await query(
      `INSERT INTO devices (id, user_id, device_name, device_type, secure_element_id, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [deviceId, userId, deviceName, deviceType, secureElementId]
    );

    const result = await query(
      `SELECT * FROM devices WHERE id = $1`,
      [deviceId]
    );

    return result.rows[0];
  }

  // Get user's devices
  async getDevices(userId: string): Promise<Device[]> {
    const result = await query(
      `SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // Remove device (and all its cards)
  async removeDevice(userId: string, deviceId: string): Promise<{ success: boolean; error?: string }> {
    const device = await query(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    if (device.rows.length === 0) {
      return { success: false, error: 'Device not found' };
    }

    // Mark all cards on this device as deleted
    await query(
      `UPDATE provisioned_cards SET status = 'deleted', updated_at = NOW()
       WHERE device_id = $1`,
      [deviceId]
    );

    // Mark device as inactive
    await query(
      `UPDATE devices SET status = 'inactive' WHERE id = $1`,
      [deviceId]
    );

    return { success: true };
  }

  // Report device as lost
  async reportDeviceLost(userId: string, deviceId: string): Promise<{ success: boolean; suspendedCards: number; error?: string }> {
    const device = await query(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );

    if (device.rows.length === 0) {
      return { success: false, suspendedCards: 0, error: 'Device not found' };
    }

    // Suspend all cards on this device
    const result = await query(
      `UPDATE provisioned_cards
       SET status = 'suspended', suspended_at = NOW(), suspend_reason = 'device_lost', updated_at = NOW()
       WHERE device_id = $1 AND status = 'active'
       RETURNING id`,
      [deviceId]
    );

    // Mark device as lost
    await query(
      `UPDATE devices SET status = 'lost' WHERE id = $1`,
      [deviceId]
    );

    return { success: true, suspendedCards: result.rowCount || 0 };
  }
}

export const authService = new AuthService();
