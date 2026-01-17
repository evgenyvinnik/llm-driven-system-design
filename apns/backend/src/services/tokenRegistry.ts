import db from "../db/index.js";
import {
  DeviceToken,
  DeviceInfo,
  RegisterDeviceResponse,
} from "../types/index.js";
import { hashToken, generateUUID } from "../utils/index.js";

export class TokenRegistry {
  async registerToken(
    token: string,
    appBundleId: string,
    deviceInfo?: DeviceInfo
  ): Promise<RegisterDeviceResponse> {
    const tokenHash = hashToken(token);

    // Check if token already exists
    const existing = await db.query<DeviceToken>(
      `SELECT * FROM device_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (existing.rows.length > 0) {
      // Update last seen and device info
      await db.query(
        `UPDATE device_tokens
         SET last_seen = NOW(), device_info = COALESCE($2, device_info), is_valid = true
         WHERE token_hash = $1`,
        [tokenHash, deviceInfo ? JSON.stringify(deviceInfo) : null]
      );

      return { device_id: existing.rows[0].device_id, is_new: false };
    }

    // Create new token
    const deviceId = generateUUID();
    await db.query(
      `INSERT INTO device_tokens (device_id, token_hash, app_bundle_id, device_info, created_at, last_seen)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [deviceId, tokenHash, appBundleId, deviceInfo ? JSON.stringify(deviceInfo) : null]
    );

    return { device_id: deviceId, is_new: true };
  }

  async lookup(token: string): Promise<DeviceToken | null> {
    const tokenHash = hashToken(token);

    const result = await db.query<DeviceToken>(
      `SELECT * FROM device_tokens
       WHERE token_hash = $1 AND is_valid = true`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async lookupById(deviceId: string): Promise<DeviceToken | null> {
    const result = await db.query<DeviceToken>(
      `SELECT * FROM device_tokens WHERE device_id = $1`,
      [deviceId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async invalidateToken(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);

    await db.query(
      `UPDATE device_tokens
       SET is_valid = false, invalidated_at = NOW(), invalidation_reason = $2
       WHERE token_hash = $1`,
      [tokenHash, reason]
    );

    // Get token info for feedback queue
    const tokenInfo = await db.query<DeviceToken>(
      `SELECT app_bundle_id, invalidated_at FROM device_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (tokenInfo.rows.length > 0) {
      // Store in feedback queue for providers
      await db.query(
        `INSERT INTO feedback_queue (token_hash, app_bundle_id, reason, timestamp)
         VALUES ($1, $2, $3, $4)`,
        [
          tokenHash,
          tokenInfo.rows[0].app_bundle_id,
          reason,
          tokenInfo.rows[0].invalidated_at,
        ]
      );
    }
  }

  async subscribeToTopic(deviceToken: string, topic: string): Promise<void> {
    const device = await this.lookup(deviceToken);
    if (!device) {
      throw new Error("Invalid token");
    }

    await db.query(
      `INSERT INTO topic_subscriptions (device_id, topic)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [device.device_id, topic]
    );
  }

  async unsubscribeFromTopic(deviceToken: string, topic: string): Promise<void> {
    const device = await this.lookup(deviceToken);
    if (!device) {
      throw new Error("Invalid token");
    }

    await db.query(
      `DELETE FROM topic_subscriptions WHERE device_id = $1 AND topic = $2`,
      [device.device_id, topic]
    );
  }

  async getDeviceTopics(deviceId: string): Promise<string[]> {
    const result = await db.query<{ topic: string }>(
      `SELECT topic FROM topic_subscriptions WHERE device_id = $1`,
      [deviceId]
    );

    return result.rows.map((row) => row.topic);
  }

  async getDevicesForTopic(topic: string): Promise<DeviceToken[]> {
    const result = await db.query<DeviceToken>(
      `SELECT dt.* FROM device_tokens dt
       JOIN topic_subscriptions ts ON dt.device_id = ts.device_id
       WHERE ts.topic = $1 AND dt.is_valid = true`,
      [topic]
    );

    return result.rows;
  }

  async getAllDevices(
    limit: number = 100,
    offset: number = 0
  ): Promise<{ devices: DeviceToken[]; total: number }> {
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM device_tokens`
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await db.query<DeviceToken>(
      `SELECT * FROM device_tokens ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { devices: result.rows, total };
  }

  async getDeviceStats(): Promise<{
    total: number;
    valid: number;
    invalid: number;
  }> {
    const result = await db.query<{ total: string; valid: string; invalid: string }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE is_valid = true) as valid,
         COUNT(*) FILTER (WHERE is_valid = false) as invalid
       FROM device_tokens`
    );

    return {
      total: parseInt(result.rows[0].total, 10),
      valid: parseInt(result.rows[0].valid, 10),
      invalid: parseInt(result.rows[0].invalid, 10),
    };
  }

  async getTopicStats(): Promise<{ topic: string; subscriber_count: number }[]> {
    const result = await db.query<{ topic: string; subscriber_count: string }>(
      `SELECT topic, COUNT(*) as subscriber_count
       FROM topic_subscriptions ts
       JOIN device_tokens dt ON ts.device_id = dt.device_id
       WHERE dt.is_valid = true
       GROUP BY topic
       ORDER BY subscriber_count DESC
       LIMIT 50`
    );

    return result.rows.map((row) => ({
      topic: row.topic,
      subscriber_count: parseInt(row.subscriber_count, 10),
    }));
  }
}

export const tokenRegistry = new TokenRegistry();
