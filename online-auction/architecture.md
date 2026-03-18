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

## Frontend Architecture

This section describes the React frontend implementation: component hierarchy, state management, routing, data fetching patterns, and key UI behaviors.

### Technology Stack

| Technology | Purpose |
|-----------|---------|
| React 19 + TypeScript | UI framework with type safety |
| TanStack Router | File-based routing with type-safe params |
| Zustand | Lightweight global state management |
| Tailwind CSS | Utility-first CSS styling |
| Vite | Development server and build tool |

### Route Structure

TanStack Router file-based routing in `frontend/src/routes/`:

| File | Path | Description |
|------|------|-------------|
| `__root.tsx` | (layout) | Root layout with sticky Header, main content Outlet, and footer |
| `index.tsx` | `/` | Home page with auction browsing, search, filters, and pagination |
| `login.tsx` | `/login` | Login form |
| `register.tsx` | `/register` | Registration form |
| `auction.$auctionId.tsx` | `/auction/:auctionId` | Auction detail with real-time bid updates via WebSocket |
| `create.tsx` | `/create` | Create new auction form with image upload (FormData) |
| `my-auctions.tsx` | `/my-auctions` | User's auctions as seller, bid history, selling history |
| `watchlist.tsx` | `/watchlist` | User's watched auctions list |
| `notifications.tsx` | `/notifications` | Notification center with read/unread management |
| `admin.tsx` | `/admin` | Admin dashboard with platform stats, user management, force-close |

### Zustand Stores

The frontend uses two Zustand stores to manage global state:

**`authStore.ts`** -- Authentication state with localStorage persistence. Stores the current user and session token. The `persist` middleware saves only the token to localStorage via `partialize`, so session survives browser refresh. On app load, `checkAuth()` validates the stored token against `GET /api/auth/me`. If valid, the user object is populated; if not, the token is cleared and the user is treated as unauthenticated. Actions: `login`, `register`, `logout`, `checkAuth`.

**`websocketStore.ts`** -- WebSocket connection state for real-time auction updates. Manages a single WebSocket connection to the server, a set of subscribed auction IDs, and a listener registry. When connected, the store sends `{ type: 'subscribe', auction_id }` messages for each auction the user is viewing. On disconnect, it automatically reconnects after 3 seconds and re-subscribes to all previously tracked auctions. External components register message callbacks via `addMessageListener()`, which returns a cleanup function. The listener pattern (a `Set<callback>` stored outside the Zustand state to avoid serialization issues) allows multiple components to independently react to the same WebSocket messages without coupling.

### Component Hierarchy

```
__root (Header + Outlet + Footer)
├── HomePage
│   ├── Search bar + Status filter + Sort dropdown
│   ├── AuctionCard[] (grid layout, responsive 1-4 columns)
│   │   └── CountdownTimer (uses useCountdown hook)
│   └── Pagination controls
├── AuctionPage (detail)
│   ├── Image display (or placeholder SVG)
│   ├── Auction metadata (seller, starting price, increment, reserve)
│   ├── CountdownTimer (large, with snipe protection notice)
│   ├── BidForm (manual bid + auto-bid toggle)
│   │   ├── Manual bid input with minimum enforcement
│   │   └── Auto-bid configuration panel
│   ├── BidHistory (chronological bid list, highlights current user)
│   └── Watch/Unwatch toggle
├── CreateAuction (FormData submission with image upload)
├── MyAuctions (tabs for selling/bidding history)
├── Watchlist (list of watched auctions)
├── Notifications (with mark-read, mark-all-read)
└── Admin (stats dashboard, user list, role management, force-close)
```

### Data Fetching Pattern

The frontend uses plain `fetch()` calls wrapped in an `api` service object (`services/api.ts`). All requests include `credentials: 'include'` for session cookie handling. A shared `handleResponse<T>()` helper parses JSON responses and throws errors with the server's error message. There is no React Query or SWR -- data fetching is done via `useEffect` with local `useState` for loading, error, and data states. When filters change (status, sort, search, page), the `useEffect` dependency array triggers a refetch.

### Key UI Patterns

**Real-time bid updates via WebSocket**: The `useAuctionSubscription` hook manages the full WebSocket lifecycle for a specific auction. It subscribes on mount, unsubscribes on unmount, and filters incoming messages by `auction_id`. When a `new_bid` message arrives, the auction detail page optimistically updates the displayed price from the WebSocket payload, then does a full refetch to get the updated bid history. When an `auction_ended` message arrives, the page refetches to show final state.

**Countdown timer**: The `useCountdown` hook recalculates time remaining every second via `setInterval`. It returns individual time components (days, hours, minutes, seconds) and a `totalSeconds` value used for urgency detection. When `totalSeconds < 300` (5 minutes), the `CountdownTimer` component switches to red pulsing text with an "Ending Soon!" label. When the countdown reaches zero, it shows "Auction Ended" in gray.

**Minimum bid enforcement**: The `BidForm` component calculates `minBid = current_price + bid_increment` and enforces it client-side before submission. The auto-bid toggle reveals a separate form for setting a maximum proxy bid amount. When an active auto-bid exists, it displays the max amount with a cancel button instead of the setup form.

**Conditional rendering by auth state and ownership**: The auction detail page checks `isAuthenticated` to show/hide the bid form (showing "Sign in to place a bid" for guests), checks `isOwner` to display "This is your auction" instead of the bid form, and checks `isWinner` to show a "You Won!" badge.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before. Each explanation covers what the pattern is, what problem it solves, and how it works in this project.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of checking "can user X do action Y?" for every user individually, the system checks "does user X have a role that permits action Y?" This decouples permission logic from individual user identities.

**What problem it solves**: Without RBAC, authorization logic scatters throughout the codebase as ad-hoc checks ("if user.id === auction.seller_id"). When new features or admin capabilities are added, every endpoint must be audited. RBAC centralizes permission decisions: a middleware checks the user's role against the route's required role before the handler executes. If the role does not match, the request is rejected with 403 Forbidden before any business logic runs.

**How it works in this project**: The `users` table has a `role` column constrained to `('user', 'admin')`. When a request arrives, the auth middleware loads the session from Redis, retrieves the user record, and attaches it to the request object. Admin endpoints (`/api/v1/admin/*`) check `req.user.role === 'admin'` via a role-checking middleware. Sellers can only edit/cancel their own auctions (ownership check + role check). Guests (no session) can only view auctions and search. This four-tier model (guest, user, seller, admin) maps directly to the RBAC boundaries table in the Security section.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it. On a cache hit, the cached value is returned directly, skipping the database entirely. The cache is "aside" from the main data flow -- it is not in the write path, and the database is the source of truth.

**What problem it solves**: Database queries are expensive (network round-trip, query parsing, disk I/O). For read-heavy workloads like auction browsing (where the same auction page may be viewed thousands of times per minute during a hot auction), querying the database for every request wastes resources and increases latency. Cache-aside reduces database load by serving repeated reads from memory (Redis responds in <1ms vs 5-50ms for PostgreSQL).

**How it works in this project**: Auction data is cached in Redis with keys like `auction:{id}` (60-second TTL) and `auction:{id}:bids` (30-second TTL). When a user views an auction, the server checks Redis first. If the key exists, the cached JSON is returned immediately. If not, the server queries PostgreSQL, stores the result in Redis with `SETEX`, and returns it. When a new bid is placed, the bid worker invalidates the cache by deleting the relevant keys, so the next read fetches fresh data from the database. This is "write-through invalidation" -- writes go to the database first, then the cache is cleared (not updated) to avoid stale data.

### Circuit Breaker

**What it is**: A circuit breaker is a stability pattern borrowed from electrical engineering. It wraps calls to an external service (payment gateway, third-party API) and monitors failure rates. When failures exceed a threshold, the circuit "opens" and immediately rejects subsequent calls without attempting them, giving the failing service time to recover. After a timeout, the circuit enters a "half-open" state where it allows a limited number of test requests. If those succeed, the circuit closes and normal operation resumes. If they fail, the circuit reopens.

**What problem it solves**: When a downstream service is failing (overloaded, crashed, network issue), continuing to send requests creates a cascade: your application's threads/connections pool exhausts while waiting for timeouts, your response times spike, and your users see errors. The circuit breaker prevents this cascade by failing fast -- returning an error immediately (or executing a fallback) instead of waiting for a timeout that will inevitably fail. This preserves your application's resources for requests that can actually succeed.

**How it works in this project**: The Opossum library wraps payment/escrow service calls in `backend/src/shared/circuitBreaker.ts`. Configuration: 5-second timeout per request, circuit opens when 50% of requests fail, stays open for 30-60 seconds before testing. When the circuit is open, the fallback handler queues the payment operation for later retry instead of blocking the bid process. The circuit breaker state is exposed as a Prometheus gauge metric (`circuit_breaker_state`) so operators can see when a downstream service is degraded. The auction end worker uses this to handle payment processing gracefully -- if payment fails, the auction is still marked as SOLD and the payment is retried later.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable data (typically JSON) rather than free-form text strings. Each log entry has well-defined fields: timestamp, log level (info/warn/error), message, and arbitrary contextual key-value pairs (user ID, auction ID, bid amount, latency). This contrasts with traditional `console.log("User 123 placed bid $50 on auction 456")` which is human-readable but impossible to reliably parse, filter, or aggregate programmatically.

**What problem it solves**: In a distributed system with multiple server instances, debugging a single user's request requires finding the relevant log entries among millions. Free-form text logs require regex-based searching and break whenever the message format changes. Structured logs enable precise queries: "show me all log entries where `auction_id = X` and `level = error` in the last hour." Log aggregation tools (Elasticsearch, Datadog, CloudWatch) can index JSON fields for sub-second search across terabytes of logs.

**How it works in this project**: The Pino library (`backend/src/shared/logger.ts`) outputs JSON logs with fields including `level`, `time`, `msg`, and contextual data. Each log line looks like `{"level":30,"time":1234567890,"msg":"bid_placed","auction_id":"abc","amount":50.00,"bidder_id":"xyz"}`. A correlation ID (from the `X-Request-Id` header) is attached to every log entry within a request, allowing all log entries for a single user action to be traced across multiple function calls. In development mode, `pino-pretty` reformats the JSON into colored, human-readable output. Key logged events: `bid_placed`, `bid_duplicate`, `auction_ended`, `circuit_breaker_open`.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system. The application exposes a `/metrics` HTTP endpoint that returns numerical measurements in a specific text format. A Prometheus server periodically scrapes this endpoint (typically every 15 seconds) and stores the values in a time-series database. Grafana or similar tools query this database to create dashboards and trigger alerts. The three main metric types are: counters (monotonically increasing values like "total requests"), histograms (distribution of values like "request duration in buckets"), and gauges (point-in-time values like "active WebSocket connections").

**What problem it solves**: Without metrics, the only way to know if the system is healthy is to wait for users to complain or for a total failure. Metrics provide continuous, quantitative visibility: "bid placement latency p95 increased from 100ms to 400ms over the last 10 minutes" is actionable before users notice degradation. Metrics also enable capacity planning ("we serve 5,000 bids/second; our database handles 8,000; we have 60% headroom") and incident investigation ("the spike in 500 errors correlates with the cache hit rate dropping from 95% to 20%").

**How it works in this project**: The `prom-client` library (`backend/src/shared/metrics.ts`) registers 15+ custom metrics. Examples: `bids_placed_total` (counter with labels for auction_id, is_auto_bid, status), `bid_placement_duration_seconds` (histogram measuring how long bid processing takes), `websocket_connections_active` (gauge tracking concurrent connections), `cache_hits_total` / `cache_misses_total` (counters for monitoring cache effectiveness). A metrics middleware records `http_request_duration_seconds` for every API request, with labels for method, path, and status code. Path labels are normalized (UUIDs replaced with `:id`) to prevent unbounded label cardinality, which would cause Prometheus to consume excessive memory.

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make within a time window. The system tracks request counts per client (identified by user ID, IP address, or API key) and rejects requests that exceed the configured threshold with HTTP 429 (Too Many Requests). The response includes a `Retry-After` header indicating when the client can try again.

**What problem it solves**: Without rate limiting, a single malicious or buggy client can monopolize server resources, making the system unresponsive for everyone. In an auction system specifically, rate limiting prevents bid bombing (a script placing hundreds of bids per second to disrupt competitors), credential stuffing attacks on the login endpoint, and scraping of auction data. It also protects downstream services (database, Redis) from being overwhelmed by a traffic spike from a single source.

**How it works in this project**: Redis-based sliding window counters track requests per user per action type. The key pattern is `user:{userId}:rate_limit` with a 60-second TTL. When a user places a bid, the server increments the counter and checks if it exceeds 10. If so, the bid is rejected with 429. Different actions have different limits: 10 bids per minute, 5 auction creations per hour, 30 searches per minute. The sliding window approach (using Redis `INCR` + `EXPIRE`) is preferred over fixed windows because it prevents the "boundary burst" problem where a client sends 10 requests at 0:59 and 10 more at 1:00, effectively getting 20 requests in 2 seconds.

### Idempotency

**What it is**: An idempotent operation produces the same result whether it is executed once or multiple times. In the context of APIs, idempotency means that if a client sends the same request twice (due to a network retry, user double-click, or mobile app timeout), the server processes it only once and returns the same response both times. The client attaches a unique key (typically a UUID) to each logical operation via a header like `X-Idempotency-Key`.

**What problem it solves**: Network failures are inevitable. When a client sends a bid request and the network drops before the response arrives, the client does not know if the bid was placed or not. Without idempotency, retrying the request could place a second bid at a higher amount (because the first bid raised the price). In financial systems, this can cause monetary loss. Idempotency guarantees that retrying a request is always safe -- the worst case is a slightly delayed response, never a duplicate side effect.

**How it works in this project**: When a bid arrives with an `X-Idempotency-Key` header, the server first checks Redis for the key. If found with a cached result, it returns that result immediately (200 OK, not 409 Conflict, because the client's intent was achieved). If not found, the server sets the key to "in-progress" in Redis (preventing concurrent duplicates from parallel retries), processes the bid, stores the result with a 24-hour TTL, and returns it. A unique partial index on `bids(idempotency_key)` in PostgreSQL provides a database-level safety net in case Redis is unavailable. Keys expire after 24 hours because a retry after that long is almost certainly a new user intent, not a network retry.

### Health Checks

**What it is**: Health check endpoints are HTTP routes that report whether the application is functioning correctly. They are consumed by infrastructure components (load balancers, Kubernetes, monitoring systems) to make automated decisions about traffic routing and container lifecycle. There are typically three types: liveness (is the process running and not deadlocked?), readiness (can the application serve traffic, i.e., are all dependencies connected?), and detailed (a debugging-oriented view of all component statuses with latency measurements).

**What problem it solves**: In a multi-instance deployment behind a load balancer, an instance might be running but unable to serve requests (database connection lost, Redis unreachable, thread pool exhausted). Without health checks, the load balancer continues sending traffic to the broken instance, causing errors for users. Health checks enable automatic traffic rerouting: if `/health/ready` returns non-200, the load balancer stops sending new requests to that instance. Kubernetes uses liveness checks to restart stuck containers and readiness checks to remove pods from service endpoints.

**How it works in this project**: The backend exposes four endpoints: `GET /api/health` (basic liveness -- returns 200 with uptime and memory usage), `GET /api/health/detailed` (checks PostgreSQL connectivity via `SELECT 1`, checks Redis connectivity via `PING`, reports connection pool stats and per-component latency), `GET /api/ready` (returns 200 only if both PostgreSQL and Redis are connected, otherwise 503), and `GET /api/live` (always returns 200 if the process is running). The detailed endpoint measures the time each dependency check takes, so operators can see if database queries are slow even before they start failing.
