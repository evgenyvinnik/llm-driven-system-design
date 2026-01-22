# Ad Click Aggregator - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design a real-time ad click aggregation system with an analytics dashboard. Key challenges include:
- End-to-end click tracking from ingestion to visualization
- Exactly-once semantics across the full stack
- Real-time aggregation with sub-second dashboard updates
- Fraud detection integrated into the data pipeline
- Hybrid storage architecture for OLTP and OLAP workloads

## Requirements Clarification

### Functional Requirements
1. **Click Ingestion API**: Accept clicks with validation and deduplication
2. **Real-time Aggregation**: Aggregate by multiple dimensions (campaign, country, device)
3. **Analytics Dashboard**: Time-series charts, KPI cards, drill-down tables
4. **Fraud Detection**: Velocity-based detection with flagging (not blocking)
5. **Test Tools**: Click generator for development and testing

### Non-Functional Requirements
1. **Throughput**: 10,000 clicks/second ingestion capacity
2. **Latency**: API < 10ms, Dashboard queries < 100ms
3. **Consistency**: Exactly-once semantics for billing accuracy
4. **Freshness**: Dashboard reflects data within 5 seconds

### Scale Estimates
- 864 million clicks/day at peak
- ~430 GB/day raw data
- 100-1,000 concurrent dashboard users
- 5-second dashboard refresh interval

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               FRONTEND (React)                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ KPI Cards    │  │ Time-Series  │  │ Campaign     │  │ Test Click           │ │
│  │ (Real-time)  │  │ Charts       │  │ Tables       │  │ Generator            │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────────┤
│                               Zustand Store                                       │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌─────────────────────┐  │
│  │ Metrics & Time-Series │  │ Filters & Time Range  │  │ UI State            │  │
│  └───────────────────────┘  └───────────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ HTTP (5s polling)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               BACKEND (Express)                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Click API    │  │ Analytics    │  │ Fraud        │  │ Admin API            │ │
│  │ POST /clicks │  │ GET /agg     │  │ Detection    │  │ GET /stats           │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘  └──────────────────────┘ │
│         │                 │                                                       │
│  ┌──────┴─────────────────┴─────────────────────────────────────────────────┐   │
│  │                        Service Layer                                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────┐   │   │
│  │  │ Ingestion  │  │ Query      │  │ Fraud      │  │ Deduplication      │   │   │
│  │  │ Service    │  │ Service    │  │ Service    │  │ Service (Redis)    │   │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
            ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
            │   Redis     │     │ PostgreSQL  │     │ ClickHouse  │
            │ (Dedup/     │     │ (Entities/  │     │ (Analytics/ │
            │  Rate Limit)│     │  Audit)     │     │  OLAP)      │
            └─────────────┘     └─────────────┘     └─────────────┘
```

## Deep Dive: End-to-End Click Flow

### 1. Click Ingestion (Frontend to Backend)

```typescript
// Frontend: Test Click Generator
async function generateClick() {
  const click = {
    ad_id: `ad_${Math.floor(Math.random() * 10)}`,
    campaign_id: `camp_${Math.floor(Math.random() * 5)}`,
    advertiser_id: `adv_${Math.floor(Math.random() * 3)}`,
    country: 'US',
    device_type: 'mobile',
  };

  const response = await fetch('/api/v1/clicks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(), // Prevent retries
    },
    body: JSON.stringify(click),
  });

  return response.json();
}
```

### 2. Backend Ingestion Pipeline

```typescript
// routes/clicks.ts
import { z } from 'zod';

const clickSchema = z.object({
  ad_id: z.string().min(1),
  campaign_id: z.string().min(1),
  advertiser_id: z.string().min(1),
  user_id: z.string().optional(),
  country: z.string().length(2).optional(),
  device_type: z.enum(['mobile', 'desktop', 'tablet']).optional(),
  os: z.string().optional(),
  browser: z.string().optional(),
});

router.post('/clicks', async (req, res) => {
  // 1. Validate input
  const parsed = clickSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // 2. Check idempotency key
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}`);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }
  }

  // 3. Generate click ID and check for duplicates
  const clickId = crypto.randomUUID();
  const isDuplicate = await deduplicationService.check(clickId);

  if (isDuplicate) {
    return res.status(200).json({
      success: true,
      click_id: clickId,
      is_duplicate: true,
    });
  }

  // 4. Run fraud detection
  const fraudResult = await fraudService.detect(parsed.data, req.ip);

  // 5. Enrich click data
  const enrichedClick = {
    click_id: clickId,
    ...parsed.data,
    timestamp: new Date(),
    ip_hash: hashIp(req.ip),
    is_fraudulent: fraudResult.isFraudulent,
    fraud_reason: fraudResult.reason,
  };

  // 6. Store in databases
  await Promise.all([
    postgresService.insertClick(enrichedClick),  // Audit trail
    clickhouseService.insertClick(enrichedClick), // Analytics
  ]);

  // 7. Cache response for idempotency
  const response = {
    success: true,
    click_id: clickId,
    is_duplicate: false,
    is_fraudulent: fraudResult.isFraudulent,
  };

  if (idempotencyKey) {
    await redis.setex(`idem:${idempotencyKey}`, 300, JSON.stringify(response));
  }

  res.status(202).json(response);
});
```

### 3. Real-Time Aggregation (ClickHouse)

```sql
-- Materialized View auto-aggregates on insert
CREATE MATERIALIZED VIEW click_aggregates_minute_mv
TO click_aggregates_minute
AS SELECT
    toStartOfMinute(timestamp) AS time_bucket,
    ad_id,
    campaign_id,
    advertiser_id,
    country,
    device_type,
    count() AS click_count,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count
FROM click_events
GROUP BY time_bucket, ad_id, campaign_id, advertiser_id, country, device_type;
```

### 4. Analytics Query (Backend to Frontend)

```typescript
// services/queryService.ts
export async function getAggregates(params: QueryParams) {
  const query = `
    SELECT
      time_bucket,
      sum(click_count) as clicks,
      sum(unique_users) as unique_users,
      sum(fraud_count) as fraud_count
    FROM click_aggregates_${params.granularity}
    WHERE time_bucket >= {start:DateTime}
      AND time_bucket <= {end:DateTime}
      ${params.campaignId ? 'AND campaign_id = {campaignId:String}' : ''}
      ${params.country ? 'AND country = {country:String}' : ''}
    GROUP BY time_bucket
    ORDER BY time_bucket
  `;

  return clickhouse.query(query, params);
}

// routes/analytics.ts
router.get('/analytics/aggregate', async (req, res) => {
  const params = {
    start: new Date(req.query.start_time as string),
    end: new Date(req.query.end_time as string),
    granularity: req.query.granularity || 'hour',
    campaignId: req.query.campaign_id,
    country: req.query.country,
  };

  const data = await queryService.getAggregates(params);

  res.json({
    data: data.rows,
    total_clicks: data.rows.reduce((sum, r) => sum + r.clicks, 0),
    query_time_ms: data.elapsed,
  });
});
```

### 5. Dashboard Rendering (Frontend)

```tsx
// stores/analyticsStore.ts
export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  metrics: null,
  isLoading: false,
  timeRange: { start: yesterday, end: now, granularity: 'hour' },
  filters: { campaignId: null, country: null },

  fetchMetrics: async () => {
    set({ isLoading: true });

    const { timeRange, filters } = get();
    const params = new URLSearchParams({
      start_time: timeRange.start.toISOString(),
      end_time: timeRange.end.toISOString(),
      granularity: timeRange.granularity,
      ...(filters.campaignId && { campaign_id: filters.campaignId }),
    });

    const response = await fetch(`/api/v1/analytics/aggregate?${params}`);
    const data = await response.json();

    set({
      metrics: transformResponse(data),
      isLoading: false,
    });
  },

  startAutoRefresh: () => {
    const interval = setInterval(() => get().fetchMetrics(), 5000);
    return () => clearInterval(interval);
  },
}));
```

## Deep Dive: Exactly-Once Semantics

### Three-Layer Defense

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Exactly-Once Guarantee                            │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: Idempotency-Key Header                                     │
│  - Client provides unique key per logical request                    │
│  - Redis stores response for 5 minutes                               │
│  - Catches: Load balancer retries, network timeouts                  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: click_id Deduplication                                     │
│  - Redis SETNX with 5-minute TTL                                     │
│  - Catches: Same click from different requests                       │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: PostgreSQL UPSERT                                          │
│  - ON CONFLICT (click_id) DO NOTHING                                 │
│  - Catches: Edge cases where Redis TTL expired                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Implementation Details

```typescript
// services/deduplicationService.ts
export const deduplicationService = {
  async check(clickId: string): Promise<boolean> {
    // SETNX returns null if key already exists
    const result = await redis.set(`dedup:${clickId}`, '1', 'EX', 300, 'NX');
    return result === null;
  },
};

// services/postgresService.ts
export const postgresService = {
  async insertClick(click: Click): Promise<void> {
    await pool.query(
      `INSERT INTO click_events (click_id, ad_id, campaign_id, ...)
       VALUES ($1, $2, $3, ...)
       ON CONFLICT (click_id) DO NOTHING`,
      [click.click_id, click.ad_id, click.campaign_id, ...]
    );
  },
};
```

## Deep Dive: Hybrid Storage Integration

### Why Two Databases?

| Use Case | PostgreSQL | ClickHouse |
|----------|------------|------------|
| Business entities (advertisers, campaigns) | ACID, joins, referential integrity | |
| Raw click audit trail | Billing disputes, legal hold | |
| Real-time aggregation | | Materialized views, SummingMergeTree |
| OLAP analytics | | Columnar storage, 10-100x faster |

### Schema Synchronization

```typescript
// services/clickhouseService.ts
export const clickhouseService = {
  async insertClick(click: Click): Promise<void> {
    await clickhouse.insert({
      table: 'click_events',
      values: [{
        click_id: click.click_id,
        ad_id: click.ad_id,
        campaign_id: click.campaign_id,
        advertiser_id: click.advertiser_id,
        user_id: click.user_id || null,
        timestamp: click.timestamp.getTime(),
        device_type: click.device_type || 'unknown',
        country: click.country || 'unknown',
        is_fraudulent: click.is_fraudulent ? 1 : 0,
        fraud_reason: click.fraud_reason || null,
      }],
      format: 'JSONEachRow',
    });
  },
};

// Both inserts happen in parallel
await Promise.all([
  postgresService.insertClick(click),  // Audit trail
  clickhouseService.insertClick(click), // Analytics
]);
```

## Deep Dive: Fraud Detection Integration

### Detection Flow

```typescript
// services/fraudService.ts
interface FraudRule {
  name: string;
  check: (click: Click, context: FraudContext) => Promise<boolean>;
  reason: string;
}

const rules: FraudRule[] = [
  {
    name: 'ip_velocity',
    check: async (click, ctx) => {
      const key = `ratelimit:ip:${ctx.ipHash}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      return count > 100; // > 100 clicks/minute
    },
    reason: 'velocity_ip',
  },
  {
    name: 'user_velocity',
    check: async (click) => {
      if (!click.user_id) return false;
      const key = `ratelimit:user:${click.user_id}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      return count > 50; // > 50 clicks/minute
    },
    reason: 'velocity_user',
  },
];

export const fraudService = {
  async detect(click: Click, ip: string): Promise<FraudResult> {
    const context = { ipHash: hashIp(ip) };

    for (const rule of rules) {
      if (await rule.check(click, context)) {
        return { isFraudulent: true, reason: rule.reason };
      }
    }

    return { isFraudulent: false, reason: null };
  },
};
```

### Fraud Visibility in Dashboard

```tsx
// components/MetricCard.tsx
function FraudRateCard() {
  const fraudRate = useAnalyticsStore((state) => {
    const m = state.metrics;
    if (!m || m.totalClicks === 0) return 0;
    return (m.fraudCount / m.totalClicks) * 100;
  });

  const status =
    fraudRate >= 5 ? 'critical' : fraudRate >= 3 ? 'warning' : 'normal';

  return (
    <MetricCard
      title="Fraud Rate"
      value={`${fraudRate.toFixed(2)}%`}
      status={status}
      icon={<AlertTriangleIcon />}
    />
  );
}
```

## Deep Dive: API Contract Design

### Click Ingestion API

```typescript
// Request
POST /api/v1/clicks
Headers:
  Content-Type: application/json
  Idempotency-Key: uuid (optional but recommended)

Body:
{
  "ad_id": "ad_001",          // required
  "campaign_id": "camp_001",  // required
  "advertiser_id": "adv_001", // required
  "user_id": "user_hash",     // optional
  "country": "US",            // optional, ISO 2-letter
  "device_type": "mobile",    // optional: mobile/desktop/tablet
  "os": "iOS",                // optional
  "browser": "Safari"         // optional
}

// Response (202 Accepted)
{
  "success": true,
  "click_id": "uuid",
  "is_duplicate": false,
  "is_fraudulent": false
}

// Error Response (400 Bad Request)
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "ad_id": ["Required"]
    }
  }
}
```

### Analytics Query API

```typescript
// Request
GET /api/v1/analytics/aggregate
  ?start_time=2024-01-15T00:00:00Z
  &end_time=2024-01-15T23:59:59Z
  &granularity=hour
  &campaign_id=camp_001 (optional)
  &country=US (optional)
  &group_by=country,device_type (optional)

// Response
{
  "data": [
    {
      "time_bucket": "2024-01-15T14:00:00Z",
      "clicks": 125000,
      "unique_users": 98000,
      "fraud_count": 2500
    }
  ],
  "total_clicks": 2500000,
  "query_time_ms": 45
}
```

## Deep Dive: Real-Time Dashboard Updates

### Polling vs WebSocket Decision

```
Current: HTTP Polling (5-second interval)
Pros:
- Simple implementation
- Works through all proxies/load balancers
- Easy to debug

Cons:
- 200ms latency per request × 1000 users = significant server load
- Not truly real-time

Future: WebSocket with fallback
- Push updates on new aggregation
- Reduce server load by 10x
- True real-time experience
```

### Auto-Refresh Implementation

```tsx
// hooks/useAutoRefresh.ts
export function useAutoRefresh(intervalMs: number = 5000) {
  const fetchMetrics = useAnalyticsStore((state) => state.fetchMetrics);
  const timeRange = useAnalyticsStore((state) => state.timeRange);
  const filters = useAnalyticsStore((state) => state.filters);

  useEffect(() => {
    // Initial fetch
    fetchMetrics();

    // Set up interval
    const interval = setInterval(fetchMetrics, intervalMs);

    return () => clearInterval(interval);
  }, [fetchMetrics, intervalMs]);

  // Refetch when filters change
  useEffect(() => {
    fetchMetrics();
  }, [timeRange, filters, fetchMetrics]);
}

// Usage in Dashboard
function Dashboard() {
  useAutoRefresh(5000);

  return (
    <DashboardLayout>
      <MetricCards />
      <ClicksChart />
      <CampaignTable />
    </DashboardLayout>
  );
}
```

## Health Check and Observability

### Unified Health Endpoint

```typescript
// routes/health.ts
router.get('/health', async (req, res) => {
  const checks = await Promise.allSettled([
    checkPostgres(),
    checkRedis(),
    checkClickhouse(),
  ]);

  const services = {
    postgres: checks[0].status === 'fulfilled' ? 'connected' : 'error',
    redis: checks[1].status === 'fulfilled' ? 'connected' : 'error',
    clickhouse: checks[2].status === 'fulfilled' ? 'connected' : 'error',
  };

  const allHealthy = Object.values(services).every((s) => s === 'connected');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    services,
    timestamp: new Date().toISOString(),
  });
});

// Frontend health indicator
function HealthIndicator() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/health');
        setHealth(await res.json());
      } catch {
        setHealth({ status: 'error', services: {} });
      }
    };

    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          health?.status === 'healthy' && 'bg-green-500',
          health?.status === 'degraded' && 'bg-yellow-500',
          (!health || health.status === 'error') && 'bg-red-500'
        )}
      />
      <span className="text-sm text-gray-600">
        {health?.status ?? 'Checking...'}
      </span>
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Dual-write (PG + CH) | Best of both worlds | Consistency complexity |
| HTTP polling | Simple, debuggable | Higher latency, server load |
| Sync fraud detection | Immediate flagging | Adds latency to ingestion |
| Zod validation | Type-safe, good errors | Additional parsing step |
| Zustand + polling | Simple state management | Manual refresh logic |

## Future Full-Stack Enhancements

1. **WebSocket Real-Time Updates**: Replace polling with push notifications
2. **GraphQL API**: Flexible querying for complex dashboard requirements
3. **Offline Support**: Service worker for cached analytics viewing
4. **A/B Testing Integration**: Track conversion metrics alongside clicks
5. **Multi-Tenant Architecture**: Isolated dashboards per advertiser
6. **Data Export**: CSV/PDF generation for reports
