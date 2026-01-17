import pool from '../db/pool.js';
import {
  LocationReport,
  DecryptedLocation,
  LocationReportRequest,
} from '../types/index.js';
import { KeyManager, decryptLocation, encryptLocation } from '../utils/crypto.js';
import { deviceService } from './deviceService.js';
import { notificationService } from './notificationService.js';
import {
  createComponentLogger,
  cacheService,
  generateIdempotencyKey,
  checkIdempotency,
  markProcessed,
  validateTimestamp,
  locationReportsTotal,
  dbQueryDuration,
} from '../shared/index.js';

/**
 * Service for managing location reports in the Find My network.
 * Handles the privacy-preserving crowd-sourced location system where
 * the server stores only encrypted location data that only device owners can decrypt.
 *
 * IMPROVEMENTS IN THIS VERSION:
 * - Redis caching for location queries (cache-aside pattern)
 * - Idempotency for location report submissions (prevents duplicates)
 * - Structured logging for debugging and monitoring
 * - Prometheus metrics for observability
 */

const log = createComponentLogger('locationService');

export class LocationService {
  /**
   * Submit an encrypted location report from a finder device.
   * This simulates what happens when an iPhone detects a nearby AirTag
   * and reports its location to Apple's servers.
   *
   * IDEMPOTENCY:
   * - Generates idempotency key from identifier + timestamp + payload
   * - Checks Redis for duplicate submissions within 24-hour window
   * - Returns cached response for duplicates (same report_id)
   *
   * @param data - The location report containing identifier hash and encrypted payload
   * @returns The stored location report
   */
  async submitReport(data: LocationReportRequest): Promise<LocationReport> {
    const timestamp = Date.now();

    // Validate timestamp to prevent replay attacks
    if (data.encrypted_payload && !validateTimestamp(timestamp)) {
      log.warn({ identifierHash: data.identifier_hash }, 'Rejecting report with invalid timestamp');
      throw new Error('Invalid report timestamp');
    }

    // Generate idempotency key for duplicate detection
    const idempotencyKey = generateIdempotencyKey(
      data.identifier_hash,
      timestamp,
      data.encrypted_payload
    );

    // Check for duplicate submission
    const idempotencyResult = await checkIdempotency(idempotencyKey);

    if (idempotencyResult.isDuplicate) {
      log.info(
        { identifierHash: data.identifier_hash, idempotencyKey },
        'Duplicate location report detected, returning cached result'
      );
      locationReportsTotal.inc({ region: data.reporter_region || 'unknown', status: 'deduplicated' });
      return idempotencyResult.previousResponse as LocationReport;
    }

    // Process the new report
    const timer = dbQueryDuration.startTimer({ operation: 'insert', table: 'location_reports' });

    try {
      const result = await pool.query(
        `INSERT INTO location_reports (identifier_hash, encrypted_payload, reporter_region)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [data.identifier_hash, data.encrypted_payload, data.reporter_region]
      );
      timer();

      const report = result.rows[0];

      // Mark as processed with response for future duplicate detection
      await markProcessed(idempotencyKey, report);

      // Invalidate any cached location data for this identifier
      await cacheService.invalidateByIdentifierHash(data.identifier_hash);

      // Check if this device is in lost mode and notify owner
      await this.checkLostModeAndNotify(data.identifier_hash);

      log.info(
        { reportId: report.id, identifierHash: data.identifier_hash, region: data.reporter_region },
        'Location report submitted successfully'
      );

      locationReportsTotal.inc({ region: data.reporter_region || 'unknown', status: 'created' });

      return report;
    } catch (error) {
      timer();
      log.error({ error, identifierHash: data.identifier_hash }, 'Failed to submit location report');
      locationReportsTotal.inc({ region: data.reporter_region || 'unknown', status: 'error' });
      throw error;
    }
  }

  /**
   * Query location reports by identifier hashes.
   * Used internally to fetch encrypted reports for a device.
   *
   * @param identifierHashes - Array of identifier hashes to search for
   * @returns Matching encrypted location reports
   */
  async queryReports(identifierHashes: string[]): Promise<LocationReport[]> {
    if (identifierHashes.length === 0) return [];

    const timer = dbQueryDuration.startTimer({ operation: 'select', table: 'location_reports' });

    try {
      const result = await pool.query(
        `SELECT * FROM location_reports
         WHERE identifier_hash = ANY($1)
         ORDER BY created_at DESC`,
        [identifierHashes]
      );
      timer();
      log.debug({ hashCount: identifierHashes.length, resultCount: result.rows.length }, 'Queried location reports');
      return result.rows;
    } catch (error) {
      timer();
      log.error({ error }, 'Failed to query location reports');
      throw error;
    }
  }

  /**
   * Get decrypted location history for a device.
   * Fetches encrypted reports, decrypts them using the master secret,
   * and returns a list of plaintext locations.
   *
   * CACHING:
   * - Checks Redis cache first (cache-aside pattern)
   * - On cache miss, fetches from DB and populates cache
   * - Cache TTL: 15 minutes (matches key rotation period)
   *
   * @param deviceId - The UUID of the device
   * @param userId - The ID of the user who should own the device
   * @param options - Query options for time range and limit
   * @returns Array of decrypted location data, sorted by timestamp descending
   */
  async getDeviceLocations(
    deviceId: string,
    userId: string,
    options: { startTime?: number; endTime?: number; limit?: number } = {}
  ): Promise<DecryptedLocation[]> {
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) {
      log.debug({ deviceId, userId }, 'Device not found or not owned by user');
      return [];
    }

    const startTime = options.startTime || Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const endTime = options.endTime || Date.now();
    const limit = options.limit || 100;

    // Check cache first
    const cacheKey = `${deviceId}:${startTime}:${endTime}:${limit}`;
    const cached = await cacheService.getLocations(cacheKey);

    if (cached) {
      log.debug({ deviceId, cacheKey }, 'Returning cached locations');
      return cached as DecryptedLocation[];
    }

    // Cache miss - fetch from database
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
    const result = locations.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);

    // Cache the result
    await cacheService.setLocations(cacheKey, result);
    log.debug({ deviceId, locationCount: result.length }, 'Cached location query result');

    return result;
  }

  /**
   * Get the most recent location for a device.
   *
   * CACHING:
   * - Uses separate cache with shorter TTL (1 minute)
   * - Users expect latest location to be fresh
   *
   * @param deviceId - The UUID of the device
   * @param userId - The ID of the user who should own the device
   * @returns The most recent decrypted location, or null if none found
   */
  async getLatestLocation(
    deviceId: string,
    userId: string
  ): Promise<DecryptedLocation | null> {
    // Check dedicated latest location cache
    const cached = await cacheService.getLatestLocation(deviceId);
    if (cached) {
      log.debug({ deviceId }, 'Returning cached latest location');
      return cached as DecryptedLocation;
    }

    // Fetch from database
    const locations = await this.getDeviceLocations(deviceId, userId, { limit: 1 });
    const latest = locations[0] || null;

    // Cache the latest location with short TTL
    if (latest) {
      await cacheService.setLatestLocation(deviceId, latest);
    }

    return latest;
  }

  /**
   * Simulate a location report for testing/demo purposes.
   * Creates an encrypted location report as if a finder device detected the AirTag.
   *
   * @param deviceId - The UUID of the device to report location for
   * @param userId - The ID of the user who should own the device
   * @param location - The simulated GPS coordinates
   * @returns The created location report, or null if device not found
   */
  async simulateLocationReport(
    deviceId: string,
    userId: string,
    location: { latitude: number; longitude: number; accuracy?: number }
  ): Promise<LocationReport | null> {
    const device = await deviceService.getDevice(deviceId, userId);
    if (!device) {
      log.debug({ deviceId, userId }, 'Cannot simulate report - device not found');
      return null;
    }

    const keyManager = new KeyManager(device.master_secret);
    const identifierHash = keyManager.getCurrentIdentifierHash();

    // Encrypt the location with the master secret
    const encryptedPayload = encryptLocation(location, device.master_secret);

    log.info(
      { deviceId, latitude: location.latitude, longitude: location.longitude },
      'Simulating location report'
    );

    // Submit the report
    return this.submitReport({
      identifier_hash: identifierHash,
      encrypted_payload: encryptedPayload,
      reporter_region: 'US', // Simulated
    });
  }

  /**
   * Check if a reported device is in lost mode and notify its owner.
   * Called automatically when a new location report is submitted.
   *
   * @param identifierHash - The identifier hash from the location report
   */
  private async checkLostModeAndNotify(identifierHash: string): Promise<void> {
    // Find devices that might match this identifier
    // In a real system, this would be more efficient
    const timer = dbQueryDuration.startTimer({ operation: 'select', table: 'lost_mode' });

    try {
      const devicesResult = await pool.query(
        `SELECT d.*, lm.enabled, lm.notify_when_found
         FROM registered_devices d
         JOIN lost_mode lm ON d.id = lm.device_id
         WHERE lm.enabled = true AND lm.notify_when_found = true`
      );
      timer();

      for (const device of devicesResult.rows) {
        const keyManager = new KeyManager(device.master_secret);
        const currentHash = keyManager.getCurrentIdentifierHash();

        if (currentHash === identifierHash) {
          // Device found! Create notification
          log.info({ deviceId: device.id, deviceName: device.name }, 'Lost device found, sending notification');

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
    } catch (error) {
      timer();
      log.error({ error, identifierHash }, 'Failed to check lost mode');
    }
  }

  /**
   * Get location report statistics for the admin dashboard.
   * Provides total count, recent counts, and regional breakdown.
   *
   * @returns Statistics object with totals and breakdowns
   */
  async getReportStats(): Promise<{
    total: number;
    last24h: number;
    lastHour: number;
    byRegion: Record<string, number>;
  }> {
    const timer = dbQueryDuration.startTimer({ operation: 'aggregate', table: 'location_reports' });

    try {
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
      timer();

      const regionMap: Record<string, number> = {};
      byRegion.rows.forEach((row: { reporter_region: string; count: string }) => {
        regionMap[row.reporter_region || 'unknown'] = parseInt(row.count);
      });

      log.debug('Fetched location report statistics');

      return {
        total: parseInt(total.rows[0].count),
        last24h: parseInt(last24h.rows[0].count),
        lastHour: parseInt(lastHour.rows[0].count),
        byRegion: regionMap,
      };
    } catch (error) {
      timer();
      log.error({ error }, 'Failed to fetch report statistics');
      throw error;
    }
  }
}

export const locationService = new LocationService();
