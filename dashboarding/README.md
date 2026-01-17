# Dashboarding System - Metrics Monitoring and Visualization

## Overview

A metrics monitoring and visualization system similar to Datadog or Grafana for collecting, storing, and visualizing time-series data. This implementation includes:

- **Metrics Ingestion API**: Collect metrics from agents with batching support
- **Time-Series Storage**: TimescaleDB for efficient time-series data storage
- **Query Engine**: SQL-based queries with automatic table selection based on time range
- **Dashboard Builder**: Customizable dashboards with multiple panel types
- **Alerting System**: Rule-based alerts with configurable thresholds and notifications
- **Real-Time Updates**: Auto-refreshing dashboards with 10-second intervals

## Key Features

- Line charts, area charts, bar charts, gauges, and stat panels
- Configurable time ranges (5m to 7d)
- Alert rule management with severity levels
- Metric exploration and discovery
- Tag-based metric filtering
- Result caching with Redis

## Prerequisites

- Node.js 20+ and npm
- Docker and Docker Compose

## Getting Started

### 1. Start Infrastructure Services

```bash
cd dashboarding
docker-compose up -d
```

This starts:
- **TimescaleDB** (PostgreSQL with time-series extensions) on port 5432
- **Redis** for caching and sessions on port 6379

### 2. Install Backend Dependencies

```bash
cd backend
npm install
```

### 3. Run Database Migrations

```bash
npm run db:migrate
```

This creates:
- Users table
- Metric definitions table
- Metrics hypertable (time-series data)
- Hourly and daily rollup tables
- Dashboards and panels tables
- Alert rules and instances tables

### 4. Seed Sample Data

```bash
npm run db:seed
```

This populates:
- Sample metrics (CPU, memory, disk, network, HTTP) for the last hour
- A pre-configured "Infrastructure Overview" dashboard with 6 panels
- Sample alert rules for high CPU, memory, and error rate

### 5. Start the Backend Server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`.

### 6. Install Frontend Dependencies

```bash
cd ../frontend
npm install
```

### 7. Start the Frontend

```bash
npm run dev
```

The UI will be available at `http://localhost:5173`.

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

## API Endpoints

### Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/metrics/ingest` | Ingest metric data points |
| POST | `/api/v1/metrics/query` | Query metrics with aggregations |
| GET | `/api/v1/metrics/latest/:name` | Get latest value for a metric |
| GET | `/api/v1/metrics/stats/:name` | Get statistics for a metric |
| GET | `/api/v1/metrics/names` | List all metric names |
| GET | `/api/v1/metrics/definitions` | Get metric definitions |
| GET | `/api/v1/metrics/tags/keys` | Get tag keys |
| GET | `/api/v1/metrics/tags/values/:key` | Get tag values |

### Dashboards

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/dashboards` | List all dashboards |
| GET | `/api/v1/dashboards/:id` | Get dashboard with panels |
| POST | `/api/v1/dashboards` | Create dashboard |
| PUT | `/api/v1/dashboards/:id` | Update dashboard |
| DELETE | `/api/v1/dashboards/:id` | Delete dashboard |
| POST | `/api/v1/dashboards/:id/panels` | Add panel to dashboard |
| PUT | `/api/v1/dashboards/:id/panels/:panelId` | Update panel |
| DELETE | `/api/v1/dashboards/:id/panels/:panelId` | Delete panel |
| POST | `/api/v1/dashboards/:id/panels/:panelId/data` | Get panel data |

### Alerts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/alerts/rules` | List alert rules |
| GET | `/api/v1/alerts/rules/:id` | Get alert rule |
| POST | `/api/v1/alerts/rules` | Create alert rule |
| PUT | `/api/v1/alerts/rules/:id` | Update alert rule |
| DELETE | `/api/v1/alerts/rules/:id` | Delete alert rule |
| POST | `/api/v1/alerts/rules/:id/evaluate` | Manually evaluate rule |
| GET | `/api/v1/alerts/instances` | Get alert history |

## Example: Ingesting Metrics

```bash
curl -X POST http://localhost:3000/api/v1/metrics/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "metrics": [
      {
        "name": "cpu.usage",
        "value": 75.5,
        "tags": {"host": "server-001", "environment": "production"}
      },
      {
        "name": "memory.usage",
        "value": 68.2,
        "tags": {"host": "server-001", "environment": "production"}
      }
    ]
  }'
```

## Example: Querying Metrics

```bash
curl -X POST http://localhost:3000/api/v1/metrics/query \
  -H "Content-Type: application/json" \
  -d '{
    "metric_name": "cpu.usage",
    "tags": {"environment": "production"},
    "start_time": "2025-01-16T00:00:00Z",
    "end_time": "2025-01-16T23:59:59Z",
    "aggregation": "avg",
    "interval": "5m"
  }'
```

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
  - [x] Metrics ingestion API
  - [x] Time-series query engine
  - [x] Dashboard CRUD
  - [x] Panel management
  - [x] Alert rules and evaluation
- [x] Database/Storage layer
  - [x] TimescaleDB hypertables
  - [x] Redis caching
- [x] API endpoints
- [x] Frontend implementation
  - [x] Dashboard listing
  - [x] Dashboard view with panels
  - [x] Chart components (line, area, bar, gauge, stat)
  - [x] Time range selector
  - [x] Alert management
  - [x] Metrics explorer
- [ ] Testing
- [ ] Performance optimization (rollups, downsampling)
- [ ] Documentation

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Technology Stack

- **Frontend:** TypeScript, Vite, React 19, TanStack Router, Zustand, Tailwind CSS, Recharts
- **Backend:** Node.js, Express, TypeScript
- **Database:** TimescaleDB (PostgreSQL extension)
- **Cache:** Redis
- **Containerization:** Docker Compose

## Future Enhancements

- Continuous aggregates for automatic rollups
- Retention policies for data lifecycle management
- WebSocket support for real-time streaming
- User authentication and authorization
- Dashboard sharing and embedding
- More panel types (heatmap, histogram)
- Notification channels (Slack, email, PagerDuty)
