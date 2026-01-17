# Ad Click Aggregator - Architecture Design

## System Overview

A real-time analytics system for aggregating ad clicks with fraud detection capabilities. The system handles high-volume click events, deduplicates them for exactly-once semantics, detects fraudulent patterns, and provides real-time analytics through aggregated data.

## Requirements

### Functional Requirements

1. **Click Tracking**: Record every ad click with metadata (ad_id, campaign_id, user_id, timestamp, geo, device)
2. **Real-time Aggregation**: Aggregate clicks by various dimensions (per ad, per campaign, per hour, per geo)
3. **Reporting API**: Query aggregated data for dashboards and billing
4. **Fraud Detection**: Identify and filter suspicious click patterns based on velocity and patterns

### Non-Functional Requirements

- **Scalability**: Design for 10,000 clicks/second (simplified for local dev)
- **Availability**: 99.9% uptime target
- **Latency**: Writes < 10ms, queries < 100ms for aggregations
- **Consistency**: Exactly-once semantics for accurate billing

## Capacity Estimation

For production scale targeting 10,000 clicks/second:

- **Daily Active Users (DAU)**: ~50M
- **Requests per second (RPS)**: 10,000 write, 100 read
- **Storage requirements**: ~430 GB/day raw, ~13 TB/month
- **Bandwidth requirements**: ~5 MB/s inbound

## High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ad Servers    │────▶│  Click API      │────▶│     Redis       │
│ (Click Sources) │     │  (Express)      │     │  (Dedup/Cache)  │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
          ┌─────────────────┐      ┌─────────────────┐
          │   Raw Storage   │      │   Aggregation   │
          │  (PostgreSQL)   │      │   Tables (PG)   │
          └─────────────────┘      └─────────────────┘
                                            │
                                            ▼
                                 ┌─────────────────┐
                                 │  Query Service  │
                                 │  (Analytics)    │
                                 └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                                 │   Dashboard     │
                                 │   (React)       │
                                 └─────────────────┘
```

### Core Components

1. **Click Collector Service** (Express API)
   - Receives click events via HTTP POST
   - Validates required fields using Zod
   - Enriches with server timestamp
   - Checks for duplicates via Redis
   - Runs fraud detection
   - Stores to database and updates aggregates

2. **Redis Cache Layer**
   - Deduplication: SETEX with 5-minute TTL for click IDs
   - Rate limiting: INCR with expiry for IP/user velocity
   - HyperLogLog: PFADD for unique user counting
   - Real-time counters: HSET for dashboard metrics

3. **PostgreSQL Storage**
   - Raw click events table for debugging/reconciliation
   - Aggregation tables (minute, hour, day granularity)
   - Uses UPSERT for atomic counter updates

4. **Query Service** (Analytics API)
   - Flexible aggregation queries
   - Filtering by campaign, ad, time range
   - Grouping by country, device type

5. **Dashboard** (React + Recharts)
   - Real-time metrics display
   - Time-series charts
   - Campaign analytics
   - Test click generator

## Data Model

### Raw Click Event

```json
{
  "click_id": "uuid-v4",
  "ad_id": "ad_12345",
  "campaign_id": "camp_789",
  "advertiser_id": "adv_456",
  "user_id": "hashed_user_id",
  "timestamp": "2024-01-15T14:30:00.123Z",
  "device_type": "mobile",
  "os": "iOS",
  "browser": "Safari",
  "country": "US",
  "region": "CA",
  "ip_hash": "sha256_of_ip",
  "is_fraudulent": false
}
```

### Database Schema

```sql
-- Raw click events
CREATE TABLE click_events (
    id SERIAL PRIMARY KEY,
    click_id VARCHAR(50) UNIQUE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(100),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    device_type VARCHAR(20),
    country VARCHAR(3),
    is_fraudulent BOOLEAN DEFAULT FALSE,
    fraud_reason VARCHAR(255)
);

-- Aggregation tables (minute, hour, day)
CREATE TABLE click_aggregates_hour (
    time_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    UNIQUE(time_bucket, ad_id, country, device_type)
);
```

## API Design

### Click Ingestion

```
POST /api/v1/clicks
Content-Type: application/json

{
  "ad_id": "ad_001",
  "campaign_id": "camp_001",
  "advertiser_id": "adv_001",
  "device_type": "mobile",
  "country": "US"
}

Response: 202 Accepted
{
  "success": true,
  "click_id": "uuid",
  "is_duplicate": false,
  "is_fraudulent": false
}
```

### Analytics Query

```
GET /api/v1/analytics/aggregate
  ?campaign_id=camp_789
  &start_time=2024-01-15T00:00:00Z
  &end_time=2024-01-15T23:59:59Z
  &group_by=hour,country
  &granularity=hour

Response:
{
  "data": [...],
  "total_clicks": 2500000,
  "query_time_ms": 45
}
```

## Key Design Decisions

### 1. Exactly-Once Semantics

**Implementation:**
- Click ID generated at source or by collector
- Redis SETEX for deduplication with 5-minute TTL
- PostgreSQL UPSERT for idempotent aggregation updates

### 2. Fraud Detection

**Rule-based detection:**
- IP velocity: > 100 clicks/minute flags as fraud
- User velocity: > 50 clicks/minute flags as fraud
- Suspicious patterns: Missing device info, regular timing

**Implementation:**
- Redis INCR with TTL for velocity tracking
- Fraudulent clicks are flagged but stored for analysis

### 3. Storage Strategy

**PostgreSQL chosen over ClickHouse for:**
- Simpler local development setup
- Familiar SQL interface
- Built-in UPSERT for aggregation updates

**Trade-off:**
- ClickHouse would be 10-20x faster for analytics at scale
- Consider migration path for production

## Technology Stack

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: PostgreSQL 16
- **Caching Layer**: Redis 7
- **Frontend**: React 19 + Vite + TanStack Router + Zustand + Tailwind CSS
- **Charts**: Recharts

## Scalability Considerations

### Horizontal Scaling

- **Collectors**: Stateless, scale behind load balancer
- **PostgreSQL**: Read replicas for analytics queries
- **Redis**: Cluster mode for deduplication at scale

### Future Enhancements

1. **Kafka**: Add for async event processing and higher throughput
2. **ClickHouse**: Migrate aggregations for better analytics performance
3. **Flink/Spark**: Stream processing for complex aggregations

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Database | PostgreSQL | ClickHouse | Simpler setup, UPSERT support |
| Cache | Redis | In-memory | Persistence, distributed ready |
| Processing | Sync | Kafka+Flink | Simpler for learning |
| Frontend | React | Vue | Ecosystem, TanStack Router |

## Monitoring and Observability

**Metrics to track:**
- Ingestion rate (clicks/sec)
- Deduplication rate
- Fraud detection rate
- Query latency (p50/p95/p99)
- Database connection pool utilization

**Health endpoint:**
```
GET /health
{
  "status": "healthy",
  "services": {
    "database": "connected",
    "redis": "connected"
  }
}
```

## Security Considerations

- IP hashing for privacy (never store raw IPs)
- Input validation with Zod schemas
- Rate limiting per client
- CORS configuration for frontend

## Future Optimizations

1. Add Kafka for event streaming
2. Implement ML-based fraud detection
3. Add geo-velocity fraud detection (impossible travel)
4. Implement data archival to S3/Parquet
5. Add A/B testing analytics
6. Implement user authentication and authorization
