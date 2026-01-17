# Online Auction System - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing an online auction platform similar to eBay. Before diving in, let me clarify some requirements and understand the scope."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

"Let me confirm the core features we need:"

1. **Item Listing** - Sellers can create auction listings with descriptions, images, starting price, and auction duration
2. **Bidding** - Users can place bids on active auctions
3. **Auto-bidding (Proxy Bidding)** - Users set a maximum bid, and the system automatically bids on their behalf up to that limit
4. **Auction End Handling** - System determines winner, notifies parties, and handles payment flow
5. **Real-time Updates** - Users see bid updates in near real-time

### Non-Functional Requirements

- **Consistency** - Critical for bid ordering; we cannot have race conditions determining winners
- **Availability** - High availability, especially during auction endings
- **Latency** - Bid acknowledgment under 200ms
- **Scalability** - Handle flash traffic during popular auction endings

### Out of Scope

"For this discussion, I'll set aside: payment processing details, shipping logistics, dispute resolution, and seller ratings."

---

## 2. Scale Estimation (3 minutes)

"Let me estimate the scale we're designing for:"

### Assumptions
- 10 million DAU (Daily Active Users)
- 1 million active auctions at any time
- Average 50 bids per auction
- Peak: 10,000 auctions ending per minute during prime time

### Traffic Estimates
- **Read requests**: 100,000 RPS (viewing auctions, checking bid status)
- **Write requests**: 1,000 RPS average, 10,000 RPS peak (placing bids)
- **WebSocket connections**: 500,000 concurrent (users watching auctions)

### Storage Estimates
- Auction metadata: ~10 KB per auction
- Bid history: ~200 bytes per bid
- Images: ~2 MB per auction (stored in object storage)
- **Total**: ~50 TB for 5 years of data

---

## 3. High-Level Architecture (8 minutes)

```
                                    ┌─────────────────┐
                                    │   CDN (Images)  │
                                    └────────┬────────┘
                                             │
┌──────────┐     ┌──────────────┐    ┌──────┴───────┐
│  Mobile  │────▶│    API       │───▶│   Auction    │
│   Apps   │     │   Gateway    │    │   Service    │
└──────────┘     └──────────────┘    └──────┬───────┘
                        │                    │
┌──────────┐            │            ┌──────┴───────┐
│   Web    │────────────┘            │    Bid       │
│  Client  │                         │   Service    │
└────┬─────┘                         └──────┬───────┘
     │                                      │
     │        ┌─────────────────────────────┴──────────────┐
     │        │                                            │
     │   ┌────▼─────┐   ┌─────────────┐   ┌───────────────┐
     │   │  Redis   │   │ PostgreSQL  │   │    Kafka      │
     │   │  Cluster │   │  (Primary)  │   │  (Events)     │
     │   └──────────┘   └─────────────┘   └───────────────┘
     │                                            │
     │   ┌────────────────────────────────────────┘
     │   │
┌────▼───▼────┐      ┌─────────────┐      ┌────────────────┐
│  WebSocket  │      │  Scheduler  │      │  Notification  │
│   Service   │      │  Service    │      │    Service     │
└─────────────┘      └─────────────┘      └────────────────┘
```

### Core Components

1. **API Gateway** - Rate limiting, authentication, request routing
2. **Auction Service** - CRUD operations for auction listings
3. **Bid Service** - Handles bid placement with strict ordering guarantees
4. **Scheduler Service** - Manages auction end times, triggers closing logic
5. **WebSocket Service** - Pushes real-time updates to connected clients
6. **Notification Service** - Sends emails, push notifications for outbid, win, etc.

---

## 4. Data Model (5 minutes)

### Core Entities

```sql
-- Auctions table
CREATE TABLE auctions (
    id              UUID PRIMARY KEY,
    seller_id       UUID NOT NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    starting_price  DECIMAL(12,2) NOT NULL,
    current_price   DECIMAL(12,2) NOT NULL,
    reserve_price   DECIMAL(12,2),
    start_time      TIMESTAMP NOT NULL,
    end_time        TIMESTAMP NOT NULL,
    status          VARCHAR(20) DEFAULT 'active',
    winner_id       UUID,
    created_at      TIMESTAMP DEFAULT NOW(),
    version         INTEGER DEFAULT 0  -- Optimistic locking
);

-- Bids table (append-only for audit trail)
CREATE TABLE bids (
    id              UUID PRIMARY KEY,
    auction_id      UUID NOT NULL,
    bidder_id       UUID NOT NULL,
    amount          DECIMAL(12,2) NOT NULL,
    max_amount      DECIMAL(12,2),  -- For auto-bidding
    created_at      TIMESTAMP DEFAULT NOW(),
    sequence_num    BIGINT NOT NULL  -- Ordering within auction
);

-- Auto-bid configuration
CREATE TABLE auto_bids (
    id              UUID PRIMARY KEY,
    auction_id      UUID NOT NULL,
    bidder_id       UUID NOT NULL,
    max_amount      DECIMAL(12,2) NOT NULL,
    current_bid     DECIMAL(12,2) NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    UNIQUE(auction_id, bidder_id)
);
```

### Indexing Strategy

```sql
CREATE INDEX idx_auctions_end_time ON auctions(end_time) WHERE status = 'active';
CREATE INDEX idx_auctions_status ON auctions(status);
CREATE INDEX idx_bids_auction ON bids(auction_id, sequence_num);
CREATE INDEX idx_bids_bidder ON bids(bidder_id, created_at);
```

---

## 5. Deep Dive: Bid Processing (10 minutes)

"The most critical component is handling concurrent bids correctly. Let me walk through the bid flow."

### The Concurrency Challenge

When multiple users bid on the same auction simultaneously:
- We must maintain strict ordering
- Only one bid can be the "winning" bid at any moment
- Auto-bidding creates additional complexity

### Solution: Distributed Locking with Redis

```
┌─────────┐     ┌─────────────┐     ┌─────────┐     ┌──────────┐
│ Client  │────▶│ Bid Service │────▶│  Redis  │────▶│ Postgres │
│         │     │             │     │  Lock   │     │          │
└─────────┘     └─────────────┘     └─────────┘     └──────────┘
```

### Bid Processing Algorithm

```python
async def place_bid(auction_id, bidder_id, amount):
    # 1. Acquire distributed lock for this auction
    lock_key = f"auction_lock:{auction_id}"
    lock = await redis.acquire_lock(lock_key, timeout=5s)

    if not lock:
        raise TooManyBiddersError("Try again shortly")

    try:
        # 2. Fetch current auction state
        auction = await db.get_auction(auction_id)

        # 3. Validate bid
        if auction.status != 'active':
            raise AuctionClosedError()
        if amount <= auction.current_price:
            raise BidTooLowError(f"Minimum: {auction.current_price + MIN_INCREMENT}")
        if bidder_id == auction.seller_id:
            raise SellerCannotBidError()

        # 4. Check for competing auto-bids
        competing_autobids = await db.get_active_autobids(
            auction_id,
            exclude_bidder=bidder_id,
            min_amount=amount
        )

        # 5. Resolve auto-bidding
        final_price, winner = resolve_autobids(amount, competing_autobids)

        # 6. Insert bid record
        bid = await db.insert_bid(auction_id, bidder_id, amount)

        # 7. Update auction current price
        await db.update_auction(auction_id, current_price=final_price)

        # 8. Publish event for real-time updates
        await kafka.publish('bid_placed', {
            'auction_id': auction_id,
            'amount': final_price,
            'bidder_id': winner
        })

        return bid
    finally:
        await redis.release_lock(lock)
```

### Auto-Bidding Logic

"Auto-bidding is essentially a proxy system. When a user sets a max bid of $100 and current price is $50, the system will automatically bid $51 (minimum increment) on their behalf. If another bidder comes in at $60, the system auto-bids $61, and so on until the max is reached."

```python
def resolve_autobids(new_bid_amount, competing_autobids):
    if not competing_autobids:
        return new_bid_amount, new_bidder_id

    # Find highest competing auto-bid
    highest_auto = max(competing_autobids, key=lambda x: x.max_amount)

    if new_bid_amount > highest_auto.max_amount:
        # New bidder wins, price is one increment above auto-bid max
        return highest_auto.max_amount + MIN_INCREMENT, new_bidder_id
    else:
        # Auto-bidder wins, price is one increment above new bid
        return new_bid_amount + MIN_INCREMENT, highest_auto.bidder_id
```

### Why This Approach?

- **Serialized access** prevents race conditions within a single auction
- **Different auctions** can be processed in parallel (lock is per-auction)
- **Redis locks** are fast (<1ms) and don't bottleneck the database
- **Append-only bid table** provides complete audit trail

---

## 6. Deep Dive: Auction Ending (5 minutes)

"Auction endings are tricky because thousands of auctions might end at the same time (e.g., sellers often end auctions at 9 PM)."

### Scheduler Design

```
┌──────────────┐     ┌───────────────┐     ┌────────────────┐
│  Scheduler   │────▶│  Redis Sorted │────▶│   Worker Pool  │
│  (Leader)    │     │    Set        │     │                │
└──────────────┘     └───────────────┘     └────────────────┘
```

### Implementation

```python
# Add auction to schedule when created
await redis.zadd('auction_endings', {auction_id: end_timestamp})

# Scheduler loop (runs every second)
async def process_ending_auctions():
    now = time.now()

    # Get auctions ending in the next second
    ending_auctions = await redis.zrangebyscore(
        'auction_endings',
        min=0,
        max=now
    )

    for auction_id in ending_auctions:
        await task_queue.enqueue('close_auction', auction_id)
        await redis.zrem('auction_endings', auction_id)
```

### Sniping Prevention

"Some platforms implement 'sniping protection' - if a bid comes in the final 2 minutes, the auction extends by 2 minutes. This prevents users from winning by bidding at the last second."

```python
if time_remaining < SNIPE_PROTECTION_WINDOW:
    auction.end_time += EXTENSION_DURATION
    await redis.zadd('auction_endings', {auction_id: new_end_time})
```

---

## 7. Real-Time Updates (3 minutes)

### WebSocket Architecture

```
┌─────────┐     ┌───────────────┐     ┌─────────────┐
│ Client  │◀───▶│  WebSocket    │◀────│   Redis     │
│         │     │   Server      │     │   Pub/Sub   │
└─────────┘     └───────────────┘     └─────────────┘
                        ▲
                        │
                ┌───────┴───────┐
                │    Kafka      │
                │  Consumer     │
                └───────────────┘
```

- Clients connect via WebSocket and subscribe to specific auction_ids
- Bid events flow through Kafka to WebSocket servers
- Redis Pub/Sub distributes events across WebSocket server instances
- Each WebSocket server maintains a map: auction_id -> connected clients

---

## 8. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Consistency vs. Availability

**Chose**: Strong consistency for bids
**Trade-off**: During Redis leader failover, bids may fail for 1-2 seconds
**Alternative**: Eventual consistency with conflict resolution (more complex, less intuitive for users)

### Trade-off 2: Per-Auction Locking vs. Sharded Queues

**Chose**: Distributed locks per auction
**Trade-off**: Hot auctions become bottlenecks
**Alternative**: Queue-based ordering (higher latency, but better for extremely hot items)

### Trade-off 3: Auto-Bid Transparency

**Chose**: Hide max autobid amounts from other bidders
**Trade-off**: Some users find it confusing when price jumps
**Alternative**: Show max bids (reduces engagement, changes bidding psychology)

---

## 9. Scalability Considerations (3 minutes)

### Horizontal Scaling

- **Bid Service**: Stateless, scale horizontally. Redis lock ensures correctness.
- **Database**: Read replicas for auction viewing; writes go to primary
- **WebSocket**: Shard by auction_id to reduce cross-node communication

### Handling Hot Auctions

For celebrity/high-profile auctions with 100,000+ concurrent watchers:
- Dedicated WebSocket cluster for the auction
- Rate limit bid submissions (1 per 5 seconds per user)
- Pre-warm cache with auction data

### Database Partitioning

```sql
-- Partition bids by auction_id for faster queries
CREATE TABLE bids (
    ...
) PARTITION BY HASH(auction_id);
```

---

## 10. Monitoring and Observability (2 minutes)

### Key Metrics

1. **Bid latency p99** - Must stay under 200ms
2. **Lock contention rate** - Monitor for hot auctions
3. **Auction close success rate** - Should be 100%
4. **WebSocket connection count** - Capacity planning

### Alerting

- Alert if bid error rate > 0.1%
- Alert if any auction fails to close on time
- Alert if WebSocket reconnection rate spikes

---

## Summary

"To summarize, I've designed an auction system with:

1. **Distributed locking** for bid consistency within each auction
2. **Auto-bidding** with transparent proxy bid logic
3. **Scheduled auction endings** with sniping protection
4. **Real-time updates** via WebSocket with Redis Pub/Sub
5. **Horizontal scalability** through stateless services and sharding

The key insight is treating each auction as a serializable unit while allowing parallelism across auctions. This gives us strong consistency where it matters most - determining the winner."

---

## Questions I'd Expect

**Q: What happens if Redis goes down during a bid?**
A: The bid fails and user is asked to retry. We use Redis Cluster with automatic failover, so downtime is typically under 2 seconds.

**Q: How do you handle someone placing a bid at the exact moment the auction ends?**
A: The bid acquisition includes an auction status check. If the auction has ended, the bid is rejected with a clear error message.

**Q: How would you implement a "Buy It Now" feature?**
A: Add a `buy_now_price` field. When someone pays that price, immediately close the auction and transition to payment flow, regardless of current bid state.
