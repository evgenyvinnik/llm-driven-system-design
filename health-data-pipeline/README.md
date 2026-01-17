# Design Health Data Pipeline - Multi-Device Health Aggregation

## Overview

A health data pipeline that aggregates and processes health metrics from multiple devices (Apple Watch, iPhone, third-party devices) with high reliability, privacy protection, and real-time insights. This educational project focuses on building a HealthKit-like data aggregation system.

## Key Features

### 1. Multi-Device Ingestion
- Apple Watch metrics (heart rate, steps, workouts)
- iPhone sensors (steps, distance)
- Third-party devices (scales, blood pressure)
- Manual entries

### 2. Data Processing
- Real-time aggregation
- Deduplication across sources
- Unit normalization
- Derived metrics

### 3. Privacy & Security
- Session-based authentication
- Encrypted storage with TimescaleDB
- Granular sharing controls
- HIPAA-ready architecture

### 4. Insights & Trends
- Daily/weekly/monthly summaries
- Trend detection
- Health insights and recommendations
- Activity change alerts

### 5. Sharing & Export
- Share tokens with expiration
- Controlled data access
- Data type filtering
- Date range restrictions

## Implementation Status

- [x] Initial architecture design
- [x] Data model design
- [x] Device sync protocol
- [x] Aggregation engine
- [x] Insights pipeline
- [x] Query API
- [x] Frontend dashboard
- [x] Admin interface
- [ ] Privacy layer (encryption)
- [ ] Sharing system
- [ ] Export functionality

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL with TimescaleDB extension
- **Cache**: Redis
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS
- **State Management**: Zustand
- **Routing**: TanStack Router
- **Charts**: Recharts

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
# Start TimescaleDB and Redis
docker-compose up -d

# Wait for services to be healthy
docker-compose ps
```

### 2. Setup Backend

```bash
cd backend

# Copy environment file
cp .env.example .env

# Install dependencies
npm install

# Start development server
npm run dev
```

The API will be available at http://localhost:3000

### 3. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend will be available at http://localhost:5173

### Running Multiple Backend Instances

For load balancing testing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Create new account
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Devices
- `GET /api/v1/devices` - List user devices
- `POST /api/v1/devices` - Register new device
- `POST /api/v1/devices/:deviceId/sync` - Sync health data

### Health Data
- `GET /api/v1/health/types` - Get health data types
- `GET /api/v1/health/samples` - Get raw samples
- `GET /api/v1/health/aggregates` - Get aggregated data
- `GET /api/v1/health/summary/daily` - Get daily summary
- `GET /api/v1/health/summary/weekly` - Get weekly summary
- `GET /api/v1/health/latest` - Get latest metrics
- `GET /api/v1/health/history/:type` - Get historical data
- `GET /api/v1/health/insights` - Get health insights
- `POST /api/v1/health/insights/analyze` - Trigger analysis

### Admin (requires admin role)
- `GET /api/v1/admin/stats` - Get system stats
- `GET /api/v1/admin/users` - List all users
- `GET /api/v1/admin/users/:userId` - Get user details
- `POST /api/v1/admin/users/:userId/reaggregate` - Re-run aggregation

## Project Structure

```
health-data-pipeline/
├── docker-compose.yml          # TimescaleDB + Redis
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── database/
│   │   └── init.sql            # Database schema
│   └── src/
│       ├── index.js            # Express app entry
│       ├── config/             # Database, Redis, config
│       ├── middleware/         # Auth middleware
│       ├── models/             # Health types, sample model
│       ├── routes/             # API routes
│       └── services/           # Business logic
│           ├── authService.js
│           ├── deviceSyncService.js
│           ├── aggregationService.js
│           ├── insightsService.js
│           └── healthQueryService.js
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── index.css
        ├── components/         # Reusable UI components
        ├── routes/             # Page components
        ├── stores/             # Zustand stores
        ├── services/           # API client
        └── types/              # TypeScript definitions
```

## Supported Health Metrics

| Type | Unit | Aggregation | Category |
|------|------|-------------|----------|
| STEPS | count | sum | activity |
| DISTANCE | meters | sum | activity |
| HEART_RATE | bpm | average | vitals |
| RESTING_HEART_RATE | bpm | average | vitals |
| BLOOD_PRESSURE_SYSTOLIC | mmHg | average | vitals |
| BLOOD_PRESSURE_DIASTOLIC | mmHg | average | vitals |
| WEIGHT | kg | latest | body |
| BODY_FAT | percent | latest | body |
| BLOOD_GLUCOSE | mg/dL | average | vitals |
| SLEEP_ANALYSIS | minutes | sum | sleep |
| ACTIVE_ENERGY | kcal | sum | activity |
| OXYGEN_SATURATION | percent | average | vitals |

## Key Technical Challenges

1. **Multi-Source Deduplication**: Priority-based deduplication handles overlapping data from different devices
2. **Time-Series Storage**: TimescaleDB hypertables optimize time-series queries
3. **Trend Detection**: Linear regression analysis for health trend insights
4. **Real-Time Aggregation**: Automatic aggregation triggered by data sync

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
