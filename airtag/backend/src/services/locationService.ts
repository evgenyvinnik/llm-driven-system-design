import pool from '../db/pool.js';
import {
  LocationReport,
  EncryptedPayload,
  DecryptedLocation,
  LocationReportRequest,
} from '../types/index.js';
import { KeyManager, decryptLocation, encryptLocation } from '../utils/crypto.js';
import { deviceService } from './deviceService.js';
import { notificationService } from './notificationService.js';

export class LocationService {
  /**
   * Submit a location report (from a finder device in the network)
   */
  async submitReport(data: LocationReportRequest): Promise<LocationReport> {
    const result = await pool.query(
      `INSERT INTO location_reports (identifier_hash, encrypted_payload, reporter_region)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.identifier_hash, data.encrypted_payload, data.reporter_region]
    );

    // Check if this device is in lost mode and notify owner
    await this.checkLostModeAndNotify(data.identifier_hash);

    return result.rows[0];
  }

  /**
   * Query location reports by identifier hashes
   */
  async queryReports(identifierHashes: string[]): Promise<LocationReport[]> {
    if (identifierHashes.length === 0) return [];

    const result = await pool.query(
      `SELECT * FROM location_reports
       WHERE identifier_hash = ANY($1)
       ORDER BY created_at DESC`,
      [identifierHashes]
    );

    return result.rows;
  }

  /**
   * Get locations for a device (decrypted)
   */
  async getDeviceLocations(
    deviceId: string,
    userId: string,
    options: { startTime?: number; endTime?: number; limit?: number } = {}
  ): Promise<DecryptedLocation[]> {
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) return [];

    const startTime = options.startTime || Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const endTime = options.endTime || Date.now();
    const limit = options.limit || 100;

    // Get identifier hashes for the time range
    const keyManager = new KeyManager(device.master_secret);
    const identifiers = keyManager.getIdentifierHashesForTimeRange(startTime, endTime);

    // Query encrypted reports
    const reports = await this.queryReports(identifiers.map((i) => i.identifierHash));

    // Decrypt reports
    const locations: DecryptedLocation[] = [];
    for (const report of reports) {
      const decrypted = decryptLocation(report.encrypted_payload, device.master_secret);
      if (decrypted) {
        locations.push({
          id: report.id,
          device_id: deviceId,
          latitude: decrypted.latitude,
          longitude: decrypted.longitude,
          accuracy: decrypted.accuracy,
          timestamp: new Date(decrypted.timestamp),
          created_at: report.created_at,
        });
      }
    }

    // Sort by timestamp descending and limit
    return locations.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);
  }

  /**
   * Get the latest location for a device
   */
  async getLatestLocation(
    deviceId: string,
    userId: string
  ): Promise<DecryptedLocation | null> {
    const locations = await this.getDeviceLocations(deviceId, userId, { limit: 1 });
    return locations[0] || null;
  }

  /**
   * Simulate a location report (for testing/demo purposes)
   */
  async simulateLocationReport(
    deviceId: string,
    userId: string,
    location: { latitude: number; longitude: number; accuracy?: number }
  ): Promise<LocationReport | null> {
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) return null;

    const keyManager = new KeyManager(device.master_secret);
    const identifierHash = keyManager.getCurrentIdentifierHash();

    // Encrypt the location with the master secret
    const encryptedPayload = encryptLocation(location, device.master_secret);

    // Submit the report
    return this.submitReport({
      identifier_hash: identifierHash,
      encrypted_payload: encryptedPayload,
      reporter_region: 'US', // Simulated
    });
  }

  /**
   * Check if a device is in lost mode and notify owner
   */
  private async checkLostModeAndNotify(identifierHash: string): Promise<void> {
    // Find devices that might match this identifier
    // In a real system, this would be more efficient
    const devicesResult = await pool.query(
      `SELECT d.*, lm.enabled, lm.notify_when_found
       FROM registered_devices d
       JOIN lost_mode lm ON d.id = lm.device_id
       WHERE lm.enabled = true AND lm.notify_when_found = true`
    );

    for (const device of devicesResult.rows) {
      const keyManager = new KeyManager(device.master_secret);
      const currentHash = keyManager.getCurrentIdentifierHash();

      if (currentHash === identifierHash) {
        // Device found! Create notification
        await notificationService.createNotification({
          user_id: device.user_id,
          device_id: device.id,
          type: 'device_found',
          title: `${device.name} has been found!`,
          message: `Your lost ${device.device_type} "${device.name}" was detected by the Find My network.`,
          data: { device_id: device.id, device_name: device.name },
        });
      }
    }
  }

  /**
   * Get location report statistics (for admin)
   */
  async getReportStats(): Promise<{
    total: number;
    last24h: number;
    lastHour: number;
    byRegion: Record<string, number>;
  }> {
    const total = await pool.query(`SELECT COUNT(*) as count FROM location_reports`);
    const last24h = await pool.query(
      `SELECT COUNT(*) as count FROM location_reports WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const lastHour = await pool.query(
      `SELECT COUNT(*) as count FROM location_reports WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    const byRegion = await pool.query(
      `SELECT reporter_region, COUNT(*) as count FROM location_reports GROUP BY reporter_region`
    );

    const regionMap: Record<string, number> = {};
    byRegion.rows.forEach((row: { reporter_region: string; count: string }) => {
      regionMap[row.reporter_region || 'unknown'] = parseInt(row.count);
    });

    return {
      total: parseInt(total.rows[0].count),
      last24h: parseInt(last24h.rows[0].count),
      lastHour: parseInt(lastHour.rows[0].count),
      byRegion: regionMap,
    };
  }
}

export const locationService = new LocationService();
