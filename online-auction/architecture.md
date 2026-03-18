# Online Auction System - Architecture Design

## System Overview

A bidding and auction platform for online sales, supporting real-time bidding, auto-bidding (proxy bids), concurrent bid handling, and fair auction resolution. The system must guarantee bid ordering correctness under high concurrency while providing sub-second feedback to users during auction endings.

## Requirements

### Functional Requirements

- **Item listing**: Sellers create auctions with title, description, images, starting price, reserve price (optional), and end time
- **Bidding**: Users place bids that must exceed current highest bid by a minimum increment
- **Auto-bidding (Proxy Bids)**: Users set a maximum bid; system automatically bids on their behalf up to that limit
- **Auction end handling**: Determine winner, handle reserve-not-met scenarios, notify participants
- **Bid history**: View all bids on an item with timestamps
- **Watchlist**: Users track auctions they are interested in
- **Anti-sniping protection**: Extend auction by 2 minutes if bid placed in final 2 minutes
- **Admin dashboard**: Cancel any auction, ban users, view system statistics

### Non-Functional Requirements

- **Scalability**: Support 100,000 concurrent auctions, 1M active users
- **Availability**: 99.9% uptime (8.76 hours downtime/year)
- **Latency**: p95 bid placement < 200ms, p99 < 500ms
- **Consistency**: Strong consistency for bid ordering; no two bids with same amount accepted
- **Durability**: Zero bid loss under any failure scenario

## Capacity Estimation

### Production Scale

| Metric | Value | Notes |
|--------|-------|-------|
| Daily Active Users (DAU) | 1,000,000 | Peak during evening hours |
| Concurrent users | 100,000 | Surge during popular auction endings |
| Active auctions | 500,000 | At any given time |
| Bids per auction | 20 avg | Range: 1-200 for hot items |
| Total bids/day | 10,000,000 | 500K auctions x 20 bids |
| Peak bid RPS | 5,000 | During hot auction endings, spikes 10x |

### Storage Requirements

| Data Type | Size per Record | Records/Year | Annual Growth |
|-----------|----------------|--------------|---------------|
| Auctions | 2 KB | 5,000,000 | 10 GB |
| Bids | 200 B | 100,000,000 | 20 GB |
| Users | 1 KB | 1,000,000 | 1 GB |
| Images | 500 KB avg | 20,000,000 | 10 TB |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 100 |
| Active auctions | 500 |
| Bids/day | 10,000 |
| Peak bid RPS | 50 |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                   │
│              Web App (React) │ Mobile App │ WebSocket Client             │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         CDN / API Gateway                                │
│                  (Rate Limiting, Auth, TLS Termination)                   │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │  API Server (N)  │ │  API Server (N)  │ │  API Server (N)  │
   │  (Express.js)    │ │  (Express.js)    │ │  (Express.js)    │
   │  + WebSocket     │ │  + WebSocket     │ │  + WebSocket     │
   └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
    ┌───────────────┬────────────┼────────────┬───────────────┐
    ▼               ▼            ▼            ▼               ▼
┌────────┐   ┌──────────┐  ┌─────────┐  ┌─────────┐   ┌──────────┐
│Postgres│   │  Redis    │  │RabbitMQ │  │Elastic  │   │  S3 /    │
│(Primary│   │  Cluster  │  │Cluster  │  │search   │   │  MinIO   │
│+ Read  │   │           │  │         │  │         │   │          │
│Replicas│   │- Sessions │  │- Bids   │  │- Auction│   │- Images  │
│)       │   │- Cache    │  │- Notifs │  │  Search │   │          │
│        │   │- Locks    │  │- End    │  │         │   │          │
│        │   │- Leaderbd │  │  Queue  │  │         │   │          │
└────────┘   └──────────┘  └─────────┘  └─────────┘   └──────────┘
```

### Core Components

1. **API Gateway / CDN**: TLS termination, rate limiting, geographic routing, DDoS protection
2. **API Servers (Express.js)**: Stateless REST API with WebSocket support for real-time bid updates
3. **PostgreSQL**: Primary data store with read replicas for query scaling
4. **Redis Cluster**: Caching, sessions, distributed locks, real-time leaderboards, rate limiting
5. **RabbitMQ**: Async processing for bids, notifications, auction endings with dead-letter support
6. **Elasticsearch**: Full-text search for auctions with faceted filtering
7. **S3 / MinIO**: Object storage for auction images, CDN-friendly

## Request Flows

### Placing a Bid

```
1. User submits bid via POST /api/v1/auctions/:id/bids
2. API Gateway validates auth token, applies rate limit
3. API server validates:
   a. Check session in Redis (auth)
   b. Rate limit check in Redis (max 10 bids/minute)
   c. Fetch current high bid from Redis cache
4. If bid > current high bid + increment:
   a. Publish bid to RabbitMQ "bids" queue
   b. Return 202 Accepted with bid ID
5. Bid Worker processes queue:
   a. Acquire distributed lock (Redis SETNX with TTL)
   b. BEGIN transaction in PostgreSQL
   c. SELECT current_high_bid FOR UPDATE (row lock)
   d. Validate bid still valid
   e. INSERT bid record
   f. UPDATE auction current_high_bid
   g. COMMIT transaction
   h. Release distributed lock
   i. Invalidate Redis cache
   j. Publish to "notifications" queue
   k. Broadcast via WebSocket to watchers
6. Notification Worker sends updates:
   a. Previous high bidder: "You've been outbid"
   b. Watchlist users: "New bid on watched item"
```

### Auto-Bidding (Proxy Bid)

```
1. User sets max_bid = $100 when current_bid = $50
2. System places bid at $51 (current + increment)
3. When another user bids $55:
   a. Bid Worker checks for proxy bids on this auction
   b. Finds user's max_bid = $100
   c. Auto-places bid at $56 on user's behalf
   d. Records as proxy_bid in bids table
4. If competing user bids $101:
   a. Exceeds user's max_bid
   b. User notified: "You've been outbid, max reached"
```

### Auction End

```
1. Scheduler polls for auctions ending in next minute
2. For each ending auction, publishes to "auction_end" queue
3. Auction End Worker:
   a. Acquire distributed lock (Redis SETNX)
   b. Fetch final bid state from PostgreSQL
   c. If high_bid >= reserve_price:
      - Mark auction SOLD
      - Process payment (circuit breaker protected)
      - Notify winner, seller
   d. Else:
      - Mark auction UNSOLD
      - Notify seller
   e. Release lock
```

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Auctions table
CREATE TABLE auctions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    image_url VARCHAR(500),
    starting_price DECIMAL(12,2) NOT NULL CHECK (starting_price > 0),
    current_price DECIMAL(12,2) NOT NULL,
    reserve_price DECIMAL(12,2),
    bid_increment DECIMAL(12,2) DEFAULT 1.00,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'ended', 'cancelled')),
    winner_id UUID REFERENCES users(id),
    winning_bid_id UUID,
    snipe_protection_minutes INTEGER DEFAULT 2,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    version INTEGER DEFAULT 0,
    CONSTRAINT valid_times CHECK (end_time > start_time)
);

-- Bids table (append-only for audit trail)
CREATE TABLE bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    is_auto_bid BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    sequence_num SERIAL
);

-- Auto-bid configuration (proxy bids)
CREATE TABLE auto_bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_amount DECIMAL(12,2) NOT NULL CHECK (max_amount > 0),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(auction_id, bidder_id)
);

-- Watchlist
CREATE TABLE watchlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, auction_id)
);

-- Notifications
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Audit logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_auctions_end_time ON auctions(end_time) WHERE status = 'active';
CREATE INDEX idx_auctions_status ON auctions(status);
CREATE INDEX idx_auctions_seller ON auctions(seller_id);
CREATE INDEX idx_bids_auction ON bids(auction_id, sequence_num);
CREATE INDEX idx_bids_bidder ON bids(bidder_id, created_at);
CREATE INDEX idx_auto_bids_auction ON auto_bids(auction_id) WHERE is_active = true;
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX idx_watchlist_user ON watchlist(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

ALTER TABLE auctions ADD CONSTRAINT fk_winning_bid
    FOREIGN KEY (winning_bid_id) REFERENCES bids(id);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_auctions_updated_at BEFORE UPDATE ON auctions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_auto_bids_updated_at BEFORE UPDATE ON auto_bids
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Caching Strategy

**Cache-Aside Pattern** with short TTLs for auction data:

| Cache Key Pattern | TTL | Invalidation |
|-------------------|-----|--------------|
| `session:{sessionId}` | 24 hours | On logout |
| `auction:{id}` | 60 seconds | On new bid |
| `auction:{id}:bids` | 30 seconds | On new bid |
| `user:{id}:rate_limit` | 60 seconds | Auto-expire |
| `search:category:{cat}` | 5 minutes | On new auction |

Cache invalidation is write-through on bid placement: after a successful bid, the cache is immediately updated so the next reader sees the new price without waiting for expiry.

### Storage Strategy

| Data | Storage | Rationale |
|------|---------|-----------|
| Users, Auctions, Bids | PostgreSQL | ACID transactions, relational integrity |
| Session data | Redis | Fast access, auto-expiry (24h TTL) |
| Auction cache | Redis | Reduce DB load, 60s TTL |
| Current high bid | Redis | Real-time updates, invalidate on new bid |
| Bid leaderboard | Redis Sorted Set | O(log N) updates, O(1) top-N queries |
| Search index | Elasticsearch | Full-text search, faceted filtering |
| Images | S3 / MinIO | Cost-effective blob storage, CDN-friendly |
| Message queues | RabbitMQ | Reliable async processing, dead-letter support |

## API Design

### Core Endpoints

```
# Authentication
POST   /api/v1/auth/register       # Create account
POST   /api/v1/auth/login          # Login, returns session cookie
POST   /api/v1/auth/logout         # Destroy session

# Auctions
GET    /api/v1/auctions            # List/search auctions (paginated)
POST   /api/v1/auctions            # Create auction (seller)
GET    /api/v1/auctions/:id        # Get auction details
PUT    /api/v1/auctions/:id        # Update auction (seller, before first bid)
DELETE /api/v1/auctions/:id        # Cancel auction (seller, before first bid)

# Bidding
POST   /api/v1/auctions/:id/bids   # Place bid (X-Idempotency-Key header)
GET    /api/v1/auctions/:id/bids   # Get bid history
POST   /api/v1/auctions/:id/proxy  # Set proxy/auto-bid

# User
GET    /api/v1/users/me/bids       # My active bids
GET    /api/v1/users/me/auctions   # My auctions (as seller)
GET    /api/v1/users/me/watchlist   # My watchlist
POST   /api/v1/users/me/watchlist   # Add to watchlist
DELETE /api/v1/users/me/watchlist/:id  # Remove from watchlist

# Admin
GET    /api/v1/admin/auctions      # All auctions with filters
PUT    /api/v1/admin/auctions/:id  # Admin override (cancel, extend)
GET    /api/v1/admin/users         # User management
POST   /api/v1/admin/users/:id/ban # Ban user
```

## Key Design Decisions

### Handling Concurrent Bids

**Problem**: Two users bid simultaneously; both see current bid as $50, both bid $51.

**Solution**: Double-layer locking with queue serialization.

1. **Redis distributed lock** (SETNX with 5s TTL) prevents multiple API servers from processing the same auction simultaneously.
2. **PostgreSQL row-level lock** (`SELECT ... FOR UPDATE`) serializes bid writes within the database.
3. **RabbitMQ queue** serializes bid processing through a single-consumer queue per auction.

**Why pessimistic over optimistic locking**: During auction endings, contention on hot auctions can spike to hundreds of simultaneous bids. Optimistic locking with version checks would cause massive retry storms -- if 100 users bid simultaneously, 99 would fail validation and retry, creating a cascade. Pessimistic locking serializes access, ensuring each bid is processed exactly once. The trade-off is reduced throughput under low contention, but correctness trumps throughput for financial transactions.

### Anti-Sniping Protection

**Problem**: Bids in final seconds give others no time to respond.

**Solution**: Extend auction by 2 minutes if bid placed within final 2 minutes. The `end_time` is updated atomically with the bid insertion inside the same transaction. Watchers are notified of the extension via WebSocket.

### Fair Ordering

**Problem**: Network latency could cause unfair bid ordering.

**Solution**: RabbitMQ single-consumer queue per auction ensures FIFO processing. Bids are routed using the auction ID as routing key, guaranteeing all bids for the same auction are processed sequentially by one worker. The `sequence_num` SERIAL column provides a database-level ordering guarantee.

### Queue-Based (Async) vs Synchronous Bids

We chose async queue processing (returning 202 Accepted) over synchronous bid placement. The trade-off: slightly delayed confirmation (~50-100ms queue latency) but guaranteed ordering and ability to handle burst traffic. During a hot auction ending, synchronous processing would create thread pool exhaustion as hundreds of concurrent requests all compete for the same database row. The queue absorbs the burst, processes bids sequentially, and returns results via WebSocket push.

## Consistency and Idempotency

### Idempotency for Bids

Clients send an `X-Idempotency-Key` header with each bid. Before processing, the system checks Redis for the key. If found, the cached result is returned. If not, the key is marked "in-progress" to prevent concurrent duplicates. After successful processing, the result is stored with a 24-hour TTL. A unique partial index on `bids(idempotency_key)` provides database-level deduplication as a safety net.

### Transaction Guarantees

- Bids are never lost (RabbitMQ persistence + acknowledgments)
- No duplicate bids (idempotency key in Redis + database)
- Auction state is always consistent (PostgreSQL transactions with row locks)
- At-least-once delivery for notifications (dead-letter queue for retries)

## Security

### Authentication and Authorization

**Session-Based Auth** stored in Redis with 24-hour TTL and secure cookies.

**RBAC Boundaries:**

| Role | Permissions |
|------|------------|
| Guest | View auctions, search |
| User | Bid, create auctions, manage watchlist |
| Seller | Edit/cancel own auctions (pre-bid) |
| Admin | Cancel any auction, ban users, view all data |

### Rate Limiting

Redis-based sliding window rate limits per user:

| Action | Limit | Window |
|--------|-------|--------|
| Place bid | 10 | 60 seconds |
| Create auction | 5 | 1 hour |
| Search | 30 | 60 seconds |

### Input Validation

- Sanitize all user inputs (XSS prevention)
- Validate bid amounts: positive decimals, max 2 decimal places
- Image uploads: Max 5 MB, allowed types (JPEG, PNG, WebP)
- SQL injection: parameterized queries exclusively

## Observability

### Metrics (Prometheus)

Key metrics exposed via `/metrics` endpoint:

| Metric | Type | Labels |
|--------|------|--------|
| `http_requests_total` | Counter | method, path, status |
| `http_request_duration_seconds` | Histogram | method, path |
| `bids_placed_total` | Counter | auction_id, is_auto_bid, status |
| `bid_placement_duration_seconds` | Histogram | status |
| `auctions_ended_total` | Counter | outcome (sold/unsold) |
| `distributed_lock_hold_duration_seconds` | Histogram | lock_name |
| `cache_hits_total` / `cache_misses_total` | Counter | cache_type |
| `circuit_breaker_state` | Gauge | service |
| `websocket_connections_active` | Gauge | - |

### SLI Dashboards

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Bid placement latency (p95) | < 200ms | > 500ms |
| Bid success rate | > 99.5% | < 99% |
| Auction end processing time | < 5s | > 30s |
| Search latency (p95) | < 100ms | > 300ms |
| API availability | > 99.9% | < 99.5% |

### Logging

Structured JSON logs with correlation IDs using Pino. Key log events: `bid_placed`, `bid_duplicate`, `auction_ended`, `circuit_breaker_open`. Development mode uses pino-pretty for human-readable output.

### Distributed Tracing

OpenTelemetry for request tracing with spans for: HTTP handler, DB query, cache lookup, queue publish, WebSocket broadcast. Trace IDs propagated through HTTP headers.

## Failure Handling

### Retry Strategy

| Operation | Retry Policy | Backoff |
|-----------|-------------|---------|
| DB connection | 3 retries | Exponential: 100ms, 200ms, 400ms |
| Cache miss fallback | 1 retry to DB | Immediate |
| Queue publish | 3 retries | Exponential: 1s, 2s, 4s |
| Notification send | 5 retries | Exponential: 1s, 2s, 4s, 8s, 16s |

### Circuit Breaker

Opossum circuit breakers protect external service calls (payment, escrow). Configuration: 5-second timeout, 50% error threshold to open, 30-60 second reset timeout. When open, fallback queues the operation for later retry.

### Dead Letter Queue

Failed RabbitMQ messages route to DLQ via dead-letter exchange. DLQ depth is monitored and alerts fire when depth exceeds 100 messages.

### Graceful Degradation

| Component Failure | Degradation Strategy |
|-------------------|---------------------|
| Redis down | Fall back to DB queries for reads, disable rate limiting |
| RabbitMQ down | Process bids synchronously (slower, still correct) |
| Elasticsearch down | Disable search, show category-based browsing |
| Payment service down | Accept bids, queue payment for later (circuit breaker) |

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scale Strategy | Trigger |
|-----------|---------------|---------|
| API Servers | Add instances behind LB | CPU > 70% |
| PostgreSQL | Read replicas for queries | Read RPS > 200 |
| Redis | Cluster mode | Memory > 80% |
| RabbitMQ | Clustering | Queue depth > 10K |
| Elasticsearch | Add data nodes | Index size > 50 GB |

### Database Sharding Strategy

If auctions exceed 10M records, shard by `auction_id` hash. Bids are co-located with their auction for locality. Users remain in a single shard (low cardinality).

### Hot Auction Handling

Popular auctions create hotspots. Mitigation:
1. Per-auction rate limiting (100 bids/minute cap)
2. Bid batching: Collect bids for 100ms window, process highest
3. Dedicated queue/worker for auctions with >50 watchers
4. Read replicas serve bid history queries to offload primary

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bid processing | Async queue (202) | Synchronous (200) | Burst absorption, guaranteed ordering |
| Concurrency control | Pessimistic locking | Optimistic (version check) | Correctness under high contention |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Search | Elasticsearch | PostgreSQL full-text | Faceted filtering, relevance scoring |
| Real-time updates | WebSocket | Polling | Sub-100ms latency for bid updates |
| Image storage | S3/MinIO + CDN | Database BLOBs | Cost, CDN delivery, independent scaling |

## Implementation Notes

This section maps the production architecture above to the local Docker + Node.js setup actually built.

### Local Setup Diagram

```
┌─────────────────┐
│   React Frontend │
│   (localhost:5173)│
└────────┬─────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  API Server :3001│     │  API Server :3002│     │  API Server :3003│
│  (Express + WS) │     │  (Express + WS) │     │  (Express + WS) │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
    ┌──────────────────┐                    ┌──────────────────┐
    │   PostgreSQL 16  │                    │   Valkey/Redis   │
    │  (localhost:5432) │                    │  (localhost:6379) │
    │                  │                    │                  │
    │  DB: auction_db  │                    │  Sessions, cache,│
    │  User: auction   │                    │  locks, leaderbd │
    └──────────────────┘                    └──────────────────┘
```

### Production Patterns Actually Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breaker | Opossum | `backend/src/shared/circuitBreaker.ts` | Payment/escrow service protection with fallback |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 15+ custom metrics: bids, auctions, cache, locks, circuit state |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with correlation, pino-pretty for dev |
| Distributed locking | ioredis SETNX | `backend/src/routes/bids.ts` | Redis-based locks for bid serialization |
| Idempotency | Redis + DB check | `backend/src/routes/bids.ts` | X-Idempotency-Key header, Redis dedup |
| WebSocket | ws | `backend/src/services/websocket.ts` | Real-time bid updates to watchers |
| Anti-sniping | Custom scheduler | `backend/src/services/scheduler.ts` | 2-minute extension on late bids |
| Health checks | Custom endpoints | `backend/src/index.ts` | `/api/health`, `/api/health/detailed`, `/api/ready`, `/api/live` |
| Rate limiting | Redis counters | `backend/src/middleware/` | Per-user sliding window |
| Metrics middleware | prom-client | `backend/src/shared/metrics.ts` | HTTP duration histograms, request counters |

### Simplifications from Production Design

| Production | Local Substitute | Impact |
|------------|-----------------|--------|
| API Gateway + CDN | Direct frontend-to-backend | No TLS termination, no geographic routing |
| RabbitMQ bid queue | Synchronous bid processing in-process | Bids processed inline, no queue serialization |
| Elasticsearch | PostgreSQL ILIKE queries | No faceted search, slower full-text |
| S3 + CloudFront | Local filesystem (`/uploads`) | No CDN, no object versioning |
| Redis Cluster | Single Valkey instance | No sharding, single point of failure |
| PostgreSQL read replicas | Single PostgreSQL instance | All reads/writes on same instance |
| Multiple bid workers | Single API server handles bids | No worker isolation |
| Load balancer (nginx) | Run 3 instances manually on :3001-:3003 | No automatic failover |

### What Was Omitted

- CDN for image delivery
- Multi-region deployment
- Kubernetes orchestration
- Database sharding
- Payment gateway integration (simulated with circuit breaker)
- Email/push notification delivery (stored in DB)
- Elasticsearch for search
- OAuth/JWT authentication
- Fraud detection / ML-based bid pattern analysis
