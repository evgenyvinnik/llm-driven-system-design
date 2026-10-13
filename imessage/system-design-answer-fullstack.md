# 💬 iMessage — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one message from the Send button to every device it lands on, and get the contracts between client and server right — because in messaging, every guarantee is split across the wire. Three contracts carry the weight: a **client message ID** that makes retries safe, a **sequence number** that makes order and missing messages visible, and **acknowledgements and watermarks** that make 'Delivered' and 'Read' honest. The backend delivers at least once; the client turns that into exactly once on screen."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the composer to the recipient's devices, plus the core flows |
| Data model & API contract | 7 min | Server tables, client store, and the fields both sides rely on |
| Deep dive 1: exactly one message per Send | 8 min | Client ID, unique index, ack with seq |
| Deep dive 2: order and catch-up | 7 min | Seq, mailbox, gap detection, reconnect |
| Deep dive 3: receipts end to end | 6 min | Acks become "Delivered", watermarks become "Read" on every device |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** 1:1 and group messaging (up to ~100 members) with replies and reactions; every message appears on all of the recipient's devices and on the sender's other devices; "Delivered" and "Read" receipts, with reading on one device clearing the badge on the others; offline compose and catch-up; typing and presence; end-to-end encryption with per-device keys. Out of scope: SMS fallback, server-side search, calls, cloud backup.

| Side | Requirement | Target |
|------|-------------|--------|
| Frontend | Send feedback | Bubble on screen < 50 ms after Enter, online or not |
| Frontend | Long threads | INP < 200 ms while typing in a 10,000-message thread |
| Frontend | Offline | Composed messages survive reconnects and reloads |
| Backend | Send acknowledgement | p99 < 200 ms to "Sent" |
| Backend | Delivery, both online | p99 < 500 ms device to device |
| Backend | Offline window | 30 days of undelivered messages per device |
| Both | Correctness | One order everywhere; nothing lost after "Sent"; nothing shown twice; statuses never move backwards |

**Scale.** 200M daily users with 2.3 devices each; 5B messages a day (~58K/s, ~100K/s peak); each message reaches ~3 devices, so ~300K device deliveries a second at peak; ~115M sockets open at peak. Message ciphertext is ~7.5 TB a day, kept 30 days on the server.

"The per-device fan-out tells me delivery state must be tracked per device, cheaply and idempotently; the client side tells me every incoming message must be safe to apply twice and in any order."

---

## 🏗️ End-to-End Architecture (9 min)

```
 ┌───────────────────────────────┐  GET /keys/{user}   ┌────────────────────────────┐
 │ Client app · chat store       ├────────────────────▶│ Key Directory              │
 │ by seq · WS client, outbox    │                     │ device keys, prekeys       │
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

1. **Send (1).** The client shows an optimistic bubble, generates a client message ID, and sends over its WebSocket (or keeps the frame in its outbox while offline). The Message Service, in one transaction on the conversation's shard, takes the next seq, inserts the message deduplicated by that ID, and writes an outbox row; the ack carries the stored message and its seq back to the client.
2. **Fan-out (2).** The outbox row reaches Kafka; fan-out workers append a mailbox row for every recipient device — including the sender's other devices — and push to whichever gateway holds each device, or wake it through APNs.
3. **Sync (3).** A reconnecting client drains its mailbox in batches, applies each message idempotently, and acks; the acks become "Delivered" receipts for the senders.

| Layer | Choice | Why |
|-------|--------|-----|
| Client | React SPA; one store with a single merge path; WebSocket client with an outbox | Pushes are merges, not refetches; sends must survive drops |
| Gateways | Stateless socket holders | Scale on connections; restart freely |
| Message Service | Stateless; seq, dedupe, sync, acks, watermarks | Scales on message rate |
| PostgreSQL conversation shards | Messages by `(conversation_id, seq)`, members, watermarks, outbox | One transaction gives order, dedupe and the fan-out event |
| Kafka + fan-out workers | Asynchronous, idempotent delivery | The sender's "Sent" doesn't wait for fan-out |
| Mailbox shards | Per-device undelivered messages | Catch-up is one scan per device |
| Redis | Device → gateway registry, presence, sessions, rate limits | Ephemeral; never holds a message |

### Flow: sending, across the wire

```
Chat store                WS client         Message Svc                      PostgreSQL    Bob
     │                        │                  │                                │         │
     │ 1 bubble, client ID K  │                  │                                │         │
     │ 2 send {K}             │                  │                                │         │
     │───────────────────────▶│                  │                                │         │
     │                        │ 3 send {K}       │                                │         │
     │                        │─────────────────▶│                                │         │
     │                        │                  │ 4 seq+1; INSERT … ON CONFLICT  │         │
     │                        │                  │───────────────────────────────▶│         │
     │                        │                  │ 5 seq 812 (or original)        │         │
     │                        │                  │◀───────────────────────────────│         │
     │                        │ 6 sent {K, 812}  │                                │         │
     │                        │◀─────────────────│                                │         │
     │ 7 swap bubble: "Sent"  │                  │                                │         │
     │◀───────────────────────│                  │                                │         │
     │                        │                  │ 8 push + inbox row                       │
     │                        │                  │─────────────────────────────────────────▶│
     │                        │                  │                                │         │
```

"Steps 1 and 4 are two halves of one contract. The client promises to reuse K for every retry of this message; the server promises that a repeated K returns the stored message instead of inserting again — enforced by a unique index inside the same transaction that takes the seq. Step 6 gives the client the seq, which is when the bubble moves to its final position."

### Flow: receipts flowing back

```
Alice UI                 Message Svc           Bob iPad    Bob Mac
    │                         │                    │          │
    │                         │ 1 new_message 812  │          │
    │                         │───────────────────▶│          │
    │                         │ 2 ack [812]        │          │
    │                         │◀───────────────────│          │
    │ 3 delivery_receipt      │                    │          │
    │◀────────────────────────│                    │          │
    │ 4 "Delivered"           │                    │          │
    │                         │ 5 read 812         │          │
    │                         │◀───────────────────│          │
    │ 6 read_receipt seq 812  │                    │          │
    │◀────────────────────────│                    │          │
    │                         │ 7 read_receipt (own)          │
    │                         │──────────────────────────────▶│
    │ 8 "Read"                │                    │          │
    │                         │                9 clear badge  │
    │                         │                    │          │
```

"'Delivered' is the recipient device's ack (step 2) turned into an event for the sender. 'Read' is a watermark — read up to seq 812 — that goes to the sender *and* to the reader's own other devices, which is how reading on my iPad clears the badge on my Mac."

### Flow: reconnecting

```
 Browser                  WS client           Chat store               Server
    │                         │                    │                      │
    │ 1 online / tab visible  │                    │                      │
    │────────────────────────▶│                    │                      │
    │                         │ 2 connect (backoff + jitter)              │
    │                         │──────────────────────────────────────────▶│
    │                         │ 3 sync_batch, has_more                    │
    │                         │◀──────────────────────────────────────────│
    │                         │ 4 receiveMessages  │                      │
    │                         │───────────────────▶│                      │
    │                         │                    │ 5 ack [ids]          │
    │                         │                    │─────────────────────▶│
    │                         │                    │ 6 sync (next batch)  │
    │                         │                    │─────────────────────▶│
    │                         │ 7 sync_batch, done                        │
    │                         │◀──────────────────────────────────────────│
    │                         │ 8 flush outbox (same K)                   │
    │                         │──────────────────────────────────────────▶│
    │                         │                    │                      │
```

"On connect the server pushes this device's backlog in batches; the client applies, acks and asks for more while `has_more` is set, then flushes its outbox with the original client IDs."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| Conversation shard | `conversations` | `id`, `type`, `last_seq` | `last_seq` is the sequencer |
| Conversation shard | `messages` | `(conversation_id, seq)`, `id`, `sender_id`, `client_message_id`, `ciphertext` | Unique `(conversation_id, sender_id, client_message_id)` |
| Conversation shard | `read_watermarks` | `(conversation_id, user_id, device_id)`, `last_read_seq` | Only moves forward |
| Conversation shard | `outbox` | `id`, `conversation_id`, `seq` | Same transaction as the message |
| Mailbox shard | `device_mailbox` | `(device_id, message_id)`, `seq`, `wrapped_key`, `enqueued_at` | Deleted by the device's ack |
| Redis | `conn:{device}`, `presence:{user}`, `session:{token}` | Gateway ID, connection IDs | TTLs |

### Client side

| Store entry | Holds | Updated by |
|-------------|-------|------------|
| `messages[conversationId]` | Messages ordered by `seq`; optimistic ones (no seq) last | One merge path for pushes, catch-up batches and history pages |
| `conversations` | Last message (with `seq`), unread count | Server list, then incremented only above that seq |
| Own message `status` | `sending` → `sent` → `delivered` → `read`, or `failed` | Ack, delivery receipt, read watermark; never backwards |
| Outbox | Frames sent while offline, with their client IDs | Flushed on reconnect (IndexedDB in production) |
| `installId` | This browser's installation ID | Generated once; survives logout |

### The contract

```
WSS  /v1/stream                           client: send_message · ack · sync · read · typing
                                          server: sync_batch · new_message · message_sent · receipts · error
POST /v1/conversations/{id}/messages      client_message_id → 201 | 200 duplicate | 403 | 422 | 429
GET  /v1/conversations/{id}/messages      ?before_seq=&after_seq=&limit= → oldest-first page with own-message status
GET  /v1/sync  ·  POST /v1/sync/ack       mailbox batch + has_more; ack deletes rows
POST /v1/conversations/{id}/read          seq → watermark (no-op if not higher)
POST /v1/auth/login                       install_id → the same device row for the same installation
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `client_message_id` | Same ID → same message, forever; same ID with different content → `422` | Retry after timeouts, reconnects and reloads without duplicates |
| `seq` | Dense, increasing, one order per conversation, equal to commit order | Order the thread, page history (`before_seq`), detect gaps (`after_seq` or sync) |
| Mailbox + `ack` | Every message stays queued for this device until it acks | Treat live pushes as a fast path; anything missed arrives on sync |
| `has_more` | Batches are oldest-first and complete | Keep asking until caught up |
| Read watermark | Never moves backwards | Send "read" freely; render "Read" from one number |
| `error.clientMessageId` + `code` | Every rejected send names its message | Mark exactly that bubble failed and offer Retry |
| `install_id` | One device row per (user, installation) | Keep one inbox and one set of receipts across logins |

---

## 🔧 Deep Dive 1: Exactly One Message per Send (8 min)

"The scenario: I hit Send in a tunnel, the socket dies before the ack, and the app retries when the signal returns. Did the first attempt commit? The client can't know. Every layer has a job."

**Client.** On Enter the store creates the bubble and a client ID with `crypto.randomUUID()`. The WebSocket client sends the frame or keeps it in an outbox; on reconnect it flushes the outbox with the same IDs. Retry after an error reuses the ID. In production the outbox lives in IndexedDB so a reload doesn't drop it.

**Server.** One transaction: take the seq with `UPDATE … SET last_seq = last_seq + 1` (membership is checked in the same statement), insert with `ON CONFLICT DO NOTHING` on `(conversation_id, sender_id, client_message_id)`. Zero rows inserted means this is a retry: roll back — returning the seq, so no gap — and answer with the original message. Two retries arriving at once serialize on the conversation row and the index; one inserts, the other gets the original.

**Back on the client**, the ack carries `{clientMessageId, message}`. The store finds the bubble by client ID and replaces it in place with the server's copy — new ID, real seq, status `sent` — keeping the React key, so nothing flickers.

| Approach | Verdict |
|----------|---------|
| ✅ Client ID + unique index in the insert transaction | Safe under timeouts, reloads and concurrent retries |
| ❌ Idempotency store checked before the insert | Two concurrent retries both pass the check |
| ❌ Dedupe by content | "ok" twice on purpose is normal |
| ❌ Disable the button | Stops double taps, not retries |

> "The original version of this repo had the dedupe logic but its WebSocket handler never passed the client ID to it — the path every message actually took had no protection. Contracts that span the wire need a test that exercises both halves; here that's an end-to-end check that sends the same ID twice over a real socket and counts rows."

"What I give up: correctness depends on client discipline — a client that regenerates the ID per attempt gets nothing — and IDs must be unique per sender per conversation forever, which UUIDs make free."

---

## 🔧 Deep Dive 2: Order and Catch-up (7 min)

"Messages reach a device three ways — a live push, a catch-up batch, a history page — in any order and sometimes twice. The thread must still show one order, the same on every device."

**The server's half.** The seq is assigned under the conversation row lock, so seq order is commit order: a client that has seen 812 will never later receive a new 811. Delivery is a per-device mailbox: the fan-out writes a row for every device, and only that device's ack deletes it. Pushes are a fast path on top; if a push is lost, the row is still there.

**The client's half.** One merge function: dedupe by ID, place by seq, ack everything applied (including duplicates — the ack is what drains the mailbox). If a push arrives with seq 812 when the highest seq I know is 810, I don't guess: I ask for a sync, and 811 comes out of the mailbox. History uses the same seq as a cursor (`before_seq`), so loading older messages never shifts what's already on screen.

**Reconnect.** The socket reconnects forever with exponential backoff capped at 30 seconds and randomized, so a server restart doesn't bring every client back in the same second; the `online` event and tab focus skip the wait. On connect the server pushes the backlog in batches of 200 with `has_more`.

| Approach | Verdict |
|----------|---------|
| ✅ Server seq + per-device mailbox + client merge by ID and seq | Any arrival order, any duplicate, any drop → same thread |
| ❌ Client sorts by `createdAt` | Clocks differ; ties |
| ❌ Server tracks a cursor per device per conversation | Catch-up becomes a query across every conversation's shard on each reconnect |
| ❌ Trust the push stream | A dropped pub/sub frame is a message lost until reload |

"What I give up: about three mailbox writes and deletes per message on the server, and a client that must keep per-conversation state — the highest seq it has seen — to notice gaps."

---

## 🔧 Deep Dive 3: Receipts End to End (6 min)

"Receipts are where client and server most often disagree, so I make both sides monotonic."

**Delivered.** When a recipient device acks, the server deletes the mailbox rows and emits one `delivery_receipt` per conversation to the senders, listing the message IDs. The delete returns only rows that were still pending, so a duplicate ack produces no second receipt. A user's own other devices acking their copy produce nothing — "Delivered" means the other side has it. In production the receipt itself rides the mailbox rails, so my offline laptop catches up on statuses like on messages.

**Read.** A device sends `read` with the last visible message. The server resolves its seq *inside that conversation* — a receipt naming a message from elsewhere is rejected — and upserts the device's watermark only if it's higher. The event goes to every participant, including the reader's other devices.

**On the client**, statuses only move forward: `sent` → `delivered` → `read`. A late delivery receipt can't overwrite "Read". A read receipt from someone else marks my messages up to its seq as Read; one from me (another device) clears the badge if it covers the latest message.

**Unread counts** must agree on both sides. The server computes "messages from others above my highest watermark"; the client trusts that number, increments it only for messages with a seq above the list's `lastMessage.seq`, and zeroes it on read. That's what stops a catch-up batch from inflating badges a second time.

| Approach | Verdict |
|----------|---------|
| ✅ Ack → delivered event; watermark → read event to all devices | One number per device; correct under duplicates and reordering |
| ❌ Per-message read flags | A row per message per reader, and a late event can un-read |
| ❌ Client polls statuses | Latency and load, for state the server already pushes |

"Reload safety: history pages include each of my messages' status, derived on the server from receipts and watermarks, so 'Read' doesn't revert to 'Sent' after a refresh."

---

## 📈 Failures & Scale (2 min)

| Failure | What the sender sees | What the recipient sees | Mitigation |
|---------|----------------------|-------------------------|------------|
| Socket drops mid-send | "Sending", then "Sent" after reconnect | One copy | Outbox replays the same client ID |
| Gateway crash | Brief "Reconnecting…" | Catch-up batch on reconnect | Mailbox holds everything; jittered reconnect |
| Conversation shard failover | Sends wait ~30 s | — | Retries with the same ID |
| Fan-out lag | "Sent", "Delivered" later | Message later | Outbox absorbs it; lag alert |
| Redis down | No typing or presence | Push becomes APNs wake + sync | Messages unaffected |
| Rate limited | "Not delivered · Retry" with a wait | — | Error frame names the message |

**What breaks first as we grow:** mailbox write and delete volume (shard by device, drop day partitions), reconnect storms after a gateway failure (client jitter, one-scan sync), and hot group conversations on one row lock (group size cap).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Send safety | Client ID + unique index in the insert | Separate idempotency store | No race between check and insert |
| Order | Server seq under a row lock | Timestamps | Same order everywhere; gaps detectable |
| Delivery | Per-device mailbox + acks; push as fast path | Trust pushes | Drops can't lose messages |
| Client apply | One merge path, by ID and seq | Append on arrival | Exactly once on screen |
| Receipts | Monotonic ack and watermark events | Polling, per-message flags | Cheap and never regresses |
| Reconnect | Unlimited, jittered backoff + outbox | Give up after N attempts | Always comes back, no duplicates |

"With more time I'd persist the outbox and recent history in IndexedDB for instant, offline-capable opens, push edits and deletes as sequenced events so every device converges on them too, and add a shared contract test suite that runs the same scenarios against both the client merge rules and the server."
