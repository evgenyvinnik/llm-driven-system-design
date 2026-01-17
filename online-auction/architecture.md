# Online Auction System - Architecture Design

## System Overview

A bidding and auction platform for online sales, supporting real-time bidding, auto-bidding (proxy bids), concurrent bid handling, and fair auction resolution.

## Requirements

### Functional Requirements

- **Item listing**: Sellers create auctions with title, description, images, starting price, reserve price (optional), and end time
- **Bidding**: Users place bids that must exceed current highest bid by a minimum increment
- **Auto-bidding (Proxy Bids)**: Users set a maximum bid; system automatically bids on their behalf up to that limit
- **Auction end handling**: Determine winner, handle reserve-not-met scenarios, notify participants
- **Bid history**: View all bids on an item with timestamps
- **Watchlist**: Users track auctions they are interested in
- **Anti-sniping protection**: Extend auction by 2 minutes if bid placed in final 2 minutes

### Non-Functional Requirements

- **Scalability**: Support 1,000 concurrent auctions, 10,000 active users
- **Availability**: 99.9% uptime (8.76 hours downtime/year)
- **Latency**: p95 bid placement < 200ms, p99 < 500ms
- **Consistency**: Strong consistency for bid ordering; no two bids with same amount accepted

## Capacity Estimation

### Local Development Scale

For learning purposes, we target a "small auction site" profile:

| Metric | Value | Notes |
|--------|-------|-------|
| Daily Active Users (DAU) | 1,000 | Simulates modest traffic |
| Concurrent users | 100 | Peak during auction endings |
| Active auctions | 500 | At any given time |
| Bids per auction | 20 avg | Range: 1-200 for hot items |
| Total bids/day | 10,000 | 500 auctions x 20 bids |

### Requests Per Second (RPS)

| Operation | RPS | Sizing Impact |
|-----------|-----|---------------|
| View auction | 50 | Read-heavy, cacheable |
| Place bid | 5 | Write, needs strong consistency |
| Create auction | 1 | Write, moderate |
| Search auctions | 20 | Read, benefits from Elasticsearch |
| Auto-bid triggers | 2 | Background processing |

**Peak RPS**: During auction endings, bid RPS can spike 10x to 50 RPS for popular items.

### Storage Requirements

| Data Type | Size per Record | Records/Year | Annual Growth |
|-----------|----------------|--------------|---------------|
| Auctions | 2 KB | 50,000 | 100 MB |
| Bids | 200 B | 1,000,000 | 200 MB |
| Users | 1 KB | 10,000 | 10 MB |
| Images | 500 KB avg | 200,000 | 100 GB |

**Total Year 1**: ~100 GB (dominated by images in MinIO)

### Component Sizing (Local Dev)

Based on capacity estimates:

| Component | Sizing | Rationale |
|-----------|--------|-----------|
| PostgreSQL | 1 instance, 1 GB RAM | Handles 100 RPS easily |
| Valkey/Redis | 1 instance, 256 MB | ~5,000 cached auctions |
| RabbitMQ | 1 instance, 256 MB | 10 msg/sec throughput |
| Elasticsearch | 1 instance, 512 MB | 50K documents searchable |
| MinIO | 1 instance, 10 GB disk | Image storage |
| API servers | 2-3 instances | Simulate load balancing |

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx:3000)   |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
     +--------v--------+          +----------v--------+          +----------v--------+
     |  API Server 1   |          |  API Server 2     |          |  API Server 3     |
     |  (Express:3001) |          |  (Express:3002)   |          |  (Express:3003)   |
     +--------+--------+          +----------+--------+          +----------+--------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
         +-----------------------------------+-----------------------------------+
         |                    |                    |                    |        |
+--------v--------+  +--------v--------+  +-------v--------+  +--------v------+ |
|   PostgreSQL    |  |  Valkey/Redis   |  |  RabbitMQ      |  | Elasticsearch | |
|   (Port 5432)   |  |  (Port 6379)    |  |  (Port 5672)   |  | (Port 9200)   | |
|                 |  |                 |  |                |  |               | |
| - Users         |  | - Session store |  | - Bid queue    |  | - Auction     | |
| - Auctions      |  | - Auction cache |  | - Notification |  |   search      | |
| - Bids          |  | - Leaderboard   |  |   queue        |  |               | |
| - Watchlists    |  | - Rate limits   |  | - Auction end  |  |               | |
+-----------------+  +-----------------+  |   queue        |  +---------------+ |
                                          +----------------+                    |
                                                                               |
                                          +----------------+                   |
                                          |     MinIO      |<------------------+
                                          |  (Port 9000)   |
                                          | - Item images  |
                                          +----------------+
```

### Core Components

1. **Load Balancer (nginx)**: Distributes requests across API servers using round-robin
2. **API Servers (Express.js)**: Stateless REST API handling all business logic
3. **PostgreSQL**: Primary data store for transactional data
4. **Valkey/Redis**: Caching, sessions, real-time leaderboards, rate limiting
5. **RabbitMQ**: Async processing for bids, notifications, auction endings
6. **Elasticsearch**: Full-text search for auctions
7. **MinIO**: S3-compatible storage for auction images

### Request Flow: Placing a Bid

```
1. User submits bid via POST /api/v1/auctions/:id/bids
2. Load balancer routes to available API server
3. API server validates:
   a. Check session in Valkey (auth)
   b. Rate limit check in Valkey (max 10 bids/minute)
   c. Fetch current high bid from Valkey cache
4. If bid > current high bid + increment:
   a. Publish bid to RabbitMQ "bids" queue
   b. Return 202 Accepted with bid ID
5. Bid Worker processes queue:
   a. BEGIN transaction in PostgreSQL
   b. SELECT current_high_bid FOR UPDATE (row lock)
   c. Validate bid still valid
   d. INSERT bid record
   e. UPDATE auction current_high_bid
   f. COMMIT transaction
   g. Invalidate Valkey cache
   h. Publish to "notifications" queue
6. Notification Worker sends updates:
   a. Previous high bidder: "You've been outbid"
   b. Watchlist users: "New bid on watched item"
```

### Request Flow: Auto-Bidding (Proxy Bid)

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

### Request Flow: Auction End

```
1. Scheduler polls for auctions ending in next minute
2. For each ending auction, publishes to "auction_end" queue
3. Auction End Worker:
   a. Acquire distributed lock (Valkey SETNX)
   b. Fetch final bid state from PostgreSQL
   c. If high_bid >= reserve_price:
      - Mark auction SOLD
      - Notify winner, seller
   d. Else:
      - Mark auction UNSOLD
      - Notify seller
   e. Release lock
```

## Data Model

### Database Schema (PostgreSQL)

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Auctions table
CREATE TABLE auctions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID REFERENCES users(id) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    starting_price DECIMAL(12,2) NOT NULL CHECK (starting_price > 0),
    reserve_price DECIMAL(12,2),
    bid_increment DECIMAL(12,2) DEFAULT 1.00,
    current_high_bid DECIMAL(12,2),
    current_high_bidder_id UUID REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'ended', 'sold', 'unsold', 'cancelled')),
    start_time TIMESTAMPTZ DEFAULT NOW(),
    end_time TIMESTAMPTZ NOT NULL,
    original_end_time TIMESTAMPTZ NOT NULL,  -- For anti-sniping tracking
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    version INTEGER DEFAULT 1  -- Optimistic locking
);

CREATE INDEX idx_auctions_status_end ON auctions(status, end_time);
CREATE INDEX idx_auctions_seller ON auctions(seller_id);
CREATE INDEX idx_auctions_category ON auctions(category);

-- Bids table
CREATE TABLE bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID REFERENCES auctions(id) NOT NULL,
    bidder_id UUID REFERENCES users(id) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    max_amount DECIMAL(12,2),  -- For proxy/auto-bids
    is_proxy_bid BOOLEAN DEFAULT FALSE,
    is_winning BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    idempotency_key VARCHAR(64) UNIQUE  -- Prevent duplicate bids
);

CREATE INDEX idx_bids_auction ON bids(auction_id, created_at DESC);
CREATE INDEX idx_bids_bidder ON bids(bidder_id);
CREATE UNIQUE INDEX idx_bids_idempotency ON bids(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Watchlist table
CREATE TABLE watchlists (
    user_id UUID REFERENCES users(id),
    auction_id UUID REFERENCES auctions(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, auction_id)
);

-- Auction images table
CREATE TABLE auction_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID REFERENCES auctions(id) NOT NULL,
    image_key VARCHAR(255) NOT NULL,  -- MinIO object key
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_images_auction ON auction_images(auction_id);

-- Notifications table (for async delivery tracking)
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type VARCHAR(50) NOT NULL,
    auction_id UUID REFERENCES auctions(id),
    message TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
```

### Storage Strategy

| Data | Storage | Rationale |
|------|---------|-----------|
| Users, Auctions, Bids | PostgreSQL | ACID transactions, relational integrity |
| Session data | Valkey | Fast access, auto-expiry (24h TTL) |
| Auction cache | Valkey | Reduce DB load, 60s TTL |
| Current high bid | Valkey | Real-time updates, invalidate on new bid |
| Bid leaderboard | Valkey Sorted Set | O(log N) updates, O(1) top-N queries |
| Search index | Elasticsearch | Full-text search, faceted filtering |
| Images | MinIO | Cost-effective blob storage, CDN-friendly |
| Message queues | RabbitMQ | Reliable async processing, dead-letter support |

### Caching Strategy

**Cache-Aside Pattern** for auction data:

```javascript
async function getAuction(auctionId) {
  const cacheKey = `auction:${auctionId}`;

  // Try cache first
  let auction = await valkey.get(cacheKey);
  if (auction) {
    return JSON.parse(auction);
  }

  // Cache miss: fetch from DB
  auction = await db.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);

  // Populate cache with 60s TTL
  await valkey.setex(cacheKey, 60, JSON.stringify(auction));

  return auction;
}

// Invalidate on bid
async function invalidateAuctionCache(auctionId) {
  await valkey.del(`auction:${auctionId}`);
  await valkey.del(`auction:${auctionId}:bids`);
}
```

**Cache TTLs:**

| Cache Key Pattern | TTL | Invalidation |
|-------------------|-----|--------------|
| `session:{sessionId}` | 24 hours | On logout |
| `auction:{id}` | 60 seconds | On new bid |
| `auction:{id}:bids` | 30 seconds | On new bid |
| `user:{id}:rate_limit` | 60 seconds | Auto-expire |
| `search:category:{cat}` | 5 minutes | On new auction |

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
POST   /api/v1/auctions/:id/bids   # Place bid
GET    /api/v1/auctions/:id/bids   # Get bid history
POST   /api/v1/auctions/:id/proxy  # Set proxy/auto-bid

# User
GET    /api/v1/users/me/bids       # My active bids
GET    /api/v1/users/me/auctions   # My auctions (as seller)
GET    /api/v1/users/me/watchlist  # My watchlist
POST   /api/v1/users/me/watchlist  # Add to watchlist
DELETE /api/v1/users/me/watchlist/:id  # Remove from watchlist

# Admin
GET    /api/v1/admin/auctions      # All auctions with filters
PUT    /api/v1/admin/auctions/:id  # Admin override (cancel, extend)
GET    /api/v1/admin/users         # User management
POST   /api/v1/admin/users/:id/ban # Ban user
```

### Example: Place Bid Request/Response

**Request:**
```http
POST /api/v1/auctions/550e8400-e29b-41d4-a716-446655440000/bids
Content-Type: application/json
Cookie: session=abc123
X-Idempotency-Key: bid-123-456

{
  "amount": 55.00
}
```

**Success Response (202 Accepted):**
```json
{
  "bidId": "660e8400-e29b-41d4-a716-446655440001",
  "status": "pending",
  "amount": 55.00,
  "message": "Bid submitted for processing"
}
```

**Error Responses:**
```json
// 400 Bad Request - Bid too low
{
  "error": "BID_TOO_LOW",
  "message": "Bid must be at least $51.00 (current: $50.00, increment: $1.00)",
  "currentBid": 50.00,
  "minimumBid": 51.00
}

// 409 Conflict - Auction ended
{
  "error": "AUCTION_ENDED",
  "message": "This auction ended at 2025-01-15T18:00:00Z"
}

// 429 Too Many Requests
{
  "error": "RATE_LIMITED",
  "message": "Maximum 10 bids per minute. Try again in 45 seconds.",
  "retryAfter": 45
}
```

## Key Design Decisions

### Handling Concurrent Bids

**Problem**: Two users bid simultaneously; both see current bid as $50, both bid $51.

**Solution**: Pessimistic locking with queue serialization

```sql
-- Bid worker uses SELECT FOR UPDATE
BEGIN;

SELECT current_high_bid, status, end_time
FROM auctions
WHERE id = $1
FOR UPDATE;  -- Row-level lock

-- Validate bid
-- If valid, update
UPDATE auctions
SET current_high_bid = $2,
    current_high_bidder_id = $3,
    version = version + 1
WHERE id = $1;

INSERT INTO bids (auction_id, bidder_id, amount) VALUES ($1, $3, $2);

COMMIT;
```

**Alternative Considered**: Optimistic locking with version check
- Pros: Higher throughput under low contention
- Cons: More retries needed during auction endings
- **Decision**: Use pessimistic for bids (correctness critical), optimistic for auction updates

### Anti-Sniping Protection

**Problem**: Bids in final seconds give others no time to respond.

**Solution**: Extend auction by 2 minutes if bid placed within final 2 minutes.

```javascript
async function processBid(bid, auction) {
  const timeRemaining = auction.end_time - Date.now();
  const SNIPE_WINDOW = 2 * 60 * 1000; // 2 minutes

  if (timeRemaining < SNIPE_WINDOW) {
    auction.end_time = new Date(Date.now() + SNIPE_WINDOW);
    // Notify watchers of extension
    await notifyWatchers(auction.id, 'AUCTION_EXTENDED');
  }
}
```

### Fair Ordering

**Problem**: Network latency could cause unfair bid ordering.

**Solution**: Use RabbitMQ single-consumer queue per auction for serialized processing.

```javascript
// Route bids to auction-specific queues
const routingKey = `bids.auction.${auctionId}`;
channel.publish('bids_exchange', routingKey, bidMessage);

// Single consumer per queue ensures FIFO ordering
channel.consume(`bids.${auctionId}`, processBid, { noAck: false });
```

### Transaction Consistency

**Guarantees:**
- Bids are never lost (RabbitMQ persistence + acknowledgments)
- No duplicate bids (idempotency key in bids table)
- Auction state is always consistent (DB transactions)
- At-least-once delivery for notifications (dead-letter queue for retries)

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Vite + TypeScript | Modern DX, fast builds |
| **Routing** | TanStack Router | Type-safe routing |
| **State** | Zustand | Simple, performant |
| **Styling** | Tailwind CSS | Rapid UI development |
| **Backend** | Node.js + Express | JavaScript ecosystem, async I/O |
| **Primary DB** | PostgreSQL 16 | ACID, mature, great tooling |
| **Cache** | Valkey | Redis-compatible, open source |
| **Queue** | RabbitMQ | Reliable messaging, DLQ support |
| **Search** | Elasticsearch 8 | Full-text, facets, aggregations |
| **Object Storage** | MinIO | S3-compatible, self-hosted |
| **Load Balancer** | nginx | Industry standard, simple config |

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scale Strategy | Trigger |
|-----------|---------------|---------|
| API Servers | Add instances behind LB | CPU > 70% |
| PostgreSQL | Read replicas for queries | Read RPS > 200 |
| Valkey | Cluster mode | Memory > 80% |
| RabbitMQ | Clustering | Queue depth > 10K |
| Elasticsearch | Add data nodes | Index size > 50 GB |

### Database Sharding Strategy (Future)

If auctions exceed 10M records:
- Shard by `auction_id` hash
- Bids co-located with their auction
- Users remain in single shard (low cardinality)

### Hot Auction Handling

Popular auctions create hotspots. Mitigation:
1. Per-auction rate limiting (100 bids/minute cap)
2. Bid batching: Collect bids for 100ms, process highest
3. Dedicated queue/worker for auctions with >50 watchers

## Security Considerations

### Authentication and Authorization

**Session-Based Auth:**
```javascript
// Session stored in Valkey
{
  sessionId: "abc123",
  userId: "user-uuid",
  role: "user",  // or "admin"
  createdAt: 1705334400,
  expiresAt: 1705420800  // 24 hours
}
```

**RBAC Boundaries:**

| Role | Permissions |
|------|------------|
| Guest | View auctions, search |
| User | Bid, create auctions, manage watchlist |
| Seller | Edit/cancel own auctions (pre-bid) |
| Admin | Cancel any auction, ban users, view all data |

**Middleware:**
```javascript
function requireAuth(req, res, next) {
  const session = await valkey.get(`session:${req.cookies.session}`);
  if (!session) return res.status(401).json({ error: 'UNAUTHORIZED' });
  req.user = JSON.parse(session);
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  next();
}
```

### Rate Limiting

```javascript
// Per-user rate limits stored in Valkey
const RATE_LIMITS = {
  'bid': { window: 60, max: 10 },      // 10 bids/minute
  'create_auction': { window: 3600, max: 5 }, // 5 auctions/hour
  'search': { window: 60, max: 30 },   // 30 searches/minute
};

async function checkRateLimit(userId, action) {
  const key = `rate:${userId}:${action}`;
  const count = await valkey.incr(key);
  if (count === 1) {
    await valkey.expire(key, RATE_LIMITS[action].window);
  }
  return count <= RATE_LIMITS[action].max;
}
```

### Input Validation

- Sanitize all user inputs (XSS prevention)
- Validate bid amounts: positive decimals, max 2 decimal places
- Image uploads: Max 5 MB, allowed types (JPEG, PNG, WebP)
- SQL injection: Use parameterized queries exclusively

## Monitoring and Observability

### Metrics (Prometheus)

```javascript
// Key metrics to track
const metrics = {
  // Request metrics
  http_requests_total: Counter,           // By endpoint, status
  http_request_duration_seconds: Histogram, // By endpoint

  // Business metrics
  bids_placed_total: Counter,             // By auction category
  auctions_created_total: Counter,
  auctions_ended_total: Counter,          // By outcome (sold/unsold)

  // System metrics
  db_query_duration_seconds: Histogram,   // By query type
  cache_hits_total: Counter,
  cache_misses_total: Counter,
  queue_depth: Gauge,                     // By queue name
  active_websocket_connections: Gauge,
};
```

### SLI Dashboards

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Bid placement latency (p95) | < 200ms | > 500ms |
| Bid success rate | > 99.5% | < 99% |
| Auction end processing time | < 5s | > 30s |
| Search latency (p95) | < 100ms | > 300ms |
| API availability | > 99.9% | < 99.5% |

### Logging

Structured JSON logs with correlation IDs:

```json
{
  "timestamp": "2025-01-15T18:30:00.123Z",
  "level": "info",
  "service": "api-server-1",
  "correlationId": "req-abc-123",
  "userId": "user-uuid",
  "action": "bid_placed",
  "auctionId": "auction-uuid",
  "amount": 55.00,
  "duration_ms": 45
}
```

### Distributed Tracing

Use OpenTelemetry for request tracing:
- Trace ID propagated through headers
- Spans for: HTTP handler, DB query, cache lookup, queue publish
- Export to Jaeger for local development

### Audit Logging

Security-sensitive operations logged to separate table:

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log admin actions, login attempts, bid cancellations
```

## Failure Handling

### Retry Strategy

| Operation | Retry Policy | Backoff |
|-----------|-------------|---------|
| DB connection | 3 retries | Exponential: 100ms, 200ms, 400ms |
| Cache miss fallback | 1 retry to DB | Immediate |
| Queue publish | 3 retries | Exponential: 1s, 2s, 4s |
| Notification send | 5 retries | Exponential: 1s, 2s, 4s, 8s, 16s |

### Idempotency

Prevent duplicate operations:

```javascript
// Client sends X-Idempotency-Key header
async function placeBid(req) {
  const idempotencyKey = req.headers['x-idempotency-key'];

  // Check if already processed
  const existing = await db.query(
    'SELECT id, amount FROM bids WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (existing.rows[0]) {
    return { status: 200, body: existing.rows[0] }; // Return cached result
  }

  // Process new bid with idempotency_key
  await db.query(
    'INSERT INTO bids (auction_id, bidder_id, amount, idempotency_key) VALUES ($1, $2, $3, $4)',
    [auctionId, userId, amount, idempotencyKey]
  );
}
```

### Circuit Breaker

Protect against cascading failures:

```javascript
const CircuitBreaker = require('opossum');

const dbBreaker = new CircuitBreaker(queryDatabase, {
  timeout: 3000,           // 3s timeout
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,     // Try again after 30s
});

dbBreaker.fallback(() => {
  // Return cached data or graceful degradation
  return getCachedAuction(auctionId);
});
```

### Dead Letter Queue

Failed messages go to DLQ for investigation:

```javascript
// RabbitMQ DLQ configuration
channel.assertQueue('bids', {
  deadLetterExchange: 'dlx',
  deadLetterRoutingKey: 'bids.failed',
});

// Monitor DLQ depth
if (dlqDepth > 100) {
  alertOps('High DLQ depth - bid processing failures');
}
```

### Backup and Recovery

| Data | Backup Frequency | Retention | Recovery Time |
|------|-----------------|-----------|---------------|
| PostgreSQL | Hourly pg_dump | 7 days | < 1 hour |
| Valkey | RDB snapshot daily | 3 days | < 5 minutes |
| MinIO | Daily sync to backup | 30 days | < 2 hours |
| RabbitMQ | Message persistence | N/A | Queue rebuild |

**Local dev approach**: Use Docker volumes, can rebuild from migrations + seed data.

## Cost Tradeoffs

### Local Development Costs

| Choice | Cost Implication | Alternative |
|--------|-----------------|-------------|
| PostgreSQL over DynamoDB | Free, simpler | DynamoDB = pay per request |
| Valkey over Redis Cloud | Free, local | Redis Cloud = $5+/month |
| MinIO over S3 | Free, local | S3 = pay per GB |
| RabbitMQ over SQS | Free, local | SQS = pay per request |
| Single Elasticsearch | Free, limited | Elastic Cloud = $95+/month |

### Production Cost Considerations

If deploying to cloud:

| Component | Monthly Cost (Est.) | Optimization |
|-----------|-------------------|--------------|
| 3x API servers (t3.small) | $45 | Use spot instances |
| RDS PostgreSQL (db.t3.small) | $25 | Reserved instance |
| ElastiCache (cache.t3.micro) | $12 | Right-size based on usage |
| S3 for images (100 GB) | $3 | Lifecycle to Glacier after 90 days |
| CloudWatch/logging | $10 | Sample logs, not 100% |
| **Total** | **~$100/month** | |

### Trade-off Decisions

1. **Eventual vs Strong Consistency for Search**
   - Search index is eventually consistent (5-second lag)
   - Trade-off: Faster writes, slight stale reads
   - Acceptable: Users expect slight delay in search results

2. **Queue vs Synchronous Bids**
   - Chose async queue (202 Accepted)
   - Trade-off: Slightly delayed confirmation, but guaranteed ordering
   - Alternative: Sync with immediate response, risk of race conditions

3. **Per-Auction Queues vs Single Queue**
   - Single queue with routing keys
   - Trade-off: Simpler ops, slight ordering risk across auctions
   - Acceptable: Ordering only matters within same auction

## Future Optimizations

1. **WebSocket for Real-Time Updates**: Push bid notifications instead of polling
2. **CDN for Images**: CloudFront/Cloudflare in front of MinIO
3. **Read Replicas**: PostgreSQL streaming replication for read scaling
4. **GraphQL API**: More efficient data fetching for complex auction views
5. **Machine Learning**: Fraud detection for suspicious bidding patterns
6. **Internationalization**: Multi-currency support, timezone-aware auctions
