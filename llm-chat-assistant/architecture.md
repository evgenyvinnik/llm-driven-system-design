# LLM Chat Assistant - Architecture Design

## System Overview

A ChatGPT / Claude.ai-style chat service. Users hold multi-turn conversations with a large language model, see the answer stream token by token, stop it mid-sentence, edit an earlier message or regenerate a reply, and come back to their history on any device. The model is a black box behind a pool of GPU replicas that is always smaller than peak demand, so the design work lives around the model: a streaming gateway whose streams survive dropped connections, conversation storage shaped as a tree of branches, context-window assembly that fits long histories into a fixed token budget, free-tier quotas, admission control that keeps paid traffic flowing when GPUs saturate, cancellation that actually returns GPU capacity, safety filters on the streaming path, and conversation history that lives in a home region with cross-region failover.

**Learning goals:**
- Long-lived generation streams: SSE versus WebSocket, and resuming a stream after the connection drops
- Admission control under GPU scarcity: per-user quotas versus instantaneous capacity, and tiered priority
- Cancellation that propagates from a Stop button to the GPU batch
- Context assembly: truncation versus summarization, and keeping the prompt prefix stable
- Where safety classifiers sit when output is streamed rather than returned whole
- Multi-region conversation storage with a single writer per user

## Requirements

### Functional Requirements

- **Chat**: Send a message and receive a streamed assistant reply in a conversation
- **Conversation history**: List, open, rename, archive, and delete conversations; history is available on every device
- **Branching**: Edit a previous user message or regenerate an assistant reply, keeping the old branch reachable
- **Stop generating**: Halt a reply mid-stream; the partial reply is saved
- **Resume**: A reply that was streaming when the network dropped or the tab reloaded continues from where it left off
- **Tiers and quotas**: Free and paid tiers with per-model message limits, context budgets, and output caps
- **Capacity handling**: When GPUs are saturated, paid users are served first; free users queue, fall back to a smaller model, or see an "at capacity" message
- **Safety**: Classify input before it reaches the model and output while it streams
- **Admin**: View capacity, queue depth, and admission decisions by tier; edit quota policies; toggle load shedding

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Time to first token (paid, unsaturated) | p50 < 1 s, p99 < 3 s |
| Inter-chunk gap while streaming | p99 < 250 ms |
| Stream completion (reply finishes and is persisted) | > 99.9% |
| Stop → GPU slot freed | p99 < 500 ms |
| Conversation API availability | 99.95% |
| Durability of completed messages | No loss after the `done` event; cross-region RPO of seconds |
| Message history read | p99 < 200 ms for the active branch of a conversation |

### Out of Scope

- Model training, fine-tuning, and GPU kernel internals (the model is a black box with `submit`, `stream`, and `cancel`)
- File uploads, retrieval over documents, tool use, and voice
- Billing and payments (tier is a field on the user)
- Sharing conversations publicly

## Capacity Estimation

### Production Scale

| Assumption | Value | Derivation |
|------------|-------|------------|
| Daily active users | 100M | Assumption |
| Messages per user per day | 10 | Assumption |
| Generations per day | 1B | 100M × 10 |
| Average generations/s | ~11.6K | 1B / 86,400 s |
| Peak generations/s | ~35K | 3× average (34,722) |
| Output tokens per reply | 500 | Assumption |
| Input (context) tokens per request | 4,000 | Assumption: system prompt + history |
| Streaming speed per reply | 50 tokens/s | Assumption, so a reply streams for 10 s |
| Concurrent streams | ~116K avg, ~347K peak | Little's law: rate × 10 s |
| Output tokens/s | ~5.8M avg, ~17.4M peak | rate × 500 |
| Input tokens/s | ~46M avg, ~139M peak | rate × 4,000; input is 8× output |
| Paid share of generations | 25% | Assumption |

### GPU Capacity

Assume one model replica (a multi-GPU node, treated as a black box) sustains **100 concurrent streams** at 50 tokens/s each, which is 5,000 output tokens/s.

| Metric | Value | Derivation |
|--------|-------|------------|
| Replicas needed at average | ~1,160 | 115,741 / 100 |
| Replicas needed at peak | ~3,470 | 347,222 / 100 |
| Replicas provisioned | 2,500 | Business decision: 250K streams, 72% of peak |
| Peak shortfall | ~97K streams | 347K − 250K |
| Paid demand at peak | ~87K streams | 25% of 347K; always fits |
| Free demand at peak | ~260K streams | 75% of 347K |
| Free demand served at peak | ~163K (63%) | 250K − 87K; the rest queues, degrades, or is told to wait |
| GPU freed by Stop | ~174 replicas | Assume 10% of replies stopped halfway → 5% of decode at peak |

Provisioning for the daily peak would mean paying for 3,470 replicas to use ~1,160 on average. The design instead provisions 72% of peak and makes admission control a first-class component.

### Gateway, Stream Log, and Storage

| Metric | Value | Derivation |
|--------|-------|------------|
| Gateway nodes at peak | 18 | 347K streams / 20K streams per node (assumed), before N+2 and per-region spread |
| Open app tabs (average) | ~2.1M | 100M × 30 min / 1,440 min; 18× the active streams |
| Stream-log appends at peak | ~3.5M/s | 347K streams × 10 chunks/s (100 ms coalescing) |
| Stream-log shards | ~35 | 3.5M / 100K appends/s per Redis shard |
| Stream-log memory at peak | ~9.7 GB | (347K active + 34.7K/s × 60 s retained) × 4 KB |
| SSE egress at peak | ~2.8 Gbps | 17.4M tokens × 4 B + 3.5M chunks × 80 B framing |
| Stored per turn | ~3 KB | 400 B user + 2 KB assistant + metadata |
| Storage growth | 3 TB/day, ~1.1 PB/year | 1B turns × 3 KB, before replication |
| Database writes | ~35K/s avg, ~104K/s peak | 3 writes per turn (user message, placeholder, final update) |

The numbers point at three constraints: GPUs (scarce and expensive), concurrent connections (bounded by how long we hold them), and the per-token write path (it must never touch the database).

### Local Development Scale

| Component | Local sizing |
|-----------|--------------|
| Users | 5 seeded accounts (3 free, 1 paid, 1 admin) plus a load script with 20 simulated users |
| Gateway instances | 3 (ports 3001–3003) behind a round-robin proxy on 3000 |
| Mock model workers | 2 workers × 4 slots at 30 tokens/s, so 8 concurrent streams saturate the "fleet" |
| PostgreSQL | One instance, a few thousand messages |
| Redis | One instance for sessions, quotas, queues, and stream logs |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Clients: web · desktop · mobile apps                    │
└────────────┬──────────────────────────────────────────────▲──────────────┘
             │ POST message (Idempotency-Key)               │ SSE chunks (id = seq)
┌────────────▼──────────────────────────────────────────────┴──────────────┐
│ Global edge: TLS · WAF · per-IP limits · GSLB to the user's home region  │
└────────────┬──────────────────────────────────────────────▲──────────────┘
             │                                              │
┌────────────▼──────────────────────────────────────────────┴──────────────┐
│ Chat API / stream gateway (stateless; any node can serve any stream)     │
│ auth · idempotency · quota · admission · SSE writer · cancel endpoint    │
└────┬─────────────┬─────────────┬─────────────┬────────────▲──────────────┘
     │             │             │             │            │ XREAD after seq
┌────▼─────┐ ┌─────▼────┐ ┌──────▼──────┐ ┌────▼─────┐ ┌────┴──────────────┐
│ Quota +  │ │ Input    │ │ Conversation│ │ Inference│ │ Stream log        │
│ sessions │ │ safety   │ │ service +   │ │ router + │ │ Redis Streams,    │
│ (Redis)  │ │ check    │ │ context     │ │ queues   │ │ one per generation│
└──────────┘ └──────────┘ └──────┬──────┘ └────┬─────┘ └────▲──────────────┘
                                 │             │ pull       │ chunks
                          ┌──────▼──────┐ ┌────▼────────────┴───────────────┐
                          │ Conversation│ │ GPU replica pools + generation  │
                          │ DB, sharded │◀│ relay (output safety filter,    │
                          │ by user_id  │ │ chunking, final persistence)    │
                          └──────┬──────┘ └─────────────────────────────────┘
                                 │ async replication
                          ┌──────▼──────┐
                          │ Paired DR   │
                          │ region      │
                          └─────────────┘
```

The key structural decision is that **the generation is decoupled from the HTTP connection**. Model replicas never write to a client socket. Tokens flow replica → relay → stream log, and any gateway node tails the stream log for any client. A dropped connection, a gateway deploy, or a page reload changes who is reading, never what is being generated.

Supporting systems not drawn: a background worker pool (title generation and summarization, submitted to the same router at background priority), Kafka carrying usage and moderation events to ClickHouse for analytics and capacity planning, and Prometheus/Grafana.

## Core Components / Request Flows

### Components

| Component | Responsibility | Production technology | Local substitute |
|-----------|----------------|-----------------------|------------------|
| Global edge | TLS, WAF, per-IP limits, route to home region | CDN/GSLB + L7 load balancer | Round-robin Node proxy on :3000 |
| Chat API / stream gateway | Auth, idempotency, quota, admission, SSE writing, cancel | Stateless Node services | Express on :3001–3003 |
| Quota store | Rolling-window message counts, in-flight counts, sessions | Redis Cluster | Single Redis |
| Input safety check | Classify the user message before admission | Classifier service (GPU or CPU) | Keyword and regex mock |
| Conversation service | Read the active branch, assemble context, persist messages | Service over sharded PostgreSQL | Module inside the gateway |
| Inference router | Per-pool priority queues, admission estimates, dispatch, orphan reaping | Regional service, sharded by model pool | Redis sorted sets + library |
| Model replicas | Generate tokens with continuous batching; honor cancel | GPU nodes (black box) | Mock workers emitting tokens at a fixed rate |
| Generation relay | Output safety filter, chunk coalescing, stream-log writes, final persistence, usage events | Sidecar beside each replica | Inline in the mock worker |
| Stream log | Ordered chunk log per generation for live tailing and resume | Redis Streams cluster | Redis Streams |
| Background workers | Titles, rolling summaries | Same router at background priority | Worker process |

### Flow 1: Send a message

1. The client generates a UUIDv7 for the user message and POSTs it with `Accept: text/event-stream`. The message ID doubles as the idempotency key.
2. The gateway authenticates the session and looks up the message ID. If it already exists for this user, this is a retry: the gateway attaches the caller to the existing generation's stream and stops.
3. **Quota**: check the rolling-window counter for (user, model) and the user's in-flight count. Free users over quota on model A are switched to model B; over the in-flight cap returns 429.
4. **Input safety**: classify the new user message. A block returns a refusal event and saves nothing to the model path.
5. **Admission**: the queue score is `now + tier_offset`. The router estimates the wait as (generations with a lower score in the pool queue) ÷ (pool dispatch rate). If the estimate exceeds the tier's maximum wait, degrade (free: model A → model B) or reject with 503 and `Retry-After`. Otherwise reserve one unit of quota.
6. **Persist**: in one transaction on the user's shard, insert the user message, insert an assistant placeholder (`status = 'queued'`), insert the generation row, and bump `conversations.updated_at` and `current_leaf_id`.
7. **Assemble context** (see Key Design Decision 4) and enqueue the generation on the pool's queue with the score from step 5.
8. The gateway sends `event: meta` (message IDs, generation ID, model, quota) and, if the request is waiting, `event: queued` with position and ETA. It then blocks on `XREAD` of `stream:{generationId}`.
9. A replica with a free slot pulls the lowest-score generation. Tokens flow to the relay, which runs the output safety filter, coalesces tokens into chunks every 100 ms (or 16 tokens), and `XADD`s them with a monotonically increasing `seq`.
10. The gateway forwards each chunk as an SSE event with `id: seq`. On the first token, the quota reservation is committed.
11. On completion, the relay writes the final content, token counts, and `finish_reason` to the assistant message in one UPDATE, appends `done` to the stream log, and emits a usage event. The stream log expires 60 s later.

```
SSE wire format (one generation):

event: meta
data: {"generation_id":"g1","user_message_id":"m1","assistant_message_id":"m2","model":"model-a","quota":{"remaining":17,"resets_at":"2026-10-11T15:12:00Z"}}

event: delta
id: 1
data: {"text":"Sure — here are three"}

event: delta
id: 2
data: {"text":" ways to"}

: heartbeat

event: done
id: 41
data: {"finish_reason":"stop","output_tokens":512}
```

### Flow 2: Resume after a dropped connection

```
seq:        1   2   3   4   5   6   7   8   9  10  11  12  done
relay  ───▶ ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■     (keeps appending to the stream log)
node A ───▶ ■   ■   ■   ■   ✕ connection lost
node B ───────────────────────── GET …/stream  Last-Event-ID: 4 ──▶ replay 5..9, tail 10..12, done
```

1. The client notices the stream ended without `done` (network error, proxy timeout, page reload).
2. It reconnects with `GET /api/v1/generations/:id/stream` and `Last-Event-ID: <last seq rendered>`. The load balancer may route it to any gateway node.
3. The gateway checks ownership, then `XREAD`s the stream log from the entry after that seq: replaying what was missed, then tailing live chunks.
4. If the stream log has already expired (completed more than 60 s ago), the gateway returns `410 Gone` and the client fetches the finished message from the conversation API.

### Flow 3: Stop generating

```
Stop click ──▶ POST /api/v1/generations/g1/cancel { last_seq_seen: 37 }
                 │
                 ▼
Gateway: mark gen:g1 cancel_requested ──▶ still queued?  ZREM from the pool queue, done
                 │ running
                 ▼
PUBLISH ctl:{replica} "cancel g1" ──▶ replica drops g1 from its running batch at the next
                                      decode step, frees its KV memory, reports a free slot
                 │
                 ▼
Relay: persist content through seq 37, status = 'cancelled', append done(cancelled)
```

A closed connection is **not** a cancel. Because streams are resumable, a disconnect most likely means "coming back". Only an explicit cancel, or the orphan reaper, stops a generation (Key Design Decision 3).

### Flow 4: Edit and regenerate

Messages form a tree through `parent_id`, and each conversation stores `current_leaf_id`.

- **Regenerate** reply R: create a new assistant placeholder whose parent is R's parent (the same user message) and start a generation. R stays as a sibling.
- **Edit** user message U: create a new user message whose parent is U's parent, then an assistant placeholder under it. U's whole subtree remains reachable.
- **Switch branch**: `PUT /current-leaf` sets the leaf; the active branch is the path from that leaf to the root.

## Database Schema

Production shards the conversation database by `user_id` (Citus/Vitess-style), so a user's conversations, messages, and generations live on one shard: listing, branch reads, and the "send" transaction are all single-shard. Locally it is one PostgreSQL instance with the same schema.

```sql
CREATE TABLE users (
  id             UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid')),
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  home_region    TEXT NOT NULL DEFAULT 'us',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id),
  title               TEXT,
  model               TEXT NOT NULL,
  current_leaf_id     UUID,                       -- FK added below (circular reference)
  summary             TEXT,                       -- rolling summary of turns before summary_through_id
  summary_through_id  UUID,
  summary_tokens      INT CHECK (summary_tokens IS NULL OR summary_tokens <= 1000),
  archived            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

-- Sidebar: newest-first, keyset pagination on (updated_at, id)
CREATE INDEX idx_conversations_user_recent
  ON conversations (user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id              UUID PRIMARY KEY,               -- client-generated UUIDv7 for user messages = idempotency key
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,                  -- denormalized shard key and ownership check
  parent_id       UUID REFERENCES messages(id),   -- NULL only for the first message
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'complete'
                  CHECK (status IN ('queued', 'streaming', 'complete', 'cancelled', 'failed', 'filtered')),
  finish_reason   TEXT CHECK (finish_reason IN ('stop', 'length', 'cancelled', 'content_filter', 'error')),
  model           TEXT,
  token_count     INT,                            -- computed once at write; context assembly never re-tokenizes
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CHECK (role = 'assistant' OR status = 'complete')
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_parent ON messages (parent_id);

ALTER TABLE conversations
  ADD CONSTRAINT fk_current_leaf FOREIGN KEY (current_leaf_id) REFERENCES messages(id);

CREATE TABLE generations (
  id                   UUID PRIMARY KEY,
  message_id           UUID NOT NULL UNIQUE REFERENCES messages(id),   -- the assistant message being written
  conversation_id      UUID NOT NULL REFERENCES conversations(id),
  user_id              UUID NOT NULL,
  tier                 TEXT NOT NULL CHECK (tier IN ('free', 'paid', 'background')),
  model                TEXT NOT NULL,
  requested_model      TEXT NOT NULL,              -- differs from model when admission degraded the request
  status               TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed', 'rejected')),
  replica_id           TEXT,
  attempt              INT NOT NULL DEFAULT 1,
  input_tokens         INT,
  output_tokens        INT,
  last_seq             INT NOT NULL DEFAULT 0,
  queued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  first_token_at       TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  cancel_requested_at  TIMESTAMPTZ,
  error                TEXT
);

CREATE INDEX idx_generations_active ON generations (status, queued_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX idx_generations_user ON generations (user_id, queued_at DESC);

CREATE TABLE quota_policies (
  tier                TEXT NOT NULL CHECK (tier IN ('free', 'paid')),
  model               TEXT NOT NULL,
  window_seconds      INT  NOT NULL CHECK (window_seconds > 0),
  max_messages        INT  NOT NULL CHECK (max_messages >= 0),
  max_input_tokens    INT  NOT NULL,              -- context budget for system prompt + summary + history
  max_output_tokens   INT  NOT NULL,
  max_concurrent      INT  NOT NULL,
  priority_offset_ms  INT  NOT NULL,              -- added to enqueue time to form the queue score
  max_queue_wait_ms   INT  NOT NULL,              -- admission: degrade or reject beyond this estimate
  fallback_model      TEXT,
  PRIMARY KEY (tier, model)
);

INSERT INTO quota_policies VALUES
  ('free', 'model-a', 10800,   20,  16000, 2000, 1, 10000,  8000, 'model-b'),
  ('free', 'model-b', 10800, 1000,  16000, 2000, 1, 10000, 15000, NULL),
  ('paid', 'model-a', 10800,  200, 120000, 8000, 3,     0, 30000, NULL),
  ('paid', 'model-b', 10800, 2000, 120000, 8000, 3,     0, 30000, NULL);

CREATE TABLE moderation_events (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL,
  message_id     UUID REFERENCES messages(id),
  generation_id  UUID REFERENCES generations(id),
  stage          TEXT NOT NULL CHECK (stage IN ('input', 'output')),
  category       TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('allow', 'warn', 'block', 'retract')),
  score          REAL NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id             BIGSERIAL PRIMARY KEY,
  generation_id  UUID NOT NULL UNIQUE REFERENCES generations(id),   -- one usage row per generation
  user_id        UUID NOT NULL,
  tier           TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INT NOT NULL,
  output_tokens  INT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_user_time ON usage_events (user_id, created_at);
```

### Redis Key Structure

| Key | Type | Purpose | TTL |
|-----|------|---------|-----|
| `sess:{sid}` | Hash | Session (user ID, tier, role) | 30 days sliding |
| `quota:{userId}:{model}:{window}` | String counters | Sliding-window message count (current + previous window) | 2 × window |
| `inflight:{userId}` | Set of generation IDs | Concurrency cap; a set so a crash can't leak a counter | 15 min safety |
| `queue:{region}:{model}` | Sorted set | Pool queue, score = enqueue_ms + priority_offset_ms | None |
| `gen:{id}` | Hash | Status, replica, tier, last_seq, last_reader_at, cancel flag | 1 h |
| `stream:{id}` | Stream | Ordered chunks (`seq`, `type`, `text`) | 60 s after `done` |
| `ctl:{replicaId}` | Pub/sub channel | Cancel signals to the replica running a generation | — |
| `pool:{model}:rate` | Hash | EWMA of dispatches/s, used to estimate queue wait | 5 min |

## API Design

### Conversations

```
GET    /api/v1/conversations?cursor=&limit=50        → Sidebar page, newest first (keyset cursor)
POST   /api/v1/conversations                         → Create (client may supply the ID)
GET    /api/v1/conversations/:id                     → Metadata + active branch + sibling counts
PATCH  /api/v1/conversations/:id                     → Rename, archive
DELETE /api/v1/conversations/:id                     → Soft delete; hard delete after 30 days
PUT    /api/v1/conversations/:id/current-leaf        → Switch branch { leaf_id }
GET    /api/v1/messages/:id/children                 → Siblings and subtrees for branch navigation
```

### Generation

```
POST   /api/v1/conversations/:id/messages            → Send (or edit, with parent_id); responds with an SSE stream
POST   /api/v1/messages/:id/regenerate               → New assistant sibling; responds with an SSE stream
GET    /api/v1/generations/:id/stream                → Resume with Last-Event-ID; 410 if the log expired
POST   /api/v1/generations/:id/cancel                → Stop { last_seq_seen }; idempotent
GET    /api/v1/quota                                 → Remaining messages per model, reset times, in-flight
```

Send request body: `{ "id": "<uuidv7>", "content": "...", "parent_id": "<uuid or null>", "model": "model-a" }`.

| Status | Meaning |
|--------|---------|
| 200 `text/event-stream` | Stream begins with `meta` (and `queued` if waiting) |
| 409 | Message ID exists but belongs to a different conversation or user |
| 429 | Quota or in-flight cap exceeded; body says which, with `resets_at` |
| 503 + `Retry-After` | At capacity: estimated wait exceeds the tier's maximum and no fallback model is available |

SSE event types: `meta`, `queued` (position, ETA), `delta` (text), `notice` (degraded model, retracted content), `done` (`finish_reason`, usage), `error`.

### Admin

```
GET    /api/v1/admin/capacity                        → Replicas, free slots, streams by pool and region
GET    /api/v1/admin/queues                          → Depth, oldest wait, admission decisions by tier
PUT    /api/v1/admin/quota-policies/:tier/:model     → Edit a policy
POST   /api/v1/admin/load-shedding                   → Force free tier to model B, or pause free admissions
```

### Operational

```
GET    /health                                       → Liveness
GET    /health/ready                                 → Redis, PostgreSQL, router reachable
GET    /metrics                                      → Prometheus
```

## Key Design Decisions

### 1. SSE per generation instead of a WebSocket per session

**Chosen: Server-Sent Events** carried on the response to the POST, read with `fetch` + `ReadableStream` (not `EventSource`, which cannot POST or set auth headers). Resume uses a GET with `Last-Event-ID`.

Chat generation is request-shaped: one user message produces one bounded stream of output. SSE matches that exactly. The connection exists only while a reply is generating, so concurrent connections track active streams (~116K average, ~347K peak) instead of open tabs (~2.1M average, 18× more). It is plain HTTP, so it passes through corporate proxies, the CDN, and HTTP/2 multiplexing unchanged, and per-request semantics such as 429 and 503 with `Retry-After` still work. Resume is part of the protocol: event IDs and `Last-Event-ID`.

**Alternative rejected: WebSocket per session.** A socket per open tab holds 2.1M connections for traffic that is idle 95% of the time. It needs sticky routing and a connection registry to deliver a reply to the right socket, a home-grown message ID and acknowledgement protocol for resume, and per-message status codes reinvented on top of frames. Its one real advantage, bidirectional messaging, buys little here: the client sends one message and occasionally a cancel, both of which are ordinary POSTs. WebSocket becomes the right choice if the product adds voice or real-time collaborative chat.

**Cost:** two client code paths (initial POST stream, resume GET), heartbeats every 15 s so idle proxies don't cut long queue waits, and HTTP/1.1 clients limited to six connections per origin (we require HTTP/2).

### 2. Generations decoupled from connections through a stream log

**Chosen: replicas write to a per-generation Redis Stream**; gateways only read it.

If the replica streamed directly into the gateway connection, a dropped connection would leave tokens with nowhere to go, and a gateway deploy would kill every stream on that node (20K at peak). With a shared log, any gateway can serve any reader from any seq: reconnects, reloads, a second tab, and gateway restarts all become "read from seq N".

**Alternatives rejected:**
- *Buffer in gateway memory with sticky resume routing*: no extra infrastructure, but a gateway crash or deploy loses every buffer on the node, and sticky routing fights the load balancer.
- *Kafka topic per region*: durable, but readers would scan a shared partition to find one generation, and producer batching adds latency to every chunk.
- *Write chunks to PostgreSQL*: ~3.5M row writes/s at peak, about 33× the database's entire peak write load for messages.

**Cost:** ~35 Redis shards for ~3.5M appends/s at peak and ~9.7 GB of memory, plus the stream log's retention rule (60 s after `done`), after which resume falls back to the database.

### 3. Explicit cancel, with an orphan reaper, instead of cancel-on-disconnect

**Chosen:** only `POST /cancel` (or the reaper) stops a generation. The cancel carries `last_seq_seen`, so the saved partial reply matches what the user saw.

Stop matters for capacity: if 10% of replies are stopped halfway, propagating the cancel to the batch frees 5% of decode capacity, ~174 replicas at peak. Propagation path: gateway → `ctl:{replica}` pub/sub → the replica removes the sequence at its next decode step and frees its KV memory → the router sees a free slot. Queued generations are just removed from the sorted set.

**Alternative rejected: cancel when the connection closes.** With resumable streams a close is ambiguous: a phone switching from Wi-Fi to LTE looks exactly like a closed tab. Cancelling on close would throw away replies that users come back for, and many proxies don't propagate client disconnects promptly anyway.

**Orphan policy:** a running generation with no reader for 30 s keeps going (it is bounded by `max_output_tokens`, and the reply is saved), **except** for free-tier generations while the pool is saturated, which the reaper cancels. At peak those GPU seconds are worth more to a waiting user than to a reply nobody may read.

### 4. Context assembly: verbatim recent turns plus an asynchronous rolling summary

**Chosen:** a hybrid of truncation and summarization, ordered for a stable prefix.

Input tokens are 8× output tokens (4,000 vs 500 per request), so the context budget is a cost lever as well as a correctness concern. Each tier has an input budget (free 16K, paid 120K of a 128K window, leaving room for the output cap).

```typescript
// Planned: backend/src/conversation/context.ts
function assembleContext(conv: Conversation, branch: Message[], policy: QuotaPolicy): ModelInput {
  const budget = policy.maxInputTokens - SYSTEM_PROMPT_TOKENS - SAFETY_MARGIN;
  const verbatimBudget = Math.floor(budget * 0.75);      // newest turns, word for word
  const tail: Message[] = [];
  let used = 0;
  for (const m of [...branch].reverse()) {               // newest first; token_count stored per message
    if (used + m.tokenCount > verbatimBudget) break;
    tail.unshift(m);
    used += m.tokenCount;
  }
  const dropped = branch.length - tail.length;
  const summary = dropped > 0 && conv.summaryCovers(branch[dropped - 1]) ? conv.summary : null;
  if (dropped > 0 && !summary) enqueueSummaryJob(conv.id, branch[dropped - 1].id);   // background priority
  // Order matters: stable parts first so the model server can reuse the computed prefix across turns.
  return { system: SYSTEM_PROMPT, summary, messages: tail };
}
```

Truncation alone is free and deterministic but silently forgets early constraints ("answer in Spanish", "my project uses Postgres 16"), which users experience as the assistant getting worse the longer they talk. Summarization on every turn costs an extra model call on the critical path, adds latency to time to first token, can introduce errors into the summary, and rewrites the prompt prefix every turn so the model server can never reuse computed prefixes.

The hybrid runs summarization **off the critical path**, at background priority, after a turn completes, and refreshes it only when the verbatim window overflows, so the prefix (system prompt → summary → turns) stays byte-identical for many consecutive turns. If the summary isn't ready, that turn falls back to plain truncation. **Cost:** a summary is lossy and occasionally wrong, and it is one more background model call per long conversation; we store it with `summary_through_id` so it is auditable and regenerable.

### 5. Two admission layers: quotas for fairness over hours, capacity admission for right now

**Chosen:** per-user quotas (Redis sliding windows) and a separate capacity gate in the router with per-tier deadline offsets.

Quotas answer "how much may this user consume today?" and change slowly. Capacity answers "can the fleet serve this in the next few seconds?" and changes every second. Merging them fails both ways: raising a free user's quota doesn't create GPUs, and a capacity crunch shouldn't burn a user's daily allowance.

The queue score is `enqueue_ms + priority_offset_ms` (paid 0 s, free 10 s, background 60 s), and replicas pull the lowest score when they have a free slot. Paid requests go ahead of any free request that arrived less than 10 s earlier, yet a free request can never starve: once it has waited 10 s longer than a new paid arrival, it wins. Admission estimates the wait as (generations ahead) ÷ (pool dispatch rate) and degrades a free request to model B past 8 s, or rejects it with `Retry-After` past 15 s on model B. At peak this is what fits ~347K streams of demand into 250K of capacity: all ~87K paid streams, ~163K free streams on model A, and the remainder on model B or deferred.

**Alternatives rejected:** *strict priority* starves free users indefinitely during a long peak; *preempting running free generations* for paid ones wastes the prefill already spent and visibly breaks a reply mid-sentence; *separate dedicated pools per tier* strand paid capacity idle off-peak.

**Cost:** two systems to tune and explain, and estimated waits are approximate, so a few requests are admitted and then wait longer than promised.

### 6. Safety filters: input before admission, output inside the relay with a short hold-back

**Chosen:** classify the user message before it costs GPU time; classify output in sliding windows inside the relay, holding back the newest 20 tokens (~400 ms at 50 tokens/s) while each window is scored.

Putting the output filter in the relay, before the stream log, means every reader (live, resumed, a second tab) sees the same filtered stream, and the persisted message equals what was streamed. If a later window is flagged, the relay stops generation (freeing the GPU), appends a `notice` event that retracts the reply, and saves the message as `filtered`.

**Alternatives rejected:** *filter the complete reply before showing it* removes streaming entirely (users wait 10 s); *filter at the gateway* runs the classifier once per reader and lets a resume or second tab see different output; *filter on the client* is trivially bypassed.

**Cost:** ~400 ms added to time to first token and a rare, jarring retraction of text the user already read. The hold-back length is the dial between those two.

### 7. Conversation storage: sharded by user, single home region per user

**Chosen:** PostgreSQL sharded by `user_id`, a home region per user, and async replication to a paired region.

Every access pattern is scoped to one user: list my conversations, read a branch, append a turn. Sharding by `user_id` makes the send transaction (user message + placeholder + generation + conversation update) a single-shard ACID write. A single writer region per user avoids multi-master conflicts on a tree structure where a lost update would orphan a branch.

**Alternatives rejected:** *Cassandra keyed by conversation* handles the append rate but gives no transaction across the four writes, and the per-user listing needs a second table kept in sync. *Multi-master across regions* invites conflicting `current_leaf_id` updates for a benefit (writing to a far region) that users rarely need.

**Cost:** a user traveling far from their home region pays cross-region latency on history reads (~100–150 ms), and a regional failover can lose the last few seconds of replicated writes.

### 8. Write each message once at completion, never per token

The assistant placeholder is inserted at send time and updated once with the final content. Per-token writes would be ~17.4M writes/s at peak; per-chunk writes ~3.5M/s. The stream log is the source of truth while streaming; PostgreSQL is the source of truth after `done`. A relay crash mid-stream is handled by continuation (see Failure Handling), with the stream log holding everything generated so far.

## Consistency and Idempotency

- **Send is idempotent by client message ID.** The UUIDv7 the client generates is the primary key. A retried POST hits the existing row and is attached to the existing generation's stream, so a flaky network never creates duplicate turns or double-charges quota. A different user or conversation reusing the ID gets 409.
- **Quota is reserve → commit → release.** Admission reserves one unit (keyed by generation ID). The first streamed token commits it. A generation that fails or is rejected before its first token releases it. A user-initiated cancel after the first token stays charged, so stop-and-regenerate loops can't be used to sample for free.
- **Chunk sequence numbers are gap-free per generation.** The relay assigns `seq` before `XADD`. Clients render a chunk only if `seq == lastSeq + 1`, ignore duplicates, and reconnect from `lastSeq` on a gap, giving exactly-once display on top of at-least-once delivery.
- **The final write is conditional.** `UPDATE messages SET ... WHERE id = $1 AND status IN ('queued', 'streaming')` means a duplicate completion (after a relay retry) or a late completion after a cancel is a no-op.
- **Cancel is idempotent.** Cancelling a finished generation returns 200 with the final status. `last_seq_seen` only ever truncates; it never extends.
- **Branch switches are last-writer-wins** on `current_leaf_id`. Two devices switching branches at once both see a valid branch.
- **Cross-region:** each user has exactly one writer region. Replication to the paired region is asynchronous (RPO of seconds). After failover, a client holding a message ID the new primary doesn't know simply re-sends it; the idempotency key makes that safe.

## Security / Auth

- **Authentication:** session cookie backed by Redis (locally); OAuth/SSO in production. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, and state-changing endpoints require a CSRF token because the cookie rides on POSTs.
- **Authorization:** every conversation, message, and generation lookup includes `user_id` from the session. On a user-sharded database the shard lookup itself enforces tenancy, and the stream endpoint checks `gen:{id}.user_id` before `XREAD`, so a guessed generation ID reveals nothing.
- **Rate limiting:** per-IP at the edge (abuse, credential stuffing), per-user request rate at the gateway, then the quota and in-flight caps above. Signup is rate-limited and verified because free-tier quotas are per account.
- **Rendering untrusted output:** model output is untrusted. The client renders markdown without raw HTML, and remote images in model output are blocked or proxied, because a prompt-injected reply can exfiltrate conversation text through image URLs.
- **Data handling:** conversations are encrypted at rest; deletes are soft for 30 days, then hard-deleted including replicas and the analytics copy (usage events hold counts, not content). Logs carry IDs and token counts, never message content.
- **Admin:** role-based access; admin actions (quota edits, load shedding) are audit-logged.

## Observability

### Metrics

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `chat_ttft_seconds` | Histogram | tier, model, region | Primary user-facing SLO |
| `chat_inter_chunk_gap_seconds` | Histogram | model | Detects stalls and slow replicas |
| `chat_queue_wait_seconds` | Histogram | tier, model | Shows priority working (paid ≪ free) |
| `chat_admission_total` | Counter | tier, decision (admit, degrade, reject) | Load shedding visibility |
| `chat_streams_active` | Gauge | gateway, model | Connection and capacity planning |
| `chat_pool_free_slots` | Gauge | model, region | Saturation signal for admission |
| `chat_cancel_to_free_seconds` | Histogram | model | Proves Stop returns capacity |
| `chat_resume_total` | Counter | outcome (replayed, gone, denied) | Resume health and stream-log TTL sizing |
| `chat_orphans_reaped_total` | Counter | tier | Orphan policy impact |
| `chat_generation_outcome_total` | Counter | finish_reason | Completion SLO; content_filter rate |
| `chat_moderation_total` | Counter | stage, category, action | Safety pipeline volume |
| `chat_context_strategy_total` | Counter | strategy (fits, summary, truncated) | How often history overflows |
| `quota_denials_total` | Counter | tier, model, reason | Quota tuning |

### Logging and Tracing

Structured JSON logs (Pino) keyed by `generation_id`, `conversation_id`, and `user_id`; a trace spans gateway → conversation service → router → replica → relay with timings for every step in the time-to-first-token budget. Content is never logged.

### Alerts

- Paid TTFT p99 > 3 s for 5 minutes
- Free admission rejections > 20% for 10 minutes (capacity planning signal, not a page)
- Cancel-to-free p99 > 2 s (cancels are not reaching replicas)
- Stream completion < 99.9% over 1 hour
- Stream-log memory > 80% (retention too long or reaper not running)

## Failure Handling

| Failure | Detection | Response |
|---------|-----------|----------|
| Client network drop | Stream ends without `done` | Client resumes with `Last-Event-ID`; generation unaffected |
| Gateway node crash or deploy | LB health check | Clients reconnect to another node and resume from the stream log |
| Replica dies mid-generation | No chunk for 5 s, or replica heartbeat lost | Router re-dispatches as a **continuation**: the partial output is appended as an assistant prefix, so seq numbering continues and the text already shown stays valid. If continuation is unsupported for the model, emit `notice: reset` and restart from seq 1 |
| Relay crash | Supervisor restart | Relay reloads `gen:{id}` state and the stream log tail, then continues persisting |
| Stream-log shard failover | Redis Cluster | Generations on the shard switch to the replica. A client that sees a seq gap it can't fill waits for `done` and loads the message from PostgreSQL |
| Conversation DB shard down | Circuit breaker opens (Opossum) | New sends for users on that shard fail fast with 503; in-flight generations finish and queue their final write for retry |
| Moderation service down | Circuit breaker | Fall back to a lightweight local classifier with a stricter threshold; never stream unclassified output |
| Model pool saturated | Free slots = 0, wait estimates rise | Admission degrades free to model B, then rejects with `Retry-After`; reaper cancels free orphans |
| Region outage | GSLB health checks | Promote the paired region's replica; users there lose at most a few seconds of writes; GPU work spills to other regions within residency rules |

Retries: the gateway retries dispatch and persistence with exponential backoff and jitter, but never retries a generation after its first token has been shown except through continuation, because a fresh sample would contradict text the user already read.

## Scalability Considerations

### Horizontal Scaling Path

1. **Gateways** are stateless; scale on active streams (20K per node).
2. **Stream log** shards by generation ID; scale on appends/s (~100K per shard).
3. **Router** shards by (region, model pool); each shard holds one pool's queue in memory with a replicated log for failover.
4. **Conversation DB** shards by `user_id`; at ~104K writes/s peak, 64 shards each take ~1.6K writes/s. Cold conversations (untouched for 90 days) move to object storage as one compacted document each and are rehydrated on open, keeping the hot tier near a few months of growth instead of ~1.1 PB/year.
5. **GPU capacity** spills across regions: the request's context (~16 KB of tokens) is shipped to wherever slots are free, adding one cross-region hop to each chunk (~75 ms) but nothing to throughput. Residency rules restrict EU users' generations and data to EU regions.

### What Breaks First

GPUs, by design: the system runs at 72% of peak demand and sheds free load. Among the non-GPU components, the stream log goes first if chunks aren't coalesced (per-token appends would be ~17.4M/s). Next is the conversation service for very long threads: reading a 2,000-message branch to assemble context on every turn. The fix is caching the assembled branch per conversation (invalidated on append) and reading only messages newer than the summary checkpoint.

### 10× Users

1B DAU means ~347K generations/s at peak, ~3.47M concurrent streams, ~34,700 replicas to serve peak at full quality, ~174 gateway nodes, and ~11 PB/year of history. Everything except the GPU fleet scales linearly with modest cost. The GPU bill forces product levers: smaller default models for free users, tighter free-tier context budgets (prefill is 8× the tokens of decode), prefix reuse across turns, and output caps.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Streaming transport | SSE per generation | WebSocket per session | Connections track active streams (~347K) not tabs (~2.1M); resume built in |
| Stream durability | Redis Streams log per generation | Gateway memory + sticky routing | Any node serves any resume; deploys don't kill streams |
| Cancellation | Explicit cancel + orphan reaper | Cancel on disconnect | A disconnect is ambiguous once streams are resumable |
| Context | Verbatim tail + async rolling summary | Truncation only / summarize every turn | Keeps early constraints without critical-path cost |
| Priority | Deadline offsets (paid 0 s, free 10 s) | Strict priority | Paid goes first; free cannot starve |
| Saturation | Degrade free to model B, then 503 | Preempt running free replies | Avoids wasted prefill and broken replies |
| Quota vs capacity | Separate layers | One combined limit | Fairness over hours and capacity per second are different questions |
| Output safety | Relay filter with 20-token hold-back | Filter whole reply first | Keeps streaming; all readers see identical output |
| Storage | PostgreSQL sharded by user_id | Cassandra by conversation | Single-shard transactions for the send path |
| Regions | Single home region per user | Multi-master | No conflicting writes on the message tree |
| Persistence | One write at completion | Per-chunk writes | 3.5M writes/s at peak is not viable |

## Implementation Notes

**Status: planned.** Nothing is implemented yet. This section describes the intended local build and how it maps to the production design above. All file paths below are planned, not existing.

### Planned Local Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                               Local machine                               │
│                                                                           │
│  ┌───────────────┐     ┌──────────────────┐     ┌──────────────────────┐  │
│  │ Frontend      │────▶│ Round-robin      │────▶│ Gateway instances    │  │
│  │ Vite :5173    │◀────│ proxy :3000      │◀────│ :3001 :3002 :3003    │  │
│  └───────────────┘     └──────────────────┘     └───┬─────────────▲────┘  │
│                                                     │ enqueue     │ XREAD │
│                    ┌────────────────────────────────▼─────────────┴────┐  │
│                    │ Redis :6379 — sessions · quotas · pool queues ·   │  │
│                    │ stream logs · cancel pub/sub                      │  │
│                    └───────────────────────────────▲───────────────────┘  │
│                                                    │ pull · XADD · cancel │
│  ┌───────────────────┐       ┌─────────────────────┴──────────────────┐   │
│  │ PostgreSQL :5432  │◀──────│ Mock model workers 1–2 (4 slots each,  │   │
│  │ users · messages  │       │ 30 tokens/s) + relay + summarizer      │   │
│  └───────────────────┘       └────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

The proxy on :3000 is deliberately **not** sticky, so a resumed stream usually lands on a different gateway instance than the one that started it. That makes resume across nodes a real, observable property of the local build rather than an assumption.

### Production-Grade Patterns Planned

| Pattern | Why it matters at scale | Planned location |
|---------|-------------------------|------------------|
| Idempotent send (client UUIDv7 as message PK) | Retries over flaky mobile networks must not duplicate turns or charge quota twice | `backend/src/gateway/send.ts` (planned) |
| Stream log + `Last-Event-ID` resume | Streams survive client drops and gateway restarts | `backend/src/shared/stream-log.ts` (planned) |
| Deadline-offset priority queue | Paid first under saturation without starving free | `backend/src/shared/queue.ts` (planned) |
| Sliding-window quotas (reused from the Rate Limiter project) | Fair per-user consumption | `backend/src/shared/quota.ts` (planned) |
| Cancel propagation over pub/sub | Stop returns GPU slots | `backend/src/worker/cancel.ts` (planned) |
| Circuit breakers (Opossum) | Moderation, PostgreSQL, and model-provider outages fail fast | `backend/src/shared/circuit-breaker.ts` (planned) |
| Prometheus metrics (prom-client) | TTFT, queue wait by tier, cancel-to-free | `backend/src/shared/metrics.ts` (planned) |
| Structured logging (Pino) | Correlate one generation across gateway, worker, and relay | `backend/src/shared/logger.ts` (planned) |
| Health checks | `/health` and `/health/ready` for the proxy | `backend/src/gateway/health.ts` (planned) |
| Edge rate limiting | Per-IP and per-user request limits before quota logic | `backend/src/shared/rate-limit.ts` (planned) |

A brief sketch of the planned admission check:

```typescript
// Planned: backend/src/shared/admission.ts
const ahead = await redis.zcount(`queue:${model}`, '-inf', score);   // generations that will be served first
const rate = await dispatchRate(model);                              // EWMA of pulls per second
const estimatedWaitMs = (ahead / Math.max(rate, 0.1)) * 1000;
if (estimatedWaitMs > policy.maxQueueWaitMs) {
  return policy.fallbackModel ? { decision: 'degrade', model: policy.fallbackModel }
                              : { decision: 'reject', retryAfterS: Math.ceil(estimatedWaitMs / 1000) };
}
return { decision: 'admit' };
```

### What Will Be Simplified or Simulated

| Production | Local substitute |
|------------|------------------|
| GPU replica pools with continuous batching | Mock workers with N slots that emit canned or echoed text at a fixed tokens/s; `MODEL_PROVIDER=api` can swap in a real model API |
| Safety classifiers | Keyword and regex classifier with configurable latency; a trigger phrase forces a mid-stream retraction for testing |
| Summarizer model | The mock worker produces an extractive summary (first sentence of each old turn) |
| Tokenizer | Approximate count (characters ÷ 4) stored per message |
| Inference router service | Library over Redis sorted sets; workers pull with a Lua pop-lowest-score script |
| Sharded PostgreSQL, home regions, DR replica | One PostgreSQL instance; `home_region` stored but unused |
| Redis Cluster for stream logs | One Redis instance |
| OAuth/SSO | Session auth with Redis |

### What Will Be Omitted

- CDN, WAF, GSLB, and multi-region failover
- Kafka and ClickHouse analytics (usage rows go straight to PostgreSQL)
- Cold-conversation tiering to object storage
- Continuation after a replica crash (locally the generation is marked failed and the client offers Regenerate)
- Kubernetes, autoscaling, and real GPU capacity planning
- File uploads, tools, voice, and public sharing
