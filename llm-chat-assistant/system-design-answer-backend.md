# LLM Chat Assistant - System Design Answer (Backend Focus)

*60-minute system design interview format - Backend Engineer Position*

> Reported as "Design ChatGPT" and "Chat assistant inference service: streaming, free-tier limits, GPU scheduling" (OpenAI) and "Design Claude's chat service" (Anthropic). Candidate-reported; see [FUTURE_PROJECTS.md](../FUTURE_PROJECTS.md#sources).

## 🎯 Introduction (2 minutes)

"Thanks. I'll design the backend of a ChatGPT-style chat service. I'm going to treat the model as a black box: something I can submit a prompt to, read a token stream from, and cancel. What makes this problem interesting isn't the model, it's that GPUs are scarce and expensive, replies take ten seconds to stream, and users expect the experience of a fast web app anyway. So I'll focus on five things: a streaming gateway whose streams survive dropped connections, conversation storage and context assembly, free-tier quotas and paid-over-free priority when the GPUs saturate, a Stop button that actually frees GPU capacity, and where safety filters sit when output is streamed. At the end I'll cover multi-region history and failure modes. Let me start with requirements."

---

## 📋 Requirements Clarification (3 minutes)

### Functional Requirements

1. **Chat** - Send a message in a conversation and receive a streamed reply
2. **History** - List, open, rename, and delete conversations from any device
3. **Branching** - Edit an earlier message or regenerate a reply without losing the old branch
4. **Stop** - Halt a reply mid-stream; keep the partial text
5. **Resume** - A reply survives a dropped connection or page reload
6. **Tiers** - Free and paid tiers with per-model message quotas, context budgets, and output caps
7. **Saturation behavior** - Paid traffic keeps flowing when GPUs are full; free users queue, degrade to a smaller model, or get "at capacity"
8. **Safety** - Classify input before generation and output while it streams

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Time to first token (paid, unsaturated) | p50 < 1 s, p99 < 3 s |
| Stream completion | > 99.9% of replies finish and are persisted |
| Stop → GPU slot freed | p99 < 500 ms |
| Completed message durability | Never lost after the final event; cross-region RPO of seconds |
| API availability | 99.95% |

### Clarifying Questions I'd Ask

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Do I own the model server? | Decides whether batching is in scope | No: black box with submit, stream, cancel, and a free-slot signal |
| Are free users a large share of traffic? | Drives admission design | Yes: 75% of generations are free tier |
| Must history be available in every region? | Shapes replication | Readable everywhere, written in one home region per user |
| Tools, files, voice? | Each adds a subsystem | Out of scope for this round |

---

## 📊 Capacity Estimation (4 minutes)

"Let me size this, because the numbers decide the architecture."

| Assumption | Value |
|------------|-------|
| Daily active users | 100M |
| Messages per user per day | 10 |
| Output tokens per reply | 500 |
| Input (context) tokens per request | 4,000 |
| Streaming speed | 50 tokens/s, so a reply streams for 10 s |
| Paid share of generations | 25% |
| One model replica (black box) | 100 concurrent streams |

| Derived | Calculation | Result |
|---------|-------------|--------|
| Generations/day | 100M × 10 | 1B |
| Average rate | 1B / 86,400 s | ~11.6K/s |
| Peak rate | 3× average | ~35K/s |
| Concurrent streams | rate × 10 s (Little's law) | ~116K average, ~347K peak |
| Output tokens/s | rate × 500 | ~5.8M average, ~17.4M peak |
| Input tokens/s | rate × 4,000 | ~46M average, ~139M peak (8× output) |
| Replicas for peak | 347K / 100 | ~3,470 |
| Replicas for average | 116K / 100 | ~1,160 |
| Storage | 1B turns × ~3 KB | 3 TB/day, ~1.1 PB/year |
| Database writes | 3 per turn | ~35K/s average, ~104K/s peak |

> "Three conclusions. First, provisioning for peak means buying ~3,470 replicas to use ~1,160 on average, so I'll assume the business provisions 2,500 replicas, which is 250K streams or 72% of peak. That makes admission control a core component, not an afterthought: at peak, ~97K streams of demand don't fit. Second, the per-token path must never touch the database: 17.4M tokens/s is not a write rate any database takes. Third, input tokens outnumber output 8 to 1, so the context I send is a cost lever, not just a correctness concern."

---

## 🏗️ High-Level Architecture (5 minutes)

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

> "The one structural decision I want to call out before anything else: the generation is decoupled from the HTTP connection. Replicas never write to a client socket. Tokens go from the replica to a relay, which filters them, coalesces them into chunks, and appends them to a per-generation stream log. Gateways only read that log. So a dropped connection, a gateway deploy, or a page reload changes who is reading, never what is being generated."

### Core Components

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| Stream gateway | Auth, idempotency, quota, admission, SSE writing, cancel | Stateless Node services |
| Quota store | Sliding-window message counts, in-flight sets, sessions | Redis Cluster |
| Conversation service | Read the active branch, assemble context, persist turns | Service over PostgreSQL sharded by user_id |
| Inference router | Per-pool priority queue, wait estimates, orphan reaping | Regional service, sharded by model pool |
| Model replicas | Generate with continuous batching, honor cancel | GPU nodes (black box) |
| Generation relay | Output safety filter, chunking, final write, usage events | Sidecar next to each replica |
| Stream log | Ordered chunks per generation for live tailing and resume | Redis Streams, 60 s retention after completion |

### One Message, Briefly

1. The client POSTs the message with a client-generated UUIDv7 that doubles as the idempotency key.
2. The gateway checks quota and the in-flight cap, runs the input classifier, and asks the router for an admission decision.
3. In one single-shard transaction it inserts the user message, an assistant placeholder, and a generation row.
4. The conversation service assembles the context, and the router enqueues the generation with a tier-dependent score.
5. A replica with a free slot pulls it. The relay writes chunks to the stream log; the gateway tails the log and forwards each chunk as an SSE event whose ID is a sequence number.
6. On completion, the relay writes the final content to the placeholder in one UPDATE and appends a done event.

---

## 💾 Data Model (4 minutes)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), email (unique), tier, role, home_region | email | Tier is free or paid; home_region pins writes |
| conversations | id, user_id, title, current_leaf_id, summary, summary_through_id, updated_at, deleted_at | (user_id, updated_at DESC, id) where not deleted | Sidebar uses keyset pagination on (updated_at, id) |
| messages | id (client UUIDv7), conversation_id, user_id, parent_id, role, content, status, finish_reason, token_count | (conversation_id, created_at), (parent_id) | parent_id makes a tree; status: queued → streaming → complete, cancelled, failed, filtered |
| generations | id, message_id (unique), user_id, tier, model, requested_model, status, replica_id, last_seq, timestamps | (status, queued_at) partial on active, (user_id, queued_at) | One per assistant message; requested_model records degradation |
| quota_policies | (tier, model) PK, window, max_messages, max_input_tokens, max_output_tokens, max_concurrent, priority_offset, max_queue_wait, fallback_model | PK | Admin-editable; cached in every gateway |
| usage_events | generation_id (unique), user_id, model, input_tokens, output_tokens | (user_id, created_at) | Feeds analytics; one row per generation |

> "Messages are a tree, not a list. Regenerate creates a new assistant sibling under the same user message; edit creates a new user sibling under the same parent. The conversation stores current_leaf_id, and the active branch is the path from that leaf to the root. Nothing is ever overwritten, so every branch stays navigable."

> "I store token_count on every message when it's written. Context assembly then becomes arithmetic over stored integers instead of re-tokenizing a long history on every turn."

**Sharding:** by user_id. Every access pattern is scoped to one user, so listing, branch reads, and the four-row send transaction are all single-shard. At ~104K writes/s peak, 64 shards take ~1.6K writes/s each.

**Write pattern:** three writes per turn: insert the user message, insert the placeholder, and update the placeholder once at completion. Never per token or per chunk.

### Policy Defaults

| Tier | Model | Quota (rolling 3 h) | Input budget | Output cap | In-flight | Queue offset | Max wait |
|------|-------|---------------------|--------------|------------|-----------|--------------|----------|
| Free | Model A | 20 messages, then model B | 16K tokens | 2K tokens | 1 | 10 s | 8 s, then degrade to model B |
| Free | Model B | 1,000 messages | 16K tokens | 2K tokens | 1 | 10 s | 15 s, then 503 "at capacity" |
| Paid | Model A | 200 messages | 120K tokens | 8K tokens | 3 | 0 s | 30 s |

---

## 🔌 API Design (2 minutes)

```
GET    /api/v1/conversations?cursor=&limit=50       → Sidebar page, newest first
GET    /api/v1/conversations/:id                    → Metadata + active branch + sibling counts
PATCH  /api/v1/conversations/:id                    → Rename, archive
DELETE /api/v1/conversations/:id                    → Soft delete
PUT    /api/v1/conversations/:id/current-leaf       → Switch branch
POST   /api/v1/conversations/:id/messages           → Send or edit (with parent_id); response is an SSE stream
POST   /api/v1/messages/:id/regenerate              → New assistant sibling; response is an SSE stream
GET    /api/v1/generations/:id/stream               → Resume from Last-Event-ID; 410 if the log expired
POST   /api/v1/generations/:id/cancel               → Stop, with last_seq_seen; idempotent
GET    /api/v1/quota                                → Remaining messages per model and reset times
GET    /api/v1/admin/queues                         → Depth, wait, and admission decisions by tier
```

| SSE event | Carries | When |
|-----------|---------|------|
| meta | message IDs, generation ID, model actually used, quota remaining | First event on every stream |
| queued | position, estimated wait | While waiting for a slot |
| delta | text, with the SSE id set to a gap-free sequence number | Every ~100 ms of output |
| notice | model degraded, or content retracted | Rare |
| done | finish reason, token usage | Last event |

Errors that happen before streaming starts use normal HTTP status codes: 429 for quota or the in-flight cap, 503 with Retry-After for capacity. That's a quiet advantage of keeping the stream on an HTTP response.

---

## 🔧 Deep Dive 1: The Streaming Gateway and Resumable Streams (8 minutes)

### Decision: SSE per generation, not a WebSocket per session

**Why SSE works here:** Chat generation is request-shaped. One user message produces one bounded stream of output, and SSE is exactly a streamed HTTP response. The connection exists only while a reply is generating, so concurrent connections equal active streams: ~116K on average and ~347K at peak, which at an assumed 20K streams per gateway node is 18 nodes at peak before redundancy. It rides plain HTTP/2, so corporate proxies, the CDN, and multiplexing work unchanged, and pre-stream errors keep real status codes. Resume is part of the protocol: every event has an ID, and a reconnecting client sends Last-Event-ID. The browser reads it with fetch and a stream reader, not EventSource, because EventSource can't POST or set headers.

**How the WebSocket alternative breaks:** A socket per open tab holds a connection for the whole session, and users keep the app open far longer than it is generating. At 100M users with ~30 minutes open per day, that's ~2.1M concurrent sockets on average, 18× the active streams, almost all idle. Delivering a reply means finding the right socket, so we need sticky routing and a connection registry. Resume needs a home-grown acknowledgement protocol. Status codes for quota and capacity get reinvented inside frames. And the one real advantage, bidirectionality, buys almost nothing: the client sends one message and occasionally a cancel, both ordinary POSTs.

**What I give up:** Two client code paths (the POST stream and the resume GET), a heartbeat comment every 15 s so idle proxies don't kill a stream that's waiting in the queue, and a dependence on HTTP/2, because HTTP/1.1 browsers cap each origin at six connections. If the product adds voice or live collaborative chat, I'd revisit WebSocket.

| Approach | Connections at average load | Resume | Errors | Verdict |
|----------|-----------------------------|--------|--------|---------|
| ✅ SSE per generation | ~116K (active streams) | Last-Event-ID built in | HTTP status codes | Chosen |
| ❌ WebSocket per session | ~2.1M (open tabs) | Custom ack protocol | Reinvented in frames | Too much state for idle traffic |
| ❌ Long polling | One request per chunk | Natural | HTTP | ~3.5M requests/s at peak |

### Decision: decouple generation from the connection with a stream log

**Why it works:** The relay appends each chunk to a Redis Stream keyed by generation ID, with a gap-free sequence number. Any gateway node can serve any reader by reading from "the entry after seq N", so reconnects, a page reload, a second tab, and a gateway deploy all reduce to the same operation. The client renders a chunk only if its seq is exactly one more than the last it rendered, which gives exactly-once display on top of at-least-once delivery.

```
seq:        1   2   3   4   5   6   7   8   9  10  11  12  done
relay  ───▶ ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■   ■     (keeps appending)
node A ───▶ ■   ■   ■   ■   ✕ connection lost
node B ───────────────────────── GET …/stream  Last-Event-ID: 4 ──▶ replay 5..9, tail 10..12, done
```

**How the alternatives break:**
- *Replica streams straight into the gateway's socket.* A dropped connection leaves tokens nowhere to go, and a deploy of one gateway node kills up to 20K live replies at once.
- *Buffer in gateway memory with sticky resume routing.* No new infrastructure, but a crash or deploy still loses every buffer on the node, and sticky routing fights the load balancer during exactly the events (deploys, failovers) when clients reconnect.
- *Write chunks to PostgreSQL.* ~3.5M writes/s at peak, about 33× the entire peak write load of the message tables.

**The cost, sized:** I coalesce tokens into chunks every 100 ms or 16 tokens. At peak that's 347K streams × 10 chunks/s = ~3.5M appends/s, or ~35 Redis shards at 100K appends/s each. Memory is ~4 KB per stream; with 347K live streams plus 60 s of completed ones retained (~2.08M), that's ~9.7 GB. After the 60 s retention, resume falls back to reading the finished message from PostgreSQL, and the gateway returns 410 so the client knows to do that.

> "The persistent store and the stream log have a clean handoff. While the reply is streaming, the stream log is the source of truth. After the done event, PostgreSQL is. The placeholder row is updated exactly once, conditionally on its status still being queued or streaming, so a duplicate completion is a no-op."

### Idempotent send

The client generates the user message ID and it's the primary key. A retried POST, say after a mobile network blip where the request landed but the response didn't, finds the existing row and is attached to the existing generation's stream. No duplicate turn, no double charge. If a different user or conversation presents the same ID, it gets 409.

---

## 🔧 Deep Dive 2: Admission, Priority, and Cancellation Under GPU Scarcity (9 minutes)

### Decision: two separate layers, quotas and capacity admission

**Why two layers:** They answer different questions on different timescales. A quota asks "how much may this user consume over the next three hours?" and is about fairness and the business model. Capacity admission asks "can the fleet start this reply in the next few seconds?" and changes every second. Quotas are sliding-window counters in Redis (the same design as the rate limiter project), plus an in-flight set per user: free users get one in-flight generation, paid get three, so opening ten tabs doesn't multiply anyone's share of the GPUs.

**How merging them breaks:** If quota is the only lever, a capacity crunch can only be handled by lowering everyone's quota, which punishes users for hours to fix a problem that lasts twenty minutes, and raising a quota later doesn't create GPUs. If capacity is the only lever, a handful of heavy free users can consume the fleet whenever it's quiet and nothing bounds their daily cost.

### Decision: deadline-offset priority, not strict priority

The router keeps one queue per model pool per region, ordered by score = enqueue time + tier offset: paid 0 s, free 10 s, background jobs such as titles and summaries 60 s. Replicas pull the lowest score whenever they have a free slot. Pull rather than push matters because only the replica knows its true headroom: a request with 100K tokens of context takes far more memory than one with 2K.

**Why it works:** Under no contention the offset is invisible, because everything is served immediately. Under saturation a paid request goes ahead of any free request that arrived less than 10 s before it, so paid latency is protected. But a free request can never starve: once it has waited 10 s longer than a new paid arrival, it wins.

**How strict priority breaks:** During a long evening peak, paid arrivals never stop, so the free queue never drains. Free users don't see "slow", they see "never", and they retry, which makes the queue longer.

**Admission on top of the queue:** For each new request the router estimates the wait as (generations with a lower score) ÷ (the pool's recent dispatch rate). A free request whose estimate exceeds 8 s on model A is degraded to the smaller model B pool, with a notice event telling the client. If model B's estimate exceeds 15 s, it gets 503 with Retry-After. Paid requests wait up to 30 s. At peak, this is how ~347K streams of demand fit into 250K of capacity: all ~87K paid streams, ~163K free streams on model A, which is 63% of free demand, and the remaining ~97K on model B or deferred.

**What I give up:** Two systems to tune and explain, and wait estimates are approximations, so a few requests are admitted and then wait a bit longer than promised.

| Approach | Paid latency at peak | Free users at peak | Verdict |
|----------|----------------------|--------------------|---------|
| ✅ Deadline offsets + degrade + 503 | Protected | Bounded wait, then smaller model, then explicit retry | Chosen |
| ❌ Strict priority | Protected | Starve during long peaks | Retry storms |
| ❌ Preempt running free replies | Protected | Replies cut mid-sentence | Wastes prefill already spent |
| ❌ Dedicated pools per tier | Protected | Unaffected by paid | Paid capacity idles off-peak |

### Decision: explicit cancel that reaches the batch, plus an orphan reaper

**Why it matters for capacity:** Assume 10% of replies are stopped about halfway. If the cancel actually reaches the GPU, that frees 5% of decode capacity, ~174 replicas at peak. If Stop only closes the client's connection, all of that is wasted generating text nobody reads.

**The path:** The client POSTs cancel with last_seq_seen. The gateway marks the generation cancelled in Redis. If it's still queued, we remove it from the sorted set and we're done. If it's running, we publish a cancel on the control channel of the replica that owns it; the replica drops that sequence from its running batch at the next decode step, frees its KV memory, and reports a free slot to the router. The relay persists the content up to last_seq_seen, so what's saved is exactly what the user saw, and appends a done event with reason cancelled. My target is p99 under 500 ms from click to free slot.

**Why not cancel on disconnect:** Once streams are resumable, a closed connection is ambiguous. A phone moving from Wi-Fi to LTE looks exactly like a closed tab. Cancelling on close would discard replies users come back for, and many proxies don't propagate client disconnects promptly anyway.

**The orphan reaper:** A running generation with no reader for 30 s normally keeps going: it's bounded by the output cap and the reply is saved to history. The exception is free-tier generations while the pool is saturated, which the reaper cancels, because at peak those GPU seconds are worth more to a free user waiting in the queue.

**Quota accounting:** Admission reserves one unit, keyed by generation ID. The first streamed token commits it. A failure or rejection before the first token releases it. A user-initiated stop after the first token stays charged, otherwise stop-and-regenerate becomes a free sampling loop.

---

## 🔧 Deep Dive 3: Context-Window Assembly (5 minutes)

### Decision: verbatim recent turns plus an asynchronous rolling summary

Each tier has an input budget: 16K tokens for free, 120K for paid out of a 128K window, leaving room for the output cap. Assembly is arithmetic over stored token counts:

1. Start with the system prompt and any custom instructions; they are pinned and always included.
2. Walk the active branch from the newest message backwards, adding whole turns until 75% of the remaining budget is used.
3. If older turns were left out and the conversation has a rolling summary covering them (at most 1,000 tokens), include it between the system prompt and the verbatim turns.
4. If older turns were left out and no summary covers them yet, send this turn with plain truncation and enqueue a summarization job at background priority.
5. Order everything as system prompt → summary → turns, so the beginning of the prompt is byte-identical from one turn to the next.

**Why it works:** Truncation keeps every recent turn exactly, and the summary preserves the early constraints that users notice when they vanish: "answer in Spanish", "my project uses Postgres 16". Summarization runs off the critical path after a turn completes, so it adds nothing to time to first token. And because I refresh the summary only when the verbatim window overflows, not every turn, the prompt prefix stays stable across many turns, which lets the model server reuse work it already did for that prefix. With input at 8× output tokens, that reuse is a real cost lever.

**How the alternatives break:** *Truncation only* is free and deterministic, but the assistant silently forgets the user's early instructions, which reads as the product getting worse the longer you talk to it. *Summarizing on every turn* puts an extra model call on the critical path, adds seconds to time to first token, compounds summary errors turn after turn, and rewrites the prompt prefix every time, so nothing can be reused.

**What I give up:** Summaries are lossy and occasionally wrong. I store the summary with the ID of the last message it covers, so it can be audited and regenerated, and every long conversation costs one extra background model call per overflow.

| Strategy | Critical-path cost | Remembers early constraints | Prefix stability | Verdict |
|----------|--------------------|-----------------------------|------------------|---------|
| ✅ Verbatim tail + async summary | None | Mostly | Stable for many turns | Chosen |
| ❌ Truncation only | None | No | Shifts as turns drop | Silent forgetting |
| ❌ Summarize every turn | One model call | Mostly | Changes every turn | Slow, costly |
| ❌ Send everything | None | Yes | Stable | Breaks at the window; prefill cost grows without bound |

---

## 🛡️ Safety Filters on the Streaming Path (3 minutes)

"There are two checkpoints, and where each sits matters more than the classifier itself."

1. **Input, before admission.** Classifying the user message costs ~50 ms and happens before we spend GPU time. A block returns a refusal and the request never enters the queue.
2. **Output, inside the relay, before the stream log.** The relay scores sliding windows of output while holding back the newest 20 tokens, ~400 ms at 50 tokens/s. If a window is flagged, the relay cancels the generation (freeing the GPU), appends a notice that retracts the reply, and saves the message as filtered.

> "Putting the output filter in the relay rather than the gateway means it runs once per generation, not once per reader, and every reader, including a resumed stream or a second tab, sees identical output. The persisted message equals what was streamed."

| Placement | Streaming kept | Consistent across readers | Verdict |
|-----------|----------------|---------------------------|---------|
| ✅ Relay with 20-token hold-back | Yes, +~400 ms to first token | Yes | Chosen |
| ❌ Classify the whole reply first | No, users wait ~10 s | Yes | Kills the product |
| ❌ At the gateway | Yes | No, each reader filtered separately | Divergent output |
| ❌ In the client | Yes | No | Trivially bypassed |

The cost is the hold-back latency and a rare retraction of text the user already read. The hold-back length is the dial between those two. If the classifier service is down, I fall back to a lightweight local classifier with a stricter threshold rather than streaming unclassified output.

---

## 🌍 Multi-Region Conversation History (3 minutes)

**Decision:** every user has one home region where their conversations are written, asynchronously replicated to a paired region.

- The edge routes each user's API calls to their home region based on a claim in the session token.
- GPU work is not pinned to the home region. When the home region's pool is full, the router ships the assembled context, ~16 KB for 4,000 tokens, to a region with free slots. That adds one cross-region hop to each chunk, ~75 ms, and nothing to throughput. Residency rules apply: EU users' data and generations stay in EU regions.
- On a region outage, the paired region is promoted. Replication is asynchronous, so the last few seconds of writes can be lost; client-generated message IDs make re-sending those safe.

**Why not multi-master:** Users almost never write to one conversation from two continents at once, and the message tree makes conflicts nasty: two regions advancing current_leaf_id or appending to the same parent concurrently would need tree-aware merge logic for a case that barely exists. The cost of single-home is ~100–150 ms of extra latency on history reads for a traveling user.

---

## 🚨 Failure Handling (2 minutes)

| Failure | Response |
|---------|----------|
| Client network drop | Client resumes from Last-Event-ID; the generation never noticed |
| Gateway node dies | Clients reconnect to any node and resume from the stream log |
| Replica dies mid-reply | No chunk for 5 s → the router re-dispatches as a continuation, with the partial output as an assistant prefix, so the text already shown stays valid and seq numbering continues |
| Stream-log shard fails over | A client that sees a seq gap it can't fill waits for done, then loads the message from PostgreSQL |
| DB shard down | Circuit breaker fails new sends for that shard fast with 503; in-flight replies finish and queue their final write |
| Pool saturated | Degrade free to model B, then 503 with Retry-After; reap free orphans |

> "One rule I hold firmly: never retry a generation from scratch after its first token has been shown. A fresh sample contradicts text the user already read. Continuation or an explicit reset notice, never a silent swap."

---

## 📈 Scalability and What Breaks First (2 minutes)

- **GPUs break first, by design.** We run at 72% of peak demand and shed free-tier load gracefully. That's a product decision expressed in admission control.
- **Among non-GPU parts, the stream log goes first if chunks aren't coalesced.** Per-token appends would be ~17.4M/s; coalescing to 100 ms brings it to ~3.5M/s.
- **Next, very long threads.** Reading a 2,000-message branch to assemble context on every turn is slow. Cache the assembled branch per conversation, invalidate on append, and read only messages newer than the summary checkpoint.
- **Storage grows ~1.1 PB/year.** Conversations untouched for 90 days move to object storage as one compacted document each and are rehydrated when opened.
- **Gateways and stream-log shards** are stateless or easily sharded and scale linearly with active streams.

---

## ❓ Follow-up Questions (3 minutes)

**"What if we get 10× more users?"** Peak becomes ~347K generations/s, ~3.47M concurrent streams, ~34,700 replicas to serve peak at full quality, ~174 gateway nodes, and ~11 PB/year of history. Everything except GPUs scales linearly at modest cost. The GPU bill forces product levers: a smaller default model for free users, tighter free-tier context budgets (input is 8× output tokens), prefix reuse across turns, and output caps.

**"A data center goes down mid-reply?"** In-flight replies on that region's replicas are re-dispatched as continuations in a surviving region. The paired region is promoted for conversation writes, losing at most a few seconds of replicated history. Clients reconnect through the edge and resume from their last seq, or reload the message once it lands.

**"Two-week MVP?"** One region, one PostgreSQL, SSE straight from the model API through a single gateway with an in-memory buffer, per-user message counters in Redis, truncation-only context, input moderation only, and a global concurrency cap with a "busy" message. I'd keep two things from day one: client-generated message IDs, because idempotency is painful to retrofit, and the message tree with parent_id, because migrating a flat message list into branches later is a data migration on the largest table.

**"Why not pause a free reply when a paid request arrives?"** Preemption throws away the prefill already done and visibly freezes a reply mid-sentence. Gating admission achieves the same priority without breaking anyone's reply.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Transport | SSE per generation | ❌ WebSocket per session | ~116K active streams vs ~2.1M idle sockets; resume built in |
| ✅ Stream durability | Redis Streams log per generation | ❌ Gateway memory + sticky routing | Any node serves any resume; deploys don't kill replies |
| ✅ Persistence | One write at completion | ❌ Per-chunk writes | ~3.5M writes/s at peak is not viable |
| ✅ Admission | Quotas + separate capacity gate | ❌ One combined limit | Fairness over hours vs capacity per second |
| ✅ Priority | Deadline offsets (paid 0 s, free 10 s) | ❌ Strict priority | Paid first, free never starves |
| ✅ Saturation | Degrade to model B, then 503 | ❌ Preempt free replies | No wasted prefill, no broken replies |
| ✅ Stop | Explicit cancel to the batch + orphan reaper | ❌ Cancel on disconnect | Disconnects are ambiguous once streams resume |
| ✅ Context | Verbatim tail + async summary | ❌ Summarize every turn | No critical-path cost; stable prefix |
| ✅ Output safety | Relay filter, 20-token hold-back | ❌ Classify the whole reply | Keeps streaming; identical for every reader |
| ✅ Regions | Single home region per user | ❌ Multi-master | No tree merge conflicts |

---

## 📝 Summary

> "To summarize: the architecture is built around one idea, that a generation is a server-side object with its own lifecycle, independent of any HTTP connection. Replicas write to a per-generation stream log; stateless gateways read from it over SSE, so dropped connections and gateway deploys become a resume from a sequence number. Because GPUs are provisioned at 72% of peak, admission control is first-class: per-user quotas handle fairness over hours, a deadline-offset priority queue protects paid latency without starving free users, and saturated free requests degrade to a smaller model before being told to retry. Stop is an explicit cancel that reaches the batch, worth ~174 replicas at peak, and disconnects are deliberately not cancels. Context assembly keeps recent turns verbatim and folds older ones into an asynchronous summary so the prompt prefix stays stable. Safety runs on input before admission and on output in the relay, so every reader sees the same filtered stream. History lives in one home region per user, sharded by user ID, written once per message. The trade-off I'd highlight is that I'm deliberately running the most expensive resource hot and investing the engineering in deciding who waits, rather than buying capacity for the peak."
