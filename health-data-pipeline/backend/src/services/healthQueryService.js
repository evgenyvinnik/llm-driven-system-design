import { db } from '../config/database.js';
import { cache } from '../config/redis.js';

export class HealthQueryService {
  async getSamples(userId, options) {
    const { type, startDate, endDate, limit = 1000, offset = 0 } = options;

    let query = `
      SELECT * FROM health_samples
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (type) {
      query += ` AND type = $${paramIndex++}`;
      params.push(type);
    }

    if (startDate) {
      query += ` AND start_date >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND start_date <= $${paramIndex++}`;
      params.push(endDate);
    }

    query += ` ORDER BY start_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  async getAggregates(userId, options) {
    const { types, period = 'day', startDate, endDate } = options;

    // Check cache first
    const cacheKey = `aggregates:${userId}:${types.join(',')}:${period}:${startDate}:${endDate}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const result = await db.query(
      `SELECT type, period_start, value, min_value, max_value, sample_count
       FROM health_aggregates
       WHERE user_id = $1
         AND type = ANY($2)
         AND period = $3
         AND period_start >= $4
         AND period_start <= $5
       ORDER BY type, period_start`,
      [userId, types, period, startDate, endDate]
    );

    // Group by type
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.type]) {
        grouped[row.type] = [];
      }
      grouped[row.type].push({
        date: row.period_start,
        value: row.value,
        minValue: row.min_value,
        maxValue: row.max_value,
        sampleCount: row.sample_count
      });
    }

    // Cache for 5 minutes
    await cache.set(cacheKey, grouped, 300);

    return grouped;
  }

  async getDailySummary(userId, date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const cacheKey = `summary:${userId}:${startOfDay.toISOString().split('T')[0]}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const result = await db.query(
      `SELECT type, value, min_value, max_value, sample_count
       FROM health_aggregates
       WHERE user_id = $1
         AND period = 'day'
         AND period_start >= $2
         AND period_start < $3`,
      [userId, startOfDay, endOfDay]
    );

    const summary = {};
    for (const row of result.rows) {
      summary[row.type] = {
        value: row.value,
        minValue: row.min_value,
        maxValue: row.max_value,
        sampleCount: row.sample_count
      };
    }

    // Cache for 5 minutes
    await cache.set(cacheKey, summary, 300);

    return summary;
  }

  async getWeeklySummary(userId) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const result = await db.query(
      `SELECT type,
              SUM(value) as total,
              AVG(value) as average,
              MIN(min_value) as min_value,
              MAX(max_value) as max_value,
              SUM(sample_count) as sample_count
       FROM health_aggregates
       WHERE user_id = $1
         AND period = 'day'
         AND period_start >= $2
         AND period_start <= $3
       GROUP BY type`,
      [userId, startDate, endDate]
    );

    const summary = {};
    for (const row of result.rows) {
      summary[row.type] = {
        total: parseFloat(row.total),
        average: parseFloat(row.average),
        minValue: row.min_value,
        maxValue: row.max_value,
        sampleCount: parseInt(row.sample_count)
      };
    }

    return summary;
  }

  async getHealthDataTypes() {
    const result = await db.query(
      `SELECT * FROM health_data_types ORDER BY category, type`
    );
    return result.rows;
  }

  async getLatestMetrics(userId) {
    // Get latest value for each metric type
    const result = await db.query(
      `SELECT DISTINCT ON (type) type, value, period_start as date
       FROM health_aggregates
       WHERE user_id = $1 AND period = 'day'
       ORDER BY type, period_start DESC`,
      [userId]
    );

    const latest = {};
    for (const row of result.rows) {
      latest[row.type] = {
        value: row.value,
        date: row.date
      };
    }

    return latest;
  }

  async getHistoricalData(userId, type, days = 30) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await db.query(
      `SELECT period_start as date, value, min_value, max_value, sample_count
       FROM health_aggregates
       WHERE user_id = $1
         AND type = $2
         AND period = 'day'
         AND period_start >= $3
         AND period_start <= $4
       ORDER BY period_start`,
      [userId, type, startDate, endDate]
    );

    return result.rows;
  }
}

export const healthQueryService = new HealthQueryService();
