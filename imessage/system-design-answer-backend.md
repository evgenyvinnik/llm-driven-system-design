# 💬 iMessage — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Chat looks like 'store a message, push it to the other person'. Two things make iMessage hard. The unit of delivery is the device, not the user — every message goes to every device of every participant, including my own other devices, and any of them can be offline for a week. And the guarantees have to survive a network that retries everything: one order that every device agrees on, nothing lost after 'Sent', nothing shown twice — while the server stores ciphertext it cannot read. So I'll spend most of the time on ordering, per-device delivery and what makes retries safe."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the per-device fan-out number |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives on which shard, and the contract |
| Deep dive 1: ordering and safe retries | 8 min | Sequence numbers and deduplication in one transaction |
| Deep dive 2: per-device delivery | 8 min | Mailboxes, acks and catch-up on reconnect |
| Deep dive 3: keys and groups | 4 min | Why encryption shapes the backend |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because 'messaging' ranges from a chat widget to a global E2E platform."

### Functional requirements

1. **Send** 1:1 and group messages (groups up to ~100 members), with replies and reactions.
2. **Multi-device sync**: a message shows up on all of the recipient's devices *and* on the sender's other devices.
3. **Receipts**: "Delivered" when a recipient device has it, "Read" when the recipient reads it; reading on my phone clears the badge on my Mac.
4. **Offline**: a device that was away gets everything it missed when it comes back.
5. **Typing and presence.**
6. **End-to-end encryption** with per-device keys; attachments encrypted on the device.

Out of scope: SMS fallback, server-side search (the server can't read anything), calls, and cloud backup of history — which is a separate product with its own key-recovery problem.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Delivery latency, both online | p99 < 500 ms device to device | Above half a second chat feels broken |
| Send acknowledgement | p99 < 200 ms to "Sent" | The sender's UI waits for it |
| Ordering | One total order per conversation, the same on every device | Answers must sit under their questions everywhere |
| Durability | Zero loss after "Sent" | The one bug users never forgive |
| Duplicates | At-least-once transport, exactly-once effect | Phones retry on every network blip |
| Offline window | 30 days of undelivered messages per device | Bounded storage and bounded exposure |
| Availability | 99.99% for send and receive | |
| Confidentiality | Server never sees plaintext | It's the product |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users and devices | 200M DAU × 2.3 ≈ 460M devices | The device is the unit I scale |
| Messages | 5B/day → ~58K/s average, ~100K/s peak | ~128 conversation shards at ~800 writes/s each |
| Device deliveries | ~3 per message (recipient's devices + my other devices) → ~300K/s peak | Mailbox writes dominate; they must be cheap and idempotent |
| Live sockets | ~25% of devices connected at peak ≈ 115M | ~1,200 gateways at ~100K sockets each |
| Message storage | ~1.5 KB × 5B ≈ 7.5 TB/day → ~225 TB for 30 days | Time-based retention; history lives on devices |
| Wrapped keys | ~256 B per recipient device → ~4 TB/day | Encryption can't be naive for groups |

"Two numbers drive everything: ~300K device deliveries per second at peak, and 115M sockets that no single process can keep track of."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys that matter: sending, fanning out to devices, and a device catching up."

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

1. **Send (1).** The device encrypts once, wraps the message key for every recipient device (from the Key Directory), and sends over its socket. The Message Service, in one transaction on the conversation's shard, takes the next sequence number, inserts the message deduplicated by the client's message ID, writes an outbox row, and acks "Sent" with the seq.
2. **Fan-out (2).** A relay publishes outbox rows to Kafka. Fan-out workers append one mailbox row per recipient device, ask Redis which gateway holds each device, and push; a device without a socket gets an APNs wake-up.
3. **Sync (3).** A device that reconnects drains its mailbox in batches and acks them; the ack deletes the rows and sends "Delivered" back to the senders.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| WebSocket gateways | TLS, socket auth, forward frames, push | Connected devices | Hold only sockets; heartbeat every 30 s |
| Message Service | Send (seq + dedupe), sync, acks, read watermarks | Message rate | Stateless |
| Key Directory | Device keys, prekeys, transparency log | Devices | Separate trust boundary |
| PostgreSQL conversation shards | Conversations with `last_seq`, members, messages, watermarks, outbox | Messages | Hash-sharded by `conversation_id` |
| Kafka | Message, receipt and membership events | Events | Partitioned by conversation, so order holds |
| Fan-out workers | Mailbox appends, push routing, APNs | Device deliveries | Idempotent on `(device_id, message_id)` |
| Mailbox shards | Each device's undelivered messages | Deliveries + backlog | Sharded by `device_id`; deleted on ack |
| Redis | Device → gateway registry, presence, sessions, rate limits | Devices | Losing it delays pushes, never loses messages |

"Why separate gateways from the Message Service? Gateways scale on open sockets — memory and file descriptors — and the Message Service scales on message rate. When a gateway restarts, 100K devices reconnect elsewhere and nothing durable is lost, because nothing durable lives there."

### Flow 1: sending a message

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

"Step 3 is the heart of the design: `UPDATE conversations SET last_seq = last_seq + 1 … RETURNING last_seq`, with the membership check in the same statement. The row lock serializes senders in this conversation until COMMIT, so commit order equals seq order. Step 5 hits a unique index on `(conversation_id, sender_id, client_message_id)` if this is a retry; then I roll back — giving the seq back, so no gap — and return the original message. Step 6 writes the outbox row in the same transaction, so the fan-out event can't be lost between commit and publish."

### Flow 2: fan-out and the "Delivered" receipt

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

"The mailbox row is written before anyone tries to push, so steps 3 to 6 are only the fast path. If the push is lost, or Redis says the device has no socket, the row waits for the next sync. The worker's inserts use `ON CONFLICT DO NOTHING` on `(device_id, message_id)`, so a crashed worker can re-read its Kafka partition safely. At step 8 the gateway hands the ack to the Message Service, which deletes the row; the delete returns only rows that were still pending, so a repeated ack produces no second receipt. The receipt in step 9 is itself an event fanned out to the sender's devices — my offline laptop learns 'Delivered' the same way it learns about messages."

### Flow 3: reconnect and catch-up

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

"On connect the device drains its mailbox oldest-first in batches of 200 and acks each one. If it drops mid-batch it gets the same rows again; the client merges by message ID and places by seq, so duplicates and out-of-order arrival are harmless."

---

## 💾 Data Model (4 min)

"Everything ordered by conversation lives on the conversation shard; everything addressed to a device lives on the mailbox shard."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| Conversation shard | `conversations` | `id`, `type`, `last_seq` | `last_seq` is the sequencer; one row lock per send |
| Conversation shard | `members` | `(conversation_id, user_id)`, `role`, `joined_seq`, `left_seq` | Membership changes take a seq too, so "was Bob a member at 812?" has one answer |
| Conversation shard | `messages` | `(conversation_id, seq)` PK, `id`, `sender_id`, `sender_device_id`, `client_message_id`, `ciphertext` | Unique `(conversation_id, sender_id, client_message_id)`; 30-day retention |
| Conversation shard | `read_watermarks` | `(conversation_id, user_id, device_id)`, `last_read_seq` | Upsert only moves forward |
| Conversation shard | `outbox` | `id`, `conversation_id`, `seq`, `kind` | Relayed to Kafka, then deleted |
| Mailbox shard | `device_mailbox` | `(device_id, message_id)` PK, `conversation_id`, `seq`, `wrapped_key`, `enqueued_at` | Index `(device_id, enqueued_at)`; deleted on ack, swept after 30 days |
| Key Directory | `devices`, `one_time_prekeys` | `device_id`, `user_id`, `identity_key`, `prekey_id` | A prekey is claimed atomically, once |
| Redis | `conn:{device}`, `presence:{user}`, `session:{token}` | gateway ID, connection IDs by heartbeat | TTLs; rebuilt from heartbeats |

"Notice there is no searchable column next to `ciphertext`. Anything the server could index would be an oracle for the content, so search, previews and spam classification become client-side problems. And the body is stored once while the wrapped key is per device: encrypting the whole body per device would triple ~7.5 TB a day to say the same thing three times."

---

## 🔌 API Design (3 min)

```
WSS    /v1/stream                               one socket per device: send_message, ack, sync, read, typing
POST   /v1/conversations/{id}/messages          send; client_message_id → 201 | 200 duplicate | 403 | 422
GET    /v1/conversations/{id}/messages          ?before_seq=&after_seq=&limit= → oldest-first page
GET    /v1/sync?limit=200                       this device's mailbox → messages + has_more
POST   /v1/sync/ack                             message_ids → delete mailbox rows, emit receipts
POST   /v1/conversations/{id}/read              seq → monotonic read watermark
GET    /v1/keys/{user_id}                       active devices: identity key + one claimed prekey each
DELETE /v1/devices/{id}                         revoke: sessions, mailbox, keys
```

- **The client generates `client_message_id`** once per message and reuses it on every retry; the same ID with different content is a `422`.
- **Keyset pagination by seq**: `before_seq` for history, `after_seq` to fill a gap the client detected. No `OFFSET`, and no timestamps as cursors.
- **The socket and REST share one contract**: the REST send and sync endpoints exist for clients that can't hold a socket and for debugging; they hit the same transaction and the same mailbox.
- **Rate limits**: 60 sends per minute per user across both paths, enforced in Redis so they hold on every instance.

---

## 🔧 Deep Dive 1: One Order and Safe Retries (8 min)

"Two guarantees come from the same transaction: every device shows a conversation in the same order, and a retried send never appears twice."

### Ordering

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Client timestamps | Sort by the sender's clock | A phone three minutes slow files its answer above the question |
| ❌ Server timestamps | `created_at` at insert | Ties; and a transaction that took time T can commit after one that took T+1, so a reader paging by time skips it forever |
| ❌ Snowflake-style IDs | Time-ordered unique IDs from many servers | Same commit-order hole, and gaps are normal so loss can't be detected |
| ❌ Vector clocks | Track causality per device | Gives causality, not one order — two devices render concurrent messages differently |
| ✅ Per-conversation seq | `last_seq + 1` under the conversation row lock | One serialization point per conversation |

"Why it works: the row lock is held until COMMIT, so commit order equals seq order. A reader who has seen 812 can never later find a new 811. That one integer then does four jobs — display order, the history cursor, gap detection ('I got 812 after 810, fetch 811'), and the read watermark."

"What I give up: each send holds the lock for a few milliseconds, which caps one conversation at a few hundred sends a second. That's irrelevant for chat. For a 50,000-member broadcast channel I'd need a different sequencer."

### Exactly-once effect

"Only the client knows whether a send is new or a retry — sending 'ok' twice on purpose is normal, so content hashing is wrong. The client generates the ID; the server enforces it with a unique index on the message row itself."

| Approach | Verdict |
|----------|---------|
| ✅ Unique `(conversation, sender, client_message_id)` in the insert | Concurrent retries serialize on the index; the loser rolls back and returns the original |
| ❌ Separate idempotency store checked first (Redis `SET NX`, lookup table) | Window between "not seen" and "inserted": two retries arriving together both pass |
| ❌ Content hash | Drops intentional repeats |
| ❌ Exactly-once transport | Impossible: the ack can always be lost |

> "This isn't hypothetical. The first version of this project checked Redis and a table before inserting, and its WebSocket path didn't even pass the client ID through — the path every message actually took had no protection at all. Putting the guarantee on the row makes it impossible to bypass."

"The rest of exactly-once is on the receiving side: acks are idempotent because the mailbox delete only reports rows that were pending, and the client merges by message ID and places by seq, so a message that arrives twice — once live, once in a sync batch — renders once."

---

## 🔧 Deep Dive 2: Per-Device Delivery (8 min)

"The biggest modeling call: where does 'this device hasn't received message 812 yet' live?"

| Approach | Reconnect sync | Write cost | Verdict |
|----------|----------------|------------|---------|
| ✅ Per-device mailbox, sharded by device | One indexed scan on one shard | ~3 appends + 3 deletes per message | Chosen |
| ❌ Store once, cursor per (device, conversation) | Scatter-gather across ~15 conversation shards, per device, per reconnect | One row per message | The hottest read becomes a distributed query |
| ❌ Redis list per device | `LRANGE` + `DEL` | Cheap | Loses data, duplicates, misses devices |

**Why the mailbox works.** The dominant read isn't "show me this conversation" — the device already has that. It's "what did I miss?", and it happens on every subway exit, app foreground and laptop wake, for every device. With a mailbox that's one range scan. It also fits encryption, because each device needs its own wrapped key anyway, and it gives retention for free: acked rows disappear, and a 30-day sweep bounds the tail of devices in drawers.

**Why fan-out-on-write is safe here.** Fan-out-on-write is famously dangerous for a celebrity with 50M followers. Messaging has no celebrities: the fan-out is members × devices, capped at roughly 100 × 5. The worst case is a few hundred rows, so precomputing it at write time is strictly better than paying a merge on billions of reads.

**Why the Redis list fails — from this codebase.** The earlier version queued offline messages in a Redis list per device. It read with `LRANGE` and deleted with `DEL` before the client had processed anything, so a drop in between lost the batch. Every server instance saw the pub/sub event and enqueued its own copy, and it only queued when a user had *no* connection anywhere — so if my phone was online, my laptop was skipped entirely. A durable row that only the device's ack removes fixes all three.

**What I give up.** Write amplification of ~300K appends and deletes per second, and a device offline for more than 30 days loses its backlog — it restores history from another device or an encrypted backup. I also accept that delivery is at-least-once and push the last step of exactly-once into the client merge.

**Read state** rides alongside: a device sends "read up to seq N", stored per device with an upsert that only moves forward, so a late read of an older message can't un-read newer ones. The event goes to the sender ("Read") and to my own other devices, which clear the badge.

---

## 🔧 Deep Dive 3: Keys and Groups (4 min)

"Encryption shapes the backend in two places: who you trust for keys, and what groups cost."

**The key directory is the trust anchor.** To message Bob, my phone fetches Bob's device list and one prekey per device. Nothing stops a malicious or compelled directory from adding a device it controls. The mitigations make that lie visible: every conversation shows "Bob added a new device", users can compare safety numbers, and the directory publishes every key binding to an append-only transparency log that clients audit. That turns the directory into its own service with its own durability and audit story — which is why it isn't a table in the Message Service.

**Groups need sender keys.** A 50-member group with 2.3 devices each is ~115 devices: per-device wrapping would put 115 × 256 B of key material on every "ok". With sender keys, each member distributes one symmetric chain key to every device once, and each message is encrypted once. The bill comes when someone is removed: every remaining member rotates and redistributes — about 49 × 113 ≈ 5,500 pairwise key messages. For a group that sends 10,000 messages a month and removes someone once a year, that's two orders of magnitude cheaper. Past a few hundred members even that breaks, and MLS (O(log N) re-keying) is the migration path.

| Approach | Verdict |
|----------|---------|
| ✅ Per-device keys + sender keys for groups | Revoking one device doesn't touch the others; O(1) encryption per group message |
| ❌ One key per account shared by all devices | Compromise any device, compromise all; revocation means re-keying everything |
| ❌ Per-device wrapping in groups | O(members × devices) per message, on the sender's phone and in storage |

"The authorization cut is server-side and immediate: removing a member stops delivery to their devices the moment the membership row commits. The key rotation is defense in depth with a visible tail."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** mailbox write and delete volume (shard by device, drop day partitions instead of deleting rows), reconnect storms when a gateway dies (jittered client backoff; the sync read is one scan), and hot conversations on one row lock (cap group size; channels need another design).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Gateway crash | "Reconnecting…", nothing lost | Mailboxes hold everything; jittered reconnect |
| Message Service crash mid-send | "Sending" a little longer | Transaction rolls back; client retries with the same ID |
| Conversation shard failover | Sends to that shard wait ~30 s | Client outbox retries; other shards unaffected |
| Kafka or fan-out lag | "Sent" but not yet "Delivered" | Outbox absorbs it; consumer-lag alert |
| Redis down | No presence or typing; pushes fall back to APNs + sync | Messages unaffected; rate limits fail open |

**What I'd watch:** send-to-device-ack latency split by push versus sync, Kafka consumer lag, mailbox enqueued versus acked (the difference is the backlog), sequencer lock waits per shard, sockets per gateway and reconnect rate, the duplicate-send rate (clients timing out), and client-reported decryption failures — the only signal we get when the crypto path breaks, because the server can't see it.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Ordering | Per-conversation seq under a row lock | Timestamps, Snowflake IDs | Commit-ordered, gap-detectable, one order everywhere |
| Send idempotency | Unique client ID on the message row | Idempotency store checked first | No check-then-act window |
| Delivery state | Per-device mailbox + acks | Cursors per conversation; Redis lists | One-scan sync; nothing lost on a drop |
| Fan-out trigger | Outbox → Kafka → workers | Publish after commit | No lost events |
| Push routing | Device → gateway registry | Broadcast to all gateways | Cost independent of gateway count |
| Read state | Monotonic per-device watermark | Per-message flags | Late events can't regress it |
| Group crypto | Sender keys, MLS later | Per-device wrapping | O(1) per message |
| Offline retention | 30 days | Forever | Bounded storage and exposure |

"With more time I'd add sealed sender — hiding who sent a message from the server, which for many users matters more than the content — client-side encrypted backup so a lost phone doesn't mean lost history, and abuse handling built on behavior and user reports, since content scanning is off the table by design."
