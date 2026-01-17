import pool from '../db/pool.js';
import { LostMode, LostModeRequest } from '../types/index.js';
import { deviceService } from './deviceService.js';

export class LostModeService {
  /**
   * Get lost mode settings for a device
   */
  async getLostMode(deviceId: string, userId: string): Promise<LostMode | null> {
    // Verify device ownership
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) return null;

    const result = await pool.query(
      `SELECT * FROM lost_mode WHERE device_id = $1`,
      [deviceId]
    );

    return result.rows[0] || null;
  }

  /**
   * Update lost mode settings for a device
   */
  async updateLostMode(
    deviceId: string,
    userId: string,
    data: LostModeRequest
  ): Promise<LostMode | null> {
    // Verify device ownership
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) return null;

    const enabledAt = data.enabled ? new Date() : null;

    const result = await pool.query(
      `INSERT INTO lost_mode (device_id, enabled, contact_phone, contact_email, message, notify_when_found, enabled_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET
         enabled = $2,
         contact_phone = COALESCE($3, lost_mode.contact_phone),
         contact_email = COALESCE($4, lost_mode.contact_email),
         message = COALESCE($5, lost_mode.message),
         notify_when_found = COALESCE($6, lost_mode.notify_when_found),
         enabled_at = CASE WHEN $2 = true AND lost_mode.enabled = false THEN $7 ELSE lost_mode.enabled_at END,
         updated_at = NOW()
       RETURNING *`,
      [
        deviceId,
        data.enabled,
        data.contact_phone,
        data.contact_email,
        data.message,
        data.notify_when_found ?? true,
        enabledAt,
      ]
    );

    return result.rows[0] || null;
  }

  /**
   * Enable lost mode quickly
   */
  async enableLostMode(deviceId: string, userId: string): Promise<LostMode | null> {
    return this.updateLostMode(deviceId, userId, { enabled: true });
  }

  /**
   * Disable lost mode
   */
  async disableLostMode(deviceId: string, userId: string): Promise<LostMode | null> {
    return this.updateLostMode(deviceId, userId, { enabled: false });
  }

  /**
   * Get all devices in lost mode (for admin)
   */
  async getAllLostDevices(): Promise<
    Array<LostMode & { device_name: string; device_type: string; user_email: string }>
  > {
    const result = await pool.query(
      `SELECT lm.*, d.name as device_name, d.device_type, u.email as user_email
       FROM lost_mode lm
       JOIN registered_devices d ON lm.device_id = d.id
       JOIN users u ON d.user_id = u.id
       WHERE lm.enabled = true
       ORDER BY lm.enabled_at DESC`
    );
    return result.rows;
  }

  /**
   * Get lost mode statistics
   */
  async getLostModeStats(): Promise<{ total: number; active: number }> {
    const total = await pool.query(`SELECT COUNT(*) as count FROM lost_mode`);
    const active = await pool.query(
      `SELECT COUNT(*) as count FROM lost_mode WHERE enabled = true`
    );

    return {
      total: parseInt(total.rows[0].count),
      active: parseInt(active.rows[0].count),
    };
  }
}

export const lostModeService = new LostModeService();
