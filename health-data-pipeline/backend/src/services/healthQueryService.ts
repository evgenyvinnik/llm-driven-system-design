import { db } from '../config/database.js';
import { cache } from '../config/redis.js';

interface GetSamplesOptions {
  type?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

interface GetAggregatesOptions {
  types: string[];
  period?: string;
  startDate: Date;
  endDate: Date;
}

interface SampleRow {
  id: string;
  user_id: string;
  type: string;
  value: number;
  unit: string;
  start_date: Date;
  end_date: Date;
  source_device: string | null;
  source_device_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface AggregateRow {
  type: string;
  period_start: Date;
  value: number;
  min_value: number;
  max_value: number;
  sample_count: number;
}

interface AggregateData {
  date: Date;
  value: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
}

interface WeeklySummaryRow {
  type: string;
  total: string;
  average: string;
  min_value: number;
  max_value: number;
  sample_count: string;
}

interface SummaryData {
  value: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
}

interface WeeklySummaryData {
  total: number;
  average: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
}

interface LatestMetricRow {
  type: string;
  value: number;
  date: Date;
}

interface HistoricalRow {
  date: Date;
  value: number;
  min_value: number;
  max_value: number;
  sample_count: number;
}

interface HealthDataTypeRow {
  type: string;
  category: string;
  unit: string;
  aggregation: string;
}

export class HealthQueryService {
  async getSamples(userId: string, options: GetSamplesOptions): Promise<SampleRow[]> {
    const { type, startDate, endDate, limit = 1000, offset = 0 } = options;

    let query = `
      SELECT * FROM health_samples
      WHERE user_id = $1
    `;
    const params: unknown[] = [userId];
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

    const result = await db.query<SampleRow>(query, params);
    return result.rows;
  }

  async getAggregates(userId: string, options: GetAggregatesOptions): Promise<Record<string, AggregateData[]>> {
    const { types, period = 'day', startDate, endDate } = options;

    // Check cache first
    const cacheKey = `aggregates:${userId}:${types.join(',')}:${period}:${startDate.toISOString()}:${endDate.toISOString()}`;
    const cached = await cache.get<Record<string, AggregateData[]>>(cacheKey);
    if (cached) return cached;

    const result = await db.query<AggregateRow>(
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
    const grouped: Record<string, AggregateData[]> = {};
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

  async getDailySummary(userId: string, date: Date): Promise<Record<string, SummaryData>> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const cacheKey = `summary:${userId}:${startOfDay.toISOString().split('T')[0]}`;
    const cached = await cache.get<Record<string, SummaryData>>(cacheKey);
    if (cached) return cached;

    const result = await db.query<AggregateRow>(
      `SELECT type, value, min_value, max_value, sample_count
       FROM health_aggregates
       WHERE user_id = $1
         AND period = 'day'
         AND period_start >= $2
         AND period_start < $3`,
      [userId, startOfDay, endOfDay]
    );

    const summary: Record<string, SummaryData> = {};
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

  async getWeeklySummary(userId: string): Promise<Record<string, WeeklySummaryData>> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const result = await db.query<WeeklySummaryRow>(
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

    const summary: Record<string, WeeklySummaryData> = {};
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

  async getHealthDataTypes(): Promise<HealthDataTypeRow[]> {
    const result = await db.query<HealthDataTypeRow>(
      `SELECT * FROM health_data_types ORDER BY category, type`
    );
    return result.rows;
  }

  async getLatestMetrics(userId: string): Promise<Record<string, { value: number; date: Date }>> {
    // Get latest value for each metric type
    const result = await db.query<LatestMetricRow>(
      `SELECT DISTINCT ON (type) type, value, period_start as date
       FROM health_aggregates
       WHERE user_id = $1 AND period = 'day'
       ORDER BY type, period_start DESC`,
      [userId]
    );

    const latest: Record<string, { value: number; date: Date }> = {};
    for (const row of result.rows) {
      latest[row.type] = {
        value: row.value,
        date: row.date
      };
    }

    return latest;
  }

  async getHistoricalData(userId: string, type: string, days: number = 30): Promise<HistoricalRow[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await db.query<HistoricalRow>(
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
