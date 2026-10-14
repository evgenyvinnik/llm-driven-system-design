# 💬 Microsoft Teams — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Chat looks like insert a row, push it to everyone. Two things make Teams hard. First, every message lives four levels deep (organization, team, channel, thread), and one wrong membership check shows a company's conversations to another company. Second, 30 million devices are connected to hundreds of different servers, and every one of them must see a channel's messages in the same order with no holes, including the laptop that slept through forty of them. My answer to the second problem is one number: a gapless sequence per channel."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the 4.5M pushes per second |
| High-level architecture | 10 min | One overview and the send, deliver and resume flows |
| Data model & API | 7 min | Shard keys, the event log, the contract |
| Deep dive 1: ordering and resume | 8 min | Why a counter row, and how a client never misses anything |
| Deep dive 2: fan-out and presence | 8 min | Getting one event to the right sockets on 300 gateways |
| Deep dive 3: permissions | 4 min | Checking four levels on every request without leaking |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because Teams is chat, meetings, files and an app platform at once."

### Functional requirements

1. **Hierarchy:** organizations contain teams, teams contain channels; teams and channels can be private.
2. **Messaging:** post, reply in one-level threads, react, edit and delete your own messages, attach files.
3. **Real time:** new messages, edits, deletions and reactions reach every member's open devices within a second.
4. **History:** opening a channel shows the latest messages; scrolling loads older ones.
5. **Presence and unread:** who is online, and unread badges for channels with new activity.

Out of scope: calls and meetings media (a separate service with an SFU), shared channels across tenants, bots, compliance export. I'll mention search and mobile push only as consumers of the event stream.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Send acknowledgement | p99 < 300 ms | The sender is waiting on it |
| Delivery to recipients | p99 < 500 ms in region | Conversation feels live below about half a second |
| Open a channel | p99 < 200 ms for 50 messages | The most frequent read |
| Availability | 99.99% for send and receive | Work stops when chat stops |
| Durability | No acknowledged message is ever lost | Messages are business records |
| Ordering | One order per channel; no gaps after reconnects | Replies that appear before their question break trust |
| Isolation | Zero cross-tenant reads | The failure the product does not survive |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users | 100M daily active, 30M devices connected at peak | A dedicated connection tier |
| Messages | 40/user/day → 4B/day → ~46K/s average, ~150K/s peak | Shard by channel |
| Events (messages, edits, reactions) | ~1.5× messages → ~220K/s peak | An ordered log per channel |
| Pushes | ~20 online recipients per event → ~4.5M/s peak | Fan out per gateway node, not per user |
| Gateways | 30M streams ÷ ~150K per node ≈ 200 nodes, 300 with headroom | A routing table: user → node |
| Storage | ~1 KB × 4B/day ≈ 4 TB/day, ~1.5 PB/year | Partitioning and storage tiers by age |
| Presence by client heartbeat | 30M ÷ 30 s = 1M writes/s | Let the gateway own presence instead |

"The two numbers I'll design around: 4.5 million pushes per second, which rules out every server subscribing to everything, and the fact that order is per channel, not global, which tells me my shard key."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys that matter: sending, fanning out, and reconnecting."

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Teams clients · web, desktop, mobile · one event stream per device                       │
  └───────┬───────────────────────────────────────────────────────────────────┬──────────────┘
          │ (1) POST /api/v1/messages              (3) GET /events?cursors=…  │
          ▼                                                   SSE, held open  ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · /api/* to Chat API · /events to Push Gateway                       │
  └───────┬───────────────────────────────────────────────────────────────────┬──────────────┘
          ▼                                                                   ▼
  ┌────────────────────┐                                      ┌──────────────────────────────┐
  │ Chat API           │                                      │ Push Gateway                 │
  │ writes · history   │                                      │ holds SSE streams            │
  │ access checks      │                                      │ ~150K per node               │
  └───────┬────────────┘                                      └─┬─────┬──────────────────────┘
          │ access check, then INSERT                           │     │               ▲
          │ message + event in 1 tx                             │     │ presence,     │ events
          ▼                                                     │     │ registry      │ for node
  ┌──────────────────────────────┐                              │     │               │
  │ PostgreSQL shards            │  replay after cursor         │     │               │
  │ messages, events: by channel │◀─────────────────────────────┘     │               │
  │ memberships: by tenant       │                                    ▼               │
  └───────┬──────────────────────┘                                ┌───────────────────┴──────┐
          │                                                       │ Redis Cluster            │
          │ (2) CDC: channel_events                               │ presence · conn registry │
          │                                                       │ gw:{node} pub/sub        │
          │                                                       └──────────────────────────┘
          │                                                                   ▲
          ▼                                                                   │ look up, publish
  ┌──────────────────────┐                                                    │
  │ Kafka                │    consume, in order per channel       ┌───────────┴──────────────┐
  │ channel-events by ch │───────────────────────────────────────▶│ Fan-out workers          │
  └───────┬──────────────┘                                        │ route events to gateways │
          │ consume                                               └──────────────────────────┘
          ▼
  ┌──────────────────────┐
  │ Search indexer       │
  │ mobile push notifier │
  └──────────────────────┘
```

1. **Send (1).** The client posts with a `clientMessageId` it generated. The Chat API checks membership at all four levels, then in one transaction on the channel's shard takes the channel's next sequence number, inserts the message and appends an event row. It answers `201` with the message and its `seq`.
2. **Fan out (2).** Change data capture streams the event row into Kafka, partitioned by channel. Fan-out workers look up which gateway nodes hold the channel's online members and publish one batch per node; each gateway writes the event to its local streams.
3. **Connect and resume (3).** Every device keeps one SSE stream to a gateway, opened with the last `seq` it applied for each channel it has loaded. The gateway replays what's newer from the event log, then switches to live events, and records the user's presence and node.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routes `/api/*` and `/events` | Connections | Idle timeout above the heartbeat |
| Chat API | Writes, history, membership checks | Requests | Stateless |
| Push Gateway | SSE streams, replay, presence | Open connections (~150K/node) | In-memory state only |
| PostgreSQL shards | Messages + event log by channel; memberships by tenant | Channels, tenants | Synchronous replica per shard |
| Kafka `channel-events` | Durable ordered copy of every event | Event rate | Keyed by channel id, 48 h retention |
| Fan-out workers | Members → gateway nodes → batches | Pushes/s | Stateless |
| Redis Cluster | Presence, connection registry, per-node pub/sub | Connected users | Losing it delays delivery, never loses data |
| Search indexer, notifier | Search index, mobile pushes | Event rate | Independent Kafka consumers |

"Why separate the gateway from the Chat API? A gateway is a memory-bound process holding 150,000 mostly idle sockets that must survive deploys; the API is stateless request/response that I want to deploy hourly. Splitting them means an API deploy never drops a stream."

### Flow 1: sending a message

```
Alice's client                            Chat API                                 PostgreSQL
       │                                      │                                         │
       │ 1 POST /messages, clientMessageId K  │                                         │
       │─────────────────────────────────────▶│                                         │
       │                                      │ 2 check org, team, channel membership   │
       │                                      │ 3 BEGIN; next_channel_seq(ch) = 42      │
       │                                      │────────────────────────────────────────▶│
       │                                      │ 4 INSERT message ON CONFLICT (user, K)  │
       │                                      │────────────────────────────────────────▶│
       │                                      │ 5 INSERT event (ch, 42); COMMIT         │
       │                                      │────────────────────────────────────────▶│
       │ 6 201 {message, seq: 42}             │                                         │
       │◀─────────────────────────────────────│                                         │
       ················· response lost; client retries with the same K ··················
       │ 7 POST /messages, clientMessageId K  │                                         │
       │─────────────────────────────────────▶│                                         │
       │                                      │ 8 conflict on (user, K): ROLLBACK       │
       │                                      │────────────────────────────────────────▶│
       │ 9 200 original message               │                                         │
       │◀─────────────────────────────────────│                                         │
       │                                      │                                         │
```

"Step 3 is the heart of the design: `next_channel_seq` increments the channel's counter row and holds that row's lock until commit. Steps 7 to 9 are the retry: the response was lost, the client sends the same key, the unique index on (user, key) turns the insert into a conflict, the transaction rolls back so the sequence number goes back unused, and the client gets the original message. A reused key with different text gets `422`."

### Flow 2: delivering an event

```
PostgreSQL           Kafka           Fan-out worker               Gateway                     Bob
     │                 │                    │                        │                         │
     │ 1 CDC (ch, 42)  │                    │                        │                         │
     │────────────────▶│                    │                        │                         │
     │                 │ 2 event, key = ch  │                        │                         │
     │                 │───────────────────▶│                        │                         │
     │                 │                    │ 3 Redis: gateways of members                     │
     │                 │                    │ 4 batch for this node  │                         │
     │                 │                    │───────────────────────▶│                         │
     │                 │             5 drop duplicates by (ch, seq)  │                         │
     │                 │                    │                        │ 6 id ch:42 new_message  │
     │                 │                    │                        │────────────────────────▶│
     │                 │                    │                        │ 7 42 = last + 1: apply  │
     │                 │                    │                        │                         │
```

"Kafka keeps a channel's events in order because the key is the channel id. Delivery is at least once, so step 5 drops anything at or below the last `seq` the gateway sent, and step 7 is the client applying an event only if it's exactly the next number."

### Flow 3: reconnecting

```
Bob's client                              Gateway            Event log (PostgreSQL)
      │                                      │                          │
      │ 1 reconnect, cursors {ch: 39}        │                          │
      │─────────────────────────────────────▶│                          │
      │                                      │ 2 head(ch) = 42          │
      │                                      │─────────────────────────▶│
      │                                      │ 3 events ch, seq 40..42  │
      │                                      │─────────────────────────▶│
      │ 4 replay 40, 41, 42 in order         │                          │
      │◀─────────────────────────────────────│                          │
      │ 5 live events from 43                │                          │
      │◀─────────────────────────────────────│                          │
      ······ cursor older than retention, or more than 500 behind ·······
      │ 6 resync {latestSeq}                 │                          │
      │◀─────────────────────────────────────│                          │
      │ 7 reconnect after reloading history  │                          │
      │─────────────────────────────────────▶│                          │
      │                                      │                          │
```

"Reconnecting is the normal case: laptops sleep, phones switch networks, gateways restart for deploys. The client sends its cursor for each channel it has in memory, and the gateway replays the gap from the log. Replay is capped at 500 events and 48 hours; past that the client reloads the newest page instead."

---

## 💾 Data Model (4 min)

"Two shard keys. Message data is sharded by **channel**, so a channel's counter, messages and events commit in one local transaction. Membership data is sharded by **tenant**, so the whole authorization chain for a request lives on one shard."

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| Directory shard | `org_members`, `team_members` | (org or team, user), role | Roles: owner, admin, member |
| Directory shard | `channels` | id, team_id, org_id, is_private | org_id denormalized for routing |
| Directory shard | `channel_members` | (channel, user), `last_read_seq` | Index by user for "my channels" |
| Message shard | `channel_heads` | channel_id, `last_seq` | The counter row |
| Message shard | `messages` | PK (channel_id, seq); id; author; parent_seq; content; client_message_id; edited_at; deleted_at | Unique (author, client_message_id); partial index on top-level messages |
| Message shard | `channel_events` | PK (channel_id, seq); type; payload | Same transaction as the change; hourly partitions dropped after 48 h |
| Message shard | `reactions` | PK (channel, message_seq, user, emoji) | The key makes a repeat add a no-op |
| Redis | `presence:{user}`, `gw:{node}:alive`, `conn:{user}` | status; 30 s lease; node ids | Presence and routing |

"Two details matter. **Deletes are tombstones**: a deleted thread root keeps its replies, and the deletion is itself an event. **Unread badges** come from `last_read_seq`: the badge is a count of top-level messages after it, capped at 100 and shown as '99+'. That's an index range scan of at most 100 rows. The alternative, a counter per member incremented on every message, turns one message in a 10,000-person channel into 10,000 writes."

"Why PostgreSQL rather than Cassandra for messages? The access pattern is partition plus range, which Cassandra handles well. But the sequence has to be gapless and commit-ordered, and in Cassandra that means a lightweight transaction (a Paxos round) per message. In a sharded PostgreSQL the counter row, the message and the event are one local transaction."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/messages                      send; clientMessageId → 201 | 200 replayed | 422 | 404
GET    /api/v1/channels/{id}/messages        ?before=<seq>&limit=50 → {messages, latestSeq, hasMore}
GET    /api/v1/messages/{id}/thread          root and replies in seq order
PATCH  /api/v1/messages/{id}                 edit own → event message_edited
DELETE /api/v1/messages/{id}                 tombstone → event message_deleted
PUT    /api/v1/messages/{id}/reactions/{e}   idempotent add; event only if it changed
DELETE /api/v1/messages/{id}/reactions/{e}   idempotent remove
GET    /events?cursors=ch1:41,ch2:17         SSE: replay after each cursor, then live
POST   /api/v1/channels/{id}/read            ?seq=<n> → last_read_seq
```

- **`clientMessageId` is the idempotency key.** Sending is not naturally idempotent, so the client says which requests are retries. Same key and same body returns the original; same key, different body is `422`.
- **One number for both directions.** `before=<seq>` pages backwards through history; the stream's cursor moves forward. `latestSeq` in the history response, read in the same snapshot as the page, is where the stream starts.
- **`404`, never `403`,** for anything the caller can't see, so nobody can probe ids to learn that a private channel exists.
- **Errors** are `application/problem+json`; rate limits are per user, in Redis, advertised with `RateLimit` headers.
- **REST for writes, SSE for pushes.** Writes need status codes, idempotency and rate limits, which HTTP already has; the push side carries hundreds of events for every one a user sends. WebSocket would win for meeting signaling, which lives in a different service.

---

## 🔧 Deep Dive 1: One Number per Channel (8 min)

"Ordering, history pagination, duplicate detection and resume all reduce to one question: how do I number a channel's events?"

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Timestamps | Order by `created_at` | Ties within a millisecond; clock skew between servers; "after 14:02:07.123" can skip a row |
| ❌ `SEQUENCE` or Snowflake ids | Unique, roughly increasing ids | Can commit out of order: id 43 visible before 42, so a cursor at 43 never sees 42 |
| ❌ Global log offset | One Kafka partition for everything | A single partition can't take 220K events/s, and order across channels is useless anyway |
| ✅ Counter row per channel | Increment inside the write transaction; lock held to commit | Writes to one channel are serialized |

**Why it works.** Incrementing the channel's counter row takes its lock, and the lock lasts until commit. So number 43 cannot be issued until the transaction holding 42 has committed or rolled back. If it rolled back, the counter goes back too and the next writer gets 42. Numbers are **gapless** and become **visible in order**. That gives me four guarantees for the price of one row:

1. **Order:** every device sorts by `seq`, so everyone sees the same sequence.
2. **History:** `before=<seq>` is a keyset cursor; page 500 is as cheap as page 1, and there are no ties to skip.
3. **Duplicates:** at-least-once delivery is safe because anything at or below the last applied `seq` is dropped.
4. **Gaps:** a client that receives 45 when it last applied 43 knows it missed exactly one event, and asks for it.

**The event log is the stream.** Every visible change, including edits, deletions and reactions, is appended to `channel_events` in the same transaction, with its own `seq`. CDC and Kafka only carry it. If a transport loses, duplicates or reorders something, the log repairs it; pub/sub as the source of truth fails silently, because Redis pub/sub is at-most-once and an instance restarting mid-publish just never delivers that message.

**Resume.** A client keeps a cursor per channel it has loaded. On reconnect it sends those cursors; the gateway reads the head, replays the missing range from the log (at most 500 events), then goes live. A cursor older than the log's 48-hour retention gets `resync`, and the client reloads the newest page. The first page and the stream meet exactly, because the history response returns `latestSeq` from the same snapshot as the page.

**What I give up.** Writes to a single channel are serialized on one row lock: a few hundred per second per channel at most. Real channels see a few per second, and the giant ones (company announcements) are read-heavy, not write-heavy. I also pay a second write per change for the event row, and 48 hours of log, about 35 TB at peak.

> "The repository builds exactly this locally: a `BEFORE INSERT` trigger numbers every message, the event log is written in the same transaction, and each SSE stream resumes from `Last-Event-ID`."

---

## 🔧 Deep Dive 2: Fan-Out and Presence (8 min)

"4.5 million pushes per second, from events produced on message shards to sockets spread over 300 gateways. The question is how an event finds its sockets."

| Approach | Cost per event | Where it breaks |
|----------|----------------|-----------------|
| ❌ Every gateway subscribes to every channel its users are in | Free per event | 150K users × ~100 channels = millions of subscriptions per node, churning on every connect |
| ❌ Per-user inbox (fan-out on write) | One write per recipient | 4.5M writes/s; one announcement to 50K people = 50K writes |
| ✅ Route to gateway nodes | One batch per node with members online | Needs an accurate connection registry |

**How routing works.** When a device connects, its gateway records `conn:{user} → node` in Redis. A fan-out worker consuming a channel's partition resolves the channel's members (cached, invalidated by membership events), keeps the online ones, groups them by node and publishes one batch per node on that node's topic. A 20-person channel costs at most 20 batches; an announcement to 100,000 people costs one batch per gateway, about 300. The cost is bounded by the number of gateways, not the size of the audience.

**Why the alternatives fail.** Channel subscriptions put the work on connection churn: every reconnect re-subscribes to hundreds of channels, and a deploy that restarts a gateway re-subscribes 150,000 users at once. Inboxes do the work on every message for every member, including members who are offline and will never read the live copy.

**Stale routing is harmless.** If the registry says Bob is on node 7 but he just moved to node 12, node 7 drops the batch. Bob's reconnect to node 12 sent his cursor, and node 12 replayed the gap from the log. Correctness never depends on the registry; only latency does.

**Slow consumers.** A gateway cuts off any client with more than 1 MB of unsent output instead of buffering without limit. The client reconnects and resumes from its cursor.

### Presence without a million heartbeats

Client heartbeats (a POST every 30 seconds) cost 1M writes per second at 30M devices and still show people online for a minute after the lid closes. But the gateway already holds the connection, so it is the authority:

1. Each gateway keeps a lease, `gw:{node}:alive`, with a 30-second TTL.
2. It writes `presence:{user}` only when state changes: first connection, last disconnection, or an explicit status like Busy.
3. If a gateway dies, its lease expires and all its users read as offline within 30 seconds. No per-user cleanup.
4. Clients subscribe to presence only for people on screen (a member list, a chat header), and changes are debounced to one per user per 10 seconds so a flaky network doesn't flicker everyone's status.

"What I give up: presence now depends on the gateway tier, and a crashed node's users take up to 30 seconds to go grey. I'll take that over a million writes a second."

---

## 🔧 Deep Dive 3: Permissions Across Four Levels (4 min)

"The failure that ends this product is one tenant reading another's messages. So the question is where the check lives and what I'm willing to cache."

**The rule.** A user can read a channel if they are in its organization, and in the team if the team is private, and in the channel if the channel is private. Posting uses the same rule; adding members requires an owner or admin role.

**Where it lives.** One indexed query walks org, team and channel for the caller, on the tenant's directory shard, on every request and every stream connect. The organization membership is an inner join, so a user from another tenant gets no row at all, exactly as if the channel didn't exist. Everything that fails answers `404`. Every channel-scoped route goes through one middleware, so a new endpoint can't forget the check.

| Approach | Read cost | Failure mode |
|----------|-----------|--------------|
| ✅ Walk the chain per request | One indexed query, one shard | Slower reads, visible on a latency graph |
| ❌ Materialized effective permissions | One lookup | A missed invalidation is a silent leak that lasts until a customer finds it |

**What I cache.** Only the slow-changing half: a user's organization memberships, for 60 seconds. Removal from a channel or organization also sends a "close stream" message to the gateways holding that user, so an open stream doesn't keep delivering after access ends.

"This isn't a performance decision; it's choosing which mistakes are recoverable. A slow check I fix from a dashboard. A stale permission I learn about from a customer."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** gateway memory and connection churn during deploys (drain nodes in waves); hot message shards (split by channel id; reads move to replicas); fan-out lag during spikes (more partitions and workers); history storage (tier by age).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Gateway node dies | ~150K devices reconnect within seconds | Cursors replay the gap; node lease expires presence |
| Fan-out worker crash | Short delay for its partitions | Kafka redelivers; duplicates dropped by `seq` |
| Pub/sub drops a message | One gateway misses an event | Next event exposes the gap; periodic head check |
| Shard primary fails | Sends fail for seconds | Promote synchronous replica; clients retry with the same key |
| Kafka down | Live delivery pauses; sending still works | Log holds events; replay on reconnect |
| Device offline for days | Cursor past retention | `resync` and reload the newest page |

**What I'd watch:** commit-to-socket delivery latency, Kafka lag per partition, duplicate drops, gap fills, resyncs by reason (rising resyncs mean clients outlive the log retention), streams per gateway, idempotent replays versus creates, and `404`s from membership checks per tenant.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Ordering | Counter row per channel | Timestamps, SEQUENCE ids | Gapless and commit-ordered: cursors never skip |
| Delivery truth | Event log in the write transaction | Pub/sub messages | Transports lose and reorder; the log repairs them |
| Transport | REST writes + SSE pushes | WebSocket both ways | Status codes and idempotency for writes |
| Fan-out | Batches per gateway node | Channel subscriptions, per-user inboxes | Cost bounded by gateway count |
| Resume | Per-channel cursors, bounded replay | Refetch on reconnect | No gaps and no full reloads |
| Permissions | Chain walk per request, `404` | Materialized permissions | Stale permissions leak silently |
| Presence | Gateway leases, change-only writes | Client heartbeats | Avoids 1M writes/s |
| Shard keys | Messages by channel, directory by tenant | By user | Keeps sequences and checks local |

"With more time I'd add per-tenant search with permission filtering at query time, the meetings signaling service, and retention policies per tenant for compliance."
