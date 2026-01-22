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
│                             Load Balancer                                │
│                            (nginx:3000)                                  │
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

-- Auctions table with optimistic locking
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
CREATE INDEX idx_auctions_ending_soon ON auctions(end_time) WHERE status = 'active';

-- Bids table (append-only for audit trail)
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
CREATE UNIQUE INDEX idx_bids_idempotency ON bids(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Auto-bid configuration (proxy bids)
CREATE TABLE auto_bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID REFERENCES auctions(id) NOT NULL,
    bidder_id UUID REFERENCES users(id) NOT NULL,
    max_amount DECIMAL(12,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(auction_id, bidder_id)
);

CREATE INDEX idx_auto_bids_auction ON auto_bids(auction_id) WHERE is_active = TRUE;

-- Watchlist for auction tracking
CREATE TABLE watchlists (
    user_id UUID REFERENCES users(id),
    auction_id UUID REFERENCES auctions(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, auction_id)
);

-- Auction images
CREATE TABLE auction_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID REFERENCES auctions(id) NOT NULL,
    image_key VARCHAR(255) NOT NULL,  -- MinIO object key
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_images_auction ON auction_images(auction_id);

-- Notifications for async delivery
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type VARCHAR(50) NOT NULL,
    auction_id UUID REFERENCES auctions(id),
    message TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_unread
    ON notifications(user_id, created_at DESC)
    WHERE read_at IS NULL;

-- Audit log for security
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

CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);
```

---

### 4. Bid Processing with Distributed Locking (10 minutes)

#### The Concurrency Challenge

Multiple API servers receive simultaneous bids for the same auction. Without coordination, race conditions occur.

#### Solution: Redis Distributed Lock + PostgreSQL Row Lock

```typescript
import { Redis } from 'ioredis';
import { Pool, PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';

interface Bid {
  id: string;
  auctionId: string;
  bidderId: string;
  amount: number;
  maxAmount?: number;
  isProxyBid: boolean;
}

interface Auction {
  id: string;
  currentHighBid: number | null;
  currentHighBidderId: string | null;
  bidIncrement: number;
  endTime: Date;
  status: string;
}

class BidService {
  constructor(
    private db: Pool,
    private redis: Redis
  ) {}

  async placeBid(
    auctionId: string,
    bidderId: string,
    amount: number,
    maxAmount?: number,
    idempotencyKey?: string
  ): Promise<Bid> {
    // 1. Check idempotency first
    if (idempotencyKey) {
      const existingBid = await this.checkIdempotency(idempotencyKey);
      if (existingBid) {
        return existingBid;
      }
    }

    // 2. Acquire distributed lock for this auction
    const lockKey = `auction:lock:${auctionId}`;
    const lockValue = uuid();
    const lockAcquired = await this.acquireLock(lockKey, lockValue, 5000);

    if (!lockAcquired) {
      throw new Error('Too many concurrent bids, please try again');
    }

    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // 3. Fetch and lock auction row
      const auctionResult = await client.query<Auction>(`
        SELECT id, current_high_bid, current_high_bidder_id,
               bid_increment, end_time, status
        FROM auctions
        WHERE id = $1
        FOR UPDATE
      `, [auctionId]);

      if (auctionResult.rows.length === 0) {
        throw new Error('Auction not found');
      }

      const auction = auctionResult.rows[0];

      // 4. Validate bid
      this.validateBid(auction, bidderId, amount);

      // 5. Check for competing auto-bids
      const { finalPrice, winnerId, isProxyBid } = await this.resolveAutoBids(
        client, auctionId, bidderId, amount, maxAmount
      );

      // 6. Insert bid record
      const bid = await this.insertBid(client, {
        auctionId,
        bidderId: winnerId,
        amount: finalPrice,
        maxAmount,
        isProxyBid,
        idempotencyKey
      });

      // 7. Update auction state
      await this.updateAuctionState(client, auctionId, finalPrice, winnerId, auction);

      // 8. Handle anti-sniping
      await this.handleAntiSniping(client, auction);

      await client.query('COMMIT');

      // 9. Invalidate cache
      await this.invalidateCache(auctionId);

      // 10. Publish events
      await this.publishBidEvent(auctionId, bid);

      return bid;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await this.releaseLock(lockKey, lockValue);
    }
  }

  private async acquireLock(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  private async releaseLock(key: string, value: string): Promise<void> {
    // Lua script ensures atomic check-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, key, value);
  }

  private validateBid(auction: Auction, bidderId: string, amount: number): void {
    if (auction.status !== 'active') {
      throw new Error('Auction is not active');
    }

    if (new Date() > new Date(auction.endTime)) {
      throw new Error('Auction has ended');
    }

    const minimumBid = auction.currentHighBid
      ? auction.currentHighBid + auction.bidIncrement
      : auction.bidIncrement;

    if (amount < minimumBid) {
      throw new Error(`Bid must be at least ${minimumBid}`);
    }

    if (bidderId === auction.currentHighBidderId) {
      throw new Error('You are already the highest bidder');
    }
  }

  private async resolveAutoBids(
    client: PoolClient,
    auctionId: string,
    bidderId: string,
    amount: number,
    maxAmount?: number
  ): Promise<{ finalPrice: number; winnerId: string; isProxyBid: boolean }> {
    // Get active auto-bids for this auction
    const autoBidsResult = await client.query<{ bidder_id: string; max_amount: number }>(`
      SELECT bidder_id, max_amount
      FROM auto_bids
      WHERE auction_id = $1 AND is_active = TRUE AND bidder_id != $2
      ORDER BY max_amount DESC
      LIMIT 1
    `, [auctionId, bidderId]);

    // If no competing auto-bids, the incoming bid wins
    if (autoBidsResult.rows.length === 0) {
      // Set up auto-bid for this user if they provided max amount
      if (maxAmount && maxAmount > amount) {
        await this.upsertAutoBid(client, auctionId, bidderId, maxAmount);
      }
      return { finalPrice: amount, winnerId: bidderId, isProxyBid: false };
    }

    const competingAutoBid = autoBidsResult.rows[0];
    const auctionResult = await client.query(`
      SELECT bid_increment FROM auctions WHERE id = $1
    `, [auctionId]);
    const increment = auctionResult.rows[0].bid_increment;

    // Determine winner based on max amounts
    const newBidderMax = maxAmount || amount;

    if (newBidderMax > competingAutoBid.max_amount) {
      // New bidder wins, price is one increment above competing max
      const finalPrice = Math.min(
        competingAutoBid.max_amount + increment,
        newBidderMax
      );

      // Update/create auto-bid for new bidder
      if (maxAmount && maxAmount > finalPrice) {
        await this.upsertAutoBid(client, auctionId, bidderId, maxAmount);
      }

      // Deactivate losing auto-bid
      await client.query(`
        UPDATE auto_bids SET is_active = FALSE
        WHERE auction_id = $1 AND bidder_id = $2
      `, [auctionId, competingAutoBid.bidder_id]);

      return { finalPrice, winnerId: bidderId, isProxyBid: false };

    } else {
      // Existing auto-bidder wins, price is one increment above new bid
      const finalPrice = Math.min(
        amount + increment,
        competingAutoBid.max_amount
      );

      return {
        finalPrice,
        winnerId: competingAutoBid.bidder_id,
        isProxyBid: true
      };
    }
  }

  private async upsertAutoBid(
    client: PoolClient,
    auctionId: string,
    bidderId: string,
    maxAmount: number
  ): Promise<void> {
    await client.query(`
      INSERT INTO auto_bids (auction_id, bidder_id, max_amount)
      VALUES ($1, $2, $3)
      ON CONFLICT (auction_id, bidder_id)
      DO UPDATE SET max_amount = $3, is_active = TRUE, updated_at = NOW()
    `, [auctionId, bidderId, maxAmount]);
  }

  private async handleAntiSniping(client: PoolClient, auction: Auction): Promise<void> {
    const SNIPE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
    const timeRemaining = new Date(auction.endTime).getTime() - Date.now();

    if (timeRemaining > 0 && timeRemaining < SNIPE_WINDOW_MS) {
      const newEndTime = new Date(Date.now() + SNIPE_WINDOW_MS);
      await client.query(`
        UPDATE auctions
        SET end_time = $1
        WHERE id = $2
      `, [newEndTime, auction.id]);

      // Update scheduler
      await this.redis.zadd('auction:endings', newEndTime.getTime(), auction.id);
    }
  }

  private async insertBid(client: PoolClient, bidData: any): Promise<Bid> {
    const result = await client.query(`
      INSERT INTO bids (auction_id, bidder_id, amount, max_amount, is_proxy_bid, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      bidData.auctionId,
      bidData.bidderId,
      bidData.amount,
      bidData.maxAmount,
      bidData.isProxyBid,
      bidData.idempotencyKey
    ]);
    return result.rows[0];
  }

  private async updateAuctionState(
    client: PoolClient,
    auctionId: string,
    newPrice: number,
    winnerId: string,
    auction: Auction
  ): Promise<void> {
    await client.query(`
      UPDATE auctions
      SET current_high_bid = $1,
          current_high_bidder_id = $2,
          updated_at = NOW(),
          version = version + 1
      WHERE id = $3
    `, [newPrice, winnerId, auctionId]);
  }

  private async checkIdempotency(key: string): Promise<Bid | null> {
    const result = await this.db.query(`
      SELECT * FROM bids WHERE idempotency_key = $1
    `, [key]);
    return result.rows[0] || null;
  }

  private async invalidateCache(auctionId: string): Promise<void> {
    await this.redis.del(
      `auction:${auctionId}`,
      `auction:${auctionId}:bids`,
      `auction:${auctionId}:current_bid`
    );
  }

  private async publishBidEvent(auctionId: string, bid: Bid): Promise<void> {
    await this.redis.publish(`auction:${auctionId}:events`, JSON.stringify({
      type: 'BID_PLACED',
      bid
    }));
  }
}
```

---

### 5. Auction Scheduler Service (5 minutes)

```typescript
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Channel } from 'amqplib';

class AuctionScheduler {
  private isRunning = false;

  constructor(
    private db: Pool,
    private redis: Redis,
    private channel: Channel
  ) {}

  async start(): Promise<void> {
    this.isRunning = true;

    // Load all active auction end times into Redis sorted set
    await this.loadAuctionEndTimes();

    // Start scheduler loop
    this.schedulerLoop();
  }

  private async loadAuctionEndTimes(): Promise<void> {
    const result = await this.db.query(`
      SELECT id, end_time
      FROM auctions
      WHERE status = 'active' AND end_time > NOW()
    `);

    const pipeline = this.redis.pipeline();
    for (const auction of result.rows) {
      pipeline.zadd(
        'auction:endings',
        new Date(auction.end_time).getTime(),
        auction.id
      );
    }
    await pipeline.exec();

    console.log(`Loaded ${result.rows.length} auction end times`);
  }

  private async schedulerLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const now = Date.now();

        // Get auctions ending in the next 5 seconds
        const endingAuctions = await this.redis.zrangebyscore(
          'auction:endings',
          0,
          now + 5000
        );

        for (const auctionId of endingAuctions) {
          // Remove from sorted set first (avoid duplicate processing)
          const removed = await this.redis.zrem('auction:endings', auctionId);
          if (removed > 0) {
            // Queue for end processing
            await this.channel.sendToQueue(
              'auction_end',
              Buffer.from(JSON.stringify({ auctionId })),
              { persistent: true }
            );
          }
        }

        // Sleep for 1 second before next check
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error('Scheduler error:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  stop(): void {
    this.isRunning = false;
  }
}

// Auction End Worker
class AuctionEndWorker {
  constructor(
    private db: Pool,
    private redis: Redis,
    private channel: Channel
  ) {}

  async processAuctionEnd(auctionId: string): Promise<void> {
    // Acquire lock to prevent duplicate processing
    const lockKey = `auction:end:lock:${auctionId}`;
    const lockValue = crypto.randomUUID();
    const acquired = await this.acquireLock(lockKey, lockValue, 30000);

    if (!acquired) {
      console.log(`Auction ${auctionId} already being processed`);
      return;
    }

    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Fetch and lock auction
      const result = await client.query(`
        SELECT * FROM auctions
        WHERE id = $1
        FOR UPDATE
      `, [auctionId]);

      const auction = result.rows[0];

      if (!auction || auction.status !== 'active') {
        console.log(`Auction ${auctionId} not active, skipping`);
        return;
      }

      // Determine outcome
      const hasWinner = auction.current_high_bid !== null;
      const reserveMet = !auction.reserve_price ||
        auction.current_high_bid >= auction.reserve_price;

      let newStatus: string;
      if (hasWinner && reserveMet) {
        newStatus = 'sold';
      } else {
        newStatus = 'unsold';
      }

      // Update auction status
      await client.query(`
        UPDATE auctions
        SET status = $1, updated_at = NOW()
        WHERE id = $2
      `, [newStatus, auctionId]);

      // Mark winning bid
      if (hasWinner && reserveMet) {
        await client.query(`
          UPDATE bids
          SET is_winning = TRUE
          WHERE auction_id = $1 AND bidder_id = $2
          ORDER BY created_at DESC
          LIMIT 1
        `, [auctionId, auction.current_high_bidder_id]);
      }

      await client.query('COMMIT');

      // Queue notifications
      await this.queueNotifications(auction, newStatus);

      // Invalidate cache
      await this.redis.del(
        `auction:${auctionId}`,
        `auction:${auctionId}:bids`
      );

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await this.releaseLock(lockKey, lockValue);
    }
  }

  private async queueNotifications(auction: any, status: string): Promise<void> {
    const notifications = [];

    // Notify seller
    notifications.push({
      userId: auction.seller_id,
      type: status === 'sold' ? 'AUCTION_SOLD' : 'AUCTION_ENDED_NO_SALE',
      auctionId: auction.id,
      message: status === 'sold'
        ? `Your auction "${auction.title}" sold for $${auction.current_high_bid}`
        : `Your auction "${auction.title}" ended without meeting reserve`
    });

    // Notify winner
    if (status === 'sold') {
      notifications.push({
        userId: auction.current_high_bidder_id,
        type: 'AUCTION_WON',
        auctionId: auction.id,
        message: `Congratulations! You won "${auction.title}" for $${auction.current_high_bid}`
      });
    }

    // Queue all notifications
    for (const notification of notifications) {
      await this.channel.sendToQueue(
        'notifications',
        Buffer.from(JSON.stringify(notification)),
        { persistent: true }
      );
    }
  }

  private async acquireLock(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  private async releaseLock(key: string, value: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, key, value);
  }
}
```

---

### 6. Caching Strategy (4 minutes)

```typescript
class AuctionCache {
  private readonly AUCTION_TTL = 60;      // 60 seconds
  private readonly BID_HISTORY_TTL = 30;  // 30 seconds
  private readonly CURRENT_BID_TTL = 10;  // 10 seconds (very fresh)

  constructor(private redis: Redis, private db: Pool) {}

  async getAuction(auctionId: string): Promise<Auction | null> {
    const cacheKey = `auction:${auctionId}`;

    // Try cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Cache miss: fetch from DB
    const result = await this.db.query(`
      SELECT a.*, u.display_name as seller_name
      FROM auctions a
      JOIN users u ON a.seller_id = u.id
      WHERE a.id = $1
    `, [auctionId]);

    if (result.rows.length === 0) return null;

    const auction = result.rows[0];

    // Cache with TTL
    await this.redis.setex(cacheKey, this.AUCTION_TTL, JSON.stringify(auction));

    return auction;
  }

  async getCurrentBid(auctionId: string): Promise<{ amount: number; bidderId: string } | null> {
    const cacheKey = `auction:${auctionId}:current_bid`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.db.query(`
      SELECT current_high_bid as amount, current_high_bidder_id as bidder_id
      FROM auctions
      WHERE id = $1
    `, [auctionId]);

    if (result.rows.length === 0 || !result.rows[0].amount) return null;

    const currentBid = result.rows[0];
    await this.redis.setex(cacheKey, this.CURRENT_BID_TTL, JSON.stringify(currentBid));

    return currentBid;
  }

  async getBidHistory(auctionId: string, limit = 20): Promise<Bid[]> {
    const cacheKey = `auction:${auctionId}:bids`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.db.query(`
      SELECT b.*, u.display_name as bidder_name
      FROM bids b
      JOIN users u ON b.bidder_id = u.id
      WHERE b.auction_id = $1
      ORDER BY b.created_at DESC
      LIMIT $2
    `, [auctionId, limit]);

    const bids = result.rows;
    await this.redis.setex(cacheKey, this.BID_HISTORY_TTL, JSON.stringify(bids));

    return bids;
  }

  // Write-through cache update on new bid
  async updateCurrentBid(auctionId: string, amount: number, bidderId: string): Promise<void> {
    const cacheKey = `auction:${auctionId}:current_bid`;
    await this.redis.setex(cacheKey, this.CURRENT_BID_TTL, JSON.stringify({
      amount,
      bidderId,
      timestamp: new Date().toISOString()
    }));

    // Invalidate other caches
    await this.redis.del(
      `auction:${auctionId}`,
      `auction:${auctionId}:bids`
    );
  }

  // Leaderboard for hot auctions
  async updateBidLeaderboard(auctionId: string, amount: number): Promise<void> {
    await this.redis.zadd('auction:hot', amount, auctionId);
    await this.redis.expire('auction:hot', 3600); // 1 hour
  }

  async getHotAuctions(limit = 10): Promise<string[]> {
    return this.redis.zrevrange('auction:hot', 0, limit - 1);
  }
}
```

---

### 7. Rate Limiting (3 minutes)

```typescript
interface RateLimitConfig {
  window: number;  // seconds
  max: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'bid': { window: 60, max: 10 },           // 10 bids per minute
  'create_auction': { window: 3600, max: 5 }, // 5 auctions per hour
  'search': { window: 60, max: 30 },        // 30 searches per minute
};

class RateLimiter {
  constructor(private redis: Redis) {}

  async checkRateLimit(userId: string, action: string): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfter?: number;
  }> {
    const config = RATE_LIMITS[action];
    if (!config) {
      return { allowed: true, remaining: Infinity };
    }

    const key = `rate:${userId}:${action}`;
    const now = Date.now();
    const windowStart = now - (config.window * 1000);

    // Use sorted set for sliding window
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}`);
    pipeline.expire(key, config.window);

    const results = await pipeline.exec();
    const count = results![1][1] as number;

    if (count >= config.max) {
      // Get oldest entry to calculate retry time
      const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const retryAfter = oldest.length > 1
        ? Math.ceil((parseInt(oldest[1]) + config.window * 1000 - now) / 1000)
        : config.window;

      return {
        allowed: false,
        remaining: 0,
        retryAfter
      };
    }

    return {
      allowed: true,
      remaining: config.max - count - 1
    };
  }
}
```

---

### 8. Prometheus Metrics (3 minutes)

```typescript
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const register = new Registry();

// Bid metrics
const bidLatency = new Histogram({
  name: 'bid_placement_duration_seconds',
  help: 'Time to process a bid',
  labelNames: ['status'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register]
});

const bidsPlacedTotal = new Counter({
  name: 'bids_placed_total',
  help: 'Total bids placed',
  labelNames: ['status', 'is_auto_bid'],
  registers: [register]
});

const currentBidAmount = new Gauge({
  name: 'auction_current_bid_amount',
  help: 'Current highest bid amount',
  labelNames: ['auction_id'],
  registers: [register]
});

// Lock metrics
const lockHoldDuration = new Histogram({
  name: 'distributed_lock_hold_duration_seconds',
  help: 'Time locks are held',
  labelNames: ['lock_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

const lockContention = new Counter({
  name: 'distributed_lock_contention_total',
  help: 'Lock acquisition failures',
  labelNames: ['lock_type'],
  registers: [register]
});

// Auction metrics
const auctionsEndedTotal = new Counter({
  name: 'auctions_ended_total',
  help: 'Total auctions ended',
  labelNames: ['outcome'],  // sold, unsold, cancelled
  registers: [register]
});

const activeAuctions = new Gauge({
  name: 'active_auctions_count',
  help: 'Number of currently active auctions',
  registers: [register]
});

// Cache metrics
const cacheHits = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hit count',
  labelNames: ['cache_type'],
  registers: [register]
});

const cacheMisses = new Counter({
  name: 'cache_misses_total',
  help: 'Cache miss count',
  labelNames: ['cache_type'],
  registers: [register]
});

export { register, bidLatency, bidsPlacedTotal, lockHoldDuration, lockContention };
```

---

### 9. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| Bid ordering | Distributed lock + DB lock | Optimistic locking | Correctness critical, low contention per auction |
| Auto-bid resolution | Synchronous in transaction | Async queue | Simpler, immediate feedback |
| Auction scheduling | Redis sorted set | Database polling | O(log N) operations, sub-ms latency |
| Cache strategy | Write-through for current bid | Pure invalidation | Real-time feel for watchers |
| Idempotency | DB unique constraint | Redis TTL key | Permanent protection, audit trail |
| Anti-sniping | 2-minute extension | Fixed end time | Fair to all bidders |

---

### 10. Future Backend Enhancements

1. **Read replicas** - Scale read queries with PostgreSQL streaming replication
2. **Sharding** - Partition by auction_id hash for horizontal scaling
3. **WebSocket real-time** - Replace polling with push notifications
4. **Fraud detection** - ML model for suspicious bidding patterns
5. **Multi-currency** - Support international auctions with currency conversion
6. **Circuit breaker** - Protect against payment gateway failures
