# Slack — System Design Answer (Backend Focus)

*45-minute system design interview format — Backend Engineer*

## 📋 Problem Statement

Design the backend for a team messaging platform:

- Real-time message delivery to thousands of concurrent users per workspace
- Hard workspace isolation for enterprise tenants
- Threading that stays cheap even in busy channels
- Full-text search across billions of messages
- Presence and typing indicators that don't melt the fan-out layer

> "I'll anchor every decision to two numbers: message delivery has to feel instant (sub-200ms end to end), and the workload is read-heavy (~100:1). Those two constraints push me toward a persistent-connection fan-out layer in front of an ACID store, with a separate engine for search."

### Functional Requirements
1. Workspaces with role-based membership (owner / admin / member / guest)
2. Public and private channels with membership + read-position tracking
3. Messages: send, edit, delete, react, thread
4. Direct messages: 1:1 and group
5. Search with filters (channel, user, date)
6. Presence and typing indicators

### Non-Functional Requirements
| NFR | Target | Why it drives design |
|-----|--------|----------------------|
| Delivery latency | < 200ms send → receipt | Rules out poll-based delivery; needs push |
| Availability | 99.99% for the messaging path | No single-node dependency on the hot path |
| Ordering | Consistent per-channel order across devices | Needs a server-assigned monotonic sequence |
| Durability | No acknowledged message ever lost | Persist-before-fan-out |
| Scale | 10M workspaces, ~1B messages/day | Sharding + async indexing |

## 🧮 Capacity Estimation

- **Users / workspaces:** 10M workspaces × ~100 users ≈ 1B users; assume 10% concurrently connected at peak → ~100M live WebSocket connections.
- **Message rate:** 1B messages/day ÷ 86,400 ≈ **12K msg/s average**, ~**50K/s peak**.
- **Storage:** ~500 bytes/message × 1B/day ≈ 500 GB/day of raw message text → ~180 TB/year before replication. This is why messages must shard, not live in one table.
- **Fan-out amplification:** average channel maybe 50 members, busy channels 1,000+. A single 50K/s peak send rate can imply millions of per-connection deliveries per second — the fan-out layer, not the DB write, is the throughput story.
- **Read multiplier:** 100:1 read:write. History scrolls, unread-count recomputation, and search dwarf writes, so the read path gets replicas and aggressive caching.
- **Connections per gateway:** ~10K sockets/box → ~10K gateways at peak. They must be stateless and cheap to add.

Two numbers here drive most of the design. The first is the **fan-out
amplification**: 50K sends/s against an average of 50 recipients is ~2.5M
deliveries/s, and a single 1,000-member channel turns one write into a thousand
pushes. That ratio is why the interesting engineering sits in the delivery
layer rather than the database — 50K writes/s is a sharding problem with a
known answer, while 2.5M/s of push is what dictates the pub/sub topology.

The second is the **100:1 read multiplier**. Almost none of that read traffic is
novel: it's the same recent messages, the same channel-member lists, and the
same unread computations requested over and over. That shape is what makes
cache-aside effective here — a 2-minute TTL on channel members absorbs a large
fraction of reads because membership changes far more slowly than it's read.
If reads were mostly deep history scrolls with no locality, caching would buy
much less and I'd lean harder on read replicas instead.

> "I'd flag one thing about these estimates: 1B users is the whole-internet
> number, and no real deployment looks like that. What matters for the design
> isn't the absolute figure but the *shape* — heavy fan-out, read-dominated,
> and cleanly partitionable by workspace. Those three properties hold at 10K
> users and at 100M, and they're what I'm actually designing against."

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
 │ presence + │        │ of truth,  │        │  async index │
 │ sessions   │        │ sharded)   │        │              │
 └────────────┘        └────────────┘        └──────────────┘
```

Gateways are interchangeable: any user can land on any gateway because the gateway holds no channel-membership state — it only mirrors one Redis subscription per connected socket. Locally this is a single Express + `ws` process (default port 3001) that can run as instances 3001–3003 sharing one Postgres and Redis; at production scale each box is one of thousands of gateways.

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

### Workspace isolation
Every query is scoped by `workspace_id`, which is the sharding key and the security boundary. Search additionally forces a mandatory `workspace_id` term filter on the ES side so one tenant can never match another tenant's documents even on a shared index.

## 🔧 Deep Dive 2: Real-Time Fan-Out — User-Level Pub/Sub

### The problem
A message to a 1,000-member channel must reach up to 1,000 WebSocket connections spread across many gateways. The gateway that receives the HTTP `POST` almost never holds all 1,000 sockets, so it can't deliver locally.

### The chosen design: fan out once at the service; subscribe per-user at the gateway
Send flow:
1. **Authenticate + rate-limit** the request at the gateway.
2. **Persist** the message to Postgres. This assigns the BIGSERIAL id, which *is* the ordering token, and makes the write durable before anyone is notified.
3. **Resolve recipients** by querying `channel_members` for the target channel's user_ids (cached, see below).
4. **Publish** the serialized message to each recipient's personal Redis channel `user:{userId}:messages`.
5. **Enqueue** the message for asynchronous Elasticsearch indexing.
6. **Return** 200 to the sender with the persisted message (including its id).

Gateway side:
1. On WebSocket connect, authenticate and open **one** Redis subscriber on `user:{userId}:messages`.
2. Every payload received on that channel is forwarded verbatim to the socket.
3. On disconnect, unsubscribe and disconnect the subscriber; update presence.

The gateway never learns channel membership — it's a dumb pipe between one Redis channel and one socket.

### Why user-level, not channel-level pub/sub

| Approach | Pros | Cons |
|----------|------|------|
| ✅ User-level (`user:{id}:messages`) | Gateway is trivial and stateless; exact targeting; presence/typing/DMs reuse the same channel | More Redis channels (one per online user) |
| ❌ Channel-level (`channel:{id}`) | Fewer channels | Every gateway must subscribe to every channel any of its sockets cares about, then filter by membership on each message |

> "Channel-level pub/sub breaks at exactly the scale we care about. If a gateway holds 10K sockets spanning 50K distinct channels, it must maintain 50K subscriptions and, worse, it re-derives 'who on this box is in this channel' for every published message — that membership filter is per-message work on the hot path. User-level pub/sub moves the fan-out to the message service, which does it once against an index we already have. The cost is more Redis subscriptions, but a subscription is cheap and Redis pub/sub sustains ~100K messages/sec on a single node, covering our 50K/s peak with headroom. What I give up is durability: pub/sub is fire-and-forget, so a momentarily disconnected socket misses the push. That's acceptable because Postgres is the source of truth — on reconnect the client pulls history since its last seen id and the missed message is simply read from the DB."

### Connection routing and cross-instance delivery
Which gateway serves which user is tracked in a Redis hash (`connections`) mapping `user_id → gateway_id` with a 1-hour TTL, so a crashed gateway self-evicts. This isn't needed for normal channel delivery (that's pure pub/sub), but it enables targeted server-initiated pushes and lets us detect duplicate sessions across devices.

## 🔧 Deep Dive 3: Threading, Presence, and DMs Without New Infrastructure

### Threading as a message attribute
A reply is just a message with `thread_ts` = parent id. Sending a reply runs in one transaction:
1. Insert the reply as a new message with `thread_ts` = parent id.
2. `UPDATE messages SET reply_count = reply_count + 1 WHERE id = parent`.
3. Fan the reply out on the same pub/sub path as any message.

Reading a thread: fetch the parent by id, then `SELECT * FROM messages WHERE thread_ts = parent ORDER BY created_at`, paginated.

> "A separate `threads` table would normalize the reply count but forces two delivery paths — 'is this a channel message or a thread message?' — and a join on every read. Treating a reply as a message means it travels the exact same persist → fan-out pipeline; the only extra work is the atomic counter bump, which the transaction already guarantees. The denormalized `reply_count` can theoretically drift, but since it's only ever changed inside the same transaction as the insert, it can't."

### Presence via Redis TTL, with a fan-out guard
1. **Heartbeat** (~every 30s): set `presence:{workspaceId}:{userId}` with a 60s TTL holding status + last-seen.
2. **Is online?**: a single key-existence check.
3. **List online users**: `SCAN` the `presence:{workspaceId}:*` pattern in batches (never `KEYS`, which blocks).
4. **Auto-cleanup**: no cron — a crashed client's key simply expires.

> "The trap is presence fan-out. Naively, every presence flip broadcasts to the whole workspace — in a 100K-user workspace that's 100K pushes for one person going idle, and presence flips constantly. So I only notify users who actually share a channel with the person changing state: look up their channels, take the distinct members, publish to those. Most large-workspace users share no channels, so this collapses the fan-out by orders of magnitude. The cost is a membership query per presence change, which is cheap and cached."

### Direct messages
DMs are a `direct_messages` conversation plus a `direct_message_members` join. Creating a DM is idempotent — "create or get existing" — so re-opening a conversation never forks it. Delivery reuses the same `user:{id}:messages` pub/sub path, so no separate real-time channel is needed for DMs vs channel messages.

## 🔎 Deep Dive 4: Search — Elasticsearch Primary, Postgres Fallback

Search is the feature most likely to be treated as an afterthought and most
likely to embarrass you in production, so I want to be specific about how it
fails, not just how it works.

```
              ┌──────────────────────────────────────────────┐
  send ──────▶│ 1. INSERT INTO messages          (Postgres)  │──▶ durable, ordered
              │ 2. enqueue index job             (async)     │
              └──────────────────────────────────────────────┘
                                  │
                                  ▼
                        ┌──────────────────┐
                        │  Elasticsearch   │  BM25 + highlighting
                        └──────────────────┘
                                  │
   GET /api/search ───────────────┤
                                  │  on transport error
                                  ▼
                        ┌──────────────────┐
                        │ Postgres GIN FTS │  to_tsvector / plainto_tsquery
                        └──────────────────┘
```

### Why two systems instead of one

> "Postgres full-text search alone would be simpler to operate — one datastore,
> no index lag, no second thing to monitor. I rejected it because ranking is the
> whole product here. A search for 'deploy' in a workspace with five years of
> history returns thousands of matches, and `ts_rank` scores them by term
> frequency in a single document. It has no corpus-level view, so a message
> that says 'deploy deploy deploy' outranks the actual deploy runbook.
> Elasticsearch's BM25 accounts for document length and inverse document
> frequency, which is what makes the top five results usable. I also get
> highlighting for free, and highlighting is what lets someone scan results
> without opening each one."

> "Elasticsearch alone was the other option, and it's the one I'd push back on
> hardest in review. ES is a search index, not a database — it has no
> transactions, and a lost shard means lost messages. Keeping Postgres as the
> source of truth means the worst ES failure is 'search is degraded', never
> 'messages are gone'. That's the entire reason indexing is asynchronous: the
> send path must not be able to fail because a search cluster is unhealthy."

### What indexing asynchronously actually costs

The index is a few seconds behind the database. Concretely: someone posts a
message and immediately searches for it, and it isn't there. That's a real,
user-visible inconsistency, and it's the price of never letting the search tier
add latency to a send. I consider it the right trade because sends outnumber
searches by a wide margin and a slow send is felt by everyone in the channel,
while a two-second index lag is felt only by the rare person who searches for
something they just wrote.

### The fallback covers less than it looks like it does

This is the part worth being honest about in an interview. The fallback
triggers on a **transport error** — ES unreachable, connection refused, timeout.
It does not trigger when Elasticsearch is reachable but its index is **empty or
stale**, because from the caller's perspective that's a perfectly successful
query that returned zero hits.

| ES state | Query result | Fallback fires? | User sees |
|----------|--------------|-----------------|-----------|
| Healthy, current | Ranked hits | — | Correct results |
| Unreachable | Transport error | ✅ Yes | Correct results, unranked |
| Reachable, empty index | `0 hits`, HTTP 200 | ❌ No | "No results found" |
| Reachable, lagging | Partial hits | ❌ No | Recent messages missing |

> "The empty-index case is the one that actually bites, and it's more common
> than a cluster outage — it happens after any restore, reindex, or fresh
> environment where messages were loaded into Postgres by a path that didn't go
> through the send handler. The system reports total health while silently
> answering every query with nothing."

Two mitigations, and I'd want both. First, **reconcile at startup**: on boot,
compare the index document count against the message count and backfill if the
index is empty, so a restored database becomes searchable without manual
intervention. Second, **treat a zero-hit response as suspicious rather than
authoritative** when the corpus is known to be non-empty — a zero-result query
against a workspace with a million messages should fall through to Postgres
rather than being reported as a confident "no results". The general lesson is
that health checks which only test reachability will call an empty index
healthy; the check has to assert on content.

---


## 🔒 Consistency, Idempotency, and Rate Limiting

### Idempotent sends
The send path accepts an idempotency key. On first use it takes a short `SET NX` lock, processes the message, and caches the response in Redis under `idem:{key}` with a 24h TTL. Retries with the same key return the cached response instead of inserting a duplicate.

> "This matters because clients on flaky mobile networks retry aggressively — the socket drops mid-request, the client resends, and without idempotency one tapped message becomes three in the channel. The 24h window comfortably outlives any reasonable retry storm; after that the key expires and the (by then long-delivered) message can't be replayed."

### Ordering
The BIGSERIAL id assigned by Postgres is the single ordering authority. Clients render strictly by id, so even if two pushes race across different sockets, every device converges on the same order without a vector clock.

### Rate limiting (Redis sliding window)
1. `ZREMRANGEBYSCORE` removes entries older than the window.
2. `ZADD` records the current request timestamp.
3. `ZCARD` counts entries in the window; reject if over the limit.
4. `EXPIRE` keeps the key from leaking.
All four run atomically in a `MULTI`. Real limits from the middleware: send 60/min, edit/delete/react 30/min, create-channel 10/min, join-channel 20/min, search 20/min.

### Caching (cache-aside)
Hot lookups — channel members (2-min TTL), user profiles (5-min), workspace settings (10-min) — are read-through Redis and invalidated on write (e.g., delete `channel:{id}:members` when membership changes). This is what keeps the 100:1 read load off Postgres.

## 🛡️ Failure Handling and Degradation

| Failure | Behavior |
|---------|----------|
| **Elasticsearch down** | Search falls back to Postgres GIN FTS; sends unaffected (indexing queue backs up, drains on recovery) |
| **Redis pub/sub down** | New messages still persist to Postgres and are visible on refresh/reconnect; live push pauses until Redis returns |
| **Gateway crash** | Sockets reconnect through the LB to another stateless gateway; the `connections` hash entry expires by TTL |
| **Postgres primary failover** | Promote a replica; writes pause briefly, reads continue on replicas |
| **Client offline** | On reconnect the client requests messages since its last-seen id; the fire-and-forget miss is backfilled from the DB |

The theme: the durable path (persist to Postgres) never depends on the real-time path (Redis/ES), so a fan-out or search outage degrades features rather than losing data.

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
GET    /api/dms | POST /api/dms
GET    /api/search?q=&channel=&user=&from=&to=
WS     /ws?userId=&workspaceId=   (ping / typing / presence up; message / reaction / presence / typing down)
```

## 📈 Scalability — What Breaks First

1. **PostgreSQL write throughput** is the first ceiling (~5K writes/s single node vs 50K/s peak). Shard the `messages` table by `workspace_id` (hash) so a workspace's traffic lands on one shard; workspaces are independent, so cross-shard queries are rare. Read replicas absorb the 100:1 history/unread read load behind PgBouncer.
2. **Redis pub/sub node** saturates next under fan-out. Move to Redis Cluster and shard by a hash of the user id so a user's subscription always resolves to one node.
3. **Gateway connection count** — each box holds ~10K sockets; scale horizontally, they're stateless. Sticky routing isn't required because any gateway can serve any user.
4. **Elasticsearch indexing lag** grows under write spikes; because indexing is async off a queue, this surfaces as "search is a few seconds behind," never as slower sends. Add index nodes / shards to catch up.

### Why not Kafka for the fan-out itself?

Kafka is in this design for notifications, webhooks, and search indexing — the
async work that happens *after* a message is durable. It is deliberately not on
the delivery path.

> "Kafka gives you durability and replay, which sounds like exactly what you'd
> want for message delivery. But consumers pull from partitions, and a chat
> gateway needs a push to a specific socket right now. I'd have to map 100M
> connections onto a partition scheme, and partition count is not something you
> change cheaply — repartitioning to add gateway capacity would be an outage.
> Redis pub/sub is the weaker primitive on purpose: no durability, no replay,
> but the semantics I actually need, which are 'deliver to whoever is listening
> on this channel, immediately.' Durability is Postgres's job, and the reconnect
> backfill is what bridges the two."

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Real-time fan-out | User-level Redis pub/sub | Channel-level pub/sub | Stateless gateways; no per-message membership filter |
| Delivery durability | Fire-and-forget + DB backfill | Persisted per-user queues | Simpler; Postgres already the source of truth |
| Threading | `thread_ts` attribute | Separate threads table | One delivery path, atomic reply_count |
| Search | ES primary + PG FTS fallback | ES only / PG only | ACID truth in PG, BM25 relevance in ES |
| Presence | Redis TTL + shared-channel fan-out | Broadcast to whole workspace | Auto-cleanup; avoids 100K-push storms |
| Message id | BIGSERIAL | UUID | Dense time-ordered index, cheap ordering |
| Sharding key | workspace_id | user_id / channel_id | Matches the isolation boundary; keeps a tenant on one shard |

## 🚀 Future Work

Per-workspace retention policies (auto-expire old messages), tiered rate limits by pricing plan, an admin audit log for compliance, a Kafka-backed async pipeline for notifications/webhooks/indexing (the production design replaces the direct enqueue used locally), read receipts, and multi-region gateways with region-local Redis for global tenants.
