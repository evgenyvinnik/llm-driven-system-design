# Ad Click Aggregator

A real-time analytics system for aggregating ad clicks with fraud detection, designed to demonstrate high-volume event processing and real-time aggregation patterns.

## Features

- **Click Event Ingestion**: High-throughput API for recording ad clicks
- **Real-time Aggregation**: Per-minute, hourly, and daily click aggregations
- **Deduplication**: Exactly-once semantics using Redis-based deduplication
- **Fraud Detection**: Real-time fraud detection based on click velocity and patterns
- **Analytics Dashboard**: Interactive dashboard with charts and metrics
- **Query API**: Flexible aggregation queries with filtering and grouping

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ad Servers    │────▶│  Click API      │────▶│     Redis       │
│                 │     │  (Express)      │     │  (Dedup/Cache)  │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   PostgreSQL    │
                        │  (Aggregates)   │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   Dashboard     │
                        │   (React)       │
                        └─────────────────┘
```

## Tech Stack

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: React 19 + Vite + TanStack Router + Zustand + Tailwind CSS
- **Database**: PostgreSQL (aggregations and raw events)
- **Cache**: Redis (deduplication, rate limiting, real-time counters)
- **Charts**: Recharts

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
# From the project root directory
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on http://localhost:3000

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

## Alternative: Native Services

If you prefer to run PostgreSQL and Redis natively:

### macOS (Homebrew)

```bash
# Install services
brew install postgresql@16 redis

# Start services
brew services start postgresql@16
brew services start redis

# Create database
createdb adclick_aggregator -U postgres

# Run schema migration
psql -d adclick_aggregator -U postgres -f backend/init.sql
```

### Linux (Ubuntu/Debian)

```bash
# Install services
sudo apt update
sudo apt install postgresql-16 redis-server

# Start services
sudo systemctl start postgresql
sudo systemctl start redis-server

# Create database
sudo -u postgres createdb adclick_aggregator

# Run schema migration
sudo -u postgres psql -d adclick_aggregator -f backend/init.sql
```

### Environment Variables

Create a `.env` file in the backend directory:

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=adclick_aggregator
POSTGRES_USER=adclick
POSTGRES_PASSWORD=adclick123
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
```

## API Endpoints

### Click Ingestion

```bash
# Single click
POST /api/v1/clicks
{
  "ad_id": "ad_001",
  "campaign_id": "camp_001",
  "advertiser_id": "adv_001",
  "device_type": "mobile",
  "country": "US"
}

# Batch clicks
POST /api/v1/clicks/batch
{
  "clicks": [
    { "ad_id": "ad_001", "campaign_id": "camp_001", "advertiser_id": "adv_001" },
    { "ad_id": "ad_002", "campaign_id": "camp_001", "advertiser_id": "adv_001" }
  ]
}
```

### Analytics

```bash
# Aggregate query
GET /api/v1/analytics/aggregate?start_time=2024-01-01T00:00:00Z&end_time=2024-01-02T00:00:00Z&granularity=hour&group_by=country

# Real-time stats
GET /api/v1/analytics/realtime?minutes=60

# Campaign summary
GET /api/v1/analytics/campaign/:campaignId/summary?start_time=...&end_time=...
```

### Admin

```bash
# System stats
GET /api/v1/admin/stats

# Recent clicks
GET /api/v1/admin/recent-clicks?limit=100&fraud_only=true

# List campaigns
GET /api/v1/admin/campaigns

# List ads
GET /api/v1/admin/ads
```

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Testing

Use the built-in Test Clicks page in the dashboard to generate test data:

1. Open http://localhost:5173/test
2. Select an ad
3. Click "Send Single Click" or "Send 10 Clicks"
4. View results on the Dashboard

Or use curl:

```bash
# Send 100 test clicks
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/v1/clicks \
    -H "Content-Type: application/json" \
    -d '{"ad_id":"ad_001","campaign_id":"camp_001","advertiser_id":"adv_001","device_type":"mobile","country":"US"}'
done
```

## Fraud Detection

The system detects fraud based on:

- **IP Click Velocity**: More than 100 clicks/minute from same IP
- **User Click Velocity**: More than 50 clicks/minute from same user
- **Suspicious Patterns**: Missing device info, suspiciously regular timing

Fraudulent clicks are flagged but still stored for analysis.

## Dashboard Pages

- **Dashboard** (`/`): Overview with key metrics and real-time chart
- **Campaigns** (`/campaigns`): Campaign-level analytics with breakdowns
- **Analytics** (`/analytics`): Custom aggregate queries
- **Recent Clicks** (`/clicks`): Raw click event log
- **Test Clicks** (`/test`): Generate test click data

## Implementation Status

- [x] Click event ingestion API
- [x] Deduplication with Redis
- [x] Real-time aggregation (minute/hour/day)
- [x] Fraud detection (velocity-based)
- [x] Query API for analytics
- [x] React dashboard with charts
- [x] Campaign analytics
- [x] Test click generator
- [ ] Kafka integration (optional)
- [ ] Advanced ML fraud detection
- [ ] User authentication

## Architecture Decisions

### Why PostgreSQL over ClickHouse?

For this learning project, PostgreSQL provides:
- Simpler setup and operation
- Familiar SQL interface
- Good enough performance for local development
- Built-in UPSERT for aggregation updates

In production at scale, ClickHouse would be preferred for:
- Columnar storage with 10-20x compression
- Faster analytical queries on billions of rows
- Native time-series support

### Why Redis for Deduplication?

- Sub-millisecond lookups
- Automatic TTL for click IDs
- HyperLogLog for unique user estimation
- Real-time counters for dashboards

## Future Improvements

1. Add Kafka for event streaming
2. Implement ML-based fraud detection
3. Add geo-velocity fraud detection
4. Implement data archival to S3/Parquet
5. Add A/B testing analytics
6. Implement user authentication

## License

MIT

---

See [architecture.md](./architecture.md) for detailed system design documentation.
See [claude.md](./claude.md) for development insights and iteration history.
