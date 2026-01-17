import pool from '../db/pool.js';
import { RegisteredDevice, CreateDeviceRequest, UpdateDeviceRequest } from '../types/index.js';
import { generateMasterSecret, KeyManager } from '../utils/crypto.js';

export class DeviceService {
  /**
   * Create a new device for a user
   */
  async createDevice(userId: string, data: CreateDeviceRequest): Promise<RegisteredDevice> {
    const masterSecret = generateMasterSecret();

    const result = await pool.query(
      `INSERT INTO registered_devices (user_id, device_type, name, emoji, master_secret)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, data.device_type, data.name, data.emoji || '📍', masterSecret]
    );

    // Also create a lost_mode entry with defaults
    await pool.query(
      `INSERT INTO lost_mode (device_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [result.rows[0].id]
    );

    return result.rows[0];
  }

  /**
   * Get all devices for a user
   */
  async getDevicesByUser(userId: string): Promise<RegisteredDevice[]> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Get a single device by ID (only if owned by user)
   */
  async getDevice(deviceId: string, userId: string): Promise<RegisteredDevice | null> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update a device
   */
  async updateDevice(
    deviceId: string,
    userId: string,
    data: UpdateDeviceRequest
  ): Promise<RegisteredDevice | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.emoji !== undefined) {
      fields.push(`emoji = $${paramCount++}`);
      values.push(data.emoji);
    }
    if (data.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(data.is_active);
    }

    if (fields.length === 0) {
      return this.getDevice(deviceId, userId);
    }

    fields.push(`updated_at = NOW()`);
    values.push(deviceId, userId);

    const result = await pool.query(
      `UPDATE registered_devices
       SET ${fields.join(', ')}
       WHERE id = $${paramCount++} AND user_id = $${paramCount}
       RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  /**
   * Delete a device
   */
  async deleteDevice(deviceId: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM registered_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get current identifier hash for a device (for location lookup)
   */
  async getCurrentIdentifierHash(deviceId: string, userId: string): Promise<string | null> {
    const device = await this.getDevice(deviceId, userId);
    if (!device) return null;

    const keyManager = new KeyManager(device.master_secret);
    return keyManager.getCurrentIdentifierHash();
  }

  /**
   * Get identifier hashes for a time range (for querying location reports)
   */
  async getIdentifierHashesForTimeRange(
    deviceId: string,
    userId: string,
    startTime: number,
    endTime: number
  ): Promise<Array<{ period: number; identifierHash: string }> | null> {
    const device = await this.getDevice(deviceId, userId);
    if (!device) return null;

    const keyManager = new KeyManager(device.master_secret);
    return keyManager.getIdentifierHashesForTimeRange(startTime, endTime);
  }

  /**
   * Get device by master secret (internal use for decryption)
   */
  async getDeviceByMasterSecret(masterSecret: string): Promise<RegisteredDevice | null> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE master_secret = $1`,
      [masterSecret]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all active devices (for admin)
   */
  async getAllDevices(): Promise<RegisteredDevice[]> {
    const result = await pool.query(
      `SELECT d.*, u.email as user_email, u.name as user_name
       FROM registered_devices d
       JOIN users u ON d.user_id = u.id
       ORDER BY d.created_at DESC`
    );
    return result.rows;
  }

  /**
   * Get device count statistics
   */
  async getDeviceStats(): Promise<{ total: number; byType: Record<string, number>; active: number }> {
    const total = await pool.query(`SELECT COUNT(*) as count FROM registered_devices`);
    const byType = await pool.query(
      `SELECT device_type, COUNT(*) as count FROM registered_devices GROUP BY device_type`
    );
    const active = await pool.query(
      `SELECT COUNT(*) as count FROM registered_devices WHERE is_active = true`
    );

    const typeMap: Record<string, number> = {};
    byType.rows.forEach((row: { device_type: string; count: string }) => {
      typeMap[row.device_type] = parseInt(row.count);
    });

    return {
      total: parseInt(total.rows[0].count),
      byType: typeMap,
      active: parseInt(active.rows[0].count),
    };
  }
}

export const deviceService = new DeviceService();
