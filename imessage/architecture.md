# iMessage (Cross-Device Messaging) — Architecture

## System Overview

iMessage delivers end-to-end encrypted messages between people who each own several devices. Two things make it a real design problem. First, **the unit of delivery is the device, not the user**: a message goes to every device of every participant — including the sender's own other devices — and any of those devices can be offline for minutes or weeks. Second, **the guarantees have to hold over an unreliable network**: everyone must see a conversation in the same order, a message must never be lost once the sender sees "Sent", and a retried send must never show up twice — all while the server stores and routes ciphertext it cannot read.

This document describes the production design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Redis + React implementation actually does.

**Learning goals**

- Ordering with a per-conversation sequence number assigned inside the write transaction.
- Per-device delivery: a durable mailbox per device, explicit acknowledgements, and catch-up on reconnect.
- Exactly-once *effect* over at-least-once delivery: client message IDs, idempotent acks, idempotent client merges.
- Delivery and read receipts as monotonic state that syncs across a user's own devices.
- WebSocket fan-out across many gateway instances, and what to do when the socket is down.
- Where end-to-end encryption shapes the backend: per-device keys, a key directory, and a server that cannot inspect content.

## Requirements

### Functional requirements

1. Send and receive 1:1 and group messages (groups up to ~100 members), with replies and reactions.
2. Multi-device sync: a message appears on all of the recipient's devices **and** on the sender's other devices.
3. Delivery receipts ("Delivered") and read receipts ("Read"); reading on one device clears the badge on the others.
4. Offline: a device that was away receives everything it missed when it reconnects; a user can compose while offline.
5. Typing indicators and presence.
6. End-to-end encryption with per-device keys; attachments are encrypted on the device before upload.

Out of scope: SMS fallback, server-side search (the server cannot read messages), calls, and cloud backup of history (a separate product with its own key-recovery problem).

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Delivery latency, both online | p99 < 500 ms sender to recipient device | Chat feels broken above half a second |
| Send acknowledgement | p99 < 200 ms to "Sent" | The sender's UI waits for it |
| Ordering | One total order per conversation, identical on every device | Replies must sit under their questions everywhere |
| Durability | Zero loss once the sender sees "Sent" | The bug users never forgive |
| Duplicates | At-least-once transport, exactly-once effect | Phones retry on every network blip |
| Offline window | Undelivered messages kept 30 days per device | Bounded storage and a bounded subpoena surface |
| Availability | 99.99% for send and receive | A messaging outage is front-page news |
| Confidentiality | The server never sees plaintext | It is the product |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users, devices | 200M DAU × 2.3 devices ≈ 460M devices | The device, not the user, is the scaling unit |
| Messages | 5B/day → ~58K/s average, ~100K/s peak | Writes spread over ~128 conversation shards (~800/s each) |
| Device deliveries | ~3 per message (recipient's devices + sender's others) → ~300K/s at peak | Mailbox appends and deletes dominate write volume |
| Live sockets | ~25% of devices connected at peak ≈ 115M | ~1,200 gateway hosts at ~100K sockets each |
| Message storage | ~1.5 KB ciphertext + metadata × 5B ≈ 7.5 TB/day → ~225 TB for 30 days | Per-shard retention by time; history lives on devices |
| Mailbox backlog | Most rows live seconds; ~1.5B rows × ~350 B ≈ 0.5 TB standing for offline devices | Small hot set, large cold tail swept after 30 days |
| Attachments | 500M/day × 2 MB ≈ 1 PB/day | Object storage + CDN, uploaded directly with presigned URLs |

The two numbers that drive the design are **~300K device deliveries per second** (so delivery must be cheap per device and survive any one component being slow) and **115M concurrent sockets** (so no single process can know where everyone is connected).

### Local Development Scale

One Express process serves REST and WebSockets on port 3000 (`dev:server1..3` start more on 3001–3003 against the same PostgreSQL and Redis to exercise cross-instance delivery). A seeded database has four users, six devices and four conversations. Everything fits in a laptop's memory; the interesting behavior is correctness under retries, reconnects and concurrent senders, not throughput. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
 ┌───────────────────────────────┐  GET /keys/{user}   ┌────────────────────────────┐
 │ Devices · iPhone, Mac, web    ├────────────────────▶│ Key Directory              │
 │ local store, device keys      │                     │ device keys, prekeys       │
 └───────────────┬───────────────┘                     └────────────────────────────┘
                 │ (1) send    (3) sync, ack
                 ▼
 ┌───────────────────────────────┐   push to device    ┌────────────────────────────┐
 │ WebSocket gateways · TLS      │◀────────────────────┤ Fan-out workers            │
 │ ~100K sockets each            │                     │ mailbox append, push       │
 └───────────────┬───────────────┘                     │ APNs wake when offline     │
                 │ send · sync · ack                   └──┬────────────▲──────────┬─┘
                 ▼                                        │ append     │ events   │ conn:{device}
 ┌───────────────────────────────┐                        ▼            │          ▼
 │ Message Service               │ drain, ack  ┌────────────────┐ ┌────┴────┐  ┌───────────────┐
 │ seq · dedupe · receipts       ├────────────▶│ Mailbox shards │ │ Kafka   │  │ Redis         │
 └───────────────┬───────────────┘             │ by device_id   │ └─────────┘  │ conn registry │
                 │ txn: seq, message, outbox   └────────────────┘      ▲       └───────────────┘
                 ▼                                                     │
 ┌───────────────────────────────┐  (2) outbox relay                   │
 │ PostgreSQL conversation       ├─────────────────────────────────────┘
 │ shards · messages by seq      │
 └───────────────────────────────┘
```

1. **Send (1).** The device encrypts the message once and wraps its key for every recipient device (fetched from the Key Directory), then sends it over its WebSocket. The Message Service, in one transaction on the conversation's PostgreSQL shard, takes the next sequence number, inserts the message — deduplicated by the client's message ID — and writes an outbox row, then acknowledges "Sent" with the sequence number.
2. **Fan-out (2).** A relay publishes outbox rows to Kafka. Fan-out workers append one mailbox row per recipient device (including the sender's other devices), look up which gateway holds each device in Redis, and push; a device with no connection gets an APNs wake-up instead.
3. **Sync (3).** A device that (re)connects drains its mailbox in batches and acknowledges each batch. The acknowledgement deletes the rows and produces "Delivered" receipts for the senders. Read receipts travel the same way as a per-device "read up to seq N" watermark.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| WebSocket gateways | TLS, socket auth, forward client frames, push frames to devices | Connected devices (~115M) | Hold only sockets; heartbeat every 30 s |
| Message Service | Send (seq + dedupe), sync, acks, read watermarks | Messages (~100K/s) | Stateless; all writes go to the owning shard |
| Key Directory | Device public keys, one-time prekeys, key-transparency log | Devices | Separate service and trust boundary |
| PostgreSQL conversation shards | Conversations (with `last_seq`), members, messages, read watermarks, outbox | Messages; 225 TB for 30 days | Hash-sharded by `conversation_id` |
| Kafka | Message, receipt and membership events from the outbox | Events | Partitioned by `conversation_id`, so per-conversation order is kept |
| Fan-out workers | Mailbox appends, push routing, APNs wake-ups | Device deliveries (~300K/s) | Idempotent: mailbox key is `(device_id, message_id)` |
| Mailbox shards | Each device's undelivered messages | Deliveries + offline backlog | Sharded by `device_id`; rows deleted on ack, swept after 30 days |
| Redis | Connection registry (device → gateway), presence, sessions, rate limits, typing | Devices | Losing it delays pushes; it never loses messages |
| APNs / FCM | Wake devices that have no socket | — | The push carries no content; the device syncs |

Gateways and the Message Service are split because they scale on different axes: gateways on open sockets (memory, file descriptors), the Message Service on message rate. A gateway restart drops 100K sockets that reconnect elsewhere with jittered backoff; nothing durable lives on it.

## Core Components / Request Flows

### Sending a message

```
 Alice phone       Gateway          Message Svc                Conv shard        Kafka
      │               │                  │                          │              │
      │ 1 send {K}    │                  │                          │              │
      │──────────────▶│                  │                          │              │
      │               │ 2 send(conv, K)  │                          │              │
      │               │─────────────────▶│                          │              │
      │               │                  │ 3 UPDATE last_seq+1      │              │
      │               │                  │─────────────────────────▶│              │
      │               │                  │ 4 seq 812                │              │
      │               │                  │◀─────────────────────────│              │
      │               │                  │ 5 INSERT … ON CONFLICT   │              │
      │               │                  │─────────────────────────▶│              │
      │               │                  │ 6 INSERT outbox; COMMIT  │              │
      │               │                  │─────────────────────────▶│              │
      │               │ 7 ack {id, 812}  │                          │              │
      │               │◀─────────────────│                          │              │
      │ 8 Sent · 812  │                  │                          │              │
      │◀──────────────│                  │                          │              │
      ··································· relay ····································
      │               │                  │                          │ 9 event 812  │
      │               │                  │                          │─────────────▶│
      │               │                  │                          │              │
```

- The client generates `clientMessageId` (K) once, when the user presses Send, and reuses it for every retry — after a timeout, a reconnect, or an app restart.
- Step 3 is `UPDATE conversations SET last_seq = last_seq + 1 … RETURNING last_seq` with a membership check in the same statement. The row lock it takes serializes senders in this conversation until COMMIT, so **commit order equals seq order**: a reader that has seen seq 812 can never later discover a new seq 811. Zero rows means the sender is not a member — the authorization check cannot race a concurrent removal.
- Step 5 relies on a unique index on `(conversation_id, sender_id, client_message_id)`. If the insert hits it, the request is a retry of a send that already committed: the service rolls back (returning the seq it just took, so there is no gap) and answers with the original message and seq.
- The outbox row commits with the message, so the event that drives fan-out cannot be lost between "committed" and "published".
- Local implementation: the same transaction writes the device inbox rows directly instead of an outbox row (one database plays both shards), and a Redis pub/sub publish replaces Kafka — see [Implementation Notes](#implementation-notes).

### Fan-out and delivery receipts

```
 Kafka         Fan-out             Mailbox    Redis    Gateway         Bob iPad
   │              │                   │         │         │                │
   │ 1 event 812  │                   │         │         │                │
   │─────────────▶│                   │         │         │                │
   │              │ 2 row per device  │         │         │                │
   │              │──────────────────▶│         │         │                │
   │              │ 3 conn:{device}?            │         │                │
   │              │────────────────────────────▶│         │                │
   │              │ 4 gateway-17                │         │                │
   │              │◀────────────────────────────│         │                │
   │              │ 5 push                                │                │
   │              │──────────────────────────────────────▶│                │
   │              │                   │         │         │ 6 new_message  │
   │              │                   │         │         │───────────────▶│
   │              │                   │         │         │ 7 ack [812]    │
   │              │                   │         │         │◀───────────────│
   │              │                   │ 8 DELETE row      │                │
   │              │                   │◀──────────────────│                │
   ······························· receipt ·································
   │ 9 delivered 812                                      │                │
   │◀─────────────────────────────────────────────────────│                │
   │              │                   │         │         │                │
```

- The fan-out worker writes one mailbox row per active device of every participant except the sending device. The row carries that device's wrapped message key; the ciphertext is stored once on the conversation shard.
- Mailbox inserts use `ON CONFLICT DO NOTHING` on `(device_id, message_id)`, so a worker that crashes and re-reads the Kafka partition repeats the work harmlessly. Offsets are committed only after the appends.
- Steps 3–5 are the fast path. The connection registry in Redis maps each device to the gateway holding its socket; a miss means "offline" and triggers an APNs wake-up. The mailbox row exists before the push is attempted, so a lost push only delays delivery until the next sync.
- Step 8: the gateway hands the ack to the Message Service, which deletes the mailbox row. Deleting returns only rows that were still pending, so a repeated ack produces no second receipt.
- Step 9: the "delivered" receipt is itself an event fanned out to the sender's devices — the sender's offline laptop learns about it on its next sync, exactly like a message. Receipts are coalesced per conversation and ack batch.

### Reconnect and catch-up

```
 Bob Mac                Gateway         Message Svc              Mailbox
    │                      │                 │                      │
    │ 1 reconnect (token)  │                 │                      │
    │─────────────────────▶│                 │                      │
    │                      │ 2 sync(device)  │                      │
    │                      │────────────────▶│                      │
    │                      │                 │ 3 oldest 200 rows    │
    │                      │                 │─────────────────────▶│
    │                      │                 │ 4 rows, has_more     │
    │                      │                 │◀─────────────────────│
    │ 5 sync_batch                           │                      │
    │◀───────────────────────────────────────│                      │
    │ 6 dedupe by id, sort by seq            │                      │
    │ 7 ack [ids]                            │                      │
    │───────────────────────────────────────▶│                      │
    │                      │                 │ 8 DELETE acked rows  │
    │                      │                 │─────────────────────▶│
    │                      │                 │ 9 delivered receipts │
    ····················· has_more: next batch ······················
    │                      │                 │                      │
```

- On connect, the device drains its mailbox oldest-first in batches of 200 and acks each batch; `has_more` asks for the next one. A device that disconnects mid-batch simply receives the same rows again: delivery is at-least-once, and the client merges by message ID.
- The client places every message by `seq`, never by arrival order — a live push, a sync batch and a history page can deliver the same message in any order.
- If a live push arrives with a seq more than one above the highest seq the client knows for that conversation, the client asks for a sync: something was missed (a dropped pub/sub frame, a race during reconnect) and the mailbox still has it.
- Messages older than the mailbox (a brand-new device, or history beyond 30 days) are not on the server in usable form: every message was encrypted for the devices that existed when it was sent. History for a new device comes from device-to-device transfer or an encrypted backup.

### Read receipts and read sync

Reading is a watermark, not a per-message flag: a device sends "read up to seq N" for a conversation. The server stores it per device with an update that only moves forward, so a late or replayed read of an older message cannot un-read newer ones. The user's read state is the highest watermark across their devices, which is also what drives the unread badge. The read event goes to every participant: the sender's devices turn "Delivered" into "Read", and the reader's own other devices clear the badge. Read receipts can be turned off per user; the watermark still syncs to the user's own devices.

### Typing and presence

Typing indicators and presence never touch PostgreSQL. Typing is a best-effort event with a few seconds of client-side expiry; a lost "stopped typing" event just times out. Presence is tracked per connection in Redis — a sorted set of connection IDs scored by last heartbeat — so a user stays online while any device is connected, and a crashed gateway's connections age out after 90 seconds instead of staying "online" forever. Presence changes go only to people who share a conversation with the user.

## Database Schema

### Production schema

Conversation shards hold everything ordered by conversation; mailbox shards hold everything addressed to a device; the Key Directory holds device identities.

```sql
-- Conversation shards (PostgreSQL, hash-sharded by conversation_id)
CREATE TABLE conversations (
  id          UUID PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  last_seq    BIGINT NOT NULL DEFAULT 0,          -- the per-conversation sequencer
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE members (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  user_id         UUID NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_seq      BIGINT NOT NULL,                -- membership changes take a seq too
  left_seq        BIGINT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  conversation_id   UUID NOT NULL,
  seq               BIGINT NOT NULL,
  id                UUID NOT NULL UNIQUE,
  sender_id         UUID NOT NULL,
  sender_device_id  UUID NOT NULL,
  client_message_id TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  ciphertext        BYTEA NOT NULL,               -- opaque to the server
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq),              -- ordering and keyset pagination
  UNIQUE (conversation_id, sender_id, client_message_id)  -- retries cannot duplicate
);

CREATE TABLE read_watermarks (
  conversation_id UUID NOT NULL,
  user_id         UUID NOT NULL,
  device_id       UUID NOT NULL,
  last_read_seq   BIGINT NOT NULL,                -- only ever increases
  PRIMARY KEY (conversation_id, user_id, device_id)
);

CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  seq             BIGINT NOT NULL,
  kind            TEXT NOT NULL,                  -- 'message' | 'membership' | 'receipt'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mailbox shards (PostgreSQL, hash-sharded by device_id)
CREATE TABLE device_mailbox (
  device_id       UUID NOT NULL,
  message_id      UUID NOT NULL,
  conversation_id UUID NOT NULL,
  seq             BIGINT NOT NULL,
  wrapped_key     BYTEA,                          -- message key encrypted for this device
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, message_id)             -- fan-out retries are no-ops
);
CREATE INDEX device_mailbox_drain ON device_mailbox (device_id, enqueued_at);

-- Key Directory
CREATE TABLE devices (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL,
  identity_key  BYTEA NOT NULL,
  signed_prekey BYTEA NOT NULL,
  push_token    TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE one_time_prekeys (
  device_id  UUID NOT NULL REFERENCES devices(id),
  prekey_id  INTEGER NOT NULL,
  public_key BYTEA NOT NULL,
  PRIMARY KEY (device_id, prekey_id)              -- claimed with DELETE … RETURNING
);
```

Retention is by time: a daily job removes ciphertext and mailbox rows older than 30 days on each shard (in practice by dropping day partitions, which needs the day in the primary key). Redis keys: `session:{token}`, `conn:{device}` → gateway ID (TTL refreshed by heartbeats), `presence:{user}` (sorted set of connection IDs by last heartbeat), `ratelimit:{scope}:{id}`, `typing:{conversation}`.

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql); it is re-runnable and backfills `seq` for databases created before sequencing existed. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `conversations.last_seq` | `conversations.last_seq` | Same sequencer, one database instead of shards |
| `messages` (ciphertext) | `messages` with `seq`, `client_message_id`, plaintext `content` | `encrypted_content`/`iv` exist but are unused; history is kept forever |
| `members` with `joined_seq`/`left_seq` | `conversation_participants` with `joined_at`/`left_at` | Membership changes are not sequenced |
| `outbox` → Kafka → `device_mailbox` | `device_inbox`, written inside the send transaction | No outbox or Kafka; the fan-out is part of the send |
| `read_watermarks` | `read_receipts.last_read_seq` | Same monotonic upsert |
| Receipt events on mailbox rails | `delivery_receipts` table + a live event | Status is re-derived from tables on reload |
| `devices`, prekeys | `devices` (+ `install_id`), `device_keys`, `prekeys` | Key tables are seeded placeholders |

## API Design

### Production API

```
WSS    /v1/stream                                 one socket per device; frames below
POST   /v1/conversations/{id}/messages            send; client_message_id → 201 | 200 duplicate | 403 | 422
GET    /v1/conversations/{id}/messages            ?before_seq=&after_seq=&limit= → oldest-first page
GET    /v1/sync?limit=200                         this device's mailbox → {messages, has_more}
POST   /v1/sync/ack                               {message_ids} → deletes mailbox rows, emits receipts
POST   /v1/conversations/{id}/read                {seq} → monotonic watermark
GET    /v1/keys/{user_id}                         active devices: identity key + one claimed prekey each
POST   /v1/devices                                register device keys, prekeys, push token
DELETE /v1/devices/{id}                           revoke: sessions, mailbox, keys; announce to contacts
```

| Frame (client → server) | Purpose |
|-------------------------|---------|
| `send_message {conversationId, content, clientMessageId}` | Send; answered with `message_sent {clientMessageId, message, isDuplicate}` |
| `ack {messageIds}` | Delete delivered rows from this device's mailbox |
| `sync` | Ask for the next mailbox batch |
| `read {conversationId, messageId}` | Advance this device's read watermark |
| `typing {conversationId, isTyping}` | Best-effort typing indicator |

| Frame (server → client) | Purpose |
|-------------------------|---------|
| `sync_batch {messages, hasMore}` | Mailbox backlog, sent on connect and on `sync` |
| `new_message {message}` | Live push of one message (carries its `seq`) |
| `delivery_receipt {conversationId, messageIds}` | A recipient device received these |
| `read_receipt {conversationId, userId, seq}` | A reader's watermark moved (also sent to the reader's other devices) |
| `error {code, clientMessageId}` | `forbidden`, `rate_limited`, `idempotency_conflict`, `invalid` |

### Local routes

The local API is mounted under `/api` (no version prefix); the WebSocket is `/ws?token=…`.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/api/auth/login` | Create a session; `installId` picks this browser's device |
| POST, GET | `/api/auth/logout`, `/api/auth/me` | End the session; current user and device |
| GET, DELETE | `/api/auth/devices`, `/api/auth/devices/:deviceId` | List devices; revoke one (sessions, inbox, open sockets) |
| GET | `/api/conversations`, `/api/conversations/:id` | List with last message and unread count; details |
| POST | `/api/conversations/direct`, `/api/conversations/group` | Create (direct creation is race-safe) |
| POST, DELETE | `/api/conversations/:id/participants[/:userId]`, `/api/conversations/:id/leave` | Group membership (admins) |
| GET | `/api/messages/conversation/:id?before_seq&after_seq&limit` | History page, oldest first, with status for own messages |
| POST | `/api/messages/conversation/:id` | REST send; `Idempotency-Key` header or `clientMessageId` → 201, 200 duplicate, 403, 422, 429 |
| GET, POST | `/api/messages/inbox`, `/api/messages/inbox/ack` | REST fallback for the device inbox |
| POST | `/api/messages/conversation/:id/read` | Advance the read watermark (404 if the message is elsewhere) |
| GET, PATCH, DELETE | `/api/messages/:id` | Read, edit, soft-delete one message |
| POST, DELETE | `/api/messages/:id/reactions[/:reaction]` | Reactions (participants only) |
| GET | `/health/live`, `/health/ready`, `/health`, `/metrics` | Operations |

## Key Design Decisions

### 1. A per-conversation sequence number, assigned under the conversation row lock

Every message gets `seq = last_seq + 1` from its conversation's row, inside the insert transaction. That single integer does four jobs: it is the display order every device agrees on, the cursor for history pages (`before_seq`), the gap detector for live delivery (812 after 810 means 811 is missing), and the watermark for read receipts. **Client timestamps** fail because phone clocks drift — a phone three minutes slow files its answer above the question. **Server timestamps** tie, and worse, they are assigned before commit: a transaction that took timestamp T can commit after one that took T+1, so a reader paging by time can skip it forever. **Globally unique time-ordered IDs** (Snowflake-style) have the same commit-order problem and leave gaps, so they cannot detect loss. **Vector clocks** capture causality but not a single order, so two devices would render concurrent messages differently. The cost is a serialization point per conversation: each send holds the row lock for a few milliseconds, which caps a single conversation at a few hundred sends per second — irrelevant for chat, decisive for a broadcast channel, which would need a different design.

### 2. A durable mailbox per device, drained with explicit acknowledgements

Delivery state lives in a per-device mailbox, and only the device's acknowledgement removes a row. The alternative that looks cheaper — store each message once and give every device a cursor per conversation — turns the hottest read in the system, "what did I miss?", into a scatter-gather across every shard holding any of the user's ~15 conversations, repeated for each device on every reconnect (subway exits, app foregrounds, laptop wakes). The mailbox makes that read one indexed range scan on one shard. It also fits encryption, because each device needs its own wrapped key anyway, and it gives natural retention: acked rows disappear, and a 30-day sweep bounds the tail. The rejected design actually shipped in this repository before: a Redis list per device, read with `LRANGE` and deleted with `DEL` before the client had processed anything. A drop between the two lost the batch, every server instance enqueued its own copy, and a user with one device online had their other devices skipped entirely. The cost of the mailbox is write amplification — about three appends and three deletes per message, ~300K/s at peak — and the fact that a device offline for more than 30 days loses its backlog.

### 3. Deduplication inside the write transaction, keyed by the client's message ID

Only the client knows whether a send is new or a retry, so the client generates the ID and the server enforces uniqueness with a constraint on the message row itself. A **separate idempotency store checked before the insert** (Redis `SET NX`, or a lookup table) opens a window between "not seen" and "inserted": two retries arriving together both pass the check. The earlier version of this project did exactly that, and its WebSocket path did not even pass the ID through. **Content hashing** is wrong because sending "ok" twice on purpose is normal. With the constraint, a duplicate rolls back its seq and returns the original message, and reusing an ID with different content is rejected (`422`), which catches client bugs. The cost is that correctness depends on client discipline: a client that regenerates the ID per attempt gets no protection.

### 4. Fan-out from an outbox through Kafka, not from the request path

The send transaction writes an outbox row; a relay publishes it to Kafka; fan-out workers write mailboxes and push. **Publishing directly after commit** is a dual write — a crash between commit and publish loses the event, and the recipient never gets the message. **Writing every mailbox inside the send transaction** would be atomic but turns each send into a distributed transaction across device shards. The outbox makes fan-out at-least-once and asynchronous, and partitioning Kafka by conversation keeps per-conversation order for the workers. The cost is a few tens of milliseconds of extra latency and one more system to operate; the sender's "Sent" does not wait for it.

### 5. Targeted push through a connection registry

With 1,200 gateways, broadcasting each event to every gateway (Redis pub/sub style) multiplies traffic by the gateway count for one recipient's benefit. **Sticky sessions** do not help because sender and recipient are different users connected to different gateways. A registry in Redis maps each device to the gateway holding its socket, so a push is one lookup and one targeted frame. The registry can be stale for a moment after a reconnect; that is harmless, because the mailbox, not the push, is the delivery guarantee. Locally, with three instances, broadcast pub/sub is simpler and is what the code does.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Send | Exactly one message per client send, even under concurrent retries | Unique `(conversation_id, sender_id, client_message_id)`; duplicate rolls back and returns the original |
| Order | One order per conversation, equal to commit order | `last_seq + 1` under the conversation row lock |
| Membership | Sender is a member at the moment of sending | Membership check inside the sequencing `UPDATE` |
| Delivery | At-least-once to every device | Mailbox row committed with (or from) the message; rows removed only by the device's ack |
| Fan-out retries | No duplicate mailbox rows | Primary key `(device_id, message_id)`, `ON CONFLICT DO NOTHING` |
| Ack | Idempotent; one receipt per delivery | `DELETE … RETURNING` reports only rows that were pending |
| Client apply | Exactly-once effect | Merge by message ID (and client ID for own sends); place by `seq` |
| Read state | Never moves backwards | Upsert with `WHERE last_read_seq < new_seq` |
| Message status | Never regresses (Read is not overwritten by a late Delivered) | Client keeps the more advanced status |

Read-your-writes for the sender holds because the ack carries the stored message and its seq. Every device of every participant converges on the same list because the list is defined by the seq range, not by what arrived when.

## Security / Auth

- **Sessions are per device.** Logging in creates or reuses one device row per installation; the session token is bound to that device. Revoking a device deletes its sessions from both the database and Redis, drops its mailbox, closes its open sockets, and (in production) removes its keys from the Key Directory and announces the change to its conversations.
- **Authorization** is conversation membership, checked inside the send transaction and on every read, reaction, typing and receipt; group admins manage membership.
- **End-to-end encryption.** Each device has its own identity key and one-time prekeys in the Key Directory. A sender encrypts the body once with a random key and wraps that key for each recipient device, so revoking one device never re-keys the others. Groups use sender keys (one symmetric chain per member, distributed pairwise once) so a group message costs one encryption instead of one per device; removing a member forces every remaining member to rotate. The Key Directory is the trust anchor — a malicious directory could add a device it controls — so device additions are announced in every conversation, safety numbers can be compared, and the directory publishes bindings to an append-only transparency log.
- **Rate limits** are enforced in Redis so they hold across instances: 60 sends per minute per user (shared by WebSocket and REST), 5 logins per 15 minutes per IP. They fail open: delivery outranks enforcement during a Redis outage.
- **Metadata** is the remaining exposure: the server sees who talks to whom and when. Push notifications carry no content. Hiding the sender from the server (sealed sender) is future work.

## Observability

- **Send:** ack latency, duplicate rate (a spike means clients are timing out and retrying), rejected sends by reason.
- **Delivery:** send → device-ack latency, split by live push versus sync; Kafka consumer lag (fan-out delay); mailbox rows enqueued, acked and expired (enqueued minus acked is the backlog); oldest unacked row per shard.
- **Sequencer:** row-lock wait time per shard — the first sign of a hot conversation.
- **Connections:** sockets per gateway, reconnect rate (a cliff means a gateway died and its devices are about to reconnect), registry misses.
- **Client-reported:** gap-triggered syncs and decryption failures. A decryption failure is invisible on the server, so the client counter is the production correctness test for the crypto path.
- Structured logs carry request, user, device, conversation and message IDs — never content or keys — so "my message never arrived" can be traced through send → fan-out → push → ack on metadata alone.

## Failure Handling

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Gateway crash | Brief "Reconnecting…"; nothing lost | Clients reconnect with jittered backoff; mailboxes hold everything |
| Message Service crash mid-send | Message stays "sending", then sends | Transaction rolls back; client retries with the same client ID |
| Conversation shard down | Sends to conversations on that shard fail; others work | Failover in ~30 s; client keeps the message in its outbox and retries |
| Kafka or fan-out lag | "Sent" but not "Delivered" for longer | Outbox absorbs the backlog; consumer lag alert |
| Mailbox shard down | Devices on it do not sync | Fan-out retries; failover; live pushes still flow |
| Redis down | No presence or typing; pushes fall back to APNs wake + sync | Messages unaffected; rate limits fail open |
| APNs throttled | Offline devices learn on next open | The mailbox is the source of truth, not the push |
| Device offline > 30 days | Backlog gone | Restore from another device or an encrypted backup |

## Scalability Considerations

1. **Fan-out volume first.** ~300K mailbox appends and deletes per second; both scale out by `device_id` shards, and daily partitions turn retention into dropping tables instead of deleting rows.
2. **Reconnect storms.** A dead gateway sends 100K devices back at once, each asking for a sync. Clients spread retries with jitter, and the sync read is one indexed scan per device.
3. **Hot conversations.** A large, busy group serializes on one row lock. Groups are capped at ~100 members; channels with thousands of members would get a sequencer per partition or a log-based design.
4. **Large groups' fan-out.** A 100-member group with 2.3 devices each is ~230 mailbox rows per message. Sender keys keep the encryption cost O(1), but the mailbox rows are still O(devices); past a few hundred members the protocol itself (MLS) needs to change.
5. **Gateways** scale horizontally; the registry is the only shared state and is rebuilt from heartbeats.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ordering | Per-conversation `seq` under a row lock | Timestamps, Snowflake IDs, vector clocks | One order everywhere, commit-ordered, detects gaps |
| Delivery state | Per-device mailbox + acks | Per-conversation cursors; Redis lists | One-scan sync, fits per-device keys, natural retention |
| Send idempotency | Unique client ID on the message row | Separate idempotency store | No check-then-act window |
| Fan-out trigger | Transactional outbox → Kafka | Publish after commit | No lost events between commit and publish |
| Push routing | Connection registry, targeted | Broadcast pub/sub, sticky sessions | Traffic independent of gateway count |
| Read state | Monotonic per-device watermark | Per-message read flags | One row per device; late events cannot regress it |
| Receipts | Events on the same mailbox rails | Polling the server | Offline sender devices catch up like messages |
| Encryption | Per-device keys + sender keys | One account key | Revoking one device does not re-key the rest |
| Offline retention | 30 days | Until delivered, forever | Bounded storage and exposure |
| Rate limiting | Redis sliding window, fail open | Fail closed | Delivery outranks enforcement |

## Implementation Notes

### What runs locally

[The entry point](./backend/src/index.ts) runs Express and the `ws` WebSocket server on one HTTP server (port 3000; `dev:server1..3` use 3001–3003). [Docker Compose](./docker-compose.yml) provides PostgreSQL 16 (schema from [`init.sql`](./backend/src/db/init.sql)) and Valkey/Redis 7. The frontend is React 19 + TanStack Router + Zustand on port 5173 and proxies `/api` and `/ws`. There is no Kafka, fan-out worker fleet, Key Directory service, APNs, object storage or load balancer.

### Production patterns implemented

**The send transaction** — [`services/messages.ts`](./backend/src/services/messages.ts) `sendMessage()` — is the core of the project. One PostgreSQL transaction takes the seq and checks membership, inserts with the idempotency constraint, and writes the inbox rows:

```sql
UPDATE conversations
SET last_seq = last_seq + 1, updated_at = NOW()
WHERE id = $1
  AND EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
  )
RETURNING last_seq
```

The insert that follows uses `ON CONFLICT (conversation_id, sender_id, client_message_id) DO NOTHING`; zero rows means a retry, so the service rolls back and returns the original message (or `IdempotencyConflictError` if the content differs). The same transaction inserts one `device_inbox` row per active device of every participant except the sending device. Because a single database plays both the conversation shard and the mailbox shard, the production outbox → Kafka → fan-out chain collapses into that one statement, and the inbox row is the durable delivery record.

**Device inbox, acks and catch-up** — [`services/websocket.ts`](./backend/src/services/websocket.ts). On connect the server pushes `sync_batch` (oldest 200 inbox rows, `getInboxBatch`); the client acks; `acknowledgeDelivery` deletes the rows and writes `delivery_receipts` in one statement and returns only rows that were pending, which become `delivery_receipt` events for the senders. Frames from one socket are processed one at a time in arrival order (so one device's sends get seqs in typing order), and the frame handler is attached before authentication finishes so frames sent the moment the socket opens are not dropped. An hourly sweep deletes inbox rows older than `INBOX_RETENTION_DAYS` (default 30). `GET /api/messages/inbox` and `POST /api/messages/inbox/ack` are a REST fallback.

**Cross-instance events** — [`services/realtime.ts`](./backend/src/services/realtime.ts) owns the pub/sub channels. Publishing happens after commit and is best-effort by design: a failed publish loses nothing, because the inbox row already exists.

**Read watermarks** — `markAsRead()` resolves the message's seq inside the conversation (a receipt naming a message elsewhere is rejected) and upserts with `WHERE read_receipts.last_read_seq < EXCLUDED.last_read_seq`. The event goes to all participants, including the reader's other devices. Unread counts are "messages from others above the user's highest watermark".

**Device identity and revocation** — [`services/auth.ts`](./backend/src/services/auth.ts). The browser keeps a random `installId` in `localStorage`; login upserts the device on a unique `(user_id, install_id)` index, so one browser stays one device and a second browser is a second device. Revocation deletes the device's sessions from PostgreSQL *and* Redis, drops its inbox, and a `control` event closes its sockets on whichever instance holds them (close code 4003).

**Presence and connections** — [`shared/connection-registry.ts`](./backend/src/shared/connection-registry.ts) keeps every socket per device (two tabs are two sockets of one device); presence in [`redis.ts`](./backend/src/redis.ts) is a per-user sorted set of connection IDs with a 90-second staleness window. Heartbeats ping every 30 seconds and terminate sockets that do not answer.

**Rate limiting** — [`shared/rate-limiter.ts`](./backend/src/shared/rate-limiter.ts) runs trim-count-add as one Lua script, so concurrent requests cannot all slip under the limit, and sets `RateLimit-*` and `Retry-After` headers. The WebSocket send path shares the REST limiter's per-user key.

**Operations** — Prometheus metrics in [`shared/metrics.ts`](./backend/src/shared/metrics.ts) (`imessage_inbox_rows_total{event}`, `imessage_idempotent_requests_total`, `imessage_message_delivery_status_total`, `imessage_rate_limit_exceeded_total{endpoint}`, `imessage_websocket_connections`), Pino JSON logs with request IDs, liveness/readiness/deep health checks, and a graceful shutdown that closes sockets with 1001 so clients reconnect elsewhere, drains HTTP, and closes Redis and PostgreSQL.

**Client protocol** — [`frontend/src/lib/messageList.ts`](./frontend/src/lib/messageList.ts) merges messages idempotently (by server ID or client ID), orders by seq, never regresses a status, and detects gaps; [`stores/chatStore.ts`](./frontend/src/stores/chatStore.ts) acks everything it applies, counts unread without double counting synced messages, and turns receipts into Sent → Delivered → Read; [`services/websocket.ts`](./frontend/src/services/websocket.ts) reconnects forever with capped, jittered backoff, keeps an outbox of frames sent while disconnected, and exposes the connection status the UI shows.

Tests: `npm test` in `backend/` (send transaction, acks, read watermark, receipts, registry, rate limiter) and in `frontend/` (message list rules).

### What was simplified or substituted

| Production design | Local substitute | Why |
|-------------------|------------------|-----|
| Conversation shards + mailbox shards | One PostgreSQL database | Laptop scale |
| Outbox → Kafka → fan-out workers | Inbox rows written inside the send transaction | One database makes the atomic version free |
| Connection registry + targeted push | Redis pub/sub broadcast to every instance | Three instances; simpler |
| Receipts as mailbox events | `delivery_receipts` table + live event; status re-derived on reload | No offline receipt delivery needed for a web client |
| Ciphertext, 30-day server retention | Plaintext `content`, history kept forever | No client crypto; the web client reads history from the server |
| Device-bound keys and auth | Session token per device in Redis (SQL audit row) | Session auth is the repository default |
| Membership as sequenced events | `joined_at`/`left_at` timestamps | Not needed without group keys |

### What was omitted

- End-to-end encryption (X3DH, Double Ratchet, sender keys), the Key Directory service and key transparency; `device_keys`, `prekeys` and `message_keys` are seeded placeholders.
- APNs/FCM, attachments and object storage, Kafka, sharding, multi-region, the load balancer.
- A client-side database: the web client keeps messages and its outbox in memory, so a reload loses messages typed offline that have not been sent yet, and history comes from the server.
- Message list virtualization, search, link previews, sealed sender.

### Known limitations

- **Edits and deletes are not pushed.** Other devices see them only when they reload history; a deleted message still in an inbox is acknowledged but not displayed.
- **Seeded phone and tablet devices never connect**, so their inbox rows accumulate until the 30-day sweep — visible as `enqueued` far above `acked` in `imessage_inbox_rows_total`. That is the "iPad in a drawer" case.
- **Membership changes are not sequenced.** A member removed after a message was queued still receives it, and a new member sees earlier messages only through the history API.
- **Sessions live only in Redis** for authentication; if Redis is down, nobody can authenticate (the SQL `sessions` table is an audit trail, not a fallback).
- **Every instance receives every event** over pub/sub, and typing and read events each query membership in PostgreSQL.
- **Presence events are delivered but the UI does not render them**, and unread counts are computed per request rather than maintained as counters.
