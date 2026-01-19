import { db } from '../config/database.js';
import { cache } from '../config/redis.js';
import { HealthSample, HealthSampleData } from '../models/healthSample.js';
import { DevicePriority, DeviceType } from '../models/healthTypes.js';
import { aggregationService } from './aggregationService.js';

export interface DeviceData {
  deviceType: string;
  deviceName: string;
  deviceIdentifier: string;
}

export interface UserDevice {
  id: string;
  user_id: string;
  device_type: string;
  device_name: string;
  device_identifier: string;
  priority: number;
  last_sync: Date | null;
  created_at: Date;
}

export interface SyncResult {
  synced: number;
  errors: number;
  errorDetails: Array<{ sample: HealthSampleData; error: string }>;
}

export class DeviceSyncService {
  async registerDevice(userId: string, deviceData: DeviceData): Promise<UserDevice> {
    const { deviceType, deviceName, deviceIdentifier } = deviceData;

    // Set default priority based on device type
    const priority = DevicePriority[deviceType as DeviceType] || 50;

    const result = await db.query<UserDevice>(
      `INSERT INTO user_devices (user_id, device_type, device_name, device_identifier, priority)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, device_identifier)
       DO UPDATE SET device_name = $3, last_sync = NOW()
       RETURNING *`,
      [userId, deviceType, deviceName, deviceIdentifier, priority]
    );

    return result.rows[0];
  }

  async getUserDevices(userId: string): Promise<UserDevice[]> {
    const result = await db.query<UserDevice>(
      `SELECT * FROM user_devices
       WHERE user_id = $1
       ORDER BY priority DESC, created_at DESC`,
      [userId]
    );

    return result.rows;
  }

  async syncFromDevice(userId: string, deviceId: string, samples: HealthSampleData[]): Promise<SyncResult> {
    const validSamples: HealthSample[] = [];
    const errors: Array<{ sample: HealthSampleData; error: string }> = [];

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
          error: (error as Error).message
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

  async batchInsert(samples: HealthSample[]): Promise<void> {
    if (samples.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
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

  getDateRange(samples: HealthSample[]): { start: Date; end: Date } {
    const dates = samples.map(s => s.startDate.getTime());
    return {
      start: new Date(Math.min(...dates)),
      end: new Date(Math.max(...dates))
    };
  }
}

export const deviceSyncService = new DeviceSyncService();
