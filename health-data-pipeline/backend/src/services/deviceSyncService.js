import { db } from '../config/database.js';
import { cache } from '../config/redis.js';
import { HealthSample } from '../models/healthSample.js';
import { DevicePriority } from '../models/healthTypes.js';
import { aggregationService } from './aggregationService.js';

export class DeviceSyncService {
  async registerDevice(userId, deviceData) {
    const { deviceType, deviceName, deviceIdentifier } = deviceData;

    // Set default priority based on device type
    const priority = DevicePriority[deviceType] || 50;

    const result = await db.query(
      `INSERT INTO user_devices (user_id, device_type, device_name, device_identifier, priority)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, device_identifier)
       DO UPDATE SET device_name = $3, last_sync = NOW()
       RETURNING *`,
      [userId, deviceType, deviceName, deviceIdentifier, priority]
    );

    return result.rows[0];
  }

  async getUserDevices(userId) {
    const result = await db.query(
      `SELECT * FROM user_devices
       WHERE user_id = $1
       ORDER BY priority DESC, created_at DESC`,
      [userId]
    );

    return result.rows;
  }

  async syncFromDevice(userId, deviceId, samples) {
    const validSamples = [];
    const errors = [];

    for (const sampleData of samples) {
      try {
        const sample = new HealthSample({
          ...sampleData,
          userId,
          sourceDeviceId: deviceId
        });

        sample.validate();
        validSamples.push(sample);
      } catch (error) {
        errors.push({
          sample: sampleData,
          error: error.message
        });
      }
    }

    // Batch insert valid samples
    if (validSamples.length > 0) {
      await this.batchInsert(validSamples);

      // Update device last sync time
      await db.query(
        `UPDATE user_devices SET last_sync = NOW() WHERE id = $1`,
        [deviceId]
      );

      // Trigger aggregation for affected date ranges
      const dateRange = this.getDateRange(validSamples);
      const types = [...new Set(validSamples.map(s => s.type))];

      await aggregationService.queueAggregation(userId, types, dateRange);
    }

    // Invalidate user cache
    await cache.invalidateUser(userId);

    return {
      synced: validSamples.length,
      errors: errors.length,
      errorDetails: errors
    };
  }

  async batchInsert(samples) {
    if (samples.length === 0) return;

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const sample of samples) {
      const row = sample.toRow();
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        row.id,
        row.user_id,
        row.type,
        row.value,
        row.unit,
        row.start_date,
        row.end_date,
        row.source_device,
        row.source_device_id,
        row.metadata
      );
    }

    await db.query(
      `INSERT INTO health_samples
         (id, user_id, type, value, unit, start_date, end_date, source_device, source_device_id, metadata)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
  }

  getDateRange(samples) {
    const dates = samples.map(s => s.startDate.getTime());
    return {
      start: new Date(Math.min(...dates)),
      end: new Date(Math.max(...dates))
    };
  }
}

export const deviceSyncService = new DeviceSyncService();
