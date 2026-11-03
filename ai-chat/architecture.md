# AI Chat Client - Architecture

## System Overview

A multi-user AI chat product in the shape of ChatGPT or Claude.ai. Each user has conversations; every answer streams token by token from a model; users stop answers, regenerate them, edit earlier messages to branch the conversation, and use the same account on several devices at once. The model-serving API is treated as an existing dependency. This design is about the product around it.

The design rests on one idea: **an answer is a server-owned generation with its own ID and state machine, not a response to an HTTP request.** The request only creates it. A worker produces it into a replayable event log, and PostgreSQL checkpoints it. Any client, on any device, can attach to it, detach, and reattach without creating another.

**Learning goals**

- Make a long-running, streamed result survive navigation, refresh, dropped connections and server restarts.
- Distinguish *retry* (same request, same result) from *regenerate* (a new answer) from *edit* (a new branch), in the data model and on the wire.
- Keep client live state keyed by generation, so switching conversations neither cancels nor leaks a stream.
- Render untrusted model output incrementally, fast and safely.
- Fan changes out across a user's devices without making pub/sub the source of truth.

This is ROADMAP entry 2. It reuses the generation lifecycle, executor leases and SSE resume from [prompt-playground](../prompt-playground/architecture.md).

## Requirements

### Functional Requirements

- Sign in; list conversations by recency; rename and delete them.
- Start a conversation with its first message; continue it; choose a model per message.
- Stream answers; Stop an answer (cancelling the model request) and keep the partial text.
- Regenerate any answer (a new sibling); edit any user message (a new branch); navigate versions (‹ 2/3 ›).
- Survive refresh, reconnects and closed tabs mid-answer, with no duplicated or lost text and no second generation.
- See answers started on another device appear, including while they stream.
- Read long conversations (thousands of messages) smoothly.
- Read recently opened conversations offline (read-only).
- Operators: watch generation health and inject latency, failures and disconnects.

### Non-Functional Requirements

| Requirement | Target (production) |
|-------------|---------------------|
| Availability | 99.95% for reading history; 99.9% for starting generations |
| Time to first token overhead | ≤ 150 ms p95 added on top of model TTFT |
| Token-to-screen latency | ≤ 100 ms p95 from the model emitting a token to it being painted |
| Resume | 100% of reconnects within the stream TTL resume without gaps or duplicates |
| Duplicate generations from client retries | 0 (idempotency per user action) |
| Durability of partial output | At most one checkpoint interval (2 s) of text lost if both the worker and the live log die |
| History load | Newest page of a 5,000-message conversation in ≤ 300 ms p95 |
| Output safety | No script execution or remote fetch caused by model output |

## Capacity Estimation

### Production Scale

| Quantity | Estimate | Derivation |
|----------|----------|------------|
| Daily active users | 5 M | Assumption (the interview answers use the same baseline) |
| Answers per user per day | 15 | Assumption |
| Generations per second | ~870 average, ~3,500 peak | 75 M per day ÷ 86,400 s, × 4 for peak |
| Answer length | ~400 tokens over ~10 s | Typical chat answer at 40–60 tokens/s |
| Concurrent generations | ~35 K at peak | 3,500/s × 10 s |
| Live log appends | ~700 K/s at peak | 20 delta events per second per generation (50 ms flush) |
| PostgreSQL statements | ~50 K/s at peak, of which ~17.5 K/s are checkpoints | ~15 per generation: create, claim, first token, context, ~2 lease renewals, ~4 checkpoints (35 K ÷ 2 s), finalize |
| Message storage | ~75 GB/day, ~27 TB/year | 150 M rows/day (question + answer) × ~0.5 KB |
| Device streams | ~1.5 M open | About 1.5 open tabs or apps per concurrently online user |

**What these numbers imply.** Tokens must stay out of PostgreSQL: the live log is an in-memory, sharded system (a Valkey cluster), and entries expire an hour after the answer ends. PostgreSQL holds the durable record, sharded by user at 10× (50 M daily users, about 500 K statements per second), since conversations never span users. Checkpoints are the largest share of PostgreSQL writes, which is why the checkpoint policy is the first knob to tune. Connection count, not request rate, sizes the SSE tier.

### Local Development Scale

Three seeded users, 11 conversations, 344 messages (one 300-message thread). One API instance, one executor running at most 8 generations, a mock model with 16 slots. Everything runs on a laptop with PostgreSQL and Valkey in Docker.

## High-Level Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Web client   │  │ Desktop app  │  │ Mobile app   │
│ (React SPA)  │  │ (main proc.) │  │              │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ HTTPS: REST + SSE (per generation, per user)
       ▼
┌────────────────────────────────────────────────────┐
│ CDN (static shell) · API gateway (auth, rate limit)│
└──────────────────────┬─────────────────────────────┘
                       ▼
┌────────────────────────────────────────────────────┐        ┌─────────────────┐
│ Chat API (stateless, N instances)                  │──pub──▶│ Valkey cluster  │
│ conversations · tree reads · generation create ·   │◀─XREAD─│ gen:{id}:events │
│ cancel · SSE: generation stream, device stream     │        │ user:{id} pubsub│
└────────────┬───────────────────────┬───────────────┘        │ queue, sessions │
             │ SQL                   │ enqueue (doorbell)     └────────┬────────┘
             ▼                       ▼                                 │ XADD deltas
┌───────────────────────┐   ┌───────────────────────────────┐          │
│ PostgreSQL (sharded   │◀──│ Generation executors (N)      │──────────┘
│ by user): convs,      │   │ claim w/ lease · build context│
│ messages, generations │   │ stream · checkpoint · finalize│
└───────────────────────┘   └──────────────┬────────────────┘
                                           │ streaming HTTP (abortable)
                                           ▼
                            ┌───────────────────────────────┐
                            │ Model serving API (existing)  │
                            └───────────────────────────────┘
```

## Core Components

### 1. Conversations and the message tree

A conversation's messages form a tree. A user message's parent is the assistant message it replies to (NULL for the first message). An assistant message's parent is the user message it answers.

- **Edit** inserts a new user message under the *same parent* as the edited one: a sibling, and so a new branch.
- **Regenerate** inserts a new assistant message under the same user message: a sibling answer.
- **Current leaf.** `conversations.current_leaf_id` records the branch the user last looked at. The visible thread is the path from the root to it.
- **Branch navigation.** Choosing a sibling asks the server for the *newest message in that sibling's subtree*. Children are always created after their parents, so the newest descendant is a leaf, and the path to it is "the latest state of that branch". The server stores it as the current leaf, so a reload or another device shows the same branch.
- **Reading.** The newest page (40) of the visible path is read by walking up parent pointers with a recursive CTE, and older pages continue from the oldest loaded message. Each message carries `siblingIds` (children of its parent, oldest first), which is all the client needs for ‹ 2/3 ›. Branches not on the path are never sent.

`depth` is stored on every message (parent depth + 1); it makes path pages easy to check and is the natural key for a materialized-path index at scale. `created_at` uses `clock_timestamp()` so a user message and its assistant placeholder, inserted in one transaction, still sort in creation order.

### 2. Generation lifecycle

```
          POST (Idempotency-Key)          executor claim (lease, attempt+1)
 client ───────────────────────▶ accepted ─────────────────────────────▶ running
                                    │                                    │  │  │
                       Stop: cancel │                       model done ──┘  │  └── error / disconnect /
                        immediately ▼                                       ▼      idle timeout / lease lost
                                cancelled ◀──── Stop: abort model ──── completed      failed (partial kept)
```

1. **Create.** One transaction locks the conversation row, checks that nothing is in flight in it, inserts the user message (unless regenerating), the empty assistant placeholder and the generation, and moves the current leaf. After the commit, the API appends a `status: accepted` event and rings the queue doorbell, then publishes `generation.created` to the user's devices.
2. **Claim.** An executor conditionally updates `accepted → running`, increments `attempt` and sets a 15 s lease. A duplicate doorbell finds nothing to claim.
3. **Context.** The executor walks up from the user message, collecting about twice the token budget, then trims to the model's budget (newest first; the message being answered is always kept). The walk is bounded, so a huge conversation doesn't read every row to build one prompt.
4. **Stream.** Tokens accumulate in memory and are appended to `gen:{id}:events` every 50 ms. A heartbeat every 5 s renews the lease and notices cancellation flags (a backstop for a missed pub/sub signal).
5. **Checkpoint.** Every 2 s the executor writes the output *published so far* and the Valkey entry ID of the last published delta to `generations.output` / `checkpoint_event_id`. The pairing is the point: checkpoint text + the events after that ID = the full output.
6. **Finalize.** One transaction writes the terminal status, output, usage and timings, copies the output into the assistant message, and bumps `conversations.updated_at`. Only *after* the commit is `end` appended, so a client that sees `end` and re-reads gets the final row. `generation.finished` then goes to the user's devices.

Every executor write is conditioned on `id, attempt, status = 'running'` (fencing), so a worker that stalled past its lease and was failed by the sweeper cannot overwrite the outcome.

### 3. Streaming and resume

The generation stream (`GET /generations/:id/events`) is SSE. Each event's SSE `id` is its Valkey stream entry ID. The API reads with `XREAD BLOCK` from the client's `Last-Event-ID` (or from the start), so:

- a dropped connection resumes exactly after the last event the client applied, on any API instance;
- a refreshed page loads the conversation over REST, gets the in-flight generation's checkpoint text and `checkpointEventId`, seeds the text and resumes after that ID, so it doesn't replay thousands of tokens;
- a second device replays the answer so far, then continues live;
- after the log expires (1 h after `end`), a finished generation is served from PostgreSQL as one `snapshot` event.

Appends go through a Lua script: once `end` exists, the stream refuses every further append. A generation can't get two endings, and a woken-up stale worker can't add text after the end.

### 4. Cancellation

`POST /generations/:id/cancel` cancels an `accepted` generation immediately. For a running one it sets `cancel_requested_at` and publishes the ID on `generations:cancel`. The owning executor aborts its fetch to the model; the model sees the client disconnect and stops generating. The executor then finalizes `cancelled` with the partial output (`output_truncated = true`). The cancel response is `202` while the outcome is still pending; whichever of `cancelled` or `completed` commits first wins, and the stream reports it.

### 5. Multi-device sync

Every tab or app holds one device stream, `GET /events`. Each API instance keeps a single subscriber connection and subscribes to `user:{id}:events` only while that user has a device connected to it (reference counted). Events are hints: `generation.created` (with the full create result, so a device viewing the conversation can append it and attach to the stream), `generation.finished`, `conversation.updated`, `conversation.deleted`. Pub/sub drops messages for disconnected devices, so every (re)connect starts with a `ready` event, and the client then reconciles from REST (conversation list, active generations).

### 6. Client state and rendering

- **Generations store keyed by generation ID.** Streams are owned by the store and a module-level registry, never by components. An assistant message subscribes only to its own generation's entry. Switching conversations therefore neither cancels a stream nor leaks its tokens. When an answer ends, the store writes it into its own conversation's thread (and the offline cache) wherever the user is.
- **Batching.** Deltas are buffered and committed once per animation frame for all streaming generations; hidden tabs flush every 500 ms.
- **Forward-only merge.** A generation's status only moves forward, so a REST reply computed before the stream's `end` can't move it backwards (the Stop race).
- **Markdown.** marked is used as a lexer only; tokens become React elements. Top-level blocks are memoized by their source text, so only the last block re-renders while streaming. Raw HTML renders as text, links are restricted to http/https/mailto, and images are never fetched.
- **Long threads.** Path pages of 40, `@tanstack/react-virtual`, follow-scroll only within 80 px of the bottom, and scroll anchoring when older pages are prepended.
- **Offline.** One IndexedDB database per user (sidebar list, newest 60 messages of the 20 most recently opened conversations), read-only, deleted on sign-out; a production service worker caches only the static shell.

## Database Schema

The full schema is `backend/src/db/init.sql`. The core tables:

```sql
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT 'New chat',
  model           text NOT NULL,
  current_leaf_id uuid REFERENCES messages (id) ON DELETE SET NULL, -- added after messages
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX conversations_user_recent
  ON conversations (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES messages (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL DEFAULT '',   -- assistant: written once, at the end
  depth           int  NOT NULL CHECK (depth >= 0),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_children ON messages (conversation_id, parent_id, created_at);

CREATE TABLE generations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_message_id      uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  assistant_message_id uuid NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('message', 'edit', 'regenerate')),
  model                text NOT NULL,
  status               text NOT NULL DEFAULT 'accepted'
                       CHECK (status IN ('accepted', 'running', 'completed', 'cancelled', 'failed')),
  idempotency_key      text NOT NULL,
  request_hash         text NOT NULL,
  attempt              int  NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_expires_at     timestamptz,
  output               text NOT NULL DEFAULT '',  -- checkpoint while running, final afterwards
  checkpoint_event_id  text,                      -- Valkey entry the checkpoint covers
  checkpointed_at      timestamptz,
  output_truncated     boolean NOT NULL DEFAULT false,
  finish_reason        text,
  error_code           text,
  error_message        text,
  input_tokens         int,
  output_tokens        int,
  context_messages     int,
  context_dropped      int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  enqueued_at          timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  first_token_at       timestamptz,
  finished_at          timestamptz,
  cancel_requested_at  timestamptz,
  UNIQUE (user_id, idempotency_key)
);
-- Two devices submitting at once: one generation, one 409.
CREATE UNIQUE INDEX generations_one_active_per_conversation
  ON generations (conversation_id) WHERE status IN ('accepted', 'running');
CREATE INDEX generations_active ON generations (status, lease_expires_at)
  WHERE status IN ('accepted', 'running');
```

**Why `output` lives on the generation and `content` on the message.** The message is the durable node in the tree; the generation is the attempt that produces it. While running, readers take the text from the generation's checkpoint. When it ends, the text is copied into the message in the same transaction as the terminal status, so history reads never join to attempt data.

### Valkey keys

| Key | Type | Purpose | Lifetime |
|-----|------|---------|----------|
| `gen:{id}:events` | Stream | status, delta and end events; SSE resume source | 1 h after `end` |
| `gen:{id}:ended` | String | Guard: no appends after `end` | 1 h |
| `generations:queue` | Stream + consumer group | Doorbell for executors (read with NOACK) | Trimmed to ~10 K |
| `generations:cancel` | Pub/sub | Tell the owning executor to abort | — |
| `user:{id}:events` | Pub/sub | Device sync hints | — |
| `session:{id}` | String | Session | 7 days |
| `ratelimit:{bucket}:{window}` | Counter | Fixed-window limits | Window + 1 s |
| `settings:stream-drop-after-events` | String | Admin knob: end browser streams after N events | Until cleared |

## API Design

```
POST   /api/v1/auth/login | /logout          GET /api/v1/auth/me
GET    /api/v1/models

GET    /api/v1/conversations?cursor=&limit=  sidebar (keyset on updated_at, id)
POST   /api/v1/conversations                 first message: conversation + messages + generation   [Idempotency-Key]
GET    /api/v1/conversations/:id             conversation + newest page of the visible path
GET    /api/v1/conversations/:id/messages?before=:messageId   older page
PATCH  /api/v1/conversations/:id             rename
DELETE /api/v1/conversations/:id             soft delete; cancels its in-flight generation
POST   /api/v1/conversations/:id/messages    new message, or edit (editOfMessageId)                [Idempotency-Key]
POST   /api/v1/conversations/:id/messages/:messageId/regenerate                                  [Idempotency-Key]
PUT    /api/v1/conversations/:id/leaf        branch navigation { messageId }

GET    /api/v1/generations/active            the caller's in-flight generations (reattach)
GET    /api/v1/generations/:id
POST   /api/v1/generations/:id/cancel        202 while pending, 200 once final
GET    /api/v1/generations/:id/events        SSE; Last-Event-ID (or ?after=) resumes
GET    /api/v1/events                        SSE; device sync for the caller

GET    /api/v1/admin/overview                GET|PUT /api/v1/admin/model-settings   PUT /api/v1/admin/stream-drop
```

Sending a message:

```
POST /api/v1/conversations/5f0c…/messages
Idempotency-Key: 8d2b…            (one per Send click; retries reuse it)
{ "content": "Which neighborhoods are quiet?", "parentMessageId": "a1…" }

202 Accepted                      (200 + Idempotent-Replayed: true on a retry)
{ "conversation": {…, "activeGenerationId": "g7…"},
  "userMessage": { "id": "u9…", "parentId": "a1…", "siblingIds": ["u3…", "u9…"], … },
  "assistantMessage": { "id": "a9…", "content": "", "generation": {…} },
  "generation": { "id": "g7…", "status": "accepted", "checkpointEventId": null, … } }
```

The generation stream:

```
id: 1793678102871-0
event: status
data: {"status":"running","attempt":1,"at":"…"}

id: 1793678102876-0
event: delta
data: {"text":"Here is how I would think about "}

id: 1793678104244-0
event: end
data: {"status":"completed","outputTruncated":false,"finishReason":"stop","usage":{"inputTokens":11,"outputTokens":92,"queueMs":8,"ttftMs":363,"durationMs":1981},…}
```

| Error | When |
|-------|------|
| `400 IDEMPOTENCY_KEY_REQUIRED` | POST that asks the model without a key |
| `409 GENERATION_IN_PROGRESS` (+ `generationId`) | Another answer is in flight in this conversation |
| `422 IDEMPOTENCY_KEY_REUSED` | Same key, different request |
| `422 INVALID_PARENT` / `INVALID_EDIT` | A user message must follow an assistant message; an edit must share the edited message's parent |
| `429 TOO_MANY_ACTIVE_GENERATIONS` / `RATE_LIMITED` | 4 in flight per user / 30 per minute |
| `404 NOT_FOUND` | Unknown ID *or another user's* conversation, message or generation |

## Key Design Decisions

### 1. Executors own generations, not the HTTP request

Running the model call inside the POST handler ties the answer to one connection and one process. A refresh, a proxy timeout or a deploy kills it, and there is nothing to reattach to. With executors, the POST returns in milliseconds, the work survives the client entirely, and any API instance can serve its stream. The cost is a queue, leases and a sweeper. The queue is only a doorbell: ownership is the conditional claim in PostgreSQL, and the sweeper re-rings lost doorbells, so a Valkey restart delays generations but never loses them.

### 2. Live tokens in a Valkey stream, PostgreSQL at checkpoints and on completion

| Option | Resume after refresh | Write load | Loss if a worker dies |
|--------|---------------------|------------|-----------------------|
| ✅ Valkey stream + checkpoint every 2 s + final write | From checkpoint, then exact replay | One small append per 50 ms in memory; one row update per 2 s | Nothing (sweeper rebuilds from the stream); ≤ 2 s if Valkey also died |
| ❌ Only store completed messages | Replay impossible after a restart; partial answers vanish | Lowest | Whole partial answer |
| ❌ Write every token to PostgreSQL | Exact | 20+ row updates per second per stream: about 700 K/s at peak | Nothing |

The pairing of checkpoint text with the entry ID it covers is what makes the checkpoint usable for resume. Without the ID, a client can't know where in the stream the checkpoint ends.

### 3. One in-flight generation per conversation

Two devices submitting into one conversation at the same instant could each create a branch. Both would be valid in the tree, but the conversation would then have two answers racing, and the visible leaf would be whichever finished last. I chose to serialize instead: the create transaction locks the conversation row and checks for an in-flight generation, and a partial unique index backs it up. The loser gets `409` with the winner's ID; its client attaches to that stream and keeps the user's text for Retry. Throughput within one conversation drops to one answer at a time, which matches how people use chat.

### 4. Retry, regenerate and edit are different requests

A retry carries the same idempotency key and returns the existing generation (`200`, replayed). Reusing a key for a different body is `422`. Regenerate and edit always mint new keys, because they ask for something new. The client reuses a key only while the outcome is unknown (connect failure, timeout, 502/503/504). After a definitive rejection nothing was created, so the next attempt is a new request.

### 5. Never auto-retry after the first token

Before the first token, an overloaded or unreachable model is retried with backoff (up to three attempts, reproducing the same answer because the generation ID seeds it). After the first token, failures end the generation as `failed` with the partial output kept. A silent restart would show a different answer and bill twice. The user decides, with Regenerate.

### 6. SSE over fetch, two streams per tab at most

Data flows one way, and Stop is a durable REST call anyway, so WebSockets would add a protocol without adding value. The client reads SSE with `fetch` rather than EventSource, so it can send `Last-Event-ID` on the *first* request (to resume from a REST checkpoint) and handle 401/404 as fatal. Each tab holds the device stream plus one stream per in-flight generation; with one in-flight generation per conversation, that is usually two.

## Consistency and Idempotency

The six review questions:

1. **Source of truth; when is a write successful?** PostgreSQL. A send is accepted when the create transaction commits (the 202). An answer is final when the terminal row commits; `end` is appended only after that.
2. **Client retries after losing the response?** Same `Idempotency-Key` → the original generation, even if the user is now over a limit (the retry asks for nothing new). Concurrent requests with the same key race on `UNIQUE (user_id, idempotency_key)`; the loser rolls back and replays the winner.
3. **Failure between two steps?** Commit, then enqueue: if the enqueue fails, the generation stays `accepted` and the sweeper re-enqueues it after 30 s. Executor dies mid-stream: the lease lapses after 15 s, and the sweeper fails it with `EXECUTOR_LOST`, keeping the streamed text (rebuilt from the stream, or the checkpoint if longer). Commit then `end`: if the append fails, an idle reader finds the terminal row and sends a `snapshot`.
4. **Ordering.** Total order within a generation (stream entry IDs). One in-flight generation per conversation. Device events are unordered hints. Sidebar order is by `updated_at`, bumped on create and finalize.
5. **Access through caches and async paths.** Every conversation, message and generation route loads through the owner (`c.user_id = $user`), and another user's IDs are 404. The SSE stream is authorized before it opens, and the session is re-checked whenever the stream idles (15 s), so signing out elsewhere closes it. Device channels are per user. The offline cache is one IndexedDB per user, deleted on sign-out; the service worker never caches API responses.
6. **What breaks first.** See Scalability Considerations.

## Security / Auth

- Session cookie (httpOnly, SameSite=Lax), session data in Valkey; production would add CSRF tokens for cross-site POSTs, or rely on SameSite plus an Origin check.
- Authorization in PostgreSQL per request, never cached in the session.
- Rate limits: login 20/min per IP; generations 30/min per user; 4 in flight per user.
- Model output is untrusted. The client renders it without any HTML path (raw HTML as text, link protocol allowlist, no image loads), and production adds a strict CSP.
- Admin routes require the `admin` role; the model knobs exist only in this local build.

## Observability

Prometheus metrics per process (`/metrics`):

| Metric | Why |
|--------|-----|
| `chat_generations_created_total{model,kind}` | Traffic mix: message vs edit vs regenerate |
| `chat_idempotent_replays_total` | How often clients lose responses |
| `chat_generations_finished_total{model,status}` | Failure and cancel rates |
| `chat_generation_queue_seconds`, `chat_generation_ttft_seconds{model}` | Where latency comes from |
| `chat_checkpoints_written_total` | Checkpoint write volume (the PostgreSQL cost driver) |
| `chat_sse_connections{kind}` | Generation vs device streams per instance: the SSE tier's sizing signal |
| `chat_stream_resumes_total` | Reconnects with Last-Event-ID: network quality and deploy impact |
| `mock_model_generations_total{outcome}`, `mock_model_active_generations` | Upstream health, including aborts after Stop |

Structured JSON logs (pino) with `generationId` and `attempt` on every executor line. `/health` and `/ready` (PostgreSQL + Valkey) on the API.

## Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Browser connection drops | Reconnect with backoff 0.5–8 s, resume after Last-Event-ID |
| API instance dies | Clients reconnect to another instance; no state lost |
| Executor crashes or stalls | Lease expires → sweeper fails it with partial output; fenced writes stop the stale worker |
| Model returns 429/5xx before first token | Up to 3 attempts with backoff; then `MODEL_UNAVAILABLE` |
| Model errors or drops mid-answer | `MODEL_ERROR` / `MODEL_DISCONNECTED`, partial kept, no auto-retry |
| Model stalls | 30 s without tokens → `MODEL_TIMEOUT` |
| Model service unhealthy | Circuit breaker (opossum) opens on stream-open failures |
| Valkey restart | Queue group recreated; sweeper re-enqueues accepted generations; readers finish from PostgreSQL |
| Queue backlog | Accepted generations older than 5 min fail with `QUEUE_TIMEOUT` instead of spinning |
| API down behind a proxy | Client treats 502/503/504 or a bare 5xx as unreachable: offline mode, retries keep the key |

## Scalability Considerations

- **SSE connections (first to break).** Each open generation stream holds a blocking Valkey reader. At thousands of streams per instance that is a connection-count problem before it is a CPU problem. The fix is one multiplexed reader per instance (one `XREAD` over many keys) fanning out in process. Evidence: `chat_sse_connections` against Valkey `connected_clients`.
- **Checkpoint writes.** At a 2 s interval, checkpoints are about 17.5 K row updates per second at today's peak and 175 K at 10×. Checkpointing on size or time (every 1 KB or 5 s) and sharding PostgreSQL by user keep that in check.
- **PostgreSQL size.** Shard by `user_id` (a conversation never spans users); move cold conversations to cheaper storage; keep messages append-only.
- **Valkey.** Cluster mode works as is: keys carry a `{generationId}` hash tag, so the append script touches one slot. The live log is bounded by TTL.
- **Deep trees.** The recursive walks are bounded by page size (reads) and token budget (context). The latest-leaf lookup scans a subtree; at scale I'd maintain a `latest_leaf_id` per message, updated on insert.
- **Executors.** Horizontal; they coordinate only through PostgreSQL leases.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Who runs the model call | Executors with leases | The POST handler | Survives refresh, deploys and dropped connections |
| Live output | Valkey stream per generation | Only final messages / every token in PostgreSQL | Exact resume without a write storm |
| Durability while streaming | Checkpoint text + event ID every 2 s | No checkpoints | Refresh resumes mid-answer; bounded loss |
| Concurrent submits | One in flight per conversation, 409 | Parallel branches | Predictable conversations |
| Retry semantics | Idempotency key + request hash | Disabled button only | Lost responses don't duplicate answers |
| After first token | Never auto-retry | Silent restart | No surprise second answer or double bill |
| Transport | SSE over fetch | WebSocket / EventSource | One-way; resume from a REST checkpoint |
| Device sync | Pub/sub hints + REST reconcile | Events as the record | Pub/sub drops messages |
| Client live state | Store keyed by generation ID | Component state | A→B switch without cancel or leak |
| Rendering | Lexer → React elements | HTML + sanitizer | No HTML path for model output |
| Offline | Per-user IndexedDB, read-only | No offline / offline sends | Useful, safe, small |

## Implementation Notes

### Local architecture

| Process | Port | Entry point |
|---------|------|-------------|
| API | 3000 | `backend/src/api/index.ts` (`dev:server1..3` for 3001–3003) |
| Executor | 3200 | `backend/src/executor/index.ts` (`dev:executor2` adds a second) |
| Mock model | 3100 | `backend/src/model/index.ts` |
| Frontend | 5173 | `frontend/src/main.tsx` (Vite proxies `/api`) |
| PostgreSQL 16, Valkey 7 | 5432, 6379 | `docker-compose.yml` (host ports overridable) |

### Production-grade patterns actually implemented

- **Idempotent creation with request hashing** (`api/services/generations.ts`). The same key returns the same generation; a different body is 422; concurrent same-key requests replay the winner. Reused only while the outcome is unknown (`frontend/src/services/chat-actions.ts`).
- **Lease + attempt fencing + sweeper** (`executor/generation-executor.ts`, `executor/sweeper.ts`). Every write is `WHERE id = $1 AND attempt = $2 AND status = 'running'`.
- **Append-once-ended log** (`shared/generation-events.ts`), a Lua script that refuses appends after `end`.
- **Checkpoints paired with event IDs.** Verified live: checkpoint text + events after `checkpointEventId` = the stored final output, byte for byte.
- **One in-flight generation per conversation** (row lock + partial unique index). Verified live: two simultaneous submits → one `202`, one `409` naming the winner.
- **Circuit breaker** on opening the model stream (opossum), retry before the first token only.
- **Prometheus metrics, pino logs, health and readiness checks, fixed-window rate limits.**
- **Session revalidation on long-lived streams** (`shared/auth.ts: sessionStillValid`).
- **Client**: generation-keyed store with rAF batching and forward-only merge (`stores/generations-store.ts`); safe incremental markdown (`lib/markdown.tsx`); virtualized thread with follow-at-bottom and prepend anchoring (`components/chat/MessageList.tsx`); per-user IndexedDB cache (`services/offline-cache.ts`); app-shell service worker in production builds (`public/sw.js`).

### Simplified or substituted

- **Mock model service** instead of a provider: deterministic markdown answers seeded by the generation ID, with knobs for TTFT, tokens/s, error rate, silent mid-stream disconnects and concurrency (429). A separate API knob ends browser streams after N events, so client resume can be watched.
- **Valkey streams as the queue** instead of RabbitMQ/Kafka (the queue is only a doorbell).
- **Single PostgreSQL**, no sharding; **session cookies** instead of OAuth/JWT.
- **Context truncation by estimated tokens** (4 characters per token), not a real tokenizer.
- **Title** from the first message's first words, not a model call.

### Omitted

CDN, multi-region, Kubernetes, PostgreSQL sharding, the multiplexed SSE reader, a real tokenizer, attachments, search, the desktop app and the assistant-sidebar variant (both discussed in `system-design-answer-frontend.md`).

### Verified locally

Backend vitest (29 tests), frontend vitest (16 tests: renderer safety, the A→B switch, completion landing, checkpoint resume, the Stop race), `tsc` and `vite build`. Live against Docker: streaming, exact resume from a mid-stream `Last-Event-ID` and from a checkpoint, 8 forced stream drops reassembling the exact output, Stop aborting the model request (model active slots 1 → 0), mid-stream model errors and disconnects, two-device 409, edit/regenerate/branch switching, cross-user 404 on every route, path and sidebar pagination, conversation switching mid-stream, refresh mid-stream, offline reload from IndexedDB with the API down (and with a fully offline browser through the service worker), automatic recovery when the API returns, and the device stream delivering a second tab's live answer. 9 screenshots and 9/9 generated smoke tests.
