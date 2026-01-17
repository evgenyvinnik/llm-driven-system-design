# Design Scalable API - Serving Millions of Users

A scalable API system capable of serving millions of concurrent users with low latency, high availability, and graceful degradation. This educational project focuses on building production-grade API infrastructure with load balancing, caching, rate limiting, and observability.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,304 |
| Source Files | 43 |
| .js | 2,104 |
| .md | 1,543 |
| .tsx | 826 |
| .ts | 270 |
| .yml | 217 |

## Architecture Overview

```
                    ┌─────────────────┐
                    │   Frontend      │
                    │  (React + TS)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   API Gateway   │
                    │   (Port 8080)   │
                    │ - Rate Limiting │
                    │ - Auth          │
                    │ - Routing       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Load Balancer  │
                    │   (Port 3000)   │
                    │ - Health Checks │
                    │ - Circuit Break │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌────────────┐    ┌────────────┐    ┌────────────┐
    │ API Server │    │ API Server │    │ API Server │
    │ (Port 3001)│    │ (Port 3002)│    │ (Port 3003)│
    └──────┬─────┘    └──────┬─────┘    └──────┬─────┘
           │                 │                 │
           └────────────┬────┴────────────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼                             ▼
    ┌──────────┐                 ┌──────────┐
    │ PostgreSQL│                │   Redis  │
    │ (Port 5432)│               │(Port 6379)│
    └──────────┘                 └──────────┘
```

## Key Features

### 1. High Availability
- Multiple API server instances with load balancing
- Health checks with automatic failover
- Circuit breakers for dependency protection

### 2. Performance
- Two-level caching (local + Redis)
- Connection pooling
- Response compression

### 3. Traffic Management
- Sliding window rate limiting
- Per-tier rate limits (anonymous, free, pro, enterprise)
- Request queuing and graceful degradation

### 4. Security
- Session-based authentication
- API key management
- Request validation and input sanitization

### 5. Observability
- Request/response logging with request IDs
- Prometheus-compatible metrics
- Real-time admin dashboard

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Docker (Recommended for Full Stack)

Start the entire stack with Docker:

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

Access points:
- Frontend: http://localhost:80
- API Gateway: http://localhost:8080
- Load Balancer: http://localhost:3000
- API Servers: http://localhost:3001, :3002, :3003

### Option 2: Native Development (Recommended for Development)

#### Step 1: Start Infrastructure Services

```bash
# Start PostgreSQL and Redis only
docker-compose -f docker-compose.dev.yml up -d
```

#### Step 2: Install Backend Dependencies

```bash
cd backend
cp .env.example .env
npm install
```

#### Step 3: Run Backend Services

Open multiple terminal windows and run:

```bash
# Terminal 1: API Gateway
npm run dev:gateway

# Terminal 2: Load Balancer
npm run dev:lb

# Terminal 3: API Server 1
npm run dev:server1

# Terminal 4: API Server 2
npm run dev:server2

# Terminal 5: API Server 3
npm run dev:server3

# Or run all at once (requires concurrently)
npm run dev:all
```

#### Step 4: Run Frontend

```bash
cd frontend
npm install
npm run dev
```

Access points:
- Frontend: http://localhost:5173
- API Gateway: http://localhost:8080
- Load Balancer: http://localhost:3000

## API Endpoints

### Authentication

```bash
# Login
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "admin123"}'

# Response: {"token": "...", "user": {...}}

# Use token for authenticated requests
curl http://localhost:8080/api/v1/me \
  -H "Authorization: Bearer <token>"
```

### Resources API

```bash
# List resources
curl http://localhost:8080/api/v1/resources

# Get single resource
curl http://localhost:8080/api/v1/resources/1

# Create resource (requires auth)
curl -X POST http://localhost:8080/api/v1/resources \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Resource", "type": "document"}'
```

### Admin Endpoints (requires admin role)

```bash
# Get dashboard data
curl http://localhost:8080/api/v1/admin/dashboard \
  -H "Authorization: Bearer <token>"

# View circuit breakers
curl http://localhost:8080/api/v1/admin/circuit-breakers \
  -H "Authorization: Bearer <token>"

# Clear cache
curl -X POST http://localhost:8080/api/v1/admin/cache/clear \
  -H "Authorization: Bearer <token>"
```

### Health & Metrics

```bash
# Health check
curl http://localhost:8080/health

# Load balancer status
curl http://localhost:3000/lb/status

# Prometheus metrics
curl http://localhost:8080/metrics
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` in the backend directory:

```bash
# Server Configuration
PORT=3001
NODE_ENV=development
INSTANCE_ID=api-1

# PostgreSQL Configuration
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=scalable_api
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# Gateway Configuration
GATEWAY_PORT=8080

# Load Balancer Configuration
LB_PORT=3000
API_SERVERS=http://localhost:3001,http://localhost:3002,http://localhost:3003

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Cache TTL (seconds)
CACHE_TTL=300

# Circuit Breaker
CIRCUIT_FAILURE_THRESHOLD=5
CIRCUIT_RESET_TIMEOUT=30000
```

### Rate Limit Tiers

| Tier | Requests/Minute |
|------|-----------------|
| Anonymous | 100 |
| Free | 1,000 |
| Pro | 10,000 |
| Enterprise | 100,000 |

## Testing the System

### Test Rate Limiting

```bash
# Send many requests to trigger rate limiting
for i in {1..150}; do
  curl -s http://localhost:8080/api/v1/status | jq -r '.status // .error'
done
```

### Test Load Balancing

```bash
# Observe requests being distributed across instances
for i in {1..10}; do
  curl -s http://localhost:3000/api/v1/status | jq -r '.instanceId'
done
```

### Test Circuit Breaker

```bash
# Call external service endpoint (randomly fails)
for i in {1..20}; do
  curl -s http://localhost:8080/api/v1/external | jq -r '.data // .error'
  sleep 0.5
done

# Check circuit breaker state
curl http://localhost:8080/api/v1/admin/circuit-breakers \
  -H "Authorization: Bearer admin-token-dev"
```

### Test Caching

```bash
# First request (cache miss)
time curl -s http://localhost:8080/api/v1/resources/1 > /dev/null

# Second request (cache hit - should be faster)
time curl -s http://localhost:8080/api/v1/resources/1 > /dev/null

# View cache stats
curl http://localhost:8080/api/v1/admin/cache \
  -H "Authorization: Bearer admin-token-dev"
```

## Default Credentials

| User | Email | Password | Role |
|------|-------|----------|------|
| Admin | admin@example.com | admin123 | admin |
| User | user@example.com | user123 | user |

## Project Structure

```
scalable-api/
├── backend/
│   ├── api-server/           # Individual API server instances
│   │   └── src/
│   │       └── index.js      # API server entry point
│   ├── gateway/              # API Gateway with rate limiting
│   │   └── src/
│   │       └── index.js      # Gateway entry point
│   ├── load-balancer/        # Load balancer with health checks
│   │   └── src/
│   │       └── index.js      # Load balancer entry point
│   ├── shared/               # Shared utilities and services
│   │   ├── config/           # Configuration management
│   │   ├── middleware/       # Express middleware (auth, logging)
│   │   ├── services/         # Core services (cache, circuit breaker, etc.)
│   │   └── utils/            # Utility functions
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── services/         # API client
│   │   └── stores/           # Zustand stores
│   └── package.json
├── database/
│   ├── schema.sql            # Database schema
│   └── migrations/           # Database migrations
├── docker-compose.yml        # Full stack deployment
├── docker-compose.dev.yml    # Development infrastructure
├── architecture.md           # System design documentation
└── README.md                 # This file
```

## Technical Challenges Addressed

1. **Horizontal Scaling**: Stateless API servers behind a load balancer
2. **Rate Limiting**: Distributed sliding window using Redis
3. **Caching**: Two-level cache (local + Redis) with cache invalidation
4. **Circuit Breakers**: Per-dependency failure isolation
5. **Observability**: Metrics, logging, and real-time dashboard

## Implementation Status

- [x] API server framework with Express
- [x] Load balancer with health checks
- [x] API Gateway with routing
- [x] Rate limiting (sliding window)
- [x] Caching layer (local + Redis)
- [x] Circuit breakers
- [x] Authentication (session-based)
- [x] Admin dashboard with metrics
- [x] Docker deployment
- [ ] Database request logging
- [ ] Distributed tracing
- [ ] Prometheus/Grafana integration

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
See [architecture.md](./architecture.md) for detailed system design documentation.

## References & Inspiration

- [Building and Deploying Netflix API Gateway](https://netflixtechblog.com/announcing-zuul-edge-service-in-the-cloud-ab3af5be08ee) - Netflix Zuul API gateway architecture
- [Kong API Gateway](https://docs.konghq.com/gateway/latest/) - Open-source API gateway and microservices management
- [Rate Limiting Strategies and Techniques](https://cloud.google.com/architecture/rate-limiting-strategies-techniques) - Google Cloud's comprehensive guide to rate limiting
- [Stripe's Rate Limiting](https://stripe.com/blog/rate-limiters) - How Stripe implements rate limiting at scale
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html) - Martin Fowler on the circuit breaker pattern
- [Resilience4j Circuit Breaker](https://resilience4j.readme.io/docs/circuitbreaker) - Modern fault tolerance library patterns
- [Load Balancing Algorithms](https://aws.amazon.com/what-is/load-balancing/) - AWS guide to load balancing strategies
- [NGINX Load Balancing Guide](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/) - Production load balancer configuration
- [12-Factor App Methodology](https://12factor.net/) - Best practices for building scalable, maintainable services
- [Caching Best Practices](https://aws.amazon.com/caching/best-practices/) - AWS caching strategies for web applications
- [API Design Patterns](https://cloud.google.com/apis/design) - Google's API design guide for scalable APIs
- [Envoy Proxy](https://www.envoyproxy.io/docs/envoy/latest/) - Modern edge and service proxy for cloud-native apps
