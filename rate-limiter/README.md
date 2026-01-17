# Rate Limiter

A distributed rate limiting service implementing multiple algorithms for API abuse prevention.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 3,399 |
| Source Files | 40 |
| .ts | 1,481 |
| .md | 1,103 |
| .tsx | 560 |
| .json | 116 |
| .yml | 53 |

## Overview

This project implements five rate limiting algorithms:

1. **Fixed Window** - Simple counter that resets at fixed time boundaries
2. **Sliding Window** - Weighted combination of current and previous windows
3. **Sliding Log** - Stores each request timestamp for precise limiting
4. **Token Bucket** - Allows controlled bursts with steady refill rate
5. **Leaky Bucket** - Smoothest output rate, prevents bursts entirely

## Features

- Multiple rate limiting algorithms with configurable parameters
- Redis-based distributed state for horizontal scaling
- Real-time metrics and health monitoring
- Interactive dashboard for testing and visualization
- Proper rate limit headers (X-RateLimit-*)
- Graceful degradation on Redis failure

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (or Redis installed locally)

### Option 1: Using Docker (Recommended)

```bash
# Start Redis and PostgreSQL
docker-compose up -d

# Install backend dependencies
cd backend
npm install

# Start the backend server
npm run dev

# In a new terminal, install frontend dependencies
cd frontend
npm install

# Start the frontend
npm run dev
```

### Option 2: Using Homebrew (macOS)

```bash
# Install Redis
brew install redis

# Start Redis service
brew services start redis

# Install and start PostgreSQL (optional, for rule storage)
brew install postgresql@16
brew services start postgresql@16

# Install backend dependencies
cd backend
npm install

# Start the backend server
npm run dev

# In a new terminal, install frontend dependencies
cd frontend
npm install

# Start the frontend
npm run dev
```

### Access the Application

- **Frontend Dashboard:** http://localhost:5173
- **Backend API:** http://localhost:3001
- **Redis Commander (dev profile):** http://localhost:8081

## Running Multiple Backend Instances

To simulate a distributed environment:

```bash
# Terminal 1
cd backend
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

All instances share the same Redis for consistent rate limiting.

## API Documentation

### Base URL

```
http://localhost:3001/api
```

### Endpoints

#### Check Rate Limit

Checks if a request should be allowed and consumes a token.

```http
POST /api/ratelimit/check
Content-Type: application/json

{
  "identifier": "user-123",
  "algorithm": "sliding_window",
  "limit": 100,
  "windowSeconds": 60,
  "burstCapacity": 10,    // For token/leaky bucket
  "refillRate": 1,        // For token bucket (tokens/sec)
  "leakRate": 1           // For leaky bucket (requests/sec)
}
```

**Response:**
```json
{
  "allowed": true,
  "remaining": 99,
  "limit": 100,
  "resetTime": 1704067260000,
  "algorithm": "sliding_window",
  "latencyMs": 1.5
}
```

**Rate Limit Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
```

#### Get Current State

Get current rate limit state without consuming a token.

```http
GET /api/ratelimit/state/:identifier?algorithm=sliding_window&limit=100&windowSeconds=60
```

**Response:**
```json
{
  "identifier": "user-123",
  "algorithm": "sliding_window",
  "allowed": true,
  "remaining": 50,
  "limit": 100,
  "resetTime": 1704067260000
}
```

#### Reset Rate Limit

Reset rate limit state for an identifier.

```http
DELETE /api/ratelimit/reset/:identifier?algorithm=sliding_window
```

**Response:**
```json
{
  "message": "Rate limit reset successfully",
  "identifier": "user-123",
  "algorithm": "sliding_window"
}
```

#### Batch Check

Check multiple identifiers in a single request.

```http
POST /api/ratelimit/batch-check
Content-Type: application/json

{
  "checks": [
    { "identifier": "user-1", "algorithm": "sliding_window", "limit": 100 },
    { "identifier": "user-2", "algorithm": "token_bucket", "burstCapacity": 10 }
  ]
}
```

**Response:**
```json
{
  "results": [
    { "identifier": "user-1", "algorithm": "sliding_window", "allowed": true, "remaining": 99 },
    { "identifier": "user-2", "algorithm": "token_bucket", "allowed": true, "remaining": 9 }
  ],
  "count": 2,
  "latencyMs": 2.5
}
```

#### Get Metrics

Get aggregated metrics for the last 5 minutes.

```http
GET /api/metrics
```

**Response:**
```json
{
  "totalRequests": 1500,
  "allowedRequests": 1400,
  "deniedRequests": 100,
  "averageLatencyMs": 1.2,
  "p99LatencyMs": 5.0,
  "activeIdentifiers": 25
}
```

#### Health Check

```http
GET /api/metrics/health
```

**Response:**
```json
{
  "status": "healthy",
  "redis": {
    "connected": true,
    "pingMs": 1
  },
  "uptime": 3600,
  "timestamp": 1704067200000
}
```

#### Get Algorithm Information

```http
GET /api/algorithms
```

**Response:**
```json
{
  "algorithms": [
    {
      "name": "fixed_window",
      "description": "Simple counter that resets at fixed time boundaries",
      "pros": ["Simple", "Memory efficient"],
      "cons": ["Burst at window boundaries"],
      "parameters": ["limit", "windowSeconds"]
    }
  ],
  "defaults": {
    "algorithm": "sliding_window",
    "limit": 100,
    "windowSeconds": 60,
    "burstCapacity": 10,
    "refillRate": 1,
    "leakRate": 1
  }
}
```

#### Demo Endpoint (Rate Limited)

This endpoint is rate limited using the sliding window algorithm.

```http
GET /api/demo
X-API-Key: optional-api-key
```

**Response:**
```json
{
  "message": "Request successful",
  "timestamp": 1704067200000,
  "serverPort": 3001
}
```

## Algorithm Details

### Fixed Window Counter

Simple counter that resets at fixed time boundaries (e.g., start of each minute).

- **Pros:** Simple, memory efficient
- **Cons:** Can allow 2x the limit at window boundaries
- **Use case:** Simple API quotas where precision is not critical

### Sliding Window Counter

Combines current and previous window counts weighted by time position within the window.

- **Pros:** Smooth limiting, memory efficient, ~1-2% accuracy
- **Cons:** Approximate (not exact)
- **Use case:** General purpose API rate limiting (recommended default)

### Sliding Window Log

Stores the timestamp of every request and counts requests in the sliding time window.

- **Pros:** Perfectly accurate sliding window
- **Cons:** Memory intensive (stores every timestamp)
- **Use case:** When exact counting is required

### Token Bucket

Bucket starts full and refills at a constant rate. Each request consumes one token.

- **Pros:** Allows controlled bursts, smooth rate limiting
- **Cons:** More complex to explain to users
- **Use case:** Traffic shaping, allowing occasional bursts

### Leaky Bucket

Requests fill a bucket that "leaks" at a constant rate.

- **Pros:** Smoothest output rate, prevents bursts entirely
- **Cons:** May add latency during high traffic
- **Use case:** Protecting downstream services with strict rate requirements

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | - | Redis password (optional) |
| `REDIS_DB` | `0` | Redis database number |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `ratelimiter` | PostgreSQL database |
| `POSTGRES_USER` | `postgres` | PostgreSQL user |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│   Client    │────▶│              API Gateway / Backend           │
│  (Browser)  │     │  ┌────────────────────────────────────────┐  │
└─────────────┘     │  │         Rate Limiter Middleware        │  │
                    │  │  ┌─────────┐ ┌─────────┐ ┌───────────┐ │  │
                    │  │  │ Fixed   │ │ Sliding │ │  Token/   │ │  │
                    │  │  │ Window  │ │ Window  │ │  Leaky    │ │  │
                    │  │  └────┬────┘ └────┬────┘ └─────┬─────┘ │  │
                    │  └───────┼───────────┼────────────┼───────┘  │
                    └──────────┼───────────┼────────────┼──────────┘
                               │           │            │
                               └───────────┼────────────┘
                                           │
                                   ┌───────▼───────┐
                                   │     Redis     │
                                   │  (Counters)   │
                                   └───────────────┘
```

## Testing

### Using the Dashboard

1. Open http://localhost:5173
2. Select an algorithm
3. Configure the parameters
4. Click "Send Request" or use "Start Auto" for continuous testing
5. Observe the results and rate limit behavior

### Using curl

```bash
# Check rate limit
curl -X POST http://localhost:3001/api/ratelimit/check \
  -H "Content-Type: application/json" \
  -d '{"identifier": "test-user", "algorithm": "sliding_window", "limit": 10}'

# Get current state
curl http://localhost:3001/api/ratelimit/state/test-user

# Reset rate limit
curl -X DELETE http://localhost:3001/api/ratelimit/reset/test-user

# Hit rate limited demo endpoint
curl -i http://localhost:3001/api/demo
```

## Development

### Backend Structure

```
backend/
├── src/
│   ├── algorithms/      # Rate limiting algorithm implementations
│   │   ├── base.ts
│   │   ├── fixed-window.ts
│   │   ├── sliding-window.ts
│   │   ├── sliding-log.ts
│   │   ├── token-bucket.ts
│   │   └── leaky-bucket.ts
│   ├── config/          # Configuration
│   ├── middleware/      # Express middleware
│   ├── routes/          # API routes
│   ├── types/           # TypeScript types
│   ├── utils/           # Utilities
│   └── index.ts         # Entry point
```

### Frontend Structure

```
frontend/
├── src/
│   ├── components/      # React components
│   ├── services/        # API client
│   ├── stores/          # Zustand stores
│   ├── types/           # TypeScript types
│   └── App.tsx          # Main app
```

## License

MIT

## References & Inspiration

- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket) - Classic algorithm for traffic shaping and rate limiting
- [Leaky Bucket Algorithm](https://en.wikipedia.org/wiki/Leaky_bucket) - Alternative algorithm for smoothing bursty traffic
- [Stripe Engineering: Rate Limiters](https://stripe.com/blog/rate-limiters) - Stripe's comprehensive guide to rate limiting patterns
- [Cloudflare: Counting Things at Scale](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) - Cloudflare's approach to distributed counting for rate limiting
- [Redis Rate Limiting Patterns](https://redis.io/learn/howtos/ratelimiting) - Redis-based rate limiting implementations
- [Designing Rate Limiting with Redis](https://engineering.classdojo.com/blog/2015/02/06/rolling-rate-limiter/) - ClassDojo's sliding window rate limiter implementation
- [Google Cloud: Rate Limiting Strategies](https://cloud.google.com/architecture/rate-limiting-strategies-techniques) - Comprehensive overview of rate limiting techniques
- [Kong: How to Design a Scalable Rate Limiter](https://konghq.com/blog/how-to-design-a-scalable-rate-limiting-algorithm) - API gateway perspective on rate limiting
- [Sliding Window Rate Limiting](https://blog.figma.com/an-alternative-approach-to-rate-limiting-f8a06cf7c94c) - Figma's sliding window counter approach
