# 💬 Microsoft Teams — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one message from the composer to every member's screen and get the contracts between the layers right, so each layer can fail without breaking the others. Three contracts carry the design: a `clientMessageId` that makes sending safe to retry, a per-channel `seq` with a cursor that makes the live list complete and ordered across reconnects, and a `404` that means the same thing on both sides when someone isn't allowed to see a channel."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the browser to the gateways, plus two flows across the seam |
| Data model & contract | 7 min | Server tables, the client store, and the fields both sides rely on |
| Deep dive 1: one message per send | 7 min | Idempotency from the button to the unique index |
| Deep dive 2: the cursor contract | 8 min | History, stream and reconnects that meet exactly |
| Deep dive 3: permissions end to end | 5 min | One rule enforced on the server and reflected in the UI |
| Failures, scale, wrap-up | 4 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Organizations contain teams, teams contain channels; teams and channels can be private. Members post, reply in one-level threads, react, edit and delete their own messages, and see each other's presence. Everything appears live on every open device; history loads as you scroll. Out of scope: meetings media, shared channels across tenants, bots.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Send acknowledgement | p99 < 300 ms |
| Backend | Delivery to recipients' browsers | p99 < 500 ms in region |
| Backend | Availability / durability | 99.99%; no acknowledged message lost |
| Frontend | Channel switch | < 100 ms cached, < 300 ms cold |
| Frontend | Responsiveness | INP < 200 ms while 20 events/s arrive |
| Both | Correctness | No missing, duplicated or reordered messages, including after reconnects |
| Both | Isolation | Nobody sees, or learns of, a channel they don't belong to |

**Scale.** 100M daily active users, 30M devices connected at peak, 4B messages a day (~150K/s at peak), and about 20 online recipients per event, so ~4.5M pushes per second spread over ~300 gateway nodes.

"The backend numbers tell me delivery needs its own connection tier and that order can only be per channel. The frontend numbers tell me the client can't refetch on every hiccup: it needs a cursor, so a reconnect costs the gap, not the whole channel."

---

## 🏗️ End-to-End Architecture (9 min)

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Teams web app · message store with a seq cursor per channel · one SSE stream             │
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

1. **Send (1).** The SPA shows the message immediately as pending and posts it with a `clientMessageId`. The Chat API checks membership, then in one transaction takes the channel's next `seq`, inserts the message and appends an event row, and returns `201` with the message.
2. **Fan out (2).** CDC streams the event row into Kafka, partitioned by channel; fan-out workers find the gateway nodes holding the channel's online members and publish one batch per node.
3. **Receive and resume (3).** Each browser holds one SSE stream, opened with its cursor (last applied `seq`) for every channel it has loaded. The gateway replays anything newer from the event log, then sends live events; the browser applies an event only if it is exactly the next number.

| Layer | Choice | Why |
|-------|--------|-----|
| Browser | React SPA; TanStack Query for lists; a message store with per-channel cursors | Lists are request/response; the message list is live and event-sourced |
| Chat API | Stateless REST | Writes need status codes, idempotency and rate limits |
| Push Gateway | SSE streams, ~150K per node | Push-heavy traffic; built-in reconnect with `Last-Event-ID` |
| PostgreSQL | Messages and event log sharded by channel; memberships by tenant | Sequence, message and event commit together |
| Kafka + fan-out workers | Ordered per channel; one batch per gateway node | Cost bounded by gateway count, not audience size |
| Redis | Presence, connection registry, rate limits | Losing it delays delivery, never loses messages |

### Flow: sending across the wire

```
Composer           Message store                              Chat API   Event stream
    │                    │                                        │            │
    │ 1 send("ship it")  │                                        │            │
    │───────────────────▶│                                        │            │
    │                    │ 2 add pending row, key K               │            │
    │                    │ 3 POST /messages {clientMessageId: K}  │            │
    │                    │───────────────────────────────────────▶│            │
    │                    │ 4 id 43: message with K                             │
    │                    │◀────────────────────────────────────────────────────│
    │                    │ 5 replace pending row in place         │            │
    │                    │ 6 201 message (same id): no-op         │            │
    │                    │◀───────────────────────────────────────│            │
    ····················· request fails: row shows Retry ·······················
    │                    │ 7 retry with the same K                │            │
    │                    │───────────────────────────────────────▶│            │
    │                    │ 8 200 original, never a duplicate      │            │
    │                    │◀───────────────────────────────────────│            │
    │                    │                                        │            │
```

"Both halves of the idempotency contract are visible here. The browser promises to reuse key `K` for every retry of this message; the server promises that a repeated `K` returns the original message instead of creating another. Whichever copy reaches the store first replaces the pending row, and the second is a no-op."

### Flow: history and stream meeting at the cursor

```
 Browser                       Chat API                      PostgreSQL                   Gateway
    │                              │                              │                          │
    │ 1 GET /messages?channelId    │                              │                          │
    │─────────────────────────────▶│                              │                          │
    │                              │ 2 snapshot: page + last_seq  │                          │
    │                              │─────────────────────────────▶│                          │
    │ 3 {messages, latestSeq: 41}  │                              │                          │
    │◀─────────────────────────────│                              │                          │
    │ 4 GET /events?cursors=ch:41                                                            │
    │───────────────────────────────────────────────────────────────────────────────────────▶│
    │                              │                              │ 5 events of ch after 41  │
    │                              │                              │◀─────────────────────────│
    │ 6 replay, then live                                                                    │
    │◀───────────────────────────────────────────────────────────────────────────────────────│
    ······················· Carol posts; fan-out reaches this gateway ························
    │ 7 id ch:42, new_message                                                                │
    │◀───────────────────────────────────────────────────────────────────────────────────────│
    │ 8 42 = cursor + 1: apply     │                              │                          │
    │                              │                              │                          │
```

"Step 2 is the server half of the cursor contract: the page and `latestSeq` come from one database snapshot, so everything up to 41 is in the page and nothing after it is. Step 4 is the client half: the stream opens after exactly that number. Step 8 is the rule the client applies to every event, live or replayed."

---

## 💾 Data Model & Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL (by tenant) | `org_members`, `team_members`, `channel_members` | (scope, user), role, `last_read_seq` | The membership chain for one request lives on one shard |
| PostgreSQL (by channel) | `channel_heads` | channel_id, `last_seq` | Counter row, locked until commit |
| PostgreSQL (by channel) | `messages` | PK (channel_id, seq); id; author; parent; content; client_message_id; deleted_at | Unique (author, client_message_id) |
| PostgreSQL (by channel) | `channel_events` | PK (channel_id, seq); type; payload | Same transaction as the change; kept 48 h |
| Redis | `presence:{user}`, `conn:{user}` | status; gateway nodes | Written by gateways on connect and disconnect |

### Client side

| Store | Holds | Updated by |
|-------|-------|------------|
| Query cache `['teams', orgId]`, `['channels', teamId]`, `['members', channelId]` | Lists | Fetch; invalidated on create or join |
| Message store, per channel | Messages by id, ordered seqs, cursor, oldest seq, `hasMore` | History pages and stream events, by the rules below |
| Pending sends | Rows with `status` and `clientMessageId` | Composer; replaced by the server copy |
| IndexedDB outbox | Unsent messages | Survives reloads; replayed with the same keys |
| URL | org, team, channel, open thread | Router; the source of truth for selection |

### The contract

```
POST /api/v1/messages                     {channelId, content, parentId?, clientMessageId}
                                          → 201 message | 200 original (replayed) | 422 | 404
GET  /api/v1/channels/{id}/messages       ?before=<seq>&limit=50 → {messages, latestSeq, hasMore}
GET  /events?cursors=ch1:41,ch2:17        SSE: id per event, replay then live | resync
PUT  /api/v1/messages/{id}/reactions/{e}  idempotent; event only if it changed
POST /api/v1/channels/{id}/read?seq=<n>   unread badge = messages after last_read_seq
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `clientMessageId` | Same key + same body → the original message; different body → `422` | Retry after timeouts and reloads without duplicates; match its pending row |
| `seq` | Gapless and in commit order within a channel | Sort, detect duplicates, detect gaps |
| `latestSeq` | Read in the same snapshot as the page | Open the stream exactly where the page ends |
| Stream replay | Everything after the cursor, in order, or `resync` | Reconnect without refetching |
| `before=<seq>` | Keyset page strictly older than the cursor | Infinite scroll upwards without gaps or duplicates |
| Reaction events | Emitted only when a row changed | Apply reactions as sets of users |
| `404` | Same answer for "missing" and "not allowed" | Show one "not found or no access" state |

---

## 🔧 Deep Dive 1: Exactly One Message per Send (7 min)

"The scenario: Alice sends on a train, the request times out, and she can't tell whether it went through. Without care, her retry posts the message twice, and everyone sees her repeat herself. Each layer has a job."

**Browser.** When Alice presses Enter, the store generates a key with `crypto.randomUUID()`, shows a dimmed pending row, and writes `{key, channel, content}` to the IndexedDB outbox before sending. Every retry (the Retry button, an automatic retry after a network error, or a reload that finds the entry in the outbox) reuses that key. Editing the text before it sends creates a new key, because it is a different request now.

**API.** The insert carries the key. A unique index on (author, `client_message_id`) makes a second insert a conflict; the transaction rolls back, so the channel's sequence number is handed back unused, and the API answers `200` with the original message. If the same key arrives with different text, that's a client bug, and the answer is `422` rather than silently returning the wrong message.

**Stream.** The original send produced exactly one event, so other members see the message once regardless of how many times Alice retried. Alice's own tabs match the event to their pending row by the key.

| Approach | Verdict |
|----------|---------|
| ✅ Client key + unique index + replayed response | Correct across timeouts, reloads and double clicks; no extra storage |
| ❌ Dedupe by content and time window | Merges two genuine identical messages ("ok", "ok"); misses retries outside the window |
| ❌ Disable the button while pending | Stops double clicks, not retries after a timeout or a reload |
| ❌ Separate idempotency-key table with stored responses | Works, but duplicates what the message row already records |

"What I give up: a unique index on every message and a little client logic. Storing the key on the message row itself means the 'stored response' is just the row, so there's nothing extra to expire."

---

## 🔧 Deep Dive 2: The Cursor Contract (8 min)

"The live list has four inputs: the history page, live events, my own REST responses, and replays after reconnects. The design goal is that the client can treat them uniformly."

**Server half.**

1. Every visible change (new, edited or deleted message, reaction changes) takes the channel's next `seq` from a counter row whose lock lasts until commit, so numbers are gapless and visible in order.
2. The change and its event row commit together; delivery systems only carry the log.
3. The history response reads the page and `latestSeq` in one snapshot.
4. On connect, the gateway replays everything after each cursor (up to 500 events, within 48 hours) before going live; otherwise it sends `resync`.

**Client half.**

1. Load the page, set the cursor to `latestSeq`, then open the stream with that cursor.
2. For each event: at or below the cursor, drop; exactly the next, apply and advance; beyond the next, reconnect from the cursor.
3. On `resync`, reload the newest page, keep pending sends, reconnect from the new `latestSeq`.
4. Every channel switch starts a new session, and responses for an older session are ignored.

| Approach | Verdict |
|----------|---------|
| ✅ Server `seq` + snapshot `latestSeq` + bounded replay | No gaps, no duplicates, cheap reconnects |
| ❌ Refetch the channel on every reconnect | Correct, but every network blip reloads 50 messages for every open device |
| ❌ Trust pub/sub delivery, dedupe by id | Duplicates handled, but a lost event leaves a silent hole until reload |
| ❌ Client timestamps for order | Different clocks, different orders on different screens |

"What it costs: the server writes an event row per change and keeps 48 hours of them, and the client owns real ordering logic. I keep that logic in pure reducer functions with unit tests, because a bug there is invisible until someone notices a missing message."

---

## 🔧 Deep Dive 3: Permissions End to End (5 min)

"One rule, enforced in one place, and reflected (not re-implemented) in the UI."

**The rule.** You can read and post in a channel if you're in its organization, in the team if the team is private, and in the channel if the channel is private. Adding members needs an owner or admin role.

**Server.** One query walks organization, team and channel for the caller on every request and every stream connect. Organization membership is an inner join, so a user from another tenant gets no row at all. Every channel-scoped route goes through one middleware, so new endpoints can't skip it. Anything that fails is `404`, which tells a prober nothing about whether a private channel exists. User search only returns people who share an organization with the caller.

**Client.** The UI's checks are affordances, not enforcement: hiding a private channel from the sidebar is good UX, but the API is reachable without the UI. A deep link to a channel the user can't see renders the same "doesn't exist or you don't have access" state for both cases. When someone is removed, the server closes their stream for that channel, and the client treats the resulting `404` on reconnect as "access ended", dropping the channel from its store.

| Approach | Verdict |
|----------|---------|
| ✅ Chain walk per request, `404`, cache only org membership briefly | A slow check shows on a dashboard; nothing stale can leak |
| ❌ Materialized per-channel permissions | One lookup, but a missed invalidation leaks silently |
| ❌ Enforce in the UI only | Anyone with curl reads everything |

"The line I'd draw: the frontend decides what to render, the backend decides what to return, and when they disagree the visible result is an empty state, never someone else's data."

---

## 📈 Failures & Scale (3 min)

| Failure | What the sender sees | What other members see | Mitigation |
|---------|----------------------|------------------------|------------|
| Request times out | Pending row, then Retry | Nothing, or the message once | Same `clientMessageId` on retry |
| Gateway restarts | Nothing | "Reconnecting…" for a few seconds, then the gap appears | Cursors replay from the log |
| Pub/sub or Kafka hiccup | Nothing | A short delay | Gap detection by `seq`; replay |
| Device asleep for days | Nothing | List refreshes on wake | `resync`, reload newest page |
| Shard failover | Sends fail briefly, then retry | Nothing lost | Synchronous replica; idempotent retries |
| Access removed | — | Channel shows "no access" | Stream closed; `404` on reconnect |

**What breaks first as we grow:** gateway connection churn during deploys (drain in waves), hot message shards (split by channel id, replicas for reads), fan-out lag during spikes (more partitions), and on the client, memory in day-long sessions (keep 10 channels, evict the least recently used).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Send safety | Client key + unique index | Content dedupe, disabled button | Retries can't duplicate; real repeats still allowed |
| Ordering | Per-channel `seq` from a counter row | Timestamps or global ids | One gapless order everyone shares |
| Live list | Cursor + replay + `resync` | Refetch on reconnect | Cheap reconnects, no holes |
| Transport | REST writes + SSE pushes | WebSocket for both | Status codes for writes; push-only stream |
| Fan-out | One batch per gateway node | Per-user inboxes | Bounded by gateway count |
| Permissions | Chain walk per request, `404` | Cached effective permissions | Nothing stale can leak |
| Client state | Message store + query cache + URL | One global store for everything | Each kind of state gets matching rules |

"With more time: per-tenant search with permission filtering at query time, typing indicators as throttled events outside the sequenced stream, and an offline-first client that keeps recent pages in IndexedDB."
