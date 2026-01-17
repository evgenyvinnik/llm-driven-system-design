import pool from '../db/pool.js';
import { RegisteredDevice, CreateDeviceRequest, UpdateDeviceRequest } from '../types/index.js';
import { generateMasterSecret, KeyManager } from '../utils/crypto.js';

/**
 * Service for managing registered devices in the Find My network.
 * Handles device registration, updates, and cryptographic key management.
 * Each device has a master secret that enables end-to-end encrypted location tracking.
 */
export class DeviceService {
  /**
   * Create a new device for a user.
   * Generates a unique master secret for the device and initializes lost mode settings.
   *
   * @param userId - The ID of the user who owns the device
   * @param data - Device creation data including type, name, and optional emoji
   * @returns The newly created device with its master secret
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
   * Get all devices belonging to a user.
   * Returns devices ordered by creation date (newest first).
   *
   * @param userId - The ID of the user to fetch devices for
   * @returns Array of registered devices
   */
  async getDevicesByUser(userId: string): Promise<RegisteredDevice[]> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Get a single device by ID, enforcing ownership.
   * Returns null if the device doesn't exist or isn't owned by the user.
   *
   * @param deviceId - The UUID of the device
   * @param userId - The ID of the user who should own the device
   * @returns The device if found and owned by user, null otherwise
   */
  async getDevice(deviceId: string, userId: string): Promise<RegisteredDevice | null> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update a device's properties (name, emoji, active status).
   * Only allows updates if the user owns the device.
   *
   * @param deviceId - The UUID of the device to update
   * @param userId - The ID of the user who should own the device
   * @param data - The fields to update
   * @returns The updated device, or null if not found/not owned
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
   * Delete a device and its associated data.
   * Only allows deletion if the user owns the device.
   *
   * @param deviceId - The UUID of the device to delete
   * @param userId - The ID of the user who should own the device
   * @returns True if the device was deleted, false if not found/not owned
   */
  async deleteDevice(deviceId: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM registered_devices WHERE id = $1 AND user_id = $2`,
      [deviceId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get the current identifier hash for a device.
   * Used to query location reports from the server.
   *
   * @param deviceId - The UUID of the device
   * @param userId - The ID of the user who should own the device
   * @returns The current identifier hash, or null if device not found
   */
  async getCurrentIdentifierHash(deviceId: string, userId: string): Promise<string | null> {
    const device = await this.getDevice(deviceId, userId);
    if (!device) return null;

    const keyManager = new KeyManager(device.master_secret);
    return keyManager.getCurrentIdentifierHash();
  }

  /**
   * Get all identifier hashes for a device across a time range.
   * Used to query historical location reports across key rotation periods.
   *
   * @param deviceId - The UUID of the device
   * @param userId - The ID of the user who should own the device
   * @param startTime - Start of time range in milliseconds
   * @param endTime - End of time range in milliseconds
   * @returns Array of period/hash pairs, or null if device not found
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
   * Get a device by its master secret.
   * Internal use only for decryption and lost mode notification.
   *
   * @param masterSecret - The device's master secret
   * @returns The device if found, null otherwise
   */
  async getDeviceByMasterSecret(masterSecret: string): Promise<RegisteredDevice | null> {
    const result = await pool.query(
      `SELECT * FROM registered_devices WHERE master_secret = $1`,
      [masterSecret]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all devices across all users.
   * Admin-only operation for system monitoring.
   *
   * @returns All registered devices with owner information
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
   * Get device count statistics for the admin dashboard.
   * Provides total count, breakdown by type, and active device count.
   *
   * @returns Statistics object with total, byType, and active counts
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
