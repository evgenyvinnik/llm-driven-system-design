import { db } from '../config/database.js';
import { cache } from '../config/redis.js';
import { HealthDataTypes, DevicePriority, getAggregationType, AggregationType, HealthDataTypeKey } from '../models/healthTypes.js';

interface DateRange {
  start: Date;
  end: Date;
}

interface HealthSample {
  id: string;
  user_id: string;
  type: string;
  value: number;
  start_date: Date | string;
  end_date: Date | string;
  source_device: string;
  source_device_id?: string;
  device_priority?: number;
}

interface TimeRange {
  start: number;
  end: number;
}

interface Overlap {
  full?: boolean;
  partial?: boolean;
  side?: 'start' | 'end';
  range: TimeRange;
}

interface Aggregate {
  periodStart: Date;
  period: string;
  value: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
}

export class AggregationService {
  // Queue aggregation job (in production would use Redis queue/Bull)
  async queueAggregation(userId: string, types: string[], dateRange: DateRange): Promise<void> {
    // For simplicity, process immediately
    // In production, would use a job queue
    await this.processAggregation(userId, types, dateRange);
  }

  async processAggregation(userId: string, types: string[], dateRange: DateRange): Promise<void> {
    for (const type of types) {
      await this.aggregateType(userId, type, dateRange);
    }
  }

  async aggregateType(userId: string, type: string, dateRange: DateRange): Promise<void> {
    const aggregationType = getAggregationType(type);

    // Get raw samples
    const samples = await db.query(
      `SELECT hs.*, ud.priority as device_priority
       FROM health_samples hs
       LEFT JOIN user_devices ud ON hs.source_device_id = ud.id
       WHERE hs.user_id = $1
         AND hs.type = $2
         AND hs.start_date >= $3
         AND hs.start_date <= $4
       ORDER BY hs.start_date, ud.priority DESC NULLS LAST`,
      [userId, type, dateRange.start, dateRange.end]
    );

    if (samples.rows.length === 0) return;

    // Deduplicate samples
    const deduped = this.deduplicateSamples(samples.rows as HealthSample[]);

    // Generate hourly aggregates
    const hourlyAggregates = this.aggregateByPeriod(deduped, 'hour', aggregationType);
    await this.storeAggregates(userId, type, hourlyAggregates, 'hour');

    // Generate daily aggregates
    const dailyAggregates = this.aggregateByPeriod(deduped, 'day', aggregationType);
    await this.storeAggregates(userId, type, dailyAggregates, 'day');

    // Invalidate cache
    await cache.invalidateUser(userId);
  }

  deduplicateSamples(samples: HealthSample[]): HealthSample[] {
    // Sort by device priority (higher priority first)
    const prioritized = [...samples].sort((a, b) => {
      const priorityA = a.device_priority || DevicePriority[a.source_device as keyof typeof DevicePriority] || 0;
      const priorityB = b.device_priority || DevicePriority[b.source_device as keyof typeof DevicePriority] || 0;
      return priorityB - priorityA;
    });

    const result: HealthSample[] = [];
    const coveredRanges: TimeRange[] = [];

    for (const sample of prioritized) {
      const startTime = new Date(sample.start_date).getTime();
      const endTime = new Date(sample.end_date).getTime();

      const overlap = this.findOverlap(startTime, endTime, coveredRanges);

      if (!overlap) {
        // No overlap, include full sample
        result.push(sample);
        coveredRanges.push({ start: startTime, end: endTime });
      } else if (overlap.partial) {
        // Partial overlap - adjust sample
        const adjusted = this.adjustForOverlap(sample, overlap);
        if (adjusted) {
          result.push(adjusted);
          coveredRanges.push({
            start: new Date(adjusted.start_date).getTime(),
            end: new Date(adjusted.end_date).getTime()
          });
        }
      }
      // Full overlap: skip (higher priority sample already covers this time)
    }

    return result;
  }

  findOverlap(start: number, end: number, coveredRanges: TimeRange[]): Overlap | null {
    for (const range of coveredRanges) {
      // Full overlap
      if (start >= range.start && end <= range.end) {
        return { full: true, range };
      }
      // Partial overlap at start
      if (start < range.start && end > range.start && end <= range.end) {
        return { partial: true, side: 'end', range };
      }
      // Partial overlap at end
      if (start >= range.start && start < range.end && end > range.end) {
        return { partial: true, side: 'start', range };
      }
    }
    return null;
  }

  adjustForOverlap(sample: HealthSample, overlap: Overlap): HealthSample | null {
    // Calculate proportion of value to keep
    const totalDuration = new Date(sample.end_date).getTime() - new Date(sample.start_date).getTime();
    if (totalDuration === 0) return null;

    let newStart = new Date(sample.start_date);
    let newEnd = new Date(sample.end_date);

    if (overlap.side === 'end') {
      newEnd = new Date(overlap.range.start);
    } else if (overlap.side === 'start') {
      newStart = new Date(overlap.range.end);
    }

    const newDuration = newEnd.getTime() - newStart.getTime();
    if (newDuration <= 0) return null;

    const proportion = newDuration / totalDuration;

    return {
      ...sample,
      start_date: newStart,
      end_date: newEnd,
      value: sample.value * proportion
    };
  }

  aggregateByPeriod(samples: HealthSample[], period: string, aggregationType: AggregationType): Aggregate[] {
    const buckets = new Map<string, number[]>();

    for (const sample of samples) {
      const bucketKey = this.getBucketKey(new Date(sample.start_date), period);

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey)!.push(sample.value);
    }

    const aggregates: Aggregate[] = [];
    for (const [key, values] of buckets) {
      aggregates.push({
        periodStart: new Date(key),
        period,
        value: this.aggregate(values, aggregationType),
        minValue: Math.min(...values),
        maxValue: Math.max(...values),
        sampleCount: values.length
      });
    }

    return aggregates;
  }

  getBucketKey(date: Date, period: string): string {
    const d = new Date(date);
    switch (period) {
      case 'hour':
        d.setMinutes(0, 0, 0);
        break;
      case 'day':
        d.setHours(0, 0, 0, 0);
        break;
      case 'week':
        const day = d.getDay();
        d.setDate(d.getDate() - day);
        d.setHours(0, 0, 0, 0);
        break;
      case 'month':
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        break;
    }
    return d.toISOString();
  }

  aggregate(values: number[], type: AggregationType): number {
    if (values.length === 0) return 0;

    switch (type) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'average':
        return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'latest':
        return values[values.length - 1];
      default:
        return values[0];
    }
  }

  async storeAggregates(userId: string, type: string, aggregates: Aggregate[], period: string): Promise<void> {
    for (const agg of aggregates) {
      await db.query(
        `INSERT INTO health_aggregates
           (user_id, type, period, period_start, value, min_value, max_value, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, type, period, period_start)
         DO UPDATE SET
           value = $5,
           min_value = $6,
           max_value = $7,
           sample_count = $8,
           updated_at = NOW()`,
        [userId, type, period, agg.periodStart, agg.value, agg.minValue, agg.maxValue, agg.sampleCount]
      );
    }
  }

  // Manual re-aggregation for a user
  async reaggregateUser(userId: string, startDate: Date, endDate: Date): Promise<void> {
    const types = Object.keys(HealthDataTypes);
    await this.processAggregation(userId, types, { start: startDate, end: endDate });
  }
}

export const aggregationService = new AggregationService();
