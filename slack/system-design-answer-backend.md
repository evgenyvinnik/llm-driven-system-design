# Slack — System Design Answer (Backend Focus)

*45-minute system design interview format — Backend Engineer*

## 📋 Problem Statement

Design the backend for a team messaging platform:

- Real-time message delivery to thousands of concurrent users per workspace
- Hard workspace isolation for enterprise tenants
- Threading that stays cheap even in busy channels
- Full-text search across billions of messages

> "I'll anchor every decision to two numbers: message delivery has to feel instant (sub-200ms end to end), and the workload is read-heavy (~100:1). Those two constraints push me toward a persistent-connection fan-out layer in front of an ACID store, with a separate engine for search."

### Functional Requirements
1. Workspaces with role-based membership (owner / admin / member / guest)
2. Public and private channels with membership + read-position tracking
3. Messages: send, edit, delete, react, thread
4. Search with filters (channel, user, date)
5. Presence and typing indicators

### Non-Functional Requirements
| NFR | Target |
|-----|--------|
| Delivery latency | < 200ms send → receipt |
| Availability | 99.99% for the messaging path |
| Ordering | Consistent per-channel order across devices |
| Scale | 10M workspaces, ~1B messages/day |

### Scale Estimates
- 10M workspaces × ~100 users = ~1B users
- 1B messages/day ≈ 12K msg/s average, ~50K/s peak
- ~500 bytes/message → ~500 GB/day raw
- Read:write ≈ 100:1 (history scrolls, unread badges, search dominate)

## 🏗️ High-Level Architecture

```
                    ┌──────────────────────┐
                    │   Load Balancer      │
                    └──────────┬───────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │  Gateway   │   │  Gateway   │   │  Gateway   │  stateless
       │ (HTTP+WS)  │   │ (HTTP+WS)  │   │ (HTTP+WS)  │  WebSocket
       └─────┬──────┘   └─────┬──────┘   └─────┬──────┘  gateways
             └────────────────┼────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 ┌────────────┐        ┌────────────┐        ┌──────────────┐
 │   Redis    │        │ PostgreSQL │        │Elasticsearch │
 │ pub/sub +  │        │  (source   │        │  (search)    │
 │ presence + │        │ of truth)  │        │  async index │
 │ sessions   │        └────────────┘        └──────────────┘
 └────────────┘
```

Gateways are interchangeable: any user can land on any gateway because the gateway holds no channel-membership state — it only mirrors one Redis subscription per connected socket (details below). Locally this is a single Express + `ws` process (default port 3001) that can run as instances 3001–3003 sharing one Postgres and Redis; at production scale each box is one of thousands of gateways.

## 💾 Deep Dive 1: Data Model and Why PostgreSQL Is the Source of Truth

### Schema (prose)

| Table | Key columns | Notes |
|-------|-------------|-------|
| **users** | id (UUID PK), email (unique), password_hash, username, display_name, avatar_url | Workspace-agnostic identity |
| **workspaces** | id (UUID PK), name, domain (unique), settings (JSONB) | The tenant boundary |
| **workspace_members** | (workspace_id, user_id) composite PK, role | Role per workspace |
| **channels** | id (UUID PK), workspace_id (FK), name, topic, is_private, is_archived | Unique on (workspace_id, name) |
| **channel_members** | (channel_id, user_id) PK, last_read_at | Membership + read cursor for unread counts |
| **messages** | id (BIGSERIAL PK), workspace_id, channel_id, user_id, thread_ts (self-ref, NULL=top-level), content, reply_count, edited_at, created_at | Threading via self-reference |
| **reactions** | (message_id, user_id, emoji) PK | One reaction per user/emoji/message |
| **direct_messages / direct_message_members** | DM conversation + participants | 1:1 and group DMs |

### Index strategy on `messages`

| Index | Columns | Serves |
|-------|---------|--------|
| idx_messages_channel | (channel_id, created_at DESC) | The dominant query: channel history, newest first |
| idx_messages_thread | thread_ts **WHERE thread_ts IS NOT NULL** (partial) | Thread reply lookups without indexing the millions of top-level rows |
| idx_messages_content_fts | GIN on `to_tsvector('english', content)` | The Postgres FTS fallback for search |

> "The messages PK is a BIGSERIAL, not a UUID. Channel history is fundamentally a time-ordered scan, and a monotonic bigint keeps the primary index dense and cache-friendly for `(channel_id, created_at DESC)` reads. Users and workspaces are UUIDs because they're referenced everywhere and I don't want an enumerable, guessable tenant id crossing a security boundary."

### Why PostgreSQL primary + Elasticsearch secondary — and why not just one

| Consideration | PostgreSQL | Elasticsearch |
|---------------|-----------|---------------|
| ✅ Message storage / ordering | ACID, cheap `(channel, time)` scans | Near-real-time, not transactional |
| ✅ Full-text ranking | Moderate (GIN, no real relevance) | Excellent (BM25, highlighting) |
| Operational cost | Low | Higher (cluster, mapping, reindex) |

> "Elasticsearch as the single store fails on the write path that matters most: a thread reply must atomically insert the message *and* bump the parent's reply_count. ES has no multi-document transaction, so a crash between the two writes leaves a thread whose count lies. Postgres gives me that atomicity for free. Conversely, Postgres FTS as the only search fails on relevance and highlighting at billions of rows — `plainto_tsquery` has no BM25 scoring and the GIN index bloats. So Postgres owns truth and ordering; ES owns ranked search, fed asynchronously so indexing lag never slows a send. When ES is unreachable, search degrades to the Postgres GIN path rather than erroring — worse ranking, but still results."

## 🔧 Deep Dive 2: Real-Time Fan-Out — User-Level Pub/Sub

### The problem
A message to a 1,000-member channel must reach up to 1,000 WebSocket connections spread across many gateways. The gateway that receives the HTTP `POST` almost never holds all 1,000 sockets.

### The chosen design: fan out once at the service; subscribe per-user at the gateway
Send flow:
1. Persist the message to Postgres (source of truth, assigns the bigint id → ordering).
2. Query `channel_members` for the recipient user_ids.
3. For each recipient, `PUBLISH` the serialized message to that user's personal Redis channel `user:{userId}:messages`.
4. Enqueue the message for async Elasticsearch indexing.

Gateway side: when a socket connects, the gateway opens **one** Redis subscriber on `user:{userId}:messages` and pipes everything it receives straight to that socket. On disconnect it unsubscribes. The gateway never learns which channels the user is in.

### Why user-level, not channel-level pub/sub

| Approach | Pros | Cons |
|----------|------|------|
| ✅ User-level (`user:{id}:messages`) | Gateway is trivial and stateless; exact targeting; presence/typing/DMs reuse the same channel | More Redis channels (one per online user) |
| ❌ Channel-level (`channel:{id}`) | Fewer channels | Every gateway must subscribe to every channel any of its sockets cares about, then filter by membership on each message |

> "Channel-level pub/sub breaks at exactly the scale we care about. If a gateway holds 10K sockets spanning 50K distinct channels, it must maintain 50K subscriptions and, worse, it re-derives 'who on this box is in this channel' for every published message — that membership filter is per-message work on the hot path. User-level pub/sub moves the fan-out to the message service, which does it once against an index we already have. The cost is more Redis subscriptions, but a subscription is cheap and Redis pub/sub sustains ~100K messages/sec on a single node, covering our 50K/s peak with headroom. What I give up is durability: pub/sub is fire-and-forget, so a momentarily disconnected socket misses the push. That's fine because Postgres is the source of truth — on reconnect the client pulls history since its last seen id and the missed message is simply read from the DB."

Connection→gateway routing (for targeted server-initiated sends) is tracked in a Redis hash with a 1-hour TTL so crashed gateways self-evict.

## 🔧 Deep Dive 3: Threading and Presence Without New Infrastructure

### Threading as a message attribute
A reply is just a message with `thread_ts` = parent id. Sending a reply runs in one transaction: insert the reply, then `UPDATE messages SET reply_count = reply_count + 1 WHERE id = parent`. Reading a thread is `SELECT * WHERE thread_ts = parent ORDER BY created_at`.

> "A separate `threads` table would normalize the reply count but forces two delivery paths — 'is this a channel message or a thread message?' — and a join on every read. Treating a reply as a message means it travels the exact same persist → fan-out pipeline as everything else; the only extra work is the atomic counter bump, which the transaction already guarantees. The denormalized `reply_count` can theoretically drift, but since it's only ever touched inside the same transaction as the insert, it can't."

### Presence via Redis TTL, with a fan-out guard
Each heartbeat (~every 30s) sets `presence:{workspaceId}:{userId}` with a 60s TTL. "Is online?" is a key existence check; "who's online?" is a `SCAN` (never `KEYS`, which would block a large workspace). Expiry means a crashed client goes offline automatically with no cleanup job.

> "The trap is presence fan-out. Naively, every presence flip broadcasts to the whole workspace — in a 100K-user workspace that's 100K pushes for one person going idle, and presence flips constantly. So I only notify users who actually share a channel with the person changing state: look up their channels, take the distinct members, publish to those. Most large-workspace users share no channels, so this collapses the fan-out by orders of magnitude. The cost is a membership query per presence change, which is cheap and cached."

## 🔒 Consistency, Idempotency, Rate Limiting

- **Idempotency:** the send path accepts an idempotency key; the first request caches its response in Redis under `idem:{key}` (24h TTL) behind a short `SET NX` lock, and retries return the cached response instead of inserting a duplicate. This matters because clients on flaky mobile networks retry aggressively — without it, one message becomes three.
- **Ordering:** the bigint message id assigned by Postgres is the ordering authority. Clients render by id, so even if two pushes arrive out of order over different sockets, the UI sorts them deterministically.
- **Rate limiting:** a Redis sorted-set sliding window (ZREMRANGEBYSCORE old entries → ZADD now → ZCARD → EXPIRE, atomically in a MULTI). Real limits from the middleware: send 60/min, edit/delete/react 30/min, create-channel 10/min, join-channel 20/min, search 20/min.

## 🔌 API Surface (representative)

```
POST   /api/auth/login | /register | /logout
GET    /api/workspaces | POST /api/workspaces | POST /api/workspaces/:id/join
GET    /api/channels?workspace=:id | POST /api/channels
POST   /api/channels/:id/join | /leave | /read
GET    /api/messages/channel/:channelId | POST /api/messages/channel/:channelId
PUT    /api/messages/:id | DELETE /api/messages/:id
GET    /api/messages/:id/thread
POST   /api/messages/:id/reactions | DELETE /api/messages/:id/reactions/:emoji
GET    /api/search?q=&channel=&user=&from=&to=
WS     /ws?userId=&workspaceId=   (ping / typing / presence up; message / reaction / presence / typing down)
```

## 📈 Scalability — What Breaks First

1. **PostgreSQL write throughput** is the first ceiling (~5K writes/s single node vs 50K/s peak). Shard the `messages` table by `workspace_id` (hash) so a workspace's traffic lands on one shard; workspaces are independent, so cross-shard queries are rare. Read replicas absorb the 100:1 history/unread read load behind PgBouncer.
2. **Redis pub/sub node** saturates next under fan-out. Move to Redis Cluster and shard by a hash of the user id so a user's subscription always resolves to one node.
3. **Gateway connection count** — each box holds ~10K sockets; scale horizontally, they're stateless. Sticky routing isn't required because any gateway can serve any user.
4. **Elasticsearch indexing lag** grows under write spikes; because indexing is async off a queue, this surfaces as "search is a few seconds behind," never as slower sends. Add index nodes / shards to catch up.

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Real-time fan-out | User-level Redis pub/sub | Channel-level pub/sub | Stateless gateways; no per-message membership filter |
| Delivery durability | Fire-and-forget + DB backfill | Persisted per-user queues | Simpler; Postgres already the source of truth |
| Threading | `thread_ts` attribute | Separate threads table | One delivery path, atomic reply_count |
| Search | ES primary + PG FTS fallback | ES only / PG only | ACID truth in PG, BM25 relevance in ES |
| Presence | Redis TTL + shared-channel fan-out | Broadcast to whole workspace | Auto-cleanup; avoids 100K-push storms |
| Message id | BIGSERIAL | UUID | Dense time-ordered index, cheap ordering |

## 🚀 Future Work

Per-workspace retention policies (auto-expire old messages), tiered rate limits by pricing plan, an admin audit log for compliance, a Kafka-backed async pipeline for notifications/webhooks/indexing (the production design replaces the direct enqueue used locally), and multi-region gateways with region-local Redis for global tenants.
