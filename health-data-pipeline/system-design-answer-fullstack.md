# Health Data Pipeline - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design a health data pipeline like Apple Health, which collects metrics from multiple devices, deduplicates overlapping data, and generates actionable health insights while maintaining strict privacy. The key challenges are handling data from diverse sources with different formats, accurately deduplicating overlapping measurements from multiple devices, and protecting highly sensitive health information.

As a full-stack solution, I'll focus on the end-to-end data flow: from device sync APIs that handle unreliable mobile networks, through the aggregation pipeline that deduplicates and summarizes data, to the React dashboard that visualizes health trends. The integration points between frontend and backend - shared types, API contracts, and real-time sync status - are critical for a cohesive user experience."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Ingest**: Collect data from multiple devices (Apple Watch, iPhone, third-party)
- **Process**: Aggregate, deduplicate, normalize data
- **Store**: Persist with encryption in time-series database
- **Query**: Fast access to historical data with caching
- **Visualize**: Dashboard with charts, insights, and goal tracking
- **Share**: Controlled data sharing with providers

### Non-Functional Requirements
- **Privacy**: HIPAA-compliant, per-user encryption
- **Reliability**: Zero data loss, idempotent ingestion
- **Latency**: < 1s for dashboard queries, < 100ms for cached data
- **Offline**: Cached data available when offline

### Scale Estimates
- Millions of users with health data
- ~1,500 samples per day per user
- Years of historical data
- Write-heavy: 90% writes, 10% reads

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                    React Frontend                          |
|  Dashboard | Trends | Insights | Devices | Sharing         |
+----------------------------------------------------------+
                           |
                    REST API + SSE
                           |
+----------------------------------------------------------+
|                    Express Backend                         |
|  +----------------+  +----------------+  +--------------+  |
|  | Ingestion API  |  |   Query API    |  |  Admin API   |  |
|  | POST /sync     |  |  GET /summary  |  | GET /stats   |  |
|  +----------------+  +----------------+  +--------------+  |
+----------------------------------------------------------+
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
+-------------+    +-------------+    +-------------+
|  RabbitMQ   |    |   Valkey    |    | TimescaleDB |
|  (queues)   |    |   (cache)   |    | (storage)   |
+-------------+    +-------------+    +-------------+
                           |
                           v
               +-------------------+
               | Aggregation Worker|
               | - Deduplication   |
               | - Time Bucketing  |
               | - Insights        |
               +-------------------+
```

### Shared Types (Frontend + Backend)

```typescript
// shared/types.ts - Used by both frontend and backend

export type HealthDataType =
  | 'STEPS'
  | 'DISTANCE'
  | 'HEART_RATE'
  | 'RESTING_HEART_RATE'
  | 'WEIGHT'
  | 'BODY_FAT'
  | 'SLEEP_ANALYSIS'
  | 'ACTIVE_ENERGY'
  | 'OXYGEN_SATURATION'
  | 'BLOOD_GLUCOSE';

export type AggregationPeriod = 'hour' | 'day' | 'week' | 'month';

export type AggregationStrategy = 'sum' | 'average' | 'latest' | 'min' | 'max';

export interface HealthSample {
  id: string;
  userId: string;
  type: HealthDataType;
  value: number;
  unit: string;
  startDate: string;  // ISO 8601
  endDate: string;
  sourceDevice: string;
  sourceApp?: string;
  metadata?: Record<string, unknown>;
}

export interface HealthAggregate {
  type: HealthDataType;
  period: AggregationPeriod;
  periodStart: string;
  value: number;
  minValue?: number;
  maxValue?: number;
  sampleCount: number;
}

export interface HealthInsight {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  direction?: 'increasing' | 'decreasing';
  message: string;
  recommendation?: string;
  data: Record<string, unknown>;
  acknowledged: boolean;
  createdAt: string;
}

export interface DeviceSyncRequest {
  samples: Omit<HealthSample, 'id' | 'userId'>[];
}

export interface DeviceSyncResponse {
  synced: number;
  errors: number;
  errorDetails?: Array<{ sample: unknown; error: string }>;
}

export interface DailySummary {
  date: string;
  metrics: Partial<Record<HealthDataType, number>>;
}

// Metric configuration shared between frontend and backend
export const METRIC_CONFIG: Record<HealthDataType, {
  displayName: string;
  unit: string;
  aggregation: AggregationStrategy;
  goal?: number;
}> = {
  STEPS: { displayName: 'Steps', unit: 'steps', aggregation: 'sum', goal: 10000 },
  DISTANCE: { displayName: 'Distance', unit: 'meters', aggregation: 'sum' },
  HEART_RATE: { displayName: 'Heart Rate', unit: 'bpm', aggregation: 'average' },
  RESTING_HEART_RATE: { displayName: 'Resting HR', unit: 'bpm', aggregation: 'average' },
  WEIGHT: { displayName: 'Weight', unit: 'kg', aggregation: 'latest' },
  BODY_FAT: { displayName: 'Body Fat', unit: '%', aggregation: 'latest' },
  SLEEP_ANALYSIS: { displayName: 'Sleep', unit: 'minutes', aggregation: 'sum' },
  ACTIVE_ENERGY: { displayName: 'Calories', unit: 'kcal', aggregation: 'sum', goal: 500 },
  OXYGEN_SATURATION: { displayName: 'SpO2', unit: '%', aggregation: 'average' },
  BLOOD_GLUCOSE: { displayName: 'Glucose', unit: 'mg/dL', aggregation: 'average' },
};
```

## Deep Dive: Device Sync API (8 minutes)

### Backend: Ingestion Endpoint

```typescript
// backend/src/routes/devices.ts
import { Router } from 'express';
import { DeviceSyncRequest, DeviceSyncResponse } from '../../shared/types.js';
import { syncService } from '../services/syncService.js';
import { checkIdempotency, storeIdempotency } from '../shared/idempotency.js';

const router = Router();

router.post('/:deviceId/sync', async (req, res) => {
  const { deviceId } = req.params;
  const userId = req.session.userId;
  const body = req.body as DeviceSyncRequest;

  // Idempotency check (handles mobile retries)
  const idempotencyKey = req.headers['x-idempotency-key'] as string ||
    generateKey(userId, deviceId, body.samples);

  const cached = await checkIdempotency(idempotencyKey);
  if (cached) {
    return res.json(cached.response);
  }

  try {
    const result = await syncService.syncFromDevice(userId, deviceId, body.samples);

    // Cache response for 24 hours
    await storeIdempotency(idempotencyKey, userId, result);

    // Update device last_sync timestamp
    await updateDeviceLastSync(userId, deviceId);

    res.json(result);
  } catch (error) {
    logger.error({ error, userId, deviceId }, 'Sync failed');
    res.status(500).json({ error: 'Sync failed' });
  }
});

// SSE endpoint for sync status updates
router.get('/sync-status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const userId = req.session.userId;

  // Subscribe to sync status updates
  const unsubscribe = syncStatusPubSub.subscribe(userId, (status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
    res.end();
  });
});

export default router;
```

### Backend: Sync Service with UPSERT

```typescript
// backend/src/services/syncService.ts
import { pool } from '../shared/db.js';
import { queue } from '../shared/queue.js';
import { HealthSample, DeviceSyncResponse, METRIC_CONFIG } from '../../shared/types.js';

class SyncService {
  async syncFromDevice(
    userId: string,
    deviceId: string,
    samples: Omit<HealthSample, 'id' | 'userId'>[]
  ): Promise<DeviceSyncResponse> {
    const validSamples: HealthSample[] = [];
    const errors: Array<{ sample: unknown; error: string }> = [];

    // Validate and normalize each sample
    for (const sample of samples) {
      try {
        const validated = this.validateSample(sample, userId);
        validSamples.push(validated);
      } catch (error) {
        errors.push({ sample, error: (error as Error).message });
      }
    }

    // Batch insert with UPSERT
    if (validSamples.length > 0) {
      await this.batchInsert(validSamples);
    }

    // Queue for aggregation
    await queue.publish('health-aggregation', {
      userId,
      sampleTypes: [...new Set(validSamples.map(s => s.type))],
      dateRange: this.getDateRange(validSamples),
    });

    return {
      synced: validSamples.length,
      errors: errors.length,
      errorDetails: errors.length > 0 ? errors : undefined,
    };
  }

  private validateSample(
    sample: Omit<HealthSample, 'id' | 'userId'>,
    userId: string
  ): HealthSample {
    const config = METRIC_CONFIG[sample.type];
    if (!config) {
      throw new Error(`Unknown health type: ${sample.type}`);
    }

    // Unit normalization
    let value = sample.value;
    if (sample.unit !== config.unit) {
      value = this.convertUnit(sample.value, sample.unit, config.unit);
    }

    return {
      id: crypto.randomUUID(),
      userId,
      type: sample.type,
      value,
      unit: config.unit,
      startDate: sample.startDate,
      endDate: sample.endDate,
      sourceDevice: sample.sourceDevice,
      sourceApp: sample.sourceApp,
      metadata: sample.metadata,
    };
  }

  private async batchInsert(samples: HealthSample[]): Promise<void> {
    const values = samples.flatMap(s => [
      s.id, s.userId, s.type, s.value, s.unit,
      s.startDate, s.endDate, s.sourceDevice, s.sourceApp,
      JSON.stringify(s.metadata || {}),
    ]);

    const placeholders = samples.map((_, i) => {
      const offset = i * 10;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5},
              $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
    }).join(', ');

    await pool.query(`
      INSERT INTO health_samples
        (id, user_id, type, value, unit, start_date, end_date,
         source_device, source_app, metadata)
      VALUES ${placeholders}
      ON CONFLICT (id) DO NOTHING
    `, values);
  }
}

export const syncService = new SyncService();
```

### Frontend: Sync Hook with Retry

```typescript
// frontend/src/hooks/useDeviceSync.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeviceSyncRequest, DeviceSyncResponse } from '../../shared/types';
import { useSyncStore } from '../stores/syncStore';

export function useDeviceSync(deviceId: string) {
  const queryClient = useQueryClient();
  const { updateDeviceSync } = useSyncStore();

  return useMutation({
    mutationFn: async (request: DeviceSyncRequest): Promise<DeviceSyncResponse> => {
      // Generate idempotency key from content
      const idempotencyKey = await generateIdempotencyKey(request.samples);

      updateDeviceSync(deviceId, { isSyncing: true });

      const response = await fetch(`/api/v1/devices/${deviceId}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error('Sync failed');
      }

      return response.json();
    },
    onSuccess: (data) => {
      updateDeviceSync(deviceId, {
        isSyncing: false,
        lastSync: new Date(),
      });

      // Invalidate queries to refresh dashboard
      queryClient.invalidateQueries({ queryKey: ['dailySummary'] });
      queryClient.invalidateQueries({ queryKey: ['aggregates'] });
    },
    onError: (error) => {
      updateDeviceSync(deviceId, { isSyncing: false });
    },
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
  });
}

async function generateIdempotencyKey(samples: unknown[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(samples));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

## Deep Dive: Query API and Dashboard (8 minutes)

### Backend: Summary and Aggregates Endpoints

```typescript
// backend/src/routes/users.ts
import { Router } from 'express';
import { cache } from '../shared/cache.js';
import { pool } from '../shared/db.js';
import { DailySummary, HealthAggregate } from '../../shared/types.js';

const router = Router();

// GET /api/v1/users/me/summary?date=2024-01-15
router.get('/me/summary', async (req, res) => {
  const userId = req.session.userId;
  const date = req.query.date as string || new Date().toISOString().split('T')[0];

  // Check cache first
  const cacheKey = `summary:${userId}:${date}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Query aggregates for the day
  const result = await pool.query<{ type: string; value: number }>(`
    SELECT type, value
    FROM health_aggregates
    WHERE user_id = $1
      AND period = 'day'
      AND period_start = DATE_TRUNC('day', $2::timestamp)
  `, [userId, date]);

  const summary: DailySummary = {
    date,
    metrics: {},
  };

  for (const row of result.rows) {
    summary.metrics[row.type as keyof typeof summary.metrics] = row.value;
  }

  // Cache for 5 minutes
  await cache.set(cacheKey, JSON.stringify(summary), 300);

  res.json(summary);
});

// GET /api/v1/users/me/aggregates?types=STEPS,HEART_RATE&period=day&startDate=...&endDate=...
router.get('/me/aggregates', async (req, res) => {
  const userId = req.session.userId;
  const types = (req.query.types as string).split(',');
  const period = req.query.period as string || 'day';
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;

  const result = await pool.query<HealthAggregate>(`
    SELECT type, period, period_start, value, min_value, max_value, sample_count
    FROM health_aggregates
    WHERE user_id = $1
      AND type = ANY($2)
      AND period = $3
      AND period_start >= $4
      AND period_start <= $5
    ORDER BY type, period_start
  `, [userId, types, period, startDate, endDate]);

  // Group by type for easier frontend consumption
  const grouped: Record<string, HealthAggregate[]> = {};
  for (const row of result.rows) {
    if (!grouped[row.type]) {
      grouped[row.type] = [];
    }
    grouped[row.type].push(row);
  }

  res.json(grouped);
});

// GET /api/v1/users/me/insights
router.get('/me/insights', async (req, res) => {
  const userId = req.session.userId;
  const includeAcknowledged = req.query.includeAcknowledged === 'true';

  const query = includeAcknowledged
    ? `SELECT * FROM health_insights WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`
    : `SELECT * FROM health_insights WHERE user_id = $1 AND acknowledged = false ORDER BY created_at DESC`;

  const result = await pool.query(query, [userId]);
  res.json(result.rows);
});

export default router;
```

### Frontend: Dashboard with Summary Hook

```typescript
// frontend/src/hooks/useHealthData.ts
import { useQuery } from '@tanstack/react-query';
import { DailySummary, HealthAggregate, HealthInsight } from '../../shared/types';

export function useDailySummary(date: Date) {
  const dateStr = date.toISOString().split('T')[0];

  return useQuery<DailySummary>({
    queryKey: ['dailySummary', dateStr],
    queryFn: async () => {
      const response = await fetch(`/api/v1/users/me/summary?date=${dateStr}`);
      if (!response.ok) throw new Error('Failed to fetch summary');
      return response.json();
    },
    staleTime: 5 * 60 * 1000,  // 5 minutes
  });
}

export function useAggregates(
  types: string[],
  period: 'hour' | 'day' | 'week' | 'month',
  startDate: Date,
  endDate: Date
) {
  const start = startDate.toISOString().split('T')[0];
  const end = endDate.toISOString().split('T')[0];

  return useQuery<Record<string, HealthAggregate[]>>({
    queryKey: ['aggregates', types, period, start, end],
    queryFn: async () => {
      const params = new URLSearchParams({
        types: types.join(','),
        period,
        startDate: start,
        endDate: end,
      });
      const response = await fetch(`/api/v1/users/me/aggregates?${params}`);
      if (!response.ok) throw new Error('Failed to fetch aggregates');
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useInsights() {
  return useQuery<HealthInsight[]>({
    queryKey: ['insights'],
    queryFn: async () => {
      const response = await fetch('/api/v1/users/me/insights');
      if (!response.ok) throw new Error('Failed to fetch insights');
      return response.json();
    },
    staleTime: 60 * 1000,  // 1 minute
  });
}
```

### Frontend: Dashboard Component

```tsx
// frontend/src/routes/index.tsx
import { useDailySummary, useInsights } from '../hooks/useHealthData';
import { useHealthStore } from '../stores/healthStore';
import { METRIC_CONFIG } from '../../shared/types';
import { MetricCard } from '../components/dashboard/MetricCard';
import { InsightsPreview } from '../components/dashboard/InsightsPreview';

export function Dashboard() {
  const { selectedDate } = useHealthStore();
  const { data: summary, isLoading } = useDailySummary(selectedDate);
  const { data: insights } = useInsights();

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Health Summary
      </h1>

      {/* Insights banner */}
      {insights && insights.length > 0 && (
        <InsightsPreview insights={insights} className="mb-6" />
      )}

      {/* Activity metrics */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">Activity</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            type="STEPS"
            value={summary?.metrics.STEPS}
            config={METRIC_CONFIG.STEPS}
          />
          <MetricCard
            type="DISTANCE"
            value={summary?.metrics.DISTANCE}
            config={METRIC_CONFIG.DISTANCE}
            format={(v) => `${(v / 1000).toFixed(1)} km`}
          />
          <MetricCard
            type="ACTIVE_ENERGY"
            value={summary?.metrics.ACTIVE_ENERGY}
            config={METRIC_CONFIG.ACTIVE_ENERGY}
          />
        </div>
      </section>

      {/* Vitals metrics */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">Vitals</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            type="HEART_RATE"
            value={summary?.metrics.HEART_RATE}
            config={METRIC_CONFIG.HEART_RATE}
          />
          <MetricCard
            type="RESTING_HEART_RATE"
            value={summary?.metrics.RESTING_HEART_RATE}
            config={METRIC_CONFIG.RESTING_HEART_RATE}
          />
          <MetricCard
            type="OXYGEN_SATURATION"
            value={summary?.metrics.OXYGEN_SATURATION}
            config={METRIC_CONFIG.OXYGEN_SATURATION}
            format={(v) => `${v.toFixed(0)}%`}
          />
        </div>
      </section>

      {/* Body metrics */}
      <section>
        <h2 className="text-lg font-semibold text-gray-700 mb-4">Body</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MetricCard
            type="WEIGHT"
            value={summary?.metrics.WEIGHT}
            config={METRIC_CONFIG.WEIGHT}
            format={(v) => `${v.toFixed(1)} kg`}
          />
          <MetricCard
            type="SLEEP_ANALYSIS"
            value={summary?.metrics.SLEEP_ANALYSIS}
            config={METRIC_CONFIG.SLEEP_ANALYSIS}
            format={(v) => `${(v / 60).toFixed(1)} hours`}
          />
        </div>
      </section>
    </div>
  );
}
```

## Deep Dive: Aggregation Worker (8 minutes)

### Deduplication and Aggregation Pipeline

```typescript
// backend/src/workers/aggregation.ts
import { queue } from '../shared/queue.js';
import { pool } from '../shared/db.js';
import { cache } from '../shared/cache.js';
import { METRIC_CONFIG, HealthDataType, AggregationStrategy } from '../../shared/types.js';

interface AggregationJob {
  userId: string;
  sampleTypes: HealthDataType[];
  dateRange: { start: string; end: string };
}

// Device priority for deduplication (higher = more trusted)
const DEVICE_PRIORITY: Record<string, number> = {
  'apple_watch': 100,
  'iphone': 80,
  'ipad': 70,
  'third_party_wearable': 50,
  'third_party_scale': 40,
  'manual_entry': 10,
};

queue.consume('health-aggregation', async (job: AggregationJob) => {
  const { userId, sampleTypes, dateRange } = job;

  for (const type of sampleTypes) {
    await aggregateType(userId, type, dateRange);
  }

  // Invalidate cache for affected dates
  await invalidateCache(userId, dateRange);
});

async function aggregateType(
  userId: string,
  type: HealthDataType,
  dateRange: { start: string; end: string }
) {
  const config = METRIC_CONFIG[type];

  // Fetch raw samples
  const result = await pool.query(`
    SELECT id, value, start_date, end_date, source_device
    FROM health_samples
    WHERE user_id = $1
      AND type = $2
      AND start_date >= $3
      AND start_date <= $4
    ORDER BY start_date
  `, [userId, type, dateRange.start, dateRange.end]);

  const samples = result.rows;

  // Deduplicate overlapping samples from different sources
  const deduped = deduplicateSamples(samples, config.aggregation);

  // Generate hourly aggregates
  const hourlyAggregates = aggregateByPeriod(deduped, 'hour', config.aggregation);

  // Generate daily aggregates
  const dailyAggregates = aggregateByPeriod(deduped, 'day', config.aggregation);

  // Store aggregates with UPSERT
  await storeAggregates(userId, type, hourlyAggregates, 'hour');
  await storeAggregates(userId, type, dailyAggregates, 'day');
}

function deduplicateSamples(
  samples: Array<{
    id: string;
    value: number;
    start_date: Date;
    end_date: Date;
    source_device: string;
  }>,
  aggregation: AggregationStrategy
) {
  // Sort by device priority (highest first)
  const sorted = [...samples].sort((a, b) =>
    (DEVICE_PRIORITY[b.source_device] || 0) - (DEVICE_PRIORITY[a.source_device] || 0)
  );

  const result = [];
  const coveredRanges: Array<{ start: Date; end: Date }> = [];

  for (const sample of sorted) {
    const start = new Date(sample.start_date);
    const end = new Date(sample.end_date);

    const overlap = findOverlap(start, end, coveredRanges);

    if (!overlap) {
      // No overlap - include full sample
      result.push(sample);
      coveredRanges.push({ start, end });
    } else if (overlap.partial && aggregation === 'sum') {
      // Partial overlap - adjust value proportionally for sum metrics
      const totalDuration = end.getTime() - start.getTime();
      const overlapDuration = overlap.overlapEnd.getTime() - overlap.overlapStart.getTime();
      const remainingRatio = (totalDuration - overlapDuration) / totalDuration;

      if (remainingRatio > 0) {
        result.push({
          ...sample,
          value: sample.value * remainingRatio,
        });
      }
    }
    // Full overlap: skip (higher priority device already covered this time)
  }

  return result;
}

function findOverlap(
  start: Date,
  end: Date,
  coveredRanges: Array<{ start: Date; end: Date }>
) {
  for (const range of coveredRanges) {
    if (start < range.end && end > range.start) {
      const overlapStart = new Date(Math.max(start.getTime(), range.start.getTime()));
      const overlapEnd = new Date(Math.min(end.getTime(), range.end.getTime()));

      if (overlapStart.getTime() === start.getTime() && overlapEnd.getTime() === end.getTime()) {
        return { full: true };
      }

      return { partial: true, overlapStart, overlapEnd };
    }
  }
  return null;
}

function aggregate(values: number[], strategy: AggregationStrategy): number {
  switch (strategy) {
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

async function storeAggregates(
  userId: string,
  type: HealthDataType,
  aggregates: Array<{ periodStart: Date; value: number; count: number }>,
  period: string
) {
  for (const agg of aggregates) {
    await pool.query(`
      INSERT INTO health_aggregates
        (user_id, type, period, period_start, value, sample_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, type, period, period_start)
      DO UPDATE SET
        value = EXCLUDED.value,
        sample_count = EXCLUDED.sample_count,
        updated_at = NOW()
    `, [userId, type, period, agg.periodStart, agg.value, agg.count]);
  }
}

async function invalidateCache(userId: string, dateRange: { start: string; end: string }) {
  // Invalidate summary cache for affected dates
  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    await cache.del(`summary:${userId}:${dateStr}`);
  }
}
```

## Deep Dive: Share Token System (5 minutes)

### Backend: Share Token Endpoints

```typescript
// backend/src/routes/sharing.ts
import { Router } from 'express';
import { pool } from '../shared/db.js';
import { HealthDataType } from '../../shared/types.js';

const router = Router();

interface CreateShareRequest {
  recipientEmail: string;
  dataTypes: HealthDataType[];
  dateStart: string;
  dateEnd: string;
  expiresAt: string;
}

// Create a share token
router.post('/tokens', async (req, res) => {
  const userId = req.session.userId;
  const { recipientEmail, dataTypes, dateStart, dateEnd, expiresAt } = req.body as CreateShareRequest;

  const accessCode = crypto.randomUUID().replace(/-/g, '').substring(0, 12);

  const result = await pool.query(`
    INSERT INTO share_tokens
      (user_id, recipient_email, data_types, date_start, date_end, expires_at, access_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, access_code, expires_at
  `, [userId, recipientEmail, dataTypes, dateStart, dateEnd, expiresAt, accessCode]);

  res.json({
    id: result.rows[0].id,
    accessCode: result.rows[0].access_code,
    shareUrl: `${process.env.BASE_URL}/shared/${result.rows[0].access_code}`,
    expiresAt: result.rows[0].expires_at,
  });
});

// Access shared data (no auth required - uses access code)
router.get('/data/:accessCode', async (req, res) => {
  const { accessCode } = req.params;

  // Validate token
  const tokenResult = await pool.query(`
    SELECT user_id, data_types, date_start, date_end
    FROM share_tokens
    WHERE access_code = $1
      AND expires_at > NOW()
      AND revoked_at IS NULL
  `, [accessCode]);

  if (tokenResult.rows.length === 0) {
    return res.status(404).json({ error: 'Invalid or expired share link' });
  }

  const token = tokenResult.rows[0];

  // Fetch authorized data
  const dataResult = await pool.query(`
    SELECT type, period_start, value
    FROM health_aggregates
    WHERE user_id = $1
      AND type = ANY($2)
      AND period = 'day'
      AND period_start >= $3
      AND period_start <= $4
    ORDER BY type, period_start
  `, [token.user_id, token.data_types, token.date_start, token.date_end]);

  res.json({
    dataTypes: token.data_types,
    dateRange: { start: token.date_start, end: token.date_end },
    data: dataResult.rows,
  });
});

// Revoke a share token
router.delete('/tokens/:tokenId', async (req, res) => {
  const userId = req.session.userId;
  const { tokenId } = req.params;

  await pool.query(`
    UPDATE share_tokens
    SET revoked_at = NOW()
    WHERE id = $1 AND user_id = $2
  `, [tokenId, userId]);

  res.json({ success: true });
});

export default router;
```

### Frontend: Share Modal Component

```tsx
// frontend/src/components/sharing/CreateShareModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { METRIC_CONFIG, HealthDataType } from '../../../shared/types';

interface CreateShareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateShareModal({ isOpen, onClose }: CreateShareModalProps) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<HealthDataType[]>([]);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [expiresIn, setExpiresIn] = useState<'7d' | '30d' | '90d'>('30d');

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async () => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresIn));

      const response = await fetch('/api/v1/sharing/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientEmail,
          dataTypes: selectedTypes,
          dateStart: dateRange.start,
          dateEnd: dateRange.end,
          expiresAt: expiresAt.toISOString(),
        }),
      });

      if (!response.ok) throw new Error('Failed to create share');
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['shareTokens'] });
      // Show success with share URL
      navigator.clipboard.writeText(data.shareUrl);
      onClose();
    },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <h2 className="text-xl font-bold mb-4">Share Health Data</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Recipient Email</label>
            <input
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
              placeholder="doctor@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Data Types</label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(METRIC_CONFIG).map(([type, config]) => (
                <button
                  key={type}
                  onClick={() => {
                    setSelectedTypes((prev) =>
                      prev.includes(type as HealthDataType)
                        ? prev.filter((t) => t !== type)
                        : [...prev, type as HealthDataType]
                    );
                  }}
                  className={`px-3 py-1 rounded-full text-sm ${
                    selectedTypes.includes(type as HealthDataType)
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {config.displayName}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Start Date</label>
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange((r) => ({ ...r, start: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">End Date</label>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange((r) => ({ ...r, end: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Link Expires In</label>
            <select
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value as typeof expiresIn)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
            </select>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg"
          >
            {createMutation.isPending ? 'Creating...' : 'Create Share Link'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB | InfluxDB | SQL compatibility, can join with users/devices tables |
| Aggregation | Pre-computed + queue | On-demand | Fast dashboard queries, background processing absorbs load |
| Deduplication | Priority-based | Latest-wins | Apple Watch sensors more accurate; consistent behavior |
| Sync | Batch with idempotency | Real-time streaming | Battery efficiency, network resilience, simpler retry logic |
| Caching | Valkey with invalidation | React Query only | Shared cache across API instances, faster cold loads |
| Charts | Recharts | D3.js | React-native, declarative API, good for time-series |

### Full-Stack Trade-off: Shared Types

**Monorepo with Shared Package (Chosen)**
- Pro: Single source of truth for types
- Pro: TypeScript catches mismatches at build time
- Con: More complex build setup

**Separate Type Definitions**
- Pro: Independent deployments
- Con: Types can drift, runtime errors

### Full-Stack Trade-off: Cache Invalidation

**Backend-initiated invalidation (Chosen)**
- Pro: Cache always consistent after aggregation
- Pro: Frontend queries always get fresh data
- Con: Slightly more complex worker logic

**TTL-only caching**
- Pro: Simpler implementation
- Con: Stale data shown for TTL duration after sync

## Closing Summary (1 minute)

"The health data pipeline is built as a cohesive full-stack system with three key integration points:

1. **Shared Types** - TypeScript types for health samples, aggregates, and insights are shared between frontend and backend. The `METRIC_CONFIG` object defines display names, units, and aggregation strategies in one place.

2. **Idempotent Sync** - The device sync API uses content-based idempotency keys that can be generated on both client and server. This enables safe retries on unreliable mobile networks while preventing duplicate data.

3. **Cache Coordination** - The aggregation worker invalidates Valkey cache entries after computing new aggregates. React Query on the frontend respects `staleTime` for optimistic performance while the backend ensures cache consistency.

The main trade-off is complexity for correctness. Shared types require a monorepo setup, but catch API contract violations at build time. Priority-based deduplication is more complex than last-write-wins, but ensures accurate step counts when users carry both iPhone and Apple Watch."
