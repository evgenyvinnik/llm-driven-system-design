# Design Online Auction System (Backend Focus)

## 45-Minute Backend Interview Answer

### 1. Requirements Clarification (3 minutes)

**Interviewer:** Design an online auction system like eBay.

**Candidate:** I'll focus on the backend architecture. Let me clarify the requirements:

**Functional Requirements:**
- Sellers create auctions with title, description, images, starting/reserve prices, end time
- Users place bids exceeding current highest bid by minimum increment
- Auto-bidding (proxy bids) where system bids automatically up to user's max
- Auction end handling with winner determination
- Anti-sniping protection (extend auction if bid in final 2 minutes)

**Non-Functional Requirements:**
- Strong consistency for bid ordering (no race conditions)
- p95 bid latency < 200ms, p99 < 500ms
- 99.9% availability
- Support 10,000 concurrent auctions, 1,000 bids/second peak

**Key Challenge:**
Ensuring correct bid ordering and winner determination when thousands of bids arrive simultaneously.

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Load Balancer (nginx:3000)                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  API Server 1   │     │  API Server 2   │     │  API Server 3   │
│  (Express:3001) │     │  (Express:3002) │     │  (Express:3003) │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
    ┌────────────────────────────┼────────────────────────────┐
    │                            │                            │
    ▼                            ▼                            ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│  PostgreSQL  │          │ Valkey/Redis │          │  RabbitMQ    │
│  (Primary)   │          │  (Cache +    │          │  (Queues)    │
│              │          │   Locking)   │          │              │
└──────────────┘          └──────────────┘          └──────────────┘
                                                          │
                                 ┌────────────────────────┼────────┐
                                 ▼                        ▼        ▼
                          ┌──────────────┐        ┌──────────────┐ │
                          │ Bid Worker   │        │ Notification │ │
                          │              │        │ Worker       │ │
                          └──────────────┘        └──────────────┘ │
                                                                   │
                          ┌──────────────┐        ┌──────────────┐ │
                          │ Scheduler    │        │ Elasticsearch│◀┘
                          │ (Auction End)│        │ (Search)     │
                          └──────────────┘        └──────────────┘
```

---

### 3. Database Schema Deep Dive (8 minutes)

#### Schema Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATABASE SCHEMA                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────┐          ┌───────────────────────┐          │
│  │        users          │          │       auctions        │          │
│  ├───────────────────────┤          ├───────────────────────┤          │
│  │ id: UUID (PK)         │◀─────────│ seller_id: UUID (FK)  │          │
│  │ email: VARCHAR(255)   │          │ id: UUID (PK)         │          │
│  │ password_hash         │          │ title: VARCHAR(255)   │          │
│  │ display_name          │          │ description: TEXT     │          │
│  │ role: user/admin      │          │ category: VARCHAR     │          │
│  │ created_at            │          │ starting_price: DEC   │          │
│  │ updated_at            │          │ reserve_price: DEC    │          │
│  └───────────────────────┘          │ bid_increment: DEC    │          │
│                                     │ current_high_bid: DEC │          │
│  ┌───────────────────────┐          │ current_high_bidder_id│          │
│  │         bids          │          │ status: enum          │          │
│  ├───────────────────────┤          │ start_time            │          │
│  │ id: UUID (PK)         │          │ end_time              │          │
│  │ auction_id: UUID (FK) │──────────│ original_end_time     │          │
│  │ bidder_id: UUID (FK)  │          │ version: INT          │          │
│  │ amount: DECIMAL       │          └───────────────────────┘          │
│  │ max_amount: DECIMAL   │                                             │
│  │ is_proxy_bid: BOOL    │          ┌───────────────────────┐          │
│  │ is_winning: BOOL      │          │      auto_bids        │          │
│  │ created_at            │          ├───────────────────────┤          │
│  │ idempotency_key       │          │ id: UUID (PK)         │          │
│  └───────────────────────┘          │ auction_id: UUID (FK) │          │
│                                     │ bidder_id: UUID (FK)  │          │
│                                     │ max_amount: DECIMAL   │          │
│                                     │ is_active: BOOL       │          │
│                                     │ created_at            │          │
│                                     │ UNIQUE(auction,bidder)│          │
│                                     └───────────────────────┘          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Key Indexes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           INDEXES                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  auctions:                                                               │
│  ├── idx_auctions_status_end ON (status, end_time)                      │
│  ├── idx_auctions_seller ON (seller_id)                                 │
│  ├── idx_auctions_category ON (category)                                │
│  └── idx_auctions_ending_soon ON (end_time) WHERE status = 'active'     │
│                                                                          │
│  bids:                                                                   │
│  ├── idx_bids_auction ON (auction_id, created_at DESC)                  │
│  ├── idx_bids_bidder ON (bidder_id)                                     │
│  └── UNIQUE idx_bids_idempotency ON (idempotency_key)                   │
│                                                                          │
│  auto_bids:                                                              │
│  └── idx_auto_bids_auction ON (auction_id) WHERE is_active = TRUE       │
│                                                                          │
│  notifications:                                                          │
│  └── idx_notifications_user_unread ON (user_id, created_at DESC)        │
│         WHERE read_at IS NULL                                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Auction Status Flow

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  draft   │───▶│  active  │───▶│  ended   │
└──────────┘    └────┬─────┘    └────┬─────┘
                     │               │
                     │         ┌─────┴─────┐
                     │         ▼           ▼
                     │    ┌────────┐  ┌────────┐
                     │    │  sold  │  │ unsold │
                     │    └────────┘  └────────┘
                     │
                     └────────────────▶┌───────────┐
                                       │ cancelled │
                                       └───────────┘
```

---

### 4. Bid Processing with Distributed Locking (10 minutes)

#### The Concurrency Challenge

Multiple API servers receive simultaneous bids for the same auction. Without coordination, race conditions occur.

#### Solution: Redis Distributed Lock + PostgreSQL Row Lock

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      BID PROCESSING FLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. Check Idempotency                                             │   │
│  │    SELECT * FROM bids WHERE idempotency_key = $1                 │   │
│  │    └─▶ If exists, return existing bid                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 2. Acquire Redis Distributed Lock                                │   │
│  │    SET auction:lock:{auctionId} {uuid} PX 5000 NX                │   │
│  │    └─▶ If failed: "Too many concurrent bids, please try again"  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 3. BEGIN PostgreSQL Transaction                                  │   │
│  │    SELECT ... FROM auctions WHERE id = $1 FOR UPDATE             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 4. Validate Bid                                                  │   │
│  │    - status === 'active'                                         │   │
│  │    - now < end_time                                              │   │
│  │    - amount >= current_high_bid + bid_increment                  │   │
│  │    - bidder !== current_high_bidder                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 5. Resolve Auto-Bids (if any competing)                          │   │
│  │    See Auto-Bid Resolution diagram below                         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 6. Insert Bid Record                                             │   │
│  │    INSERT INTO bids (auction_id, bidder_id, amount, ...)         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 7. Update Auction State                                          │   │
│  │    UPDATE auctions SET current_high_bid = $1,                    │   │
│  │           current_high_bidder_id = $2, version = version + 1     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 8. Handle Anti-Sniping                                           │   │
│  │    If timeRemaining < 2 minutes: extend end_time by 2 minutes    │   │
│  │    ZADD auction:endings {newEndTime} {auctionId}                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 9. COMMIT Transaction                                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 10. Post-Commit Actions (after releasing lock)                   │   │
│  │    - Invalidate cache: DEL auction:{id}, auction:{id}:bids       │   │
│  │    - Publish event: PUBLISH auction:{id}:events BID_PLACED       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Redis Lock Release (Lua Script)

"I use a Lua script for atomic check-and-delete to prevent accidentally releasing someone else's lock."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ATOMIC LOCK RELEASE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  if redis.call("get", KEYS[1]) == ARGV[1] then                          │
│      return redis.call("del", KEYS[1])                                  │
│  else                                                                    │
│      return 0                                                            │
│  end                                                                     │
│                                                                          │
│  KEYS[1] = auction:lock:{auctionId}                                     │
│  ARGV[1] = {uuid} (the token we used to acquire)                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Auto-Bid Resolution

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      AUTO-BID RESOLUTION                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Incoming bid: $100 (max: $150)                                          │
│  Existing auto-bid: $200 max                                             │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ Case 1: New bidder max > Existing max                         │      │
│  │                                                               │      │
│  │   newBidderMax ($150) > existingMax ($120)                    │      │
│  │   finalPrice = min(existingMax + increment, newBidderMax)     │      │
│  │             = min($121, $150) = $121                          │      │
│  │   Winner: New bidder at $121                                  │      │
│  │   Deactivate losing auto-bid                                  │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ Case 2: Existing max > New bidder max                         │      │
│  │                                                               │      │
│  │   existingMax ($200) > newBidderMax ($150)                    │      │
│  │   finalPrice = min(newBidAmount + increment, existingMax)     │      │
│  │             = min($101, $200) = $101                          │      │
│  │   Winner: Existing auto-bidder (proxy bid) at $101            │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ Case 3: No competing auto-bids                                │      │
│  │                                                               │      │
│  │   finalPrice = incoming bid amount                            │      │
│  │   If maxAmount provided, create new auto-bid for this user    │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 5. Auction Scheduler Service (5 minutes)

#### Scheduler Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      AUCTION SCHEDULER                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Redis Sorted Set: auction:endings                                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Score = end_time timestamp (ms)                                  │   │
│  │ Member = auction_id                                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Startup:                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ SELECT id, end_time FROM auctions                                │   │
│  │ WHERE status = 'active' AND end_time > NOW()                     │   │
│  │                                                                  │   │
│  │ For each: ZADD auction:endings {end_time_ms} {auction_id}        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Scheduler Loop (every 1 second):                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. ZRANGEBYSCORE auction:endings 0 (now + 5000)                  │   │
│  │ 2. For each ending auction:                                      │   │
│  │    a. ZREM auction:endings {auctionId}                           │   │
│  │    b. Queue to RabbitMQ: auction_end queue                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Auction End Worker

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUCTION END WORKER                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 1. Acquire end-processing lock (prevent duplicates)           │      │
│  │    SET auction:end:lock:{auctionId} {uuid} PX 30000 NX         │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 2. SELECT * FROM auctions WHERE id = $1 FOR UPDATE            │      │
│  │    Verify status === 'active'                                 │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 3. Determine Outcome                                          │      │
│  │                                                               │      │
│  │    hasWinner = current_high_bid IS NOT NULL                   │      │
│  │    reserveMet = current_high_bid >= reserve_price             │      │
│  │                                                               │      │
│  │    ┌─────────────────┐    ┌─────────────────┐                │      │
│  │    │ hasWinner AND   │    │ Otherwise       │                │      │
│  │    │ reserveMet      │    │                 │                │      │
│  │    │     ▼           │    │     ▼           │                │      │
│  │    │ status = 'sold' │    │ status = 'unsold│                │      │
│  │    └─────────────────┘    └─────────────────┘                │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 4. UPDATE auctions SET status = $1                            │      │
│  │    UPDATE bids SET is_winning = TRUE WHERE ... (if sold)      │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 5. Queue Notifications                                        │      │
│  │    - Seller: AUCTION_SOLD or AUCTION_ENDED_NO_SALE            │      │
│  │    - Winner: AUCTION_WON                                      │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 6. Caching Strategy (4 minutes)

#### Cache TTLs and Keys

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CACHING STRATEGY                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ Cache Key             │ TTL      │ Content                    │      │
│  ├───────────────────────┼──────────┼────────────────────────────┤      │
│  │ auction:{id}          │ 60s      │ Full auction details       │      │
│  │ auction:{id}:bids     │ 30s      │ Bid history (last 20)      │      │
│  │ auction:{id}:current  │ 10s      │ Current high bid only      │      │
│  │ auction:hot           │ 3600s    │ Sorted set by bid amount   │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Cache Patterns:                                                         │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ Read: Cache-aside with lazy loading                           │      │
│  │ Write: Write-through for current_bid (immediate update)       │      │
│  │ Invalidation: DEL on bid placement for other caches           │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Hot Auctions Leaderboard:                                              │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ On new bid: ZADD auction:hot {amount} {auctionId}             │      │
│  │ Query: ZREVRANGE auction:hot 0 9  (top 10)                    │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Read Flow

```
┌────────┐     ┌─────────┐     ┌───────┐     ┌────────────┐
│ Client │     │   API   │     │ Redis │     │ PostgreSQL │
└───┬────┘     └────┬────┘     └───┬───┘     └─────┬──────┘
    │               │              │               │
    │ GET /auction  │              │               │
    ├──────────────▶│              │               │
    │               │              │               │
    │               │ GET auction:123              │
    │               ├─────────────▶│               │
    │               │◀─────────────┤               │
    │               │              │               │
    │               │ [Cache Miss]                 │
    │               │                              │
    │               │ SELECT * FROM auctions       │
    │               ├─────────────────────────────▶│
    │               │◀─────────────────────────────┤
    │               │              │               │
    │               │ SETEX 60     │               │
    │               ├─────────────▶│               │
    │               │              │               │
    │◀──────────────┤              │               │
    │   Response    │              │               │
    ▼               ▼              ▼               ▼
```

---

### 7. Rate Limiting (3 minutes)

#### Rate Limit Configuration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        RATE LIMITS                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Action            │ Window  │ Max Requests                             │
│  ──────────────────┼─────────┼─────────────                             │
│  bid               │ 60s     │ 10 bids                                  │
│  create_auction    │ 3600s   │ 5 auctions                               │
│  search            │ 60s     │ 30 searches                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Sliding Window Implementation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   SLIDING WINDOW RATE LIMITER                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Key: rate:{userId}:{action}                                             │
│  Data Structure: Sorted Set (score = timestamp)                          │
│                                                                          │
│  Pipeline Operations:                                                    │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ 1. ZREMRANGEBYSCORE key 0 (now - window)  // Remove expired   │      │
│  │ 2. ZCARD key                              // Count in window  │      │
│  │ 3. ZADD key {now} {now}                   // Add this request │      │
│  │ 4. EXPIRE key {window}                    // Set TTL          │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Response:                                                               │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ If count >= max:                                              │      │
│  │   { allowed: false, remaining: 0, retryAfter: N seconds }     │      │
│  │ Else:                                                         │      │
│  │   { allowed: true, remaining: max - count - 1 }               │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 8. Prometheus Metrics (3 minutes)

#### Key Metrics

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       PROMETHEUS METRICS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Bid Metrics:                                                            │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ bid_placement_duration_seconds (Histogram)                    │      │
│  │   Labels: status                                              │      │
│  │   Buckets: 0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5                 │      │
│  │                                                               │      │
│  │ bids_placed_total (Counter)                                   │      │
│  │   Labels: status, is_auto_bid                                 │      │
│  │                                                               │      │
│  │ auction_current_bid_amount (Gauge)                            │      │
│  │   Labels: auction_id                                          │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Lock Metrics:                                                           │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ distributed_lock_hold_duration_seconds (Histogram)            │      │
│  │   Labels: lock_type                                           │      │
│  │                                                               │      │
│  │ distributed_lock_contention_total (Counter)                   │      │
│  │   Labels: lock_type                                           │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Auction Metrics:                                                        │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ auctions_ended_total (Counter)                                │      │
│  │   Labels: outcome (sold, unsold, cancelled)                   │      │
│  │                                                               │      │
│  │ active_auctions_count (Gauge)                                 │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
│  Cache Metrics:                                                          │
│  ┌───────────────────────────────────────────────────────────────┐      │
│  │ cache_hits_total (Counter) - Labels: cache_type               │      │
│  │ cache_misses_total (Counter) - Labels: cache_type             │      │
│  └───────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 9. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| **Bid ordering** | Distributed lock + DB lock | Optimistic locking | Correctness critical, low contention per auction |
| **Auto-bid resolution** | Synchronous in transaction | Async queue | Simpler, immediate feedback |
| **Auction scheduling** | Redis sorted set | Database polling | O(log N) operations, sub-ms latency |
| **Cache strategy** | Write-through for current bid | Pure invalidation | Real-time feel for watchers |
| **Idempotency** | DB unique constraint | Redis TTL key | Permanent protection, audit trail |
| **Anti-sniping** | 2-minute extension | Fixed end time | Fair to all bidders |

---

### 10. Future Backend Enhancements

1. **Read replicas** - Scale read queries with PostgreSQL streaming replication
2. **Sharding** - Partition by auction_id hash for horizontal scaling
3. **WebSocket real-time** - Replace polling with push notifications
4. **Fraud detection** - ML model for suspicious bidding patterns
5. **Multi-currency** - Support international auctions with currency conversion
6. **Circuit breaker** - Protect against payment gateway failures
