# Design Venmo - Architecture

## System Overview

Venmo is a peer-to-peer payment platform with social features. Core challenges involve balance management, instant transfers, and social feed scalability.

**Learning Goals:**
- Build consistent wallet/balance systems
- Design real-time P2P transfer flows
- Implement social transaction feeds
- Handle multi-source funding

---

## Requirements

### Functional Requirements

1. **Send**: Transfer money to other users
2. **Request**: Ask others for payment
3. **Feed**: View social transaction activity
4. **Balance**: Manage Venmo wallet
5. **Cashout**: Transfer to bank account
6. **Friends**: Social connections with friend graph

### Non-Functional Requirements

- **Latency**: < 500ms for P2P transfers (p99)
- **Consistency**: Accurate balances always (strong consistency for wallets)
- **Availability**: 99.99% for transfer processing
- **Scale**: 80M+ users, high volume on weekends and holidays
- **Feed Latency**: < 200ms for feed reads (p95)

---

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| DAU | 20M users | ~25% of 80M MAU |
| Peak Transfer RPS | 5,000 | Weekend evenings, holidays |
| Avg Friends/User | 100 | Social graph density |
| Feed Fan-out Writes/Transfer | 100 | Avg friends of sender + receiver |
| Feed Reads/Day | 200M | Users check feed ~10x/day |
| Storage (transfers/year) | ~50 GB | 500 bytes * 100M transfers |
| Feed Storage (30 days) | ~200 GB | 100 fan-out items * 500 bytes * 4M transfers/month |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 5-20 seeded |
| Concurrent Requests | 5-10 |
| Total Storage | < 50 MB |
| Redis Memory | < 20 MB |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│                 Mobile App │ Web App                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│          (Auth, Rate Limiting, Request Routing)                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Transfer Service│    │  Feed Service │    │ Wallet Service│
│               │    │               │    │               │
│ - Send/Request│    │ - Timeline    │    │ - Balance     │
│ - Split bills │    │ - Social graph│    │ - Funding     │
│ - Idempotency │    │ - Visibility  │    │ - Cashout     │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌───────────────────────────────────────────────────────────────┐
│                    Message Queue (RabbitMQ)                    │
│         feed-fanout │ notifications │ cashout-batch            │
└───────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌───────────────────┐              ┌───────────────────┐
│    PostgreSQL     │              │   Redis / Valkey   │
│  - Users/Wallets  │              │  - Balance cache   │
│  - Transfers      │              │  - Sessions        │
│  - Feed items     │              │  - Idempotency     │
│  - Social graph   │              │  - Rate limits     │
│  - Audit log      │              │                    │
└───────────────────┘              └───────────────────┘
        │
        ▼
┌───────────────────┐
│  External APIs    │
│  - Bank (ACH)     │
│  - Card networks  │
│  - Push to debit  │
└───────────────────┘
```

At production scale, the feed storage would move from PostgreSQL to Cassandra for superior write throughput and time-series access patterns. PostgreSQL remains correct for the local implementation since feed fan-out volume is negligible.

---

## Core Components

### 1. Wallet and Balance Management

The wallet system uses PostgreSQL `SELECT FOR UPDATE` row-level locking to prevent race conditions on balance updates. Every transfer is atomic: debit sender and credit receiver within a single transaction.

**Balance Integrity Flow:**
1. Begin transaction
2. Lock sender's wallet row (`SELECT FOR UPDATE`)
3. Calculate available balance (wallet balance + pending external charges)
4. Determine funding source via waterfall: Balance --> Bank (free) --> Card (fee)
5. Debit sender wallet
6. Credit receiver wallet
7. Create transfer record
8. Commit transaction
9. Invalidate balance caches (Redis)
10. Fan out to feed (async)

The `FOR UPDATE` lock serializes concurrent transfers from the same sender, preventing negative balances. This is acceptable because a single user rarely sends multiple transfers simultaneously -- the lock hold time is < 50ms.

### 2. Funding Waterfall

When a user's wallet balance is insufficient, the system automatically selects the cheapest funding source:

| Priority | Source | Fee | Settlement |
|----------|--------|-----|------------|
| 1 | Venmo balance | Free | Instant |
| 2 | Linked bank (ACH) | Free | 1-3 business days |
| 3 | Linked debit card | 1.5% (max $15) | Instant |
| 4 | Linked credit card | 3% | Instant |

The waterfall runs within the same database transaction to ensure atomicity. If no funding source is available, the transfer fails and the transaction rolls back.

### 3. Social Feed (Fan-Out on Write)

When a transfer completes, the system writes a feed item for every relevant user:

- **Private transfers**: Feed items for sender and receiver only
- **Friends-only transfers**: Feed items for sender, receiver, and mutual friends
- **Public transfers**: Feed items for sender, receiver, and all friends of both

**Fan-out process:**
1. Transfer commits in PostgreSQL
2. Get friend lists for sender and receiver
3. Deduplicate the union of friend sets
4. Insert feed items for all target users
5. Filter by visibility settings on read

**Read path:**
```
SELECT fi.*, u_sender.name, u_receiver.name
FROM feed_items fi
JOIN transfers t ON fi.transfer_id = t.id
JOIN users u_sender ON t.sender_id = u_sender.id
JOIN users u_receiver ON t.receiver_id = u_receiver.id
WHERE fi.user_id = $1
ORDER BY fi.created_at DESC
LIMIT 20
```

**Why fan-out on write over fan-in on read:** Fan-in requires joining against the friend graph and visibility rules on every feed request. For 100 friends, that is 100 subqueries per read. Fan-out moves this cost to the write path where it is amortized, making reads O(1) against a pre-computed table. The tradeoff is storage -- each transfer produces N feed items -- but storage is cheap relative to p95 read latency.

### 4. Payment Requests

Requests create a pending record that the requestee can pay or decline:

1. Requester creates request with amount and note
2. Requestee receives push notification
3. Requestee pays (triggers normal transfer flow) or declines
4. If unpaid after 3 days, a reminder is sent
5. Request can be cancelled by requester at any time

### 5. Cashout

Two speeds:

| Speed | Mechanism | Fee | Arrival |
|-------|-----------|-----|---------|
| Standard | ACH batch | Free | 1-3 business days |
| Instant | Push-to-debit card | 1.5% (max $15) | Minutes |

Standard cashouts are batched and submitted to the ACH network daily. Instant cashouts use the debit card push network for real-time delivery.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  pin_hash VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Wallets (one per user, balance in cents)
CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0,
  pending_balance INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payment Methods (bank accounts and cards)
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  type VARCHAR(20) NOT NULL,  -- 'bank', 'card', 'debit_card'
  is_default BOOLEAN DEFAULT FALSE,
  name VARCHAR(200),
  last4 VARCHAR(4),
  bank_name VARCHAR(100),
  routing_number VARCHAR(20),
  account_number_encrypted TEXT,
  card_token VARCHAR(100),
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transfers (P2P payments)
CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  visibility VARCHAR(20) DEFAULT 'public',  -- 'public', 'friends', 'private'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  funding_source VARCHAR(20),
  idempotency_key VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transfers_sender ON transfers(sender_id, created_at DESC);
CREATE INDEX idx_transfers_receiver ON transfers(receiver_id, created_at DESC);
CREATE UNIQUE INDEX idx_transfers_idempotency ON transfers(sender_id, idempotency_key);

-- Payment Requests
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES users(id),
  requestee_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  transfer_id UUID REFERENCES transfers(id),
  reminder_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cashouts
CREATE TABLE cashouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  fee INTEGER DEFAULT 0,
  speed VARCHAR(20) NOT NULL,  -- 'instant', 'standard'
  status VARCHAR(20) NOT NULL,
  payment_method_id UUID REFERENCES payment_methods(id),
  estimated_arrival TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bill Splits
CREATE TABLE splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES users(id),
  total_amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE split_participants (
  split_id UUID REFERENCES splits(id),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  paid_at TIMESTAMP,
  PRIMARY KEY (split_id, user_id)
);

-- Friendships (bidirectional)
CREATE TABLE friendships (
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

-- Feed Items (fan-out on write)
CREATE TABLE feed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feed_items_user ON feed_items(user_id, created_at DESC);

-- Social interactions
CREATE TABLE transfer_likes (
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, transfer_id)
);

CREATE TABLE transfer_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transfer_comments_transfer ON transfer_comments(transfer_id, created_at);

-- Audit Log (append-only)
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,
  actor_type VARCHAR(20),
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(30),
  resource_id UUID,
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(50),
  details JSONB,
  outcome VARCHAR(20) NOT NULL DEFAULT 'success'
);

CREATE INDEX idx_audit_actor ON audit_log(actor_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_action ON audit_log(action, timestamp DESC);
```

---

## API Design

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Login, returns session |
| POST | `/api/auth/logout` | Yes | Invalidate session |
| GET | `/api/wallet` | Yes | Get wallet balance |
| POST | `/api/wallet/deposit` | Yes | Add money from funding source |
| POST | `/api/wallet/cashout` | Yes | Withdraw to bank |
| POST | `/api/transfers` | Yes | Send money (requires Idempotency-Key) |
| GET | `/api/transfers` | Yes | Transaction history |
| POST | `/api/requests` | Yes | Request money |
| GET | `/api/requests/received` | Yes | Incoming requests |
| GET | `/api/requests/sent` | Yes | Outgoing requests |
| POST | `/api/requests/:id/pay` | Yes | Pay a request |
| POST | `/api/requests/:id/decline` | Yes | Decline a request |
| GET | `/api/feed` | Yes | Social feed |
| POST | `/api/feed/:transferId/like` | Yes | Like a transfer |
| POST | `/api/feed/:transferId/comment` | Yes | Comment on transfer |
| GET | `/api/friends` | Yes | Friend list |
| POST | `/api/friends/add` | Yes | Send friend request |
| GET | `/api/payment-methods` | Yes | List linked accounts |
| POST | `/api/payment-methods` | Yes | Link bank/card |
| GET | `/metrics` | Internal | Prometheus metrics |
| GET | `/health` | None | Health check |

---

## Key Design Decisions

### 1. Row-Level Locking for Balance Updates

**Chosen:** PostgreSQL `SELECT FOR UPDATE` on wallet rows within transactions.
**Alternative:** Optimistic locking with version numbers and retries.
**Rationale:** For P2P transfers, the contention window is narrow -- a single user rarely sends multiple concurrent transfers. `FOR UPDATE` provides deterministic behavior: the second request waits (not retries) until the first completes. With optimistic locking, high-contention users (e.g., merchants receiving many payments) would see frequent retry storms. The tradeoff is that `FOR UPDATE` holds a row lock for the transaction duration (~10-50ms), which is acceptable for our access pattern but would not scale to thousands of concurrent writes to the same row.

### 2. Fan-Out on Write for Social Feed

**Chosen:** Pre-compute feeds by inserting a feed item per friend when a transfer occurs.
**Alternative:** Fan-in on read (query friends' transfers on demand).
**Rationale:** Venmo's feed is read-heavy (users scroll their feed far more often than they send money). Fan-out on write makes reads O(1) against a pre-indexed table, keeping feed latency under 50ms. The write cost is O(F) where F is the average friend count (~100 inserts per transfer), but transfers happen at ~5K RPS peak while feed reads happen at ~50K RPS. The storage cost (100x more rows) is justified by 10x fewer expensive join queries. For celebrity users with millions of friends, a hybrid approach (fan-out for normal users, fan-in for celebrities) would be needed.

### 3. PostgreSQL for Feed Storage (vs Cassandra)

**Chosen:** PostgreSQL for all data including feed items.
**Alternative:** Cassandra for feed storage with time-series partitioning.
**Rationale:** For a learning implementation, PostgreSQL simplifies operations (one database to manage) and makes the fan-out pattern easy to reason about. At production scale with 80M users, the feed table would grow to billions of rows. Cassandra's partition-key design (`user_id` as partition key, `created_at` as clustering key) maps perfectly to the feed access pattern. The migration path is straightforward because feed items are write-once and queried by a single key.

---

## Consistency and Idempotency

**Transfer Idempotency:**
- Client generates UUID when user clicks "Send" (not on page load)
- Server checks Redis via `SET NX` for atomic duplicate detection
- If duplicate: return cached result (completed or failed)
- If processing: return 409 Conflict
- Result cached with 24-hour TTL in Redis
- Permanent record via `idempotency_key` column in `transfers` table with unique index

**Balance Consistency:**
- Strong consistency via PostgreSQL transactions with row-level locking
- Balance cache in Redis is invalidated after every wallet modification
- Cache is read-through: miss hits PostgreSQL, result cached with 5-minute TTL

---

## Security / Auth

| Control | Implementation |
|---------|---------------|
| Authentication | Session-based with Redis-backed tokens, 24-hour expiry |
| Password Storage | bcrypt with cost factor 12 |
| Session Tokens | UUID v4, stored in Redis |
| Transfer Limits | $5,000 per transfer, $7,500 weekly |
| Audit Trail | Append-only `audit_log` table for all money movements |
| Sensitive Data | Account numbers encrypted, routing numbers masked in logs |
| Log Redaction | Pino redact paths for passwords, tokens, account numbers |

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `venmo_transfers_total` | Counter | status, funding_source | Transfer success/failure rates |
| `venmo_transfer_amount_cents` | Histogram | -- | Transfer amount distribution |
| `venmo_cashouts_total` | Counter | speed, status | Cashout volume tracking |
| `venmo_payment_requests_total` | Counter | status | Request lifecycle tracking |
| `venmo_http_request_duration_seconds` | Histogram | method, route, status_code | API latency |
| `venmo_db_query_duration_seconds` | Histogram | query_type, table | Database performance |
| `venmo_balance_cache_hits_total` | Counter | -- | Cache effectiveness |
| `venmo_feed_fanout_duration_seconds` | Histogram | -- | Fan-out performance |
| `venmo_circuit_breaker_state` | Gauge | service | External dependency health |
| `venmo_idempotency_cache_hits_total` | Counter | -- | Duplicate detection rate |
| `venmo_postgres_connections_active` | Gauge | -- | Connection pool health |
| `venmo_audit_events_total` | Counter | action, outcome | Compliance tracking |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Transfer success rate | 99.9% | < 99.5% for 5 min |
| Transfer latency p50 | < 100ms | > 150ms for 5 min |
| Transfer latency p99 | < 500ms | > 800ms for 2 min |
| Balance cache hit rate | > 90% | < 80% for 10 min |
| Feed load latency p95 | < 200ms | > 400ms for 5 min |
| Feed fan-out completion | 99.9% | < 99% for 5 min |
| PostgreSQL pool usage | < 80% | > 90% for 5 min |

### Structured Logging

JSON logs via Pino with: `service`, `requestId`, `userId`, `event`, `durationMs`. Sensitive fields (passwords, tokens, account numbers) are automatically redacted via Pino's `redact` configuration.

---

## Failure Handling

### Circuit Breakers

| Service | Failure Threshold | Reset Timeout | Fallback |
|---------|-------------------|---------------|----------|
| Bank API (ACH) | 3 failures | 60 seconds | Queue for later, notify user |
| Card Network | 5 failures | 30 seconds | Use alternate funding source |
| ACH Network | 3 failures | 120 seconds | Delay cashout, notify |

### Retry Strategy

| Operation | Retries | Backoff | Notes |
|-----------|---------|---------|-------|
| Transfer (internal) | 3 | Exponential (100ms-2s) | Idempotency key prevents duplicates |
| External payment | 5 | Exponential (500ms-30s) | Bank/card network calls |
| Feed fan-out | 3 | Fixed (100ms) | Non-critical, eventual consistency |

### Failure Mode Summary

| Failure | Detection | Mitigation | Recovery |
|---------|-----------|------------|----------|
| Duplicate transfer | Idempotency key match | Return cached result | Automatic |
| Insufficient funds | Balance check | Waterfall to next funding source | Automatic |
| Bank API down | Circuit breaker open | Fail fast, queue cashout | Auto after reset |
| Database down | Health check | Return 503 | Manual failover |
| Redis down | Connection error | Fall back to PostgreSQL queries | Auto-reconnect |
| Feed fan-out failure | Async error | Retry queue, eventual consistency | Automatic |

---

## Scalability Considerations

### Scaling Path

| Component | Current | Production Scale |
|-----------|---------|-----------------|
| API Servers | 1-3 processes | Stateless fleet behind ALB, auto-scale |
| PostgreSQL | Single instance | Primary + replicas, feed data migrated to Cassandra |
| Redis | Single instance | Cluster mode with persistence |
| Feed Fan-out | Synchronous inserts | RabbitMQ/Kafka workers for async fan-out |
| Notifications | Not implemented | Push notification service with Firebase/APNs |

### What Breaks First

1. **Feed table size** -- with 80M users and 100 friends each, the feed table grows by billions of rows monthly. Solution: migrate to Cassandra with `user_id` partition key and TTL-based expiry.
2. **Write contention on popular users** -- a user receiving thousands of payments (merchant-like) will have lock contention on their wallet row. Solution: batched credits with a pending balance queue.
3. **Fan-out for high-follower users** -- if a user has 10K+ friends, a single transfer generates 10K inserts. Solution: hybrid fan-out (write for normal users, read for celebrities).

### Storage Tiering

| Tier | Data Age | Storage | Query Speed |
|------|----------|---------|-------------|
| Hot | 0-90 days | PostgreSQL | < 50ms |
| Warm | 90 days-2 years | Archive table | < 500ms |
| Cold | 2-7 years | S3/MinIO (Parquet) | Minutes |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balance locking | `SELECT FOR UPDATE` | Optimistic locking | Low contention for P2P, no retry storms |
| Feed architecture | Fan-out on write | Fan-in on read | Read-heavy workload, O(1) reads |
| Feed storage | PostgreSQL | Cassandra | Simpler for learning; Cassandra for production |
| Funding selection | Automatic waterfall | User selects each time | Better UX, minimizes fees |
| Transfer speed | Instant (in-app) | Batch processing | User expectation for P2P |
| Idempotency | Redis + DB column | DB-only unique index | Sub-ms lookups, graceful Redis failure |

---

## Implementation Notes

### Local Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐
│  Frontend    │     │  Backend (Express)  :3000            │
│  React+Vite  │────▶│                                     │
│  :5173       │     │  Routes: auth, transfers, wallet,   │
│              │     │  feed, friends, requests,            │
│              │     │  paymentMethods                      │
│              │     │                                     │
│              │     │  Services: transfer (funding,        │
│              │     │  locking, fan-out)                   │
│              │     │                                     │
│              │     │  Shared: logger, metrics, audit,    │
│              │     │  circuit-breaker, idempotency, retry,│
│              │     │  archival                            │
│              │     │                                     │
│              │     │  Middleware: auth (session-based)     │
│              │     └──────────┬──────────┬──────────────┘
│              │                │          │
└─────────────┘     ┌──────────▼──┐  ┌────▼──────────┐
                     │ PostgreSQL  │  │ Valkey/Redis   │
                     │ :5432       │  │ :6379          │
                     │ venmo       │  │ Sessions,      │
                     │             │  │ balance cache,  │
                     │             │  │ idempotency     │
                     └─────────────┘  └───────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File(s) | Why It Matters |
|---------|---------|---------------|
| **Idempotency** | `backend/src/shared/idempotency.ts`, `backend/src/routes/transfers.ts` | Prevents duplicate money transfers. Uses Redis `SET NX` with 24h TTL. Falls back to PostgreSQL unique index. |
| **Circuit breakers** | `backend/src/shared/circuit-breaker.ts` | Custom implementation with CLOSED/OPEN/HALF_OPEN states. Pre-configured for bank API (3 failures, 60s reset), card network (5/30s), ACH (3/120s). Metrics-integrated. |
| **Prometheus metrics** | `backend/src/shared/metrics.ts` | 15+ metrics covering transfers, cashouts, HTTP latency, DB queries, cache hits, circuit breakers, audit events. Exposed at `/metrics`. |
| **Structured logging** | `backend/src/shared/logger.ts` | Pino with JSON output, automatic redaction of passwords/tokens/account numbers, child loggers for request context. |
| **Audit logging** | `backend/src/shared/audit.ts`, `backend/src/db/init.sql` | Append-only `audit_log` table. Logs all money movements, auth events, payment method changes. |
| **Retry with backoff** | `backend/src/shared/retry.ts` | Exponential backoff with jitter for external API calls. Configurable per operation type. |
| **Transaction archival** | `backend/src/shared/archival.ts` | Tiered retention: 90 days hot (PostgreSQL), 2 years warm (archive table), 7 years cold (object storage). |
| **Transfer service** | `backend/src/services/transfer.ts` | `SELECT FOR UPDATE` locking, funding waterfall (balance --> bank --> card), fan-out to feed, balance cache invalidation. |
| **Health checks** | `backend/src/index.ts` | `/health` (basic), `/health/detailed` (PostgreSQL + Redis), `/health/live`, `/health/ready`. |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Notes |
|---------------------|-----------------|-------|
| Bank API (ACH) | Simulated instant completion | No actual ACH network calls |
| Card network | Simulated charges | No real card processing |
| Push notifications | In-app only (database) | No Firebase/APNs integration |
| Feed storage (Cassandra) | PostgreSQL `feed_items` table | Works at local scale, not production |
| Message queue (RabbitMQ) | Synchronous fan-out | Feed items inserted within the transfer transaction |
| OAuth/social login | Session-based with bcrypt | No OAuth providers |
| Multi-region | Single-process, multi-port (`dev:server1/2/3`) | Stateless design supports scaling |

### What Was Omitted

- CDN and static asset hosting
- Multi-region deployment and replication
- Kubernetes orchestration
- Push notification service (Firebase/APNs)
- KYC/AML verification workflows
- Bill splitting (tables exist, workflow not implemented)
- QR code payments
- Recurring payments
- Real-time payment streaming (RTP network)
- Fraud detection and risk scoring
- Data archival pipeline to object storage (logic exists, pipeline not wired)

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (RootComponent)
├── /login ─── LoginPage (unauthenticated)
├── /register ─── RegisterPage (unauthenticated)
└── Layout (authenticated shell with bottom nav)
    ├── / ─── FeedPage
    │   └── TransactionCard (per-item, with likes/comments)
    ├── /pay ─── PayPage
    │   ├── UserSearchDropdown (debounced search)
    │   └── Avatar
    ├── /request ─── RequestPage
    │   ├── CreateRequestForm
    │   │   ├── AmountInput, UserSearchDropdown
    │   ├── ReceivedRequests ─── RequestCard[]
    │   └── SentRequests ─── RequestCard[]
    ├── /wallet ─── WalletPage
    │   ├── WalletBalanceCard
    │   ├── WalletTabNavigation
    │   └── WalletTabContent
    │       ├── WalletOverview (deposit + cashout forms)
    │       ├── TransactionHistory
    │       └── PaymentMethodsTab
    │           ├── PaymentMethodItem[]
    │           ├── AddBankForm, CashoutForm, DepositForm
    │           └── RecentCashouts
    └── /profile ─── ProfilePage
```

The root component (`__root.tsx`) checks authentication status on mount via `useAuthStore().checkAuth()`, which validates the session token against the backend. Unauthenticated users are redirected to `/login`; authenticated users on login/register pages are redirected to `/`. The `Layout` component provides a persistent mobile-style navigation bar at the bottom with links to Feed, Pay, Request, Wallet, and Profile.

### Routing (TanStack Router, File-Based)

Routes are defined under `frontend/src/routes/`. TanStack Router auto-generates `routeTree.gen.ts`. All routes are static paths -- no dynamic segments. Auth routing is handled at the root level via `<Navigate>` redirects rather than per-route `beforeLoad` guards, keeping auth logic centralized.

### Zustand Stores

Venmo uses five separate Zustand stores, each managing a distinct domain. This separation prevents unrelated state updates from causing unnecessary re-renders.

**`useAuthStore`** -- Manages user identity, session lifecycle, and balance. Provides `login`, `register`, `logout`, and `checkAuth` actions. The `checkAuth` action reads the session ID from `localStorage`, validates it against the backend (`GET /api/auth/me`), and populates the `user` object. The `updateBalance` action allows other stores to update the displayed balance after transfers without a full re-fetch.

**`useFeedStore`** -- Manages the social transaction feed. Provides `loadFeed` (friends' activity) and `loadGlobalFeed` (all public activity). The `addItem` action optimistically prepends a new transfer to the feed after a successful payment, so the user sees their transaction immediately without waiting for a re-fetch. The `updateItem` action updates individual feed items in-place (e.g., when a like count changes).

**`useRequestsStore`** -- Manages sent and received payment requests. Loads both lists in parallel via `Promise.all`. Separate from the feed store because payment requests have their own lifecycle (pending, paid, declined) that is independent of the social feed.

**`useWalletStore`** -- Manages the wallet balance, pending balance, and linked payment methods. The `loadWallet` action fetches all three from a single endpoint (`GET /api/wallet`). This store is consumed by both the Wallet page (full display) and the Pay page (showing available balance below the amount input).

**`useFriendsStore`** -- Manages the friend list and pending friend requests. Provides CRUD actions for friend connections. Used by the Profile page and the user search dropdown in the Pay flow.

### Data Fetching Pattern

All API calls are centralized in `frontend/src/services/api.ts` as a single `api` object with method-per-endpoint. A generic `request<T>()` wrapper handles session token injection (reading from `localStorage` and attaching as `x-session-id` header), JSON serialization, and error handling.

Data fetching follows the Zustand store action pattern: each store has async actions (e.g., `loadFeed`, `loadWallet`) that call the API, update store state, and manage loading flags. Components call these actions in `useEffect` hooks on mount. There is no global caching layer -- each navigation to a page triggers a fresh fetch. For the Pay page, user search is debounced at 300ms to avoid flooding the search endpoint while the user types.

### Key UI Patterns

**Social Feed (FeedPage):** A toggle between "Friends" and "Global" feeds using pill-shaped buttons. Each feed item is rendered as a `TransactionCard` showing sender, receiver, note, amount, visibility level, timestamp, and social interactions (likes, comments). The card handles like/unlike toggling and inline comment display. Empty states use illustrative SVG icons with contextual messaging.

**Payment Flow (PayPage):** A form-based payment flow with inline user search. As the user types a recipient username, a debounced search queries the backend and renders a dropdown of matching users with avatars. Selecting a user populates the recipient field and shows a confirmation badge. The amount input includes client-side validation ($0.01 minimum, $5,000 maximum). After successful payment, the transfer is optimistically added to the feed store and the user is redirected to the feed after a 1.5-second delay showing a success animation.

**Wallet Management (WalletPage):** A tabbed interface (Overview, History, Payment Methods) under a prominent balance card. The balance card uses the Venmo brand blue background with white text. The Overview tab provides deposit and cashout forms. The History tab lists past transactions. The Payment Methods tab manages linked bank accounts and cards with add/delete/set-default actions. Tab switching is entirely client-side -- all data is fetched once on mount.

**Request Management (RequestPage):** A tabbed layout separating "Create", "Received", and "Sent" requests. Received requests show pay/decline action buttons. Sent requests show cancel/remind buttons. Each request card displays a status badge (pending/paid/declined/cancelled) with appropriate color coding.

### Type Safety

All domain types are defined in `frontend/src/types/index.ts`: `User`, `Transfer`, `PaymentRequest`, `PaymentMethod`, `Friend`, `Cashout`. The API service uses inline `import()` type references for return types, providing type safety for API responses without a separate types-per-endpoint file.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Idempotency

**What it is:** Idempotency is a property of an operation where performing it multiple times produces the same result as performing it once. For a P2P payment app, it means that if a user taps "Pay" and the network drops, retrying the request will not send the money twice.

**Why it matters for P2P transfers:** When Alice sends Bob $50, the server debits Alice's wallet and credits Bob's. If the response is lost in transit and Alice's app retries, a non-idempotent server would debit Alice again and credit Bob again -- a $100 transfer instead of $50. This is catastrophic for user trust and requires manual intervention to reverse.

**How it works here:** The client generates a UUID when the user taps "Send" (not on page load, to avoid reuse across different payment attempts). This UUID is sent as an idempotency key. The server checks Redis via `SET NX` (set-if-not-exists) to atomically claim the key. If the key already exists with a completed result, the cached response is returned. If it exists with a pending status, 409 Conflict is returned. The result is cached with a 24-hour TTL. A unique index on `transfers(sender_id, idempotency_key)` in PostgreSQL serves as a durable fallback if Redis is unavailable.

### Redis Cache-Aside (Balance Cache)

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache miss, the database is queried, the result is stored in the cache, and then returned. On a cache hit, the cached value is returned without touching the database.

**Why it matters:** Wallet balance is the most frequently read value in the system -- it is displayed on every page (header, pay form, wallet page). Computing it from PostgreSQL requires summing transfers and wallet modifications, which is a relatively expensive query. Redis provides sub-millisecond reads, turning this from a 5-20ms database query into a < 1ms cache lookup.

**How it works here:** After every wallet modification (transfer, deposit, cashout), the balance cache for the affected user is invalidated (deleted from Redis). The next balance read misses the cache, queries PostgreSQL, and populates the cache with a 5-minute TTL. This means the cache is always fresh after a write (immediate invalidation) and eventually stale for read-only users (5-minute window). The `venmo_balance_cache_hits_total` Prometheus counter tracks cache effectiveness -- the SLI target is > 90% hit rate.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that stops an application from making calls to a service that is known to be failing. It has three states: CLOSED (normal operation -- requests pass through), OPEN (service is failing -- requests fail immediately without trying), and HALF_OPEN (after a timeout, a single test request is allowed through to check if the service has recovered).

**Why it matters:** Venmo calls external services for ACH bank transfers, card charges, and push-to-debit cashouts. If the bank API goes down, every cashout attempt would hang for the full timeout (say 30 seconds), consuming a connection pool slot and a thread. With 100 concurrent cashout attempts, the connection pool is exhausted and the entire API becomes unresponsive -- even for unrelated requests like viewing the feed. The circuit breaker fails fast (in microseconds) when the bank API is known to be down.

**How it works here:** A custom circuit breaker implementation (`backend/src/shared/circuit-breaker.ts`) manages three states with configurable thresholds. Three breakers are pre-configured: bank API (3 failures, 60s reset), card network (5 failures, 30s reset), and ACH network (3 failures, 120s reset). When the bank API circuit opens, cashout requests immediately receive a user-friendly error ("Cashouts are temporarily unavailable, please try again in a few minutes") instead of hanging. Circuit breaker state is exposed as a `venmo_circuit_breaker_state` Prometheus gauge for monitoring.

### Structured Logging

**What it is:** Structured logging produces log entries as JSON objects with consistent, queryable fields, rather than free-form text strings. Each entry includes a fixed set of keys (timestamp, level, service, requestId, userId, event) plus event-specific data.

**Why it matters:** When investigating why a transfer failed, you need to find all log entries related to that specific request across multiple service layers. With unstructured logs like `"Transfer failed: insufficient funds"`, you would need to grep for partial strings and manually correlate entries. With structured logs, you can query `{"userId": "abc123", "event": "transfer_failed", "timestamp": {">": "2024-01-15T10:00:00Z"}}` and instantly find every relevant entry. Structured logs also enable automated alerting on specific fields -- for example, alerting when `event: "transfer_failed"` exceeds 10 occurrences in 5 minutes.

**How it works here:** Pino is configured (`backend/src/shared/logger.ts`) with JSON output and automatic redaction of sensitive fields (passwords, session tokens, bank account numbers) via Pino's `redact` configuration. Child loggers carry per-request context (requestId, userId) so that every log entry within a request handler automatically includes the user's identity without passing it explicitly through every function call.

### Prometheus Metrics

**What it is:** Prometheus is a time-series monitoring system that collects numeric measurements from applications at regular intervals. Applications expose a `/metrics` endpoint in a specific text format. Prometheus scrapes this endpoint and stores time-stamped values, enabling dashboards and alerting. Metrics come in four types: counters (only go up -- total requests), gauges (go up and down -- active connections), histograms (distributions -- request latency buckets), and summaries (pre-calculated percentiles).

**Why it matters:** Metrics answer questions that logs cannot efficiently answer: "What is the p95 transfer latency over the last hour?" "What percentage of transfers use bank funding vs. card funding?" "Is the balance cache hit rate declining?" For a P2P payment platform, the `venmo_transfers_total` counter by funding source reveals whether the funding waterfall is working correctly, while `venmo_feed_fanout_duration_seconds` reveals whether the social feed is becoming a performance bottleneck as users gain more friends.

**How it works here:** The implementation uses `prom-client` (`backend/src/shared/metrics.ts`) with 15+ metrics exposed at `/metrics`. Business metrics include `venmo_transfers_total` (counter by status and funding source), `venmo_transfer_amount_cents` (histogram for amount distribution), `venmo_cashouts_total` (counter by speed and status), and `venmo_payment_requests_total` (counter by status). Infrastructure metrics include `venmo_http_request_duration_seconds` (histogram by method/route/status), `venmo_db_query_duration_seconds` (histogram by query type), `venmo_balance_cache_hits_total`, `venmo_feed_fanout_duration_seconds`, and `venmo_postgres_connections_active`.

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. When the limit is exceeded, the server responds with HTTP 429 (Too Many Requests). Limits are typically tracked per user or per IP address using a sliding window or fixed window algorithm.

**Why it matters:** Without rate limiting, a single user could send thousands of transfers per second (accidentally or maliciously), overwhelming the database and degrading service for all users. Rate limiting also prevents brute-force attacks on the login endpoint, API abuse by automated scripts, and denial-of-service attacks. For Venmo specifically, transfer limits ($5,000 per transfer, $7,500 weekly) are a form of business-level rate limiting that protects against fraud and money laundering.

**How it works here:** Transfer limits are enforced at the application level: the transfer service checks the weekly rolling total before processing. API-level rate limiting (per-user, per-endpoint) is designed but not yet implemented in the local version. The design calls for Redis-based sliding window counters shared across API server instances, with different limits per endpoint category (stricter for auth endpoints, more generous for feed reads).

### Audit Logging

**What it is:** Audit logging is the practice of recording a permanent, tamper-resistant trail of all significant actions in a system. Unlike application logs (which are for debugging), audit logs are for compliance, forensics, and dispute resolution. They answer the question "who did what, when, and from where?"

**Why it matters:** For a payment platform, regulatory requirements (BSA/AML, state money transmitter licenses) mandate that every money movement is traceable. If a user disputes a transfer ("I didn't send that $500"), the audit log provides evidence: the IP address the request came from, the device's user agent, the exact timestamp, and the session that authorized it. Audit logs are append-only -- they cannot be modified or deleted, even by administrators.

**How it works here:** An append-only `audit_log` table (`backend/src/db/init.sql`) records every significant action: transfers, deposits, cashouts, login attempts, payment method changes, and friend request actions. Each entry captures `actor_id`, `actor_type`, `action`, `resource_type`, `resource_id`, `ip_address`, `user_agent`, `request_id`, and a `details` JSONB field for action-specific data. The `outcome` column records whether the action succeeded or failed. Indexes on `(actor_id, timestamp)`, `(resource_type, resource_id)`, and `(action, timestamp)` enable efficient forensic queries.

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether an application is functioning correctly. Load balancers poll these endpoints to decide whether to route traffic to an instance. Container orchestrators use them to decide whether to restart a container.

**Why it matters:** If a Venmo API server loses its PostgreSQL connection, it cannot process transfers. Without a health check, the load balancer continues routing transfer requests to this broken instance, causing 100% failure for those requests. With a health check, the load balancer detects the unhealthy instance within seconds and routes traffic to healthy instances instead.

**How it works here:** Four health endpoints are implemented (`backend/src/index.ts`): `/health` (basic -- is the process alive?), `/health/detailed` (checks PostgreSQL and Redis connectivity with latency measurement), `/health/live` (Kubernetes liveness probe -- process is running), and `/health/ready` (Kubernetes readiness probe -- ready to accept traffic, meaning all dependencies are reachable). The detailed endpoint returns JSON with per-dependency status and latency, enabling operators to diagnose which specific dependency has failed.
