# AI Chat Client — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Generation lifecycle → Deep dives → Scale*

> "This looks like a messages table and one `POST /chat` endpoint, and that's the trap. The interesting object isn't the message, it's the *generation*: one attempt by the model to write one assistant message. It runs for five to sixty seconds, longer than a connection is reliable, a tab stays open, or an API process lives through a deploy. So my design treats a generation as a durable record with its own state machine, owned by an executor through a lease, with its tokens in a replayable log and its partial output checkpointed. The other half is that messages form a tree, because edits and regenerations create branches. Most of this answer is those two ideas and the races around them."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Scope without inference, capacity math that keeps tokens out of PostgreSQL |
| Architecture | ~6 min | Stateless API, executors as the only model callers, two kinds of SSE stream |
| Data model | ~5 min | Message tree, generation record, current-leaf pointer |
| API | ~5 min | 202 vs 200 replay, 409 for a busy conversation, the SSE contract |
| Generation lifecycle | ~8 min | State machine, a successful and a failed trace, Stop |
| Deep dives | ~13 min | Who owns a generation, where partial output lives, one writer per conversation |
| Scale and wrap-up | ~3 min | What breaks first at 10× and 100×, with the evidence |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Is model serving in scope? | Decides whether this is an inference interview | No. A model API streams tokens and can be slow, answer 429, fail, or drop mid-stream |
| Must an answer survive closing the tab? | Whether a generation is tied to a connection | Yes. Refresh, navigate away or switch devices and the answer keeps going |
| Can a user edit an earlier message? | Linear list vs tree | Yes, and regenerate any answer. Old versions stay reachable |
| Same account on several devices? | Fan-out and concurrency | Yes: laptop, phone, desktop app, all live |
| Shared conversations or teams? | Authorization model | Out of scope. Every conversation has one owner |
| How long are conversations? | Pagination and context | Up to thousands of messages; the model sees a budgeted window |

### Functional requirements

1. A sidebar of conversations, most recent first. Rename, delete.
2. Send a message and watch the answer stream token by token. Stop it at any time and keep what was written.
3. Edit an earlier user message: a new branch from that point. Regenerate an answer: another answer to the same question. Navigate between versions.
4. Reconnect, refresh or open the conversation on another device mid-answer and see the same generation continue, never a new one.
5. Long conversations open fast and page backwards.
6. An operator view of generation health, plus knobs to make the model slow, fail or disconnect.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Acceptance | p99 < 150 ms for the POST | It records and enqueues; it never waits for the model |
| Token to screen | ≤ 100 ms p95 after the model emits it | 50 ms delta batching is most of the budget |
| Resume | A reconnect loses nothing, duplicates nothing, starts nothing | Drives the per-generation log |
| One click, one generation | Even when the POST's response is lost | Tokens cost money, and a second sample is a different answer |
| No silent loss | Every accepted generation ends visibly: completed, cancelled or failed | Drives leases and the sweeper |
| Isolation | Nobody reads another user's conversation, including through the stream | Every query is scoped by owner |
| Availability | 99.9% for the product | End-to-end availability is capped by the model provider |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Generations | 75M/day ≈ 870/s average, ≈ 3,500/s peak | 5M daily users × 15 answers, 4× peak factor |
| Concurrent generations | ≈ 35,000 | 3,500/s × ~10 s per answer (≈ 400 tokens at 40–60 tokens/s) |
| Open generation streams | ≈ 45,000 | ≈ 1.3 viewers per generation (second device, reconnects) |
| Open device-sync streams | ≈ 1–2M | One mostly idle stream per open tab or app window |
| Live-log appends | ≈ 700K/s | 20 appends/s per generation (50 ms batches) × 35K |
| PostgreSQL statements | ≈ 50K/s at peak | ≈ 15 per generation: the create transaction, claim, first token, context, ~2 lease renewals, ~4 checkpoints, the finalize transaction |
| Storage | ≈ 300 GB/day | ≈ 4 KB per exchange, including the generation record |

> "Two numbers shape the design. Seven hundred thousand appends a second for output that matters for about an hour is exactly what I don't want in PostgreSQL, so live tokens get their own store. And fifty thousand statements a second is past a comfortable single primary, so the relational data shards by user from the start. Most of those statements are checkpoints and lease renewals, which makes the checkpoint interval a real cost knob, not a detail."

---

## 🏗️ Architecture (~6 min)

```
┌────────────────────┐        ┌───────────────────────────────────────────────────────┐
│ Clients            │ HTTPS  │ Load balancer / API gateway                           │
│ web · phone ·      ├───────▶│ TLS · session cookie · /events routes to stream fleet │
│ desktop app        │◀─ SSE ─┤                                                       │
└────────────────────┘        └──────────┬─────────────────────────────┬──────────────┘
                                (1) REST │                (5) SSE x 2  │
                      ┌──────────────────▼───────────┐  ┌──────────────▼──────────────┐
                      │ Chat API (stateless)         │  │ Stream service              │
                      │ conversations · messages     │  │ per-generation log replay   │
                      │ generations · admin          │  │ per-user device events      │
                      └───┬──────────────────────┬───┘  └──────────────┬──────────────┘
       (2) one txn:       │    (3) append status │                     │ blocking read,
   user msg, placeholder, │      enqueue, publish│                     │ subscribe
     generation, leaf     │                      │                     │
           ┌──────────────▼───────┐   ┌──────────▼─────────────────────▼──────────────┐
           │ PostgreSQL (by user) │   │ Valkey cluster                                │
           │ source of truth      │   │ gen:{id}:events log · generations:queue       │
           │ tree · generations   │   │ cancel channel · user:{id}:events pub/sub     │
           └──────────────▲───────┘   │ sessions · rate-limit counters                │
                          │           └──────────▲─────────────────────▲──────────────┘
   (6) claim, renew,      │                      │ (6) pull ids        │ (8) deltas 50 ms,
   checkpoint, finalize   │                      │                     │ end, finished
           ┌──────────────┴──────────────────────┴─────────────────────┴──────────────┐
           │ Generation executors (N): 15 s lease · 5 s heartbeat · 2 s checkpoint     │
           │ context builder · retry before first token · circuit breaker · sweeper    │
           └───────────────────────────────────┬──────────────────────────────────────┘
                                               │ (7) streaming HTTP, aborted on Stop
                                    ┌──────────▼───────────┐
                                    │ Model API (existing) │
                                    └──────────────────────┘
```

**Walking the diagram:**

1. The client posts a message with an `Idempotency-Key`. The API authorizes, validates and applies limits.
2. In one transaction it locks the conversation, checks nothing is in flight, inserts the user message, an empty assistant placeholder and the generation (`accepted`), and moves the conversation's current-leaf pointer. **The commit is acceptance.**
3. It appends `status: accepted` to the generation's log, rings the queue doorbell, publishes `generation.created` on the user's channel, and answers `202`.
4. The user's other devices receive that event over their device stream and can attach too.
5. Each device opens the generation's SSE stream, which replays the log from its `Last-Event-ID` and then tails it.
6. An executor pulls the ID, claims the row with a conditional update and a lease, and builds the model context from the tree.
7. It streams from the model. It is the only component that calls the model.
8. Every 50 ms it appends a `delta`; every 2 s it checkpoints to PostgreSQL. At the end it commits the outcome, then appends `end` and publishes `generation.finished`.

**Three placement decisions worth stating:**

- **PostgreSQL is the only source of truth.** Valkey holds the live log, the doorbell, pub/sub and sessions. Losing Valkey loses live progress and hints, never an accepted generation or a final answer.
- **Executors own model calls.** Credentials, concurrency limits, retries and the circuit breaker have one home, and REST capacity stops depending on model latency.
- **Two stream types, one fleet.** Generation streams are short and busy; device streams are long and mostly idle. Both scale with open connections rather than requests per second, so in production they get their own fleet. Locally both are served by the API process.

---

## 💾 Data Model (~5 min)

```
conversations ── owner, title, model, current_leaf_id ───────────────┐
      │                                                              │
      └──▶ messages (a tree)                                         ▼
             user  ── parent: the assistant message it answers (NULL at the root)
             assistant ── parent: the user message it answers
                   ▲
                   └── generations (1:1 with an assistant message)
                         status · attempt · lease · output checkpoint · usage
```

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| users | id, username, password_hash, role | unique username | Roles: user, admin |
| conversations | id, user_id, title, model, current_leaf_id, updated_at, deleted_at | (user_id, updated_at DESC, id DESC) where not deleted | Leaf pointer is a foreign key that becomes NULL if its message disappears. Soft delete |
| messages | id, conversation_id, parent_id, role, content, depth, created_at | (conversation_id, parent_id, created_at) | `created_at` uses the clock at insert, not the transaction start, so a user message and its placeholder inserted together still sort in order. Assistant content is written once, when its generation ends |
| generations | id, conversation_id, user_id, user_message_id, assistant_message_id, kind, model, status, idempotency_key, request_hash, attempt, lease_owner, lease_expires_at, output, checkpoint_event_id, usage, context_messages, context_dropped, timestamps, cancel_requested_at | unique (user_id, idempotency_key); unique assistant_message_id; **partial unique (conversation_id) where status is accepted or running**; partial index on active rows for the sweeper | `kind` is message, edit or regenerate. `output` is the checkpoint while running and the final text after |

**How edits and regenerations map onto the tree.** A new message's parent is the current leaf. An edit inserts a sibling of the edited user message, under the same parent, and the server checks that the replaced message really is a user message with that parent. A regeneration inserts a new assistant sibling under the same user message. Siblings are ordered by creation time, which is all a client needs to show "‹ 2/3 ›". Nothing is ever overwritten.

**The current-leaf pointer** is the one mutable piece. The visible thread is the path from the root to that leaf. Switching to a sibling asks the server for the *latest state of that branch*: the newest message in the sibling's subtree. Children are always newer than their parents, so the newest descendant is guaranteed to be a leaf. One recursive query down the subtree answers it, and the pointer is stored, so a reload or another device opens the same branch.

**Why generation and message are separate rows.** The message is what the conversation shows; the generation is the attempt, with everything operational about it: who owns it, when it started, what it cost, how it ended. A failed attempt still has a message (with its partial text) because the user saw it and may refer to it. The cost is that the final text exists twice, on the message and in the generation's output. In production I'd clear the generation's copy after finalize, or keep it only for a short audit window.

---

## 🔌 API Design (~5 min)

```
POST   /api/v1/conversations                        → New chat: conversation + first message + generation (Idempotency-Key)
GET    /api/v1/conversations?cursor=                → Sidebar, keyset on (updated_at, id)
GET    /api/v1/conversations/:id                    → Conversation + newest 40 messages of the visible path
GET    /api/v1/conversations/:id/messages?before=   → The 40 ancestors before a message (scrolling up)
PATCH  /api/v1/conversations/:id                    → Rename
DELETE /api/v1/conversations/:id                    → Soft delete; cancels any in-flight generation
POST   /api/v1/conversations/:id/messages           → New message or edit (parentMessageId, editOfMessageId)
POST   /api/v1/conversations/:id/messages/:messageId/regenerate → Another answer to a user message
PUT    /api/v1/conversations/:id/leaf               → Branch switch: latest state of the branch through messageId
GET    /api/v1/generations/active                   → Caller's in-flight generations (reattach after refresh)
GET    /api/v1/generations/:id                      → Status, checkpoint output, usage
POST   /api/v1/generations/:id/cancel               → Stop
GET    /api/v1/generations/:id/events               → SSE: status · delta · end · snapshot (Last-Event-ID)
GET    /api/v1/events                               → SSE: this user's changes from every device
GET    /api/v1/admin/overview · PUT /api/v1/admin/model-settings · PUT /api/v1/admin/stream-drop
```

| Contract | Success | Errors the client branches on |
|----------|---------|-------------------------------|
| Create (new chat, message, edit, regenerate) | `202` with conversation, user message, assistant placeholder and generation. Same key again: `200`, the same objects, `Idempotent-Replayed: true` | `400` no key; `422 IDEMPOTENCY_KEY_REUSED` with the original generation ID; `409 GENERATION_IN_PROGRESS` with the in-flight generation's ID; `429` for 30 per minute or 4 active per user; `422 INVALID_PARENT` / `INVALID_EDIT` |
| Follow events | Frames with IDs, closed after `end`; a single `snapshot` from PostgreSQL once the log has expired | `401` and `404` are final: the client stops retrying |
| Cancel | `200` if already final; `202` while the executor stops it, with the outcome arriving as `end` | `404` if not the caller's |
| Branch switch | `200` with the new visible path, pointer stored | `404` if the message is not in this conversation |

**The stream contract.** Each frame's `id` is the Valkey stream entry ID, monotonic within a generation. A client that reconnects with `Last-Event-ID` gets exactly the entries after it. The REST representation of an in-flight generation carries `output` and `checkpointEventId` as a pair, so a refreshed client can show the checkpoint at once and resume the stream after that ID instead of replaying from the first token.

> "The `409` carries the winner's generation ID on purpose. The client that lost the race isn't in an error state; it just learned there is already an answer being written, and it can attach to it."

---

## 🔁 Generation Lifecycle (~8 min)

```
                      claim if still accepted
 POST (key)           attempt + 1, 15 s lease
 ──────────▶ accepted ──────────────────────▶ running
               │  │                              │
               │  │                              ├─ model done ──────────────────▶ completed
               │  │                              ├─ Stop: cancel signal ─────────▶ cancelled (partial kept)
               │  │                              ├─ error / drop / 30 s idle ────▶ failed (MODEL_ERROR, MODEL_DISCONNECTED, MODEL_TIMEOUT)
               │  │                              ├─ lease expired, sweeper ──────▶ failed (EXECUTOR_LOST, partial kept)
               │  │                              └─ executor drains ─────────────▶ failed (EXECUTOR_SHUTDOWN)
               │  └─ never claimed for 5 min, sweeper ──────────────────────────▶ failed (QUEUE_TIMEOUT)
               └──── Stop while accepted, API ──────────────────────────────────▶ cancelled
```

Every arrow is a conditional update that names the state it leaves, and terminal states have no exits. Whoever commits first owns the outcome; every later writer matches zero rows.

### ✅ Successful trace: one message, end to end

1. **Click.** The client mints one key per Send and posts the content with `parentMessageId` set to the leaf it is showing.
2. **Replay check first.** The API looks up (user, key). On a miss it applies the 30-per-minute limit and the 4-active cap. Checking the key before the limits matters: a retry of an accepted request asks for nothing new and must never get a `429`.
3. **Create.** In one transaction: lock the conversation row through its owner (404 for anyone else), confirm no generation is in flight, check the parent is an assistant message in this conversation, insert the user message at depth parent + 1, insert the empty assistant placeholder, insert the generation with the key and a hash of the request (insert-if-absent on the key), and point the leaf at the placeholder. Commit.
4. **Announce.** Append `status: accepted` to `gen:{id}:events`, add the ID to the queue, publish `generation.created` with the full result on `user:{id}:events`, answer `202`. If Valkey fails here the API still answers `202`: the row is durable and the sweeper re-rings accepted generations after 30 s.
5. **Claim.** An executor reads the ID (consumer group, no acknowledgements) and updates the row from `accepted` to `running`, incrementing `attempt`, with a 15 s lease. It appends `status: running` and checks the cancel flag once, since a Stop may have raced the claim.
6. **Context.** It walks up the tree from the user message, stopping once it has collected about twice the model's budget, and keeps the newest messages that fit (the question itself always fits, trimmed if it must). Empty answers from failed attempts are skipped; partial answers are kept because the user saw them. The counts of messages sent and dropped are recorded.
7. **Generate.** The first token stamps `first_token_at`. Tokens are flushed as one `delta` every 50 ms. Every 2 s the executor writes a checkpoint: the text *already appended to the log*, together with the entry ID of the last appended delta, fenced on attempt and status. Every 5 s a heartbeat renews the lease and reads `cancel_requested_at` in the same statement.
8. **Finalize.** On the model's `done`, flush the last delta, then one transaction: generation `completed` with output and usage, fenced on attempt and status; assistant message content; conversation `updated_at`. Commit, then append `end` (which closes the log and starts its 1-hour expiry), then publish `generation.finished`. Order matters: a client that sees `end` and re-reads gets the final row.

**"The connection drops halfway through a response. Can the client reconnect without creating another generation?"** Yes, by construction. The generation is a row owned by an executor, not by the connection, so the drop affects nothing upstream. The client reconnects to `GET /generations/:id/events` with the last entry ID it applied and receives exactly the entries after it. If it refreshed and lost its memory, it reads the generation, shows the checkpoint, and resumes after `checkpointEventId`. Reconnecting is reading; there is no code path from a dropped stream to another POST. I tested this exactly: a mid-stream resume and a checkpoint-plus-resume both reproduced the stored output byte for byte, and with the API configured to cut every stream after five events, the client needed eight connections and still assembled the identical text.

### ❌ Failed trace: the executor dies mid-answer

1. **Crash at token 150 of 400.** The log holds everything up to the last 50 ms flush; PostgreSQL holds the last checkpoint, at most 2 s older.
2. **Viewers wait.** Streams go quiet. Ping comments every 15 s keep connections open, and each idle cycle re-checks the session and whether PostgreSQL already has an outcome.
3. **Lease expiry.** No heartbeats, so the lease lapses at most 15 s after the last renewal.
4. **Sweep.** Every executor sweeps every 10 s with the same conditional update ("running with an expired lease becomes failed, `EXECUTOR_LOST`"); row locking makes exactly one sweeper win.
5. **Close, then read.** The winner appends `end` first, which closes the log, then concatenates the deltas. It stores whichever is longer, the log's text or the PostgreSQL checkpoint (the checkpoint covers the case where Valkey lost the log too), as the output and the message content, with `output_truncated = true`. It publishes `generation.finished`.
6. **The user sees** 150 tokens and "The server writing this answer stopped responding", within about 25 s. There is no automatic retry; Regenerate is one click and creates a new generation with a new key.
7. **If the executor was only stalled** (a long pause, a partition) it is fenced three ways when it wakes: its heartbeat matches no row, so it aborts the model request and stops paying; its appends are refused because the log is closed; its finalize matches no row, so its outcome is discarded.

> "Step 5's order is the subtle part. If the sweeper read the log before closing it, a stalled executor could slip one more delta in between, and the stored text would differ from what viewers saw. The append script refuses everything after the first `end`, so closing first makes the stored output and the viewed output identical."

### Stop, and the stop-versus-complete race

- **Accepted generation.** The API cancels it directly (conditional update from `accepted`), appends `end`, publishes `generation.finished`.
- **Running generation.** The API only sets `cancel_requested_at` and publishes the ID on `generations:cancel`. The owning executor aborts its HTTP request to the model, so generation stops upstream, not just on screen. It then finalizes `cancelled` with the partial output. A lost pub/sub message is caught by the next heartbeat within 5 s.

**"Does pressing Stop only stop rendering, or does it also cancel backend work?"** It cancels the backend work. Locally the mock model's active-generation count went from one to zero within 150 ms of the Stop, with its log reading "caller disconnected, generation stopped". If the finalize of a completed answer commits first, the cancel matches no running row and the answer stays `completed`; if the abort lands first, it is `cancelled` with partial text. Either way there is one outcome, and the `202` response never overrides what the stream says.

---

## 🔐 Idempotency and Concurrency Control (~3 min)

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Ask for an answer | At most one generation per user action | Unique (user, key) + request hash; replay returns the original with `200` |
| Reuse a key for something else | Rejected, never silently replayed | Hash mismatch → `422 IDEMPOTENCY_KEY_REUSED` |
| Answers per conversation | At most one in flight | Row lock on the conversation, then a partial unique index as the backstop |
| Enqueue | At least once | Row commits first; sweeper re-rings accepted rows older than 30 s |
| Execute | One owner at a time | Conditional claim, 15 s lease, attempt fencing |
| Outcome | Exactly one ending | Fenced finalize; the log closed by the first `end` |
| Delivery | No gaps, no duplicates | Entry IDs + `Last-Event-ID` |
| Branch pointer, rename | Last write wins | Accepted: both are cheap to redo, neither loses data |

**"What distinguishes retrying a request from asking for a new answer?"** The key. A retry repeats the same user action, so it reuses the same key, and the server answers with the generation that already exists, whether that one is still streaming or long finished. Regenerate is a new user action asking for a different sample, so it gets a new key and a new assistant sibling. The hash covers the operation itself (new chat, message, regenerate) and its inputs, so a regeneration can never be mistaken for a replay of the original message. There is one more rule on the client: it reuses a key only while the outcome is unknown (the request failed to connect, or a gateway answered instead of the API). A definitive rejection such as `409` or `429` means nothing was created, so the next attempt is a new request with a new key.

**"A user opens the same conversation on two devices and submits on both at once. What happens?"** Both POSTs carry different keys and the same parent. Each transaction locks the conversation row first, so they serialize. The first inserts its messages and its generation and commits. The second then sees an in-flight generation and fails with `409 GENERATION_IN_PROGRESS` carrying the first one's ID. That device keeps the user's text, attaches to the winner's stream, and offers Retry once the answer is done. If anything ever bypassed the lock, the partial unique index on in-flight generations per conversation rejects the second insert anyway. Locally, two simultaneous curls produced exactly one `202` and one `409` naming the winner. Device A's answer also appears live on device B, because B received `generation.created` on its device stream and followed the same generation.

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: A generation outlives the request — executors, leases and fencing

**Decision.** The API records and enqueues; an executor owns each generation through a lease stored in the generation row. The claim is a conditional update that increments `attempt`; heartbeats renew the lease every 5 s; every checkpoint and the finalize are conditioned on that attempt still owning a running row. The queue is a doorbell read without acknowledgements, never the owner.

**Why it works here.** An answer lasts longer than any one connection is trustworthy. With ownership in the row, "refresh mid-answer", "open it on the phone", "switch conversations" and "deploy the API" are all non-events for the generation. Ownership lives in exactly one place, so the sweeper can run in every executor with no leader election, a duplicate doorbell is harmless (only an `accepted` row can be claimed) and a lost one is repaired after 30 s. The generation ID also seeds the model request, so a retry before the first token reproduces the same answer rather than a different one.

**How the alternative breaks.** Running the model call inside the POST handler and streaming the response straight back ties the answer's life to one TCP connection and one process. A phone that walks out of Wi-Fi range, a proxy idle timeout, or a rolling deploy kills the answer mid-sentence. The reconnect has nothing to reattach to, so the only recovery is another POST: a second bill and a different sample, which is precisely the duplicate the requirements forbid. A second device can't watch either, because the tokens exist only in that one response. And every API worker is pinned for ten seconds per answer, so REST capacity becomes a function of model speed.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Executor + PostgreSQL lease + attempt fencing | Survives tabs, devices and deploys; one owner; safe concurrent sweepers | Lease protocol, sweeper, one extra hop on the token path |
| ❌ Model call inside the POST | Least code | Dies with the connection; reconnect means a new generation; no second viewer |
| ❌ Queue with acknowledgements as owner | Off-the-shelf redelivery | Two sources of truth; redelivery is a silent retry after tokens were shown |

**What I give up.** Three moving parts that only matter on failure paths, and crash detection bounded by the lease: about 25 s before a user sees `EXECUTOR_LOST`. A shorter lease detects faster but adds renewal writes and risks false expiry during a database hiccup; 15 s tolerates two missed heartbeats. Deploys don't pay the lease: a draining executor stops pulling work, waits up to 8 s, and fails the rest explicitly with `EXECUTOR_SHUTDOWN`.

### Deep dive 2: Where partial output lives — a Valkey log plus PostgreSQL checkpoints

**Decision.** Live tokens go to a per-generation Valkey stream in 50 ms batches. Every 2 s the executor writes a checkpoint to PostgreSQL: the text it has *already appended*, paired with the entry ID of the last appended delta. The final text is written once, in the finalize transaction. Appends go through a small server-side script that refuses anything after the first `end`, so the log can only ever have one ending.

**Why it works here.** The log gives every reader, on any API instance, resume from any offset: the reconnect story is just `XREAD` after an ID. The checkpoint pairing is what makes a refresh cheap and correct. "Checkpoint text + every delta after its entry ID = the full output" holds by construction, because the checkpoint never includes text that isn't in the log yet. So a refreshed client shows the checkpoint instantly and resumes from there, and if Valkey loses the log entirely, the sweeper still has a recent PostgreSQL copy to keep.

**How the alternatives break.**

- *Store only completed messages.* Simple, but a crash at token 300 loses everything, so the user's half-read answer vanishes. A refreshed client has to replay the whole log from token one, and once the log expires or Valkey restarts there is nothing at all for an answer that never finished.
- *Write every token (or every delta) to PostgreSQL.* At 35K concurrent generations that's 700K writes a second for data that matters for minutes. Each delta is a row update producing a dead tuple, so autovacuum and replication lag become the product's latency. Resume also needs ordered delta rows and polling, which reinvents the log badly.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Valkey log + paired PostgreSQL checkpoints | Exact resume anywhere; cheap refresh; survives Valkey loss with ≤ 2 s gap | Two stores to keep consistent; checkpoint writes are a real share of load |
| ❌ Completed messages only | Fewest writes | Crashes lose the whole answer; refresh replays everything |
| ❌ Every delta to PostgreSQL | One store | Write amplification, vacuum pressure, polling-based resume |

**What I give up.** Checkpoints are about four statements per answer, more than a quarter of the per-generation write budget, so the interval is a tuning knob: 5 s halves the cost and widens the gap a Valkey failure could lose. Two stores also need the ordering rules above (append before checkpoint, commit before `end`, close before reading), and each one is a place to get it wrong. The fencing on the checkpoint update is what keeps a stale executor from overwriting the sweeper's version.

### Deep dive 3: One writer per conversation — lock plus partial unique index

**Decision.** A conversation has at most one generation in flight. The create transaction locks the conversation row, checks for an in-flight generation, and a partial unique index on in-flight generations per conversation backs it up. The loser of a race gets `409` with the winner's ID.

**Why it works here.** The next answer's context is the path through the previous answer. If two answers run at once in one conversation, the second was built from a context missing the first, and the user's two devices now disagree about what the conversation is. Serializing per conversation keeps the tree's meaning simple: every branch was created from a settled parent. The lock is per conversation, so it never contends across users or across a user's other conversations, and the index makes the rule hold even if a future code path forgets the lock.

**How the alternative breaks.** Allowing parallel generations, each simply becoming a sibling branch, sounds harmless because the tree can represent it. In practice the two answers race for the current-leaf pointer, so whichever finishes last decides what both devices see, and the user's "latest message" depends on timing. Each answer's context misses the other's question, so a follow-up sent on either device is grounded in half the conversation. Per-user rate limits can't prevent it either, since both requests are legitimate.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ One in flight per conversation, 409 + attach | Clear semantics; deterministic leaf; trivially explained to users | Second device must wait or attach; a long answer blocks a quick follow-up |
| ❌ Parallel generations as sibling branches | No waiting | Leaf pointer races; contexts miss each other; confusing on two devices |
| ❌ Queue the second request behind the first | No error shown | Its parent is stale by the time it runs; hides an ambiguity the user should resolve |

**What I give up.** Throughput within one conversation, by design. A user who wants two things at once opens two conversations, which the per-user cap of four in-flight answers allows. The client must handle `409` well: keep the text, attach to the existing answer, and make Retry re-target the new leaf with a fresh key.

---

## 📚 Very Long Conversations (~2 min)

**"How do very long conversations change fetching and rendering?"** Three things change, all of them because of the tree.

- **Fetching.** Opening a conversation never loads the whole tree. The server walks up from the current leaf with a recursive query capped at 41 rows (a page of 40 plus one to know whether more exist) and returns that page with each message's siblings, computed in one extra query over the parents on the page. Scrolling up asks for the ancestors of the oldest message loaded. Depth is stored on every message, so a page is contiguous by construction (I verified a 300-message thread arrives as eight pages with depths 0 to 299 and no gaps).
- **Context.** The server, not the client, decides what the model sees. The executor's upward walk carries a running token count and stops at about twice the budget, so a 5,000-message conversation reads a few dozen rows to build a prompt of a few thousand tokens. The newest messages win; how many were dropped is recorded on the generation for the operator view. Summarizing the dropped prefix is the obvious next step; I did not build it.
- **Rendering.** The client virtualizes the list and anchors scroll when older pages are prepended. That is mostly the frontend answer's territory; the backend's job is pages that are cheap, contiguous and stable.

---

## 🛡️ Failure Handling and Access (~2 min)

| Failure | Behavior |
|---------|----------|
| Model 429 / unreachable before the first token | Up to three starts with backoff (Retry-After, or 250 ms × 2ⁿ), behind a circuit breaker |
| Model error mid-stream | `failed`, `MODEL_ERROR`, partial text kept; no retry, because the user already saw part of an answer |
| Model drops the connection silently | `failed`, `MODEL_DISCONNECTED`, partial kept |
| No tokens for 30 s | Heartbeat aborts: `MODEL_TIMEOUT` |
| Valkey down during finalize | PostgreSQL has the outcome; an idle stream reader checks every 15 s and sends a `snapshot` |
| Device event missed | Pub/sub is a hint; every (re)connect starts with a `ready` event, and the client re-reads its sidebar and `/generations/active` |
| Conversation deleted mid-answer | Soft delete flags in-flight generations for cancel and signals their executors |

**Access.** Every conversation, message and generation route loads through the owner: the conversation query carries the user ID, and the generation query joins the conversation's owner. Another user's ID is a `404`, indistinguishable from a missing one, so IDs can't be probed. The SSE endpoint authorizes the same way *before* it reads the log. Long-lived streams re-check that the session still exists on every idle cycle (15 s), so signing out on one device closes streams on the others. Device channels are per user ID and are only subscribed after authentication. Admin routes require the admin role. Locally I checked all eight conversation and generation routes for another user's IDs: every one returned `404`.

**Observability.** Separate histograms for queue time and time to first token (opposite fixes), counters for created generations by kind, idempotent replays, stream resumes, checkpoints written and outcomes by status, and a gauge of open streams by kind. Logs carry IDs, never message text.

---

## ✅ Design Review Checklist

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | PostgreSQL. A generation is accepted when the create transaction commits, before the `202`. An answer is final when the finalize transaction commits, before `end` is appended |
| Client retries after losing the response? | Same key → the existing generation with `200`, checked before limits. A dropped stream resumes from `Last-Event-ID`; a refresh resumes from the checkpoint's entry ID. Nothing re-POSTs |
| Worker fails between two steps? | Commit but no enqueue: re-rung after 30 s. Executor dies after reading the doorbell: still accepted, same repair. Dies mid-stream: lease expiry, `EXECUTOR_LOST`, partial kept. Valkey fails at finalize: PostgreSQL has it; readers fall back to a snapshot |
| Which ordering is required? | Within a generation: log order, one ending. Within a conversation: one generation in flight, children after parents. Nothing across conversations |
| Access with caches and async work? | Owner checked per request on every route including SSE; sessions re-checked on long streams; executors act only on rows authorized at creation; pub/sub channels are per user |
| What breaks first at scale? | Statement volume in PostgreSQL, then stream connections, below |

---

## 📈 What Breaks First at 10× and 100× (~3 min)

Today's peak: ≈ 3,500 generations/s, ≈ 35K concurrent, ≈ 45K generation streams, ≈ 50K PostgreSQL statements/s, ≈ 700K log appends/s.

| Rank | Component | At 10× | At 100× | Fix |
|------|-----------|--------|---------|-----|
| 1 | PostgreSQL statements | ≈ 500K/s | ≈ 5M/s | Shard by user ID (conversations, messages and generations share it); stretch checkpoints to 5 s under load; renew leases every 10 s; move finished generation output out of the hot table |
| 2 | Generation streams | ≈ 450K open | ≈ 4.5M | Each open stream holds a dedicated blocking Valkey connection today; replace with one multiplexed reader per stream-service instance |
| 3 | Device fan-out | ≈ 15M device streams | — | Classic pub/sub in a cluster broadcasts every message to every node; use sharded pub/sub keyed by user, and coalesce events per tab |
| 4 | Log appends | ≈ 7M/s | ≈ 70M/s | Keys are hash-tagged per generation, so they spread across shards; add shards, widen batching to 100 ms |
| — | The model provider | | | The real ceiling: admission control with fair share per user, `429` with Retry-After instead of an unbounded queue |

> "My evidence for ranking PostgreSQL first is counting statements in the executor: a claim, a first-token stamp, a context update, two renewals and four checkpoints for a ten-second answer, plus two transactions. That's fifteen, and checkpoints and renewals are most of it, which also tells me where the cheapest relief is. The stream ranking comes from the stream handler opening one connection per viewer. I'd confirm both with the queue-time versus TTFT split before buying hardware."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Generation ownership | Executor + lease + attempt fencing | Model call inside the POST | Survives connections, devices and deploys |
| Live output | Per-generation Valkey log | Pub/sub, or rows in PostgreSQL | Resume from any offset without write amplification |
| Partial output | Checkpoints paired with log entry IDs | Completed messages only | Cheap exact refresh; survives Valkey loss |
| History | Message tree + current-leaf pointer | Linear list with overwrite | Edits and regenerations never destroy anything |
| Creation | Idempotency-Key + request hash, replay before limits | Client debouncing | Lost responses and concurrent retries |
| Conversation concurrency | One in flight, lock + partial unique index | Parallel sibling generations | Deterministic leaf and complete contexts |
| Retries | Only before the first token | Transparent retry | No silently different answers or double billing |
| Device sync | Pub/sub hints + REST reconcile on reconnect | Durable per-device queues | Simple; correctness never depends on delivery |
| Access | 404 through the owner, SSE included | 403 | Doesn't confirm that an ID exists |

---

## 📝 Wrap-up (~1 min)

> "The whole design follows from treating a generation as a first-class record. It has an owner with a lease, a replayable log, checkpoints that line up with the log, and exactly one ending, so a client is only ever a viewer: drop, refresh, switch device, and nothing is lost, duplicated or billed twice. Messages form a tree with one movable pointer, so edits and regenerations are additions rather than overwrites. One generation per conversation keeps that tree meaningful when two devices race. What I'd validate first in production is the checkpoint interval against PostgreSQL load, and I'd run a kill-an-executor drill to confirm the fencing holds."

### How the local implementation compares

The repo runs this design on one machine: an Express API that also serves both SSE streams, a separate executor process with leases, heartbeats, checkpoints and the sweeper, PostgreSQL 16, Valkey 7, and its own mock model service. The mock streams deterministic markdown answers seeded by the generation ID, with runtime knobs for time to first token, tokens per second, an error partway through, a silent mid-stream disconnect and the number of concurrent slots; the API adds a knob that cuts browser streams after N events to exercise resume. Compared with this answer, there is one PostgreSQL and one Valkey instead of shards and a cluster, each open stream holds its own Valkey connection, device fan-out uses classic pub/sub, rate limits are fixed windows, auth is a session cookie with Valkey-backed sessions, there is no real provider adapter, and context truncation drops old messages rather than summarizing them.
