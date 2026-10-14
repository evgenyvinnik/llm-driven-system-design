# Microsoft Teams — Architecture

## System Overview

Microsoft Teams is enterprise chat organized as a hierarchy: an **organization** (the tenant) contains **teams**, teams contain **channels**, and channels hold messages with one-level **threads**, reactions, file attachments and live **presence**. The messaging itself is familiar. Three things make it a real design problem:

1. **Tenant isolation through a four-level hierarchy.** Every level has its own member list, so "can Alice read this message?" depends on her organization, team and channel memberships at once. Getting it wrong leaks one company's conversations to another, which is the failure an enterprise product does not survive.
2. **Real-time delivery across many servers, in order, without gaps.** Tens of millions of devices hold open connections spread over hundreds of gateway servers. Every member of a channel must see its messages in the same order, and a laptop that sleeps through 40 messages must get exactly those 40 when it wakes up, not a refetch of everything and not a silent hole.
3. **Presence at scale.** "Who is online" changes constantly and is watched by everyone, so naive designs either flood the system with heartbeats or show people online hours after they left.

This document describes the production-scale design first. [Implementation Notes](#implementation-notes) describes what the local Express + PostgreSQL + Valkey + MinIO + React implementation actually does.

**Learning goals**

- Modeling a membership hierarchy and checking it on every request without making reads slow.
- Giving every channel a gapless sequence number and using it for ordering, history pagination, deduplication and resume.
- Treating the event log as the source of truth for delivery, with pub/sub only as a fast signal.
- Fanning events out to a gateway tier that holds the connections.
- Presence that expires on its own instead of relying on "user went offline" events.

## Requirements

### Functional requirements

1. Organizations contain teams; teams contain channels. Teams and channels can be private (limited to their own member list).
2. Members post messages, reply in one-level threads, react with emoji, edit and delete their own messages, and attach files.
3. New messages, edits, deletions and reactions appear on every member's open devices within a second.
4. Opening a channel shows the latest messages; scrolling up loads older history.
5. Members see who is online, and unread badges for channels with new activity.
6. Search across the messages a user is allowed to read; mobile push notifications for mentions.

Out of scope here: calls and meetings media (signaling would run on its own service, media through an SFU and TURN relays), shared channels across tenants, bots, and compliance export.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Send acknowledgement | p99 < 300 ms |
| Delivery latency (send to recipients' screens, same region) | p99 < 500 ms |
| Open a channel (newest 50 messages) | p99 < 200 ms server-side |
| Availability of send and receive | 99.99% |
| Durability | An acknowledged message is never lost (synchronous replication) |
| Ordering | All members see a channel's events in one order; reconnecting never leaves gaps |
| Tenant isolation | Zero cross-tenant reads; non-members cannot even learn a private channel exists |
| Presence freshness | Online/offline correct within 60 s; status changes visible within 5 s |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users | 100M daily active, 30M concurrent devices at peak | A dedicated connection tier |
| Messages | 40 per user per day → 4B/day → ~46K/s average, ~150K/s peak | Shard by channel; one shard owns a channel's writes |
| Channel events (messages, edits, reactions) | ~1.5× messages → ~220K/s peak | One ordered log per channel |
| Deliveries | ~20 online recipients per event → ~4.5M pushes/s at peak | Fan out to gateways, not to users one by one |
| Gateway nodes | 30M streams / ~150K per node ≈ 200 nodes (300 with headroom) | Routing table: which node holds which user |
| Message storage | ~1 KB × 4B/day ≈ 4 TB/day, ~1.5 PB/year before replication | Partition by channel; older months on cheaper tiers |
| Event log | 220K/s × ~1 KB, kept 48 hours ≈ 35 TB | Short retention; older gaps resync instead of replaying |
| Presence by client heartbeat | 30M / 30 s = 1M writes/s | Replace with gateway-held connection leases |

Two numbers drive the design: **4.5 million pushes per second**, which is why delivery runs through a separate gateway tier and a routing table instead of every server subscribing to everything, and **one ordered stream per channel**, which is why the shard key is the channel and every write takes the next number in that channel.

### Local Development Scale

One Express process (two or three to exercise cross-instance fan-out), PostgreSQL, Valkey and MinIO, four seeded users, three channels and a few dozen messages. There is no gateway tier, Kafka, search or mobile push locally. Ports and setup are in the [README](./README.md).

## High-Level Architecture

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

1. **Send (1).** The client posts a message with a client-generated `clientMessageId`. The Chat API checks the sender's membership at every level, then, in one transaction on the channel's shard, takes the channel's next sequence number, inserts the message and appends a `new_message` row to the channel's event log. It answers `201` with the message and its `seq`.
2. **Fan out (2).** Change data capture (CDC) streams new event-log rows into Kafka, partitioned by channel so each channel stays in order. Fan-out workers look up which gateway nodes hold the channel's online members and publish one batch per node; each gateway writes the event to its local streams.
3. **Connect and resume (3).** Each device holds one SSE stream to a gateway, opened with the last `seq` it applied for each channel it has loaded. The gateway replays whatever is newer from the event log, then switches to live events. The gateway also records the user's presence and which node holds the connection.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routes `/api/*` and `/events` | Connections | Long-lived streams need idle timeouts above the heartbeat interval |
| Chat API | Writes, history pages, membership checks | Requests (~150K writes/s peak) | Stateless |
| Push Gateway | Holds SSE streams; replay on connect; presence | Open connections (~150K per node) | Stateful only in memory; a lost node means clients reconnect elsewhere |
| PostgreSQL shards | Messages and per-channel event logs (by channel); memberships (by tenant) | Channels, storage | Primary + synchronous replica per shard; read replicas for history and replay |
| Kafka `channel-events` | Durable, ordered copy of every event for consumers | Event rate | Partitioned by channel id; 48 h retention |
| Fan-out workers | Resolve members → gateway nodes, publish batches | Deliveries/s | Stateless; scale with partitions |
| Redis Cluster | Presence, connection registry, `gw:{node}` pub/sub, sessions, rate limits | Connected users | Losing it degrades delivery to replay-on-reconnect, never loses messages |
| Search indexer, notifier | Elasticsearch index per tenant; APNs/FCM pushes for mentions | Event rate | Read Kafka independently, at their own pace |

The Chat API and the gateway tier are separate because their resources are opposite. The Chat API is stateless request/response and scales with traffic; a gateway is a memory-bound process holding 150,000 idle sockets that must stay up through deploys. Splitting them lets a Chat API deploy happen every hour without dropping a single stream.

## Core Components / Request Flows

### Sending a message

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

- **The sequence number.** `next_channel_seq(ch)` is an `UPDATE channels SET last_seq = last_seq + 1 … RETURNING last_seq`. The row lock it takes lasts until the transaction ends, so every write to one channel is serialized and numbers are **gapless** (a rollback hands its number back) and **visible in order** (number 43 cannot be issued before 42 has committed). At chat rates, even a busy channel sees a few writes per second, far below what a single row lock can serialize.
- **The idempotency key.** The client generates `clientMessageId` once per message and reuses it on every retry. A unique index on `(user_id, client_message_id)` turns a retried insert into a conflict; the transaction rolls back (returning the sequence number) and the API answers `200` with the original message. Reusing a key for a different message is a `422`.
- **Threads.** A reply carries `parent_message_id`, which must be a top-level message in the same channel; the database rejects anything else, so threads stay one level deep.
- **Locally,** a `BEFORE INSERT` trigger assigns `seq` to every message from any code path, and the API publishes the event to Redis right after commit instead of relying on CDC and Kafka (see [Implementation Notes](#implementation-notes)).

### Delivering an event

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

- Kafka partitions by channel id, so one worker sees a channel's events in commit order. Workers resolve the channel's members (cached, invalidated by membership events), keep only those online, and look up their gateway node in the connection registry. A 20-person channel produces at most 20 node messages; a 50,000-person announcement channel produces one message per gateway node (about 300), not 50,000.
- Delivery is at least once: a worker that crashes before committing its Kafka offset re-sends a batch. Gateways and clients both drop anything at or below the last `seq` they applied for that channel.
- The client checks every event: `seq = last + 1` is applied; anything lower is a duplicate; anything higher means it missed something, so it reconnects with its cursor and lets the gateway replay.
- A slow client (more than 1 MB of unsent output) is disconnected rather than buffered; it reconnects and resumes from its cursor.

### Reconnecting without losing anything

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

- Laptops sleep, phones switch networks and gateways restart for deploys, so reconnecting is the normal case. The client sends a cursor for every channel it has in memory (usually one to ten); everything else only needs a fresh head `seq` for its unread badge.
- Replay is bounded: a cursor more than 500 events behind, or older than the 48-hour log retention, gets `resync`, and the client reloads the newest history page instead. The history response carries `latestSeq` from the same database snapshot, so the next stream starts exactly where the page ends.
- **Locally,** each open channel has its own stream, so the standard SSE `Last-Event-ID` header is the channel cursor and the browser resends it automatically on reconnect.

### Presence

A gateway already knows which users it holds connections for, so presence does not need client heartbeats. Each gateway keeps a lease key (`gw:{node}:alive`, 30-second TTL, refreshed every 10 seconds) and writes `presence:{user}` only when a user's state changes: first connection, last disconnection, or an explicit status such as Busy. If a gateway dies, its lease expires and its users read as offline within 30 seconds, with no per-user cleanup. Clients subscribe to the presence of the people currently on screen (a member list, a chat header, at most a few hundred), and changes are pushed through the same fan-out path, debounced to one change per user per 10 seconds so a flaky network does not flicker everyone's status.

## Database Schema

### Production schema

Two kinds of shards. **Directory shards** hold memberships, sharded by organization, so the whole membership chain for a request lives on one shard. **Message shards** hold messages, the per-channel counter and the event log, sharded by channel, so a channel's sequence number, messages and events commit in one local transaction.

```sql
-- Directory shard (key: org_id)
CREATE TABLE organizations (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE org_members (
  org_id   UUID REFERENCES organizations(id),
  user_id  UUID NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE teams (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  is_private  BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE team_members (
  team_id  UUID REFERENCES teams(id),
  user_id  UUID NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE channels (
  id          UUID PRIMARY KEY,
  team_id     UUID NOT NULL REFERENCES teams(id),
  org_id      UUID NOT NULL,                         -- denormalized: routes to this shard
  name        TEXT NOT NULL,
  is_private  BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE channel_members (
  channel_id     UUID REFERENCES channels(id),
  user_id        UUID NOT NULL,
  last_read_seq  BIGINT NOT NULL DEFAULT 0,          -- unread = messages after this seq
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_by_user ON channel_members (user_id);

-- Message shard (key: channel_id)
CREATE TABLE channel_heads (
  channel_id  UUID PRIMARY KEY,
  last_seq    BIGINT NOT NULL DEFAULT 0              -- next_channel_seq() increments this row
);
CREATE TABLE messages (
  channel_id         UUID NOT NULL,
  seq                BIGINT NOT NULL,                -- order, history cursor, dedup key
  id                 UUID NOT NULL UNIQUE,
  author_id          UUID NOT NULL,
  parent_seq         BIGINT,                         -- thread root in the same channel
  content            TEXT NOT NULL,
  client_message_id  UUID,                           -- sender's idempotency key
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,                    -- tombstone keeps threads intact
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, seq)
);
CREATE INDEX messages_top_level ON messages (channel_id, seq DESC) WHERE parent_seq IS NULL;
CREATE INDEX messages_thread ON messages (channel_id, parent_seq, seq) WHERE parent_seq IS NOT NULL;
CREATE UNIQUE INDEX messages_client_id ON messages (author_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE reactions (
  channel_id   UUID NOT NULL,
  message_seq  BIGINT NOT NULL,
  user_id      UUID NOT NULL,
  emoji        TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_seq, user_id, emoji)
);

CREATE TABLE channel_events (
  channel_id  UUID NOT NULL,
  seq         BIGINT NOT NULL,
  event_type  TEXT NOT NULL,                         -- new_message, message_edited, ...
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, seq)
) PARTITION BY RANGE (created_at);                   -- hourly partitions, dropped after 48 h
```

Unread counts use `last_read_seq`: a badge is `COUNT(*)` of top-level messages after it, capped with `LIMIT 100` and shown as "99+", which is an index range scan of at most 100 rows instead of a counter that every message would have to increment for every member.

Redis keys: `presence:{user}` (status, set on change), `gw:{node}:alive` (lease), `conn:{user}` (gateway nodes holding the user's streams), `gw:{node}` (pub/sub topic per gateway), `session:{id}`, `rl:{scope}:{id}`.

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql). It is applied by Docker Compose on a fresh volume and by `npm run db:migrate`, and it is re-runnable: an existing database gains the new columns, and its messages are numbered per channel by a one-time backfill.

| Production | Local | Difference |
|------------|-------|------------|
| Directory and message shards | One PostgreSQL database | No sharding; UUID primary keys everywhere |
| `channel_heads.last_seq` | `channels.last_seq` | Same counter, kept on the channel row |
| `messages` keyed `(channel_id, seq)` | `messages` keyed by `id`, unique `(channel_id, seq)` | `seq` is assigned by a `BEFORE INSERT` trigger; replies reference `parent_message_id` |
| `reactions` | `message_reactions` | Keyed by `message_id` |
| `channel_events`, partitioned | `channel_events`, unpartitioned | Same columns; no retention job yet |
| `channel_members.last_read_seq` | `channel_members.last_read_at` | Timestamp; unread badges are not implemented |
| — | `files` | Attachment metadata; bytes live in MinIO |

The counter function, verbatim from `init.sql`:

```sql
CREATE OR REPLACE FUNCTION next_channel_seq(p_channel_id UUID) RETURNS BIGINT AS $$
  UPDATE channels SET last_seq = last_seq + 1 WHERE id = p_channel_id RETURNING last_seq;
$$ LANGUAGE sql;
```

## API Design

### Production API

```
POST   /api/v1/messages                   send; clientMessageId → 201 | 200 replayed | 422 | 404
GET    /api/v1/channels/{id}/messages     ?before=<seq>&limit=50 → {messages, latestSeq, hasMore}
GET    /api/v1/messages/{id}/thread       root + replies, in seq order
PATCH  /api/v1/messages/{id}              edit own message → event message_edited
DELETE /api/v1/messages/{id}              tombstone → event message_deleted
PUT    /api/v1/messages/{id}/reactions/{emoji}     idempotent add; event only if it changed
DELETE /api/v1/messages/{id}/reactions/{emoji}     idempotent remove
GET    /events?cursors=ch1:41,ch2:17      SSE: replay after each cursor, then live; resync if too old
POST   /api/v1/channels/{id}/read         ?seq=<n> sets last_read_seq
GET    /api/v1/orgs/{id}/teams · /teams/{id}/channels · /channels/{id}/members
```

- Every event on the stream carries its channel and `seq`; `seq` is also the history cursor, so "older than" and "newer than" use the same number.
- Errors are `application/problem+json`. Anything the caller cannot see is `404`, never `403`, so ids cannot be probed for private channels or other tenants.
- Rate limits are per user and advertised with `RateLimit` headers.

### Local routes

The local API is mounted under `/api` (no version prefix).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Session auth (cookie) |
| GET, POST | `/api/organizations`, `/:orgId`, `/:orgId/members` | Org list, create, details and members (members only); adding members needs owner/admin |
| GET, POST | `/api/teams?orgId=`, `/:teamId`, `/:teamId/members` | Teams; adding members needs team owner or org owner/admin |
| GET, POST | `/api/channels?teamId=`, `/:channelId`, `/:channelId/members`, `/:channelId/read` | Channels; private ones only for their members |
| GET | `/api/messages?channelId=&before=<seq>&limit=` | History page newest first, plus `latestSeq` and `hasMore` |
| POST, PUT, DELETE | `/api/messages`, `/api/messages/:id`; GET `/:id/thread` | Send (with `clientMessageId`), edit, delete (tombstone), thread |
| POST, DELETE | `/api/reactions` | Add or remove; `changed: false` when nothing changed |
| GET | `/api/sse/:channelId?after=<seq>` | Event stream for one channel; honors `Last-Event-ID` |
| POST, GET | `/api/presence/heartbeat`, `/api/presence/channel/:id` | Heartbeat; members with online flags |
| POST, GET | `/api/files`, `/api/files/:id/download`, `/api/files?channelId=` | Upload through the API to MinIO; presigned download |
| GET | `/api/users/search?q=`, `/api/users/:id` | Only people who share an organization with the caller |
| GET | `/api/health`, `/api/health/live`, `/metrics` | Readiness, liveness, Prometheus |

## Key Design Decisions

### 1. A gapless per-channel sequence from a counter row

Every change in a channel takes the next number from that channel's counter row inside the write transaction. The alternatives fail in specific ways. **Timestamps** tie and drift across servers, so two messages written in the same millisecond sort differently on different devices, and "everything after 14:02:07.123" can skip a row. **A database `SEQUENCE` or Snowflake-style id** is unique and roughly ordered, but numbers can commit out of order: id 42's transaction can commit after id 43's, so a reader that saw 43 and moved its cursor past 42 never sees 42. The counter row avoids both because the lock is held until commit: 43 cannot exist until 42 is committed or rolled back. That one number then does four jobs: display order, history cursor, duplicate detection and gap detection. The cost is that writes to a single channel are serialized; at a few writes per second per channel that is invisible, and the busiest announcement channels are read-heavy, not write-heavy.

### 2. The event log is the stream; pub/sub only says "something new"

Every visible change (new, edited or deleted message, reaction added or removed) is appended to `channel_events` in the same transaction as the change itself, so the log can never disagree with the data. Delivery systems (CDC into Kafka in production, Redis pub/sub locally) are allowed to lose, duplicate or reorder events, because anything they get wrong is repaired from the log: duplicates are dropped by `seq`, gaps are filled by reading the missing range, and a reconnecting client replays from its cursor. Treating pub/sub as the source of truth fails silently: Redis pub/sub is at-most-once, so an instance restarting during a publish leaves its clients permanently missing that message, with nothing to reveal it until someone reloads. The cost is a second write per change and a log to prune; a 48-hour window keeps it to about 35 TB at peak scale.

### 3. REST for writes, Server-Sent Events for pushes

Sending a message is a request that needs a real answer: an idempotency key, a status code, validation errors, rate limiting. HTTP already has all of these. Over a WebSocket, "send" becomes a frame with no status, so the protocol has to reinvent acknowledgements, correlation ids and error types. The traffic is also lopsided: a member of busy channels receives hundreds of events for every one they send. SSE carries exactly that shape, works through corporate proxies as plain HTTP, and reconnects automatically while resending `Last-Event-ID`. What it costs: client-originated signals (typing, read position) become small POSTs, and browsers allow only about six HTTP/1.1 connections per origin, which HTTP/2 multiplexing removes. WebSocket would win for call and meeting signaling, where both sides talk constantly; that belongs to the meetings service, not the chat path.

### 4. Fan out by routing to gateways, not by subscribing to channels

With one stream per device carrying all of a user's channels, a gateway holding 150,000 users would need subscriptions to every channel any of them belongs to, millions per node, with heavy churn as people connect and disconnect. Writing every event into a per-user inbox (fan-out on write) costs one write per recipient: 4.5M writes per second, and 50,000 for a single announcement. Routing resolves each event to the gateway nodes that hold its members and sends one batch per node, so the cost per event is bounded by the number of gateway nodes. The price is a connection registry that must stay accurate: a stale entry sends a batch to a node that no longer holds the user, which is harmless (the event is dropped there) because the user's own reconnect replays from the log.

### 5. Authorization walks the whole chain on every request

A message is readable only if the user is a member of the organization and, for private teams or channels, of that team or channel. The check walks org, team and channel in one indexed query on the tenant's directory shard and runs on every request; anything that fails answers `404`. The tempting alternative is to materialize "effective permissions per user per channel" for one-lookup reads. Its failure mode is the problem: a missed invalidation becomes a silent cross-tenant leak that lasts until someone notices. A slow chain walk shows up on a latency graph; a stale permission shows up in a customer's incident report. Only the slow-changing half, a user's organization memberships, is cached (60-second TTL), and membership removals also push a "close stream" message to the gateways holding that user.

### 6. Presence from connection leases, not client heartbeats

Client heartbeats every 30 seconds cost 1M writes per second at 30M devices, and they still mark users online for up to a minute after a laptop lid closes. The gateway already holds the connection, so it is the authority: per-node leases make a dead node's users go offline together, and per-user writes happen only on state changes. The trade-off is that presence now depends on the gateway tier being healthy, and the 30-second lease still bounds how fast a crashed node's users appear offline.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Send message | At most one message per client send, even across retries | `clientMessageId` + unique `(author, key)`; retry returns the original; different body → `422` |
| Per-channel order | Everyone sees one order | Counter row locked until commit; gapless `seq` |
| Delivery | Every event reaches every connected member exactly once in effect | At-least-once transport; drop `seq <= last`; replay gaps from the log |
| History + stream | No gap or overlap between the first page and the stream | Page and `latestSeq` read in one snapshot; stream starts after `latestSeq` |
| Reactions | Count equals the set of reactors | Unique `(message, user, emoji)`; event only when a row changed; clients apply as a set |
| Edit/delete | Converge on every device | Logged events; deletes are tombstones, so replies keep their root |
| Membership adds | Repeatable | `ON CONFLICT DO NOTHING` on the primary key |

## Security / Auth

- **Authentication:** SSO (SAML/OIDC) issues a session; the session id lives in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie and is regenerated at login to prevent session fixation.
- **Authorization:** the org → team → channel chain walk on every request and on every stream connect; `404` for anything not visible; role checks for management (org owners/admins add members; team owners manage their team).
- **Tenant directory:** user search and profiles only return people who share an organization with the caller.
- **Rate limits:** per user in Redis (for example 120 messages per minute), so the limit holds across every API instance.
- **Content:** messages render as text, never HTML; attachments are served from a separate domain through short-lived signed URLs; file type and size are checked at upload.
- **Encryption:** TLS everywhere; storage encrypted at rest with per-tenant keys for customers that require them.

## Observability

- **Delivery:** end-to-end delivery latency (commit time to gateway write), Kafka consumer lag per partition, gateway batches per second, events dropped as duplicates, gap fills, `resync` counts by reason. Rising gap fills means the transport is losing events; rising resyncs means clients stay offline longer than the log retention.
- **Writes:** send latency, idempotent replays (`200`) versus creates (`201`), `422` key conflicts, per-channel lock wait time.
- **Connections:** open streams per gateway, connects and disconnects per second, slow clients cut off.
- **Authorization:** `404`s from membership checks per tenant; a spike can mean a client bug or probing.
- Structured logs carry tenant, channel and `seq`, so one message can be traced from insert to every delivery.

## Failure Handling

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Gateway node dies | Streams drop for ~150K users; they reconnect within seconds | Clients reconnect with cursors and replay; lease expiry marks the node's users offline |
| Fan-out worker crash | Brief delay for its partitions | Kafka redelivers from the last offset; duplicates dropped by `seq` |
| Redis pub/sub loses messages | A gateway misses events | Next event exposes the gap, or the periodic head check catches up from the log |
| Message shard primary fails | Sends to its channels fail for seconds | Promote the synchronous replica; clients retry with the same `clientMessageId` |
| Kafka unavailable | Live delivery pauses; sends still succeed | Events wait in the log; gateways replay on reconnect; CDC resumes from its position |
| Client offline for days | Cursor older than retention | `resync`: reload the newest page, badges from head `seq` |
| Slow client | Its own stream only | Cut off above 1 MB of unsent output; reconnects and replays |

## Scalability Considerations

1. **Connections first.** Gateways scale horizontally; capacity planning is streams per node and memory per stream. Deploys drain nodes gradually so clients reconnect in waves rather than all at once.
2. **Message shards** split by channel id; a channel never spans shards, so its sequence stays a local transaction. Hot channels are hot for reads, which read replicas absorb.
3. **Fan-out** scales with Kafka partitions and workers. Huge channels cost one batch per gateway node per event, so an announcement to 100,000 people is ~300 batches.
4. **Directory shards** split by tenant. The largest tenants (hundreds of thousands of users) get dedicated shards.
5. **History storage** tiers by age: recent months on primary storage, older ones on cheaper storage behind the same history API.
6. **Multi-region:** a tenant has a home region where its channels' shards live; other regions run gateways that forward writes home and receive events from it.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ordering | Per-channel counter row | Timestamps, SEQUENCE, Snowflake ids | Gapless and commit-ordered, so cursors never skip |
| Source of truth for delivery | Event log written in the write transaction | Pub/sub messages | Transport can lose or reorder; the log repairs it |
| Transport | REST writes + SSE pushes | WebSocket for both | Status codes and idempotency for writes; push-only stream |
| Fan-out | Route batches to gateway nodes | Channel subscriptions per node; per-user inboxes | Cost bounded by gateway count, not audience size |
| Resume | Cursor per loaded channel, bounded replay | Refetch on reconnect | No gaps, no full reloads after short disconnects |
| Authorization | Chain walk per request, `404` | Materialized permissions | Stale permissions leak silently; slow checks are visible |
| Presence | Gateway leases, change-only writes | Client heartbeats | 1M writes/s avoided; dead nodes expire together |
| Unread badges | Range count after `last_read_seq`, capped | Counter per member per message | One write per read instead of one per member per message |
| Sharding | Messages by channel; directory by tenant | Shard by user | Keeps a channel's writes and a tenant's checks local |

## Implementation Notes

### What runs locally

[The entry point](./backend/src/index.ts) starts one Express process ([`app.ts`](./backend/src/app.ts)) that serves the REST API and the SSE streams on port 3001 (`npm run dev:server2` and `dev:server3` start more instances on 3002 and 3003). Docker Compose provides PostgreSQL 16, Valkey 7 and MinIO. The frontend is React 19 with TanStack Router and Zustand on port 5173, proxying `/api` to 3001. Seeded logins are `alice`, `bob`, `carol` and `dave`, all with `password123`.

### Production patterns implemented

**Hierarchy authorization on every route.** [`services/access.ts`](./backend/src/services/access.ts) walks org → team → channel for the caller in one query (an inner join on `org_members` is the tenant check), and [`middleware/access.ts`](./backend/src/middleware/access.ts) applies it to every channel- or message-scoped route, the SSE stream included. Private teams and channels need their own membership; management routes check roles from an allowlist; user search and profiles are limited to people who share an organization. Login and registration regenerate the session id.

```typescript
router.get('/:channelId', requireAuth, requireChannelAccess((req) => req.params.channelId), …)
// no row from the chain walk, or a private level the user is not on -> 404 'Channel not found'
```

**Per-channel sequence and event log.** `init.sql` defines `next_channel_seq()` and a `BEFORE INSERT` trigger that numbers every message and enforces one-level threads. Message creates, edits, soft deletes and reaction changes append to `channel_events` in the same transaction ([`messageService.ts`](./backend/src/services/messageService.ts), [`reactionService.ts`](./backend/src/services/reactionService.ts), [`channelEvents.ts`](./backend/src/services/channelEvents.ts)). A no-op (duplicate send, reaction already present) rolls back so its number is handed back.

**Ordered, resumable SSE.** [`sseService.ts`](./backend/src/services/sseService.ts) keeps one stream per channel per instance and serializes replay and delivery through a per-channel queue. A client opens `/api/sse/:channelId?after=<latestSeq>`; on reconnect the browser's `Last-Event-ID` takes over. The instance replays up to 500 events from the log, drops duplicates by `seq`, fills gaps from the log when pub/sub delivers out of order, and sends `resync` when the range was never logged or is too long. It subscribes to a channel's Redis topic on the first local viewer and unsubscribes after the last, checks committed heads every 15 seconds to recover lost publishes, cuts off clients with more than 1 MB buffered, and ends all streams on `SIGTERM` so clients resume on another instance.

**Idempotent sends and snapshot-consistent history.** `POST /api/messages` takes `clientMessageId`; a repeat returns the original with `200` and `Idempotent-Replayed: true`, a reused key with different content returns `422`. History pages are keyset-paginated by `seq` and read together with `latestSeq` in one `REPEATABLE READ` transaction.

**Distributed rate limits.** [`rateLimiter.ts`](./backend/src/services/rateLimiter.ts) stores counters in Redis (`rate-limit-redis`), keyed per user when signed in, and fails open if Redis is down.

**Client consistency.** The [chat store](./frontend/src/stores/chatStore.ts) loads the history page, then opens the stream from its `latestSeq`; it applies an event only if `seq` is exactly the next one, reopens the stream from its cursor on a gap, reloads on `resync`, and ignores responses for channels the user has already left. Sends appear immediately as pending rows that the server copy replaces by `clientMessageId` (with a Retry button on failure), and reactions toggle optimistically and apply as sets ([`messageReducers.ts`](./frontend/src/stores/messageReducers.ts)).

**Operations.** Prometheus metrics for HTTP routes (recorded by [`middleware/httpMetrics.ts`](./backend/src/middleware/httpMetrics.ts)), SSE delivery, replays, resyncs, gap fills and publish failures; Pino structured logs; `/api/health` (readiness: database and Redis) and `/api/health/live`.

**Tests.** Backend vitest covers the access rules, the stream manager (replay, duplicates, gap fill, resync, subscribe/unsubscribe, head check, failed publish) and the message routes (idempotency, `404`, keyset parameters). Frontend vitest covers the event reducers.

### Simplified or substituted

- **One stream per open channel** instead of one multiplexed stream per device, so `Last-Event-ID` is simply the channel cursor. Channels that are not open get no live updates or badges.
- **Redis pub/sub from the API process** instead of CDC → Kafka → fan-out workers → gateways; the API instances are also the gateways. The event log plus the head check stand in for Kafka's durability.
- **Client heartbeats for presence** (`POST /api/presence/heartbeat` every 30 s, `SETEX presence:{user} 60`) instead of gateway leases; presence is read when the member list opens and is not pushed.
- **One PostgreSQL database**, MinIO for S3, session cookies instead of SSO, uploads relayed through the API (multer memory storage, 50 MB cap) with presigned downloads.

### Omitted

Kafka, fan-out workers, search, mobile notifications, unread badges and mentions, typing indicators (the `TypingIndicator` component has no backend), calls and meetings, multi-region, sharding, and retention for `channel_events`.

### Known limitations

- Access is checked when a stream opens; there are no remove-member endpoints, and a removal made directly in the database would not close an open stream.
- `channel_events` grows without bound; once a retention job exists, older cursors resync rather than replay.
- A crash between commit and publish delays delivery to other instances until the channel's next event or the next head check (at most about 15 seconds).
- Edit and delete exist only in the API. Uploaded files are not linked to a message in the UI (`FileAttachment` is unused); the composer posts `[File: name]` as text.
- `multer` buffers an upload before the channel access check, because `channelId` arrives as a multipart field.
- Pending sends are kept in memory only; a reload loses unsent messages.
- `services/circuitBreaker.ts` exists but nothing uses it.
