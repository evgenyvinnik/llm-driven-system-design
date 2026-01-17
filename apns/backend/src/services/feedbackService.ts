import db from "../db/index.js";
import { FeedbackEntry } from "../types/index.js";

export class FeedbackService {
  async reportInvalidToken(tokenHash: string, reason: string): Promise<void> {
    // Get app info for the token
    const tokenInfo = await db.query<{ app_bundle_id: string; invalidated_at: Date }>(
      `SELECT app_bundle_id, invalidated_at FROM device_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (tokenInfo.rows.length === 0) return;

    const { app_bundle_id, invalidated_at } = tokenInfo.rows[0];

    // Store in feedback queue for providers
    await db.query(
      `INSERT INTO feedback_queue (token_hash, app_bundle_id, reason, timestamp)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, app_bundle_id, reason, invalidated_at || new Date()]
    );
  }

  async getFeedback(
    appBundleId: string,
    since?: Date
  ): Promise<FeedbackEntry[]> {
    const sinceDate = since || new Date(0);

    const result = await db.query<FeedbackEntry>(
      `SELECT * FROM feedback_queue
       WHERE app_bundle_id = $1 AND timestamp > $2
       ORDER BY timestamp ASC
       LIMIT 1000`,
      [appBundleId, sinceDate]
    );

    return result.rows;
  }

  async getAllFeedback(
    limit: number = 100,
    offset: number = 0
  ): Promise<{ feedback: FeedbackEntry[]; total: number }> {
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM feedback_queue`
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await db.query<FeedbackEntry>(
      `SELECT * FROM feedback_queue
       ORDER BY timestamp DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { feedback: result.rows, total };
  }

  async clearFeedback(appBundleId: string, beforeTimestamp?: Date): Promise<number> {
    let query = `DELETE FROM feedback_queue WHERE app_bundle_id = $1`;
    const params: unknown[] = [appBundleId];

    if (beforeTimestamp) {
      query += ` AND timestamp <= $2`;
      params.push(beforeTimestamp);
    }

    const result = await db.query(query, params);
    return result.rowCount || 0;
  }
}

export const feedbackService = new FeedbackService();
