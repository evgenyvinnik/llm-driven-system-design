import pool from '../db/pool.js';
import { TrackerSighting } from '../types/index.js';
import { haversineDistance } from '../utils/crypto.js';
import { notificationService } from './notificationService.js';
import { deviceService } from './deviceService.js';
import { KeyManager } from '../utils/crypto.js';

const ALERT_THRESHOLD = 3; // Number of sightings before alert
const TIME_WINDOW = 3 * 60 * 60 * 1000; // 3 hours
const MIN_DISTANCE_KM = 0.5; // 500 meters minimum travel distance

export class AntiStalkingService {
  /**
   * Record a tracker sighting (called when user's device detects a nearby tracker)
   */
  async recordSighting(
    userId: string,
    identifierHash: string,
    location: { latitude: number; longitude: number }
  ): Promise<{ isAlert: boolean; sighting: TrackerSighting }> {
    // Check if this is the user's own device
    const isOwnDevice = await this.isUserDevice(userId, identifierHash);
    if (isOwnDevice) {
      // Return with no alert for own devices
      const result = await pool.query(
        `INSERT INTO tracker_sightings (user_id, identifier_hash, latitude, longitude)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, identifierHash, location.latitude, location.longitude]
      );
      return { isAlert: false, sighting: result.rows[0] };
    }

    // Record the sighting
    const result = await pool.query(
      `INSERT INTO tracker_sightings (user_id, identifier_hash, latitude, longitude)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, identifierHash, location.latitude, location.longitude]
    );

    const sighting = result.rows[0];

    // Check for stalking pattern
    const isAlert = await this.checkStalkingPattern(userId, identifierHash);

    if (isAlert) {
      await this.createStalkingAlert(userId, identifierHash);
    }

    return { isAlert, sighting };
  }

  /**
   * Check if an identifier belongs to the user's registered devices
   */
  private async isUserDevice(userId: string, identifierHash: string): Promise<boolean> {
    const devices = await deviceService.getDevicesByUser(userId);

    for (const device of devices) {
      const keyManager = new KeyManager(device.master_secret);
      const currentHash = keyManager.getCurrentIdentifierHash();
      if (currentHash === identifierHash) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if sightings indicate a stalking pattern
   */
  private async checkStalkingPattern(
    userId: string,
    identifierHash: string
  ): Promise<boolean> {
    // Get recent sightings
    const cutoffTime = new Date(Date.now() - TIME_WINDOW);
    const result = await pool.query(
      `SELECT * FROM tracker_sightings
       WHERE user_id = $1 AND identifier_hash = $2 AND seen_at > $3
       ORDER BY seen_at ASC`,
      [userId, identifierHash, cutoffTime]
    );

    const sightings = result.rows;

    if (sightings.length < ALERT_THRESHOLD) {
      return false;
    }

    // Calculate total distance traveled with this tracker
    let totalDistance = 0;
    for (let i = 1; i < sightings.length; i++) {
      totalDistance += haversineDistance(
        sightings[i - 1].latitude,
        sightings[i - 1].longitude,
        sightings[i].latitude,
        sightings[i].longitude
      );
    }

    // If traveled more than MIN_DISTANCE_KM with this tracker, alert
    if (totalDistance > MIN_DISTANCE_KM) {
      return true;
    }

    // Check time span
    const firstSeen = new Date(sightings[0].seen_at).getTime();
    const lastSeen = new Date(sightings[sightings.length - 1].seen_at).getTime();
    const timeSpan = lastSeen - firstSeen;

    // If tracker has been with user for more than 1 hour
    if (timeSpan > 60 * 60 * 1000) {
      return true;
    }

    return false;
  }

  /**
   * Create a stalking alert notification
   */
  private async createStalkingAlert(userId: string, identifierHash: string): Promise<void> {
    // Check if we already sent an alert for this tracker recently
    const recentAlert = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND type = 'unknown_tracker'
       AND data->>'identifier_hash' = $2
       AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId, identifierHash]
    );

    if (recentAlert.rows.length > 0) {
      return; // Already alerted
    }

    // Get sighting history
    const sightings = await this.getSightings(userId, identifierHash);

    await notificationService.createNotification({
      user_id: userId,
      type: 'unknown_tracker',
      title: 'Unknown AirTag Detected',
      message:
        'An AirTag that does not belong to you has been traveling with you. Tap to learn more.',
      data: {
        identifier_hash: identifierHash,
        first_seen: sightings[0]?.seen_at,
        sighting_count: sightings.length,
      },
    });
  }

  /**
   * Get all sightings for a specific tracker by a user
   */
  async getSightings(
    userId: string,
    identifierHash: string
  ): Promise<TrackerSighting[]> {
    const cutoffTime = new Date(Date.now() - TIME_WINDOW);
    const result = await pool.query(
      `SELECT * FROM tracker_sightings
       WHERE user_id = $1 AND identifier_hash = $2 AND seen_at > $3
       ORDER BY seen_at DESC`,
      [userId, identifierHash, cutoffTime]
    );
    return result.rows;
  }

  /**
   * Get all unknown trackers detected by a user
   */
  async getUnknownTrackers(userId: string): Promise<
    Array<{
      identifier_hash: string;
      first_seen: Date;
      last_seen: Date;
      sighting_count: number;
    }>
  > {
    const cutoffTime = new Date(Date.now() - TIME_WINDOW);
    const result = await pool.query(
      `SELECT
         identifier_hash,
         MIN(seen_at) as first_seen,
         MAX(seen_at) as last_seen,
         COUNT(*) as sighting_count
       FROM tracker_sightings
       WHERE user_id = $1 AND seen_at > $2
       GROUP BY identifier_hash
       HAVING COUNT(*) >= $3
       ORDER BY last_seen DESC`,
      [userId, cutoffTime, ALERT_THRESHOLD]
    );

    // Filter out user's own devices
    const devices = await deviceService.getDevicesByUser(userId);
    const ownHashes = new Set<string>();

    for (const device of devices) {
      const keyManager = new KeyManager(device.master_secret);
      ownHashes.add(keyManager.getCurrentIdentifierHash());
    }

    return result.rows
      .filter((row: { identifier_hash: string }) => !ownHashes.has(row.identifier_hash))
      .map((row: { identifier_hash: string; first_seen: Date; last_seen: Date; sighting_count: string }) => ({
        ...row,
        sighting_count: parseInt(row.sighting_count as unknown as string),
      }));
  }

  /**
   * Get anti-stalking statistics (for admin)
   */
  async getAntiStalkingStats(): Promise<{
    totalSightings: number;
    uniqueTrackers: number;
    alertsTriggered: number;
  }> {
    const totalSightings = await pool.query(
      `SELECT COUNT(*) as count FROM tracker_sightings`
    );
    const uniqueTrackers = await pool.query(
      `SELECT COUNT(DISTINCT identifier_hash) as count FROM tracker_sightings`
    );
    const alertsTriggered = await pool.query(
      `SELECT COUNT(*) as count FROM notifications WHERE type = 'unknown_tracker'`
    );

    return {
      totalSightings: parseInt(totalSightings.rows[0].count),
      uniqueTrackers: parseInt(uniqueTrackers.rows[0].count),
      alertsTriggered: parseInt(alertsTriggered.rows[0].count),
    };
  }
}

export const antiStalkingService = new AntiStalkingService();
