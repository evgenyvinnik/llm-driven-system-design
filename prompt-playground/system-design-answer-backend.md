# Prompt Playground — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Run lifecycle → Deep dives → Scale*

> "The model API already exists, so I'm deliberately not designing inference: no batching, no GPU scheduling, no KV caches. The system is the product around that API, and its hard parts are about state, not throughput. Every result must be reproducible, which pushes me toward immutable content behind mutable pointers. A run must outlive the HTTP request that started it, which pushes me toward a durable run record owned by an executor through a lease, with output in a replayable log. Most of this answer is those two ideas applied carefully."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Scope that excludes inference; capacity math that keeps tokens out of PostgreSQL |
| Architecture | ~6 min | Stateless API, separate stream service, executors as the only model callers |
| Data model | ~5 min | Mutable heads, content-addressed snapshots, append-only versions, runs that pin everything |
| API | ~5 min | 202 vs 200 replay, 409 / 428 / 410 semantics, the SSE contract |
| Run lifecycle | ~8 min | State machine, one successful and one failed trace, cancellation races |
| Deep dives | ~13 min | Run ownership, the live event log, retry semantics |
| Scale and wrap-up | ~3 min | What breaks first and the evidence for it |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Is model serving in scope? | Decides whether this is an inference interview | No. The API exists, streams tokens, and can be slow, answer 429, or fail partway |
| Who uses it? | Tenancy and sharing model | Developers in workspaces. Presets are shared; drafts are personal |
| Must a run survive closing the tab? | Whether a run is tied to a connection | Yes. Navigating away or refreshing never cancels a run |
| Real-time co-editing of one prompt? | CRDTs versus versioning | No. Drafts stay private until saved, and saves are versioned |
| Who can open a shared link? | Auth on the read path | Anyone with the link: read-only, revocable |
| How long is history kept? | Storage and partitioning | 90 days of runs |

### Functional requirements

1. Prompts in a workspace: a system message, a user template with `{{variable}}` placeholders, a title.
2. Edits are a draft that survives a refresh. Saving creates an immutable, numbered version, and any version can be restored.
3. Run with a model, temperature, top-p and max tokens. Output streams token by token, and a running run can be stopped.
4. Several runs in flight at once. Leaving the page never cancels one, and finished runs land in history.
5. Compare two or three configs side by side.
6. History of every run with the exact text, variables, config, usage and timings it used.
7. Workspace presets that two people can edit without silently overwriting each other.
8. Read-only share links to one version or one finished run; links can be revoked, and a recipient can fork.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Run acceptance | p99 < 150 ms | `POST /runs` only records and enqueues; it never waits for the model |
| Streaming overhead | A token reaches the browser within 100 ms (p95) of the model emitting it | 50 ms delta batching is most of that budget |
| Resume | A reconnect loses no tokens and never starts a duplicate generation | Drives the event-log design |
| No silent loss | Every accepted run ends visibly as completed, cancelled or failed | Drives leases and the sweeper |
| Reproducibility | A run's text, variables and config never change after creation | Drives the data model |
| Isolation | No reads across workspaces; a share link exposes only what it names | Enforced in every query |
| Availability | 99.9% | End-to-end availability is capped by the model provider anyway |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Runs | 2M/day ≈ 23/s average, ≈ 120/s peak | 100K daily active developers × 20 runs, 5× peak factor |
| Concurrent generations | ≈ 1,200 | 120 runs/s × 10 s of streaming per run |
| Open SSE streams | ≈ 2,000 | ≈ 1.5 viewers per run (second tabs, comparisons, reconnects) |
| Live-output appends | ≈ 24K/s | 20 appends/s per run with 50 ms batching × 1,200; per-token appends would be 4–5× more |
| PostgreSQL writes | ≈ 720/s | ≈ 6 per run: insert, claim, first-token time, ~2 lease renewals, finalize |
| Run storage | ≈ 20 GB/day, ≈ 1.8 TB at 90 days | ≈ 10 KB per run: rendered input, output, metadata |
| Live logs resident | ≈ 250 MB | ≈ 83K runs end per hour × ≈ 3 KB of deltas, 1-hour TTL |

> "Two numbers shape the design. 720 writes a second is easy work for one PostgreSQL primary, so the record of truth can be plain relational rows, provided tokens stay out of it. 24K appends a second for output that matters for an hour is exactly what I don't want in PostgreSQL, so live output gets its own store. And the real ceiling is the model provider's capacity, not anything I build."

---

## 🏗️ Architecture (~6 min)

```
┌───────────────────┐        ┌──────────────────────────────────────────────────────┐
│ Browser           │ HTTPS  │ Load balancer / API gateway                          │
│ draft (local)     ├───────▶│ TLS · sessions · /events go to the stream fleet      │
│ run store         │◀─ SSE ─┤                                                      │
└───────────────────┘        └─────────┬──────────────────────────────┬─────────────┘
                               (1) REST│                      (4) SSE │
                     ┌─────────────────▼──────────┐   ┌───────────────▼─────────────┐
                     │ Playground API (stateless) │   │ Stream service              │
                     │ prompts · versions · runs  │   │ replays a run's log from    │
                     │ presets · shares · admin   │   │ Last-Event-ID, then tails   │
                     └──┬───────────────────────┬─┘   └───────────────┬─────────────┘
           (2) insert   │        (3) append     │                     │ blocking read
               run      │      queued, enqueue  │                     │
             ┌──────────▼─────────┐   ┌─────────▼─────────────────────▼─────────────┐
             │ PostgreSQL         │   │ Valkey cluster                              │
             │ source of truth    │   │ one event log (stream) per run              │
             │ primary + replicas │   │ run queue (doorbell) · cancel pub/sub       │
             └──────────▲─────────┘   │ sessions · rate-limit counters              │
                        │             └─────────▲─────────────────────▲─────────────┘
    (5) claim, lease,   │                       │ (5) pull run ids    │ (7) deltas,
    (8) finalize        │                       │                     │ 50 ms; end
             ┌──────────┴───────────────────────┴─────────────────────┴─────────────┐
             │ Run executors (N): lease per run · heartbeat 5 s · sweeper 10 s      │
             │ retry before first token · circuit breaker · cancel listener         │
             └──────────────────────────────────┬───────────────────────────────────┘
                                                │ (6) streaming HTTP
                                     ┌──────────▼───────────┐
                                     │ Model API (existing) │
                                     └──────────────────────┘
```

**Walking the diagram:**

1. The browser sends `POST /runs` with an `Idempotency-Key`. The stateless API authorizes, validates, and applies limits.
2. It inserts the run as `queued` in PostgreSQL. **That commit is the moment the run is accepted.**
3. It appends a `queued` status event to the run's log, rings the queue's doorbell with the run ID, and returns `202`.
4. The browser opens the run's SSE stream. The stream service replays the log from the client's last event ID and then tails it.
5. An executor pulls the run ID and claims the run in PostgreSQL with a conditional update and a 15-second lease.
6. It calls the model, the only component that does.
7. It batches tokens into `delta` events every 50 ms and appends them to the log.
8. It records the outcome in PostgreSQL with an update fenced by its attempt number, then appends the `end` event that closes the log.

**Three placement decisions worth stating:**

- **PostgreSQL is the only source of truth.** Valkey holds things that are either rebuildable or ephemeral. Losing Valkey loses live progress, never an accepted run or a final result.
- **Executors are the only callers of the model.** Provider credentials live in one service, and concurrency limits, retries and the circuit breaker all have one home. The API's capacity no longer depends on model latency.
- **The stream service is a separate fleet in production.** SSE connections are long-lived and mostly idle, so they scale with open connections, not requests per second. Two thousand open streams should never consume the REST tier's capacity. In the local build it is the same process as the API.

---

## 💾 Data Model (~5 min)

```
prompts ── mutable head: title, description, head_version
   │
   ├──▶ prompt_snapshots ── immutable, content-addressed by sha256(system, template)
   │          ▲      ▲
   │          │      └──────────── runs ── snapshot_id + copied config + variables + rendered text
   │          │
   └──▶ prompt_versions ── v1, v2, v3 … append-only labels pointing at snapshots
```

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| workspaces, workspace_members | (workspace_id, user_id) PK, role | member index on user_id | Every resource query joins membership |
| prompts | id, workspace_id, title, description, head_version | (workspace_id, updated_at) | The mutable head. Text is never stored here |
| prompt_snapshots | id, prompt_id, content_hash, system_text, template_text, variables | unique (prompt_id, content_hash) | Immutable. Identical text is stored once per prompt |
| prompt_versions | (prompt_id, version) PK, snapshot_id, message, created_by | index on snapshot_id | Append-only numbered labels on snapshots |
| model_presets | id, workspace_id, name, config, revision | unique (workspace_id, name) | `revision` is the compare-and-set token for `If-Match` |
| runs | id, workspace_id, prompt_id, snapshot_id, version (null = draft), comparison_id, model, config copy, variables, rendered system and input, status, output, output_truncated, error_code, token counts | unique (created_by, idempotency_key); (prompt_id, created_at); partial indexes on status queued/running; partial on comparison_id | Pins everything it ran with |
| runs (ownership) | attempt, lease_owner, lease_expires_at, request_hash | same row | `attempt` is the fencing token |
| runs (timings) | created_at, enqueued_at, started_at, first_token_at, finished_at, cancel_requested_at | same row | Queue time, TTFT and duration are derived from these |
| shares | token (128-bit random) PK, workspace_id, prompt_id, snapshot_id, version, run_id, revoked_at | (prompt_id, created_at) | Names one immutable thing |

| Valkey key | Type | Purpose | Lifetime |
|------------|------|---------|----------|
| `run:{id}:events` | Stream | A run's event log: status, delta, end | 1 hour after the end |
| `run:{id}:ended` | String | Closed flag; appends are refused once set | 1 hour |
| `runs:queue` | Stream + consumer group | Run IDs waiting for an executor (a doorbell) | Trimmed to ~10K entries |
| `runs:cancel` | Pub/sub channel | Cancel signal to the owning executor | — |
| `session:{id}`, `ratelimit:{bucket}:{window}` | String, counter | Sessions; fixed-window limits shared by all instances | 7 days; window + 1 s |

**Data decisions I'd say out loud:**

- **"A developer edits a prompt while its previous version is running. Which text belongs to the result?"** The run's snapshot, fixed when the run was created. An edit produces a new snapshot (or reuses one with the same hash) and never touches the old one. The run also stores the rendered system and user text that was actually sent, so reproducing it never re-renders anything.
- **Draft runs need no fake versions.** Running unsaved text upserts a snapshot with no version. If that exact text is saved later, the new version points at the same snapshot, and history shows "Draft · now v4". That label is computed at read time by joining on `snapshot_id`, so no run row is ever updated.
- **Config is copied onto the run, never referenced.** Editing a preset next week must not rewrite what last week's run used.
- **Partial indexes on in-flight status** keep the sweeper, the active-run cap and `GET /runs/active` scanning only in-flight rows (about a thousand at peak), not the 1.8 TB table.
- **"How would you add side-by-side comparisons without redesigning the data model?"** A comparison is N ordinary runs sharing a nullable `comparison_id`. Each run already pins its own snapshot and config, so one column and one partial index were the whole schema change. Each run also has its own idempotency key, executor and log, so if the active-run cap rejects one, the others still start and the UI reports "1 of 2 runs started".

---

## 🔌 API Design (~5 min)

```
POST   /api/v1/runs                     → Start a run (Idempotency-Key required) → 202, or 200 replay
GET    /api/v1/runs/active              → Caller's queued and running runs (reattach after refresh)
GET    /api/v1/runs/:id                 → Full run
POST   /api/v1/runs/:id/cancel          → 200 if already final, 202 while the executor stops it
GET    /api/v1/runs/:id/events          → SSE: status, delta, end, snapshot (Last-Event-ID resume)
GET    /api/v1/comparisons/:id          → All runs of one comparison

GET    /api/v1/prompts/:id              → Prompt, head version text, version list
POST   /api/v1/prompts/:id/versions     → Save next version (baseVersion → 409 HEAD_MOVED)
GET    /api/v1/prompts/:id/runs?before= → History page, keyset-paginated, no full output
PATCH  /api/v1/presets/:id              → Update (If-Match required → 428 / 409 REVISION_CONFLICT)
DELETE /api/v1/presets/:id              → Delete (If-Match required)
POST   /api/v1/prompts/:id/shares       → Link to a version or a finished run
DELETE /api/v1/shares/:token            → Revoke
GET    /api/v1/shared/:token            → Public read, no session (410 when revoked)
POST   /api/v1/shared/:token/fork       → Copy into the caller's workspace as v1
```

| Status | When | Why this code |
|--------|------|---------------|
| `202 Accepted` | New run recorded and enqueued | The work has not happened; the result arrives on the stream |
| `200` + `Idempotent-Replayed: true` | Same key, same request hash | The client lost the first response; it gets the original run, not a second one |
| `422 IDEMPOTENCY_KEY_REUSED` | Same key, different body | A client bug; silently returning the wrong run would be worse |
| `422 MISSING_VARIABLES` | A `{{variable}}` has no value | Caught before anything is stored |
| `429 RATE_LIMITED` / `TOO_MANY_ACTIVE_RUNS` | Over 30 runs/min or 6 active runs | Admission control per user |
| `409 HEAD_MOVED` | Version save whose `baseVersion` is not the head | Body carries the newer head, so the editor can offer "load theirs" or "keep mine on top" |
| `428 Precondition Required` | Preset `PATCH`/`DELETE` without `If-Match` | Forces every client to opt into the concurrency check |
| `409 REVISION_CONFLICT` | `If-Match` revision is stale | Body carries the current preset and who changed it |
| `409 RUN_NOT_FINISHED` | Sharing a run that is still streaming | A share must name something immutable |
| `410 SHARE_REVOKED` | Revoked share link | "This existed and was withdrawn", distinct from a mistyped token's 404 |
| `404` for another workspace's IDs | Not a member | Same answer as a missing resource, so IDs reveal nothing |

> "I chose 428 instead of treating a missing `If-Match` as 'overwrite whatever is there'. Otherwise one old client or one curl command quietly reintroduces last-write-wins, and that is exactly the outcome the requirements forbid."

**The stream contract.** Each SSE frame's `id` is the Valkey stream entry ID. Events are `status` (queued or running, with the attempt), `delta` (text since the previous delta), `end` (final status, finish reason, error, usage with queue ms, TTFT and duration) and `snapshot` (the whole run from PostgreSQL, sent when the live log has expired). A client that reconnects sends `Last-Event-ID` and receives exactly the entries after it, with no gaps and no duplicates. A new tab starts from the beginning and rebuilds the output so far.

---

## 🔁 Run Lifecycle (~8 min)

```
                    claim if still queued
 POST /runs         attempt + 1, 15 s lease
 ──────────▶ queued ──────────────────▶ running
               │  │                       │
               │  │                       ├─ model finished ────────────▶ completed
               │  │                       ├─ cancel signal ─────────────▶ cancelled (partial kept)
               │  │                       ├─ model error / 30 s idle ───▶ failed (MODEL_ERROR, MODEL_TIMEOUT)
               │  │                       ├─ lease expired, sweeper ────▶ failed (EXECUTOR_LOST, partial kept)
               │  │                       └─ executor drains ───────────▶ failed (EXECUTOR_SHUTDOWN)
               │  └─ unclaimed for 5 min, sweeper ──────────────────────▶ failed (QUEUE_TIMEOUT)
               └──── cancel while queued, API ──────────────────────────▶ cancelled
```

Every arrow is a conditional update that names the state it leaves. Terminal states have no outgoing arrows, so whichever writer commits first owns the outcome and every later writer matches zero rows.

### Successful trace

1. **Click.** The browser generates one `Idempotency-Key` per click and posts the text, variables, config and optional `comparisonId`.
2. **Replay check first.** The API looks up (user, key). On a miss, it loads the prompt joined with workspace membership (404 for non-members), renders variables, applies the 30-per-minute limit and the 6-active-run cap, upserts the snapshot by content hash, and looks up which saved version (if any) points at that snapshot.
3. **Insert.** The run row is inserted as `queued` with the copied config, rendered text, key and request hash. The insert does nothing on a key conflict, so two concurrent retries create one row. **The commit is acceptance.**
4. **Doorbell.** The API appends `status: queued` to the run's log, adds the run ID to the queue stream, and returns `202`. If Valkey hiccups here, the API logs it and still returns `202`: the run is durable, and the sweeper re-rings queued runs whose last doorbell is older than 30 s.
5. **Stream.** The browser opens `GET /runs/:id/events`. The stream service re-authorizes, replays from the start, and blocks waiting for new entries.
6. **Claim.** An executor reads the run ID and runs a conditional update: only a row still `queued` becomes `running`, with `attempt + 1`, its executor ID as lease owner, and a lease 15 s out. A duplicate doorbell or a run cancelled meanwhile matches zero rows and is dropped. It then appends `status: running` and checks the cancel flag once, because a cancel may have raced the claim.
7. **Generate.** The first token records `first_token_at`. Tokens accumulate in a buffer flushed as one `delta` every 50 ms. Every 5 s a heartbeat renews the lease, conditioned on this attempt still owning a running row, and reads the cancel flag in the same statement.
8. **Finalize.** On the model's `done`, the executor flushes the last delta and writes `completed`, output and usage, conditioned on attempt and status. Only then does it append `end`, which closes the log and starts its 1-hour TTL. The stream service forwards `end` and closes the connection.

**"A run finishes after the user has navigated elsewhere. Where does its result appear?"** Nothing about the outcome depends on a connection: the executor writes it to PostgreSQL, so it is in the prompt's history for every workspace member. The client follows streams from an app-level store rather than from the page component, so a toast links back to the result. After a refresh, `GET /runs/active` returns the runs still in flight and the client re-follows each one from the start of its log.

### Failed trace: the executor dies mid-run

1. **Crash at token 200 of 500.** Everything up to the last 50 ms flush is in the log. The browser's stream goes quiet; ping comments every 15 s keep the connection open.
2. **Lease expiry.** With no heartbeats, the lease lapses at most 15 s after the last renewal.
3. **Sweep.** Every executor runs a sweeper every 10 s. Each one attempts the conditional update "running with an expired lease becomes failed with `EXECUTOR_LOST`". Row locking means exactly one sweeper wins each row.
4. **Keep the partial output.** The winner appends the `end` event first, which closes the log, then reads it, concatenates the deltas, and stores them as the output with `output_truncated = true`. The user sees 200 tokens and the error within roughly 25 s of the last heartbeat.
5. **No automatic retry.** Deep dive 3 explains why. "Run again" is one click and creates a new run with a new key.
6. **The "dead" executor was only stalled** (a long GC pause, a network partition, or a SIGSTOP in local testing). When it wakes it is fenced out three ways: its next heartbeat matches zero rows, so it aborts the model request and stops paying for tokens; its delta appends are refused because the log is closed; and its finalize matches zero rows, so its outcome is discarded. One run, one recorded ending.

> "The order of step 4 matters. If the sweeper read the log before closing it, a stalled executor could squeeze in one last delta between the two steps, and the stored output would differ from what viewers saw. Closing first makes them identical."

### Cancellation and the cancel-versus-complete race

- **Queued run.** The API cancels it directly with a conditional update from `queued` to `cancelled` and appends `end`. If an executor claims at the same instant, the row lock serializes them. If the claim wins, the API's update matches nothing and it falls through to the running path.
- **Running run.** The API does **not** write `cancelled`. It sets `cancel_requested_at` and publishes the run ID on `runs:cancel`. The executor that owns the run aborts its HTTP request to the model, so generation and billing stop upstream, not just rendering. It then finalizes `cancelled` with the partial output. A lost pub/sub message is caught by the next heartbeat within 5 s.
- **Why only the owner writes the terminal state.** The partial output and token usage live in the executor's memory and the log, not in the API. With one writer, the stored output, the usage and the `end` event always agree.
- **Cancel racing completion.** If the executor's finalize commits first, the run is `completed` and the cancel's flag update matches no running row. If the abort lands first, the run is `cancelled` with its partial output. Either way there is exactly one outcome. The cancel endpoint answers `202` while the executor is stopping, and the truth arrives as `end` on the stream. The client must never let an older REST copy move a run backwards: local browser testing caught the Stop response, sent before `end`, flipping a cancelled run back to "running".

---

## 🔐 Idempotency and Concurrency Control (~3 min)

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Start a run | At most one run per click, even with retries | Unique (user, key) + a stable hash of the request body; replay returns the original |
| Enqueue | At least once | Row committed before enqueue; sweeper re-enqueues queued runs older than 30 s |
| Execute | At most one owner at a time | Conditional claim, 15 s lease, `attempt` fencing token |
| Final outcome | Exactly one recorded ending | Finalize conditioned on attempt and running status; log closed by the first `end` |
| Delivery to a browser | No gaps, no duplicates | Stream entry IDs + `Last-Event-ID` |
| Save a version | No lost saves | Append-only versions, row lock on the prompt, `baseVersion` check |
| Edit a preset | No silent overwrite | `revision` compare-and-set through `If-Match` |
| Rename a prompt | Last write wins | Accepted: a lost rename is cheap to redo |

**Replay is checked before rate limits.** A retry of an accepted request asks for nothing new. Suppose a user starts their sixth active run and the response is lost. If the retry hit the active-run cap first, it would get `429`, the client would conclude the run failed, and the user would click again, creating the very duplicate the key exists to prevent. The request hash covers the parsed body with keys sorted, so the same key with a different prompt is `422`, never a silent replay of the wrong run.

**"Two people update the same saved preset. How do you avoid silently overwriting either change?"** Each preset carries a `revision`. A `PATCH` must send the revision it loaded as `If-Match`, and the update applies only where the stored revision still matches, incrementing it. If Alice saved first, Bob's update matches zero rows and he gets `409 REVISION_CONFLICT` with Alice's version and her name. His editor shows both side by side with "Use theirs" or "Overwrite with mine", and the second choice is an explicit re-send against the new revision. Prompt versions work the same way through `baseVersion`, except nothing can ever be overwritten there, because versions are append-only. The `409` exists so nobody becomes head on top of a version they never saw, and re-saving identical text is a no-op.

> "Locks would need lease management for an editor someone left open over lunch, and last-write-wins drops a teammate's change without telling anyone. Edits to shared presets are rare and short, so an optimistic check costs nothing in the common case and turns the rare conflict into an explicit choice."

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: Who owns a run? Executors with PostgreSQL leases, the queue as a doorbell

**Decision.** The API only records and enqueues. An executor owns each run through a lease in the run row: a conditional claim, a 15 s lease renewed every 5 s, and an `attempt` number that fences every later write. The Valkey queue is read without acknowledgements and treated as a doorbell; it never decides who owns anything.

**Why it works here.** A generation lasts 5 to 60 seconds, longer than a developer stays on one page. With the run decoupled from any connection, "leave and come back", "open it in another tab" and "survive a deploy of the API" all come for free. Ownership lives in one place, the run row, and every transition is a conditional update against it, so the sweeper can safely run in every executor with no leader election. A duplicate doorbell is harmless because only a row that is still `queued` can be claimed. A lost doorbell is harmless because the run is still `queued` in PostgreSQL, and the sweeper re-rings it after 30 s.

**How the alternatives break.**

- *Streaming inside the `POST` request* ties the run's life to one TCP connection and one API process. Closing the tab, a proxy's idle timeout or a rolling deploy kills the generation mid-answer. A reconnect has no generation to reattach to, so it must start a new one: duplicate tokens, a duplicate bill, and a different answer. Every API worker is also pinned for the full generation, so REST capacity becomes a function of model latency.
- *The queue as source of truth* (acknowledged entries, pending lists, visibility timeouts) puts ownership in two places. After a crash, the queue says "executor A holds it" while PostgreSQL says `running`, and someone must reconcile them. Worse, a visibility timeout redelivers the run to another executor, which is an automatic retry after tokens were already streamed: exactly what deep dive 3 rules out. A slow executor and its replacement would both stream into the same log.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Executor + PostgreSQL lease + fencing, queue as doorbell | Runs outlive tabs and deploys; one owner; one source of truth; safe concurrent sweepers | Lease protocol, sweeper, one extra hop on the token path |
| ❌ Stream inside the POST | Simplest code, no queue | Run dies with the connection; reconnect duplicates the generation; deploys cut every run |
| ❌ Queue as source of truth | Off-the-shelf redelivery | Two owners of state; redelivery is a silent retry mid-stream |

**What I give up.** A queue, a lease protocol and a sweeper that all need testing on failure paths, plus one hop on the token path (an append and a blocking read; the 50 ms batching dominates it). Crash detection is bounded by the lease: about 25 s worst case before a user sees `EXECUTOR_LOST`. A shorter lease detects faster but costs more renewal writes and risks false expiry during a database latency spike; 15 s tolerates two missed heartbeats. Deploys don't pay this cost: a draining executor stops pulling work, waits up to 8 s, and fails the rest explicitly with `EXECUTOR_SHUTDOWN` rather than leaving them to the lease.

### Deep dive 2: Live output as a per-run, replayable event log

**Decision.** Each run gets its own Valkey stream. The executor appends batched deltas, and the stream service reads with a blocking read from the client's last entry ID. The first `end` closes the log for good. An hour later the log expires, and readers get a single `snapshot` event built from PostgreSQL.

**Why it works here.** The resume requirement means replay from an arbitrary offset, from any server. Stream entries are ordered and carry IDs that double as SSE event IDs, so `Last-Event-ID` resume needs no extra bookkeeping. Appends are cheap, and expiry is per run. Any stream-service instance can serve any run, because the log lives in Valkey and not in the process that started the run. The only ordering I need is within one run; nothing is ordered across runs, so there is no reason for a global log. The closed-log rule gives two invariants that make fencing work: nothing is appended after the end, and a run has exactly one ending. The append is an atomic check-and-append against a per-run "ended" flag, and both keys share the `{id}` hash tag so they live in one cluster slot.

**How the alternatives break.**

- *Pub/sub* is fire-and-forget. Tokens published during a two-second reconnect are gone, and a second tab opened halfway through sees only the second half. Resume would need a sticky route to whichever process holds the tokens.
- *Writing deltas to PostgreSQL* means ≈ 24K row writes a second at peak for data that matters for an hour. Appending to the run's output column instead is worse: under MVCC every append rewrites the row, so a 500-token run leaves hundreds of dead tuples on the hottest table. It competes with the 720 writes a second that actually matter.
- *Kafka* gives replay, but it is built around partitions, not per-run streams. A topic per run means millions of topics a day. A shared topic forces every reader to scan everyone's tokens to find one run's, and retention is per topic, not per run.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ One Valkey stream per run, closed by the first `end` | Replay from any offset; cheap appends; per-run TTL; any instance serves any run | Live output only as durable as Valkey |
| ❌ Pub/sub | Trivial | No replay; reconnect and late joiners lose tokens |
| ❌ Deltas in PostgreSQL | One store | ≈ 24K writes/s and row bloat on the source of truth |
| ❌ Kafka | Durable replay | Partition-oriented; per-run lookup and retention don't fit |

**What I give up.** If Valkey is lost mid-run, viewers lose the live view of that run, and the sweeper's partial-output rebuild has nothing to read. But the executor still writes the final output to PostgreSQL. Any reader that has been idle for a full 15 s block checks PostgreSQL, and if the run has ended it sends the `snapshot`. Losing the store costs live progress, never an outcome. Batching at 50 ms is the other cost: it is invisible to a human reading text, but it is part of the 100 ms streaming budget.

### Deep dive 3: Retry only before the first token, never after

**Decision.** The executor retries only while no output exists: a 429, a 5xx or a refused connection when opening the stream, up to 3 attempts, waiting the larger of `Retry-After` and 250 ms × 2ⁿ. A circuit breaker wraps only the stream-opening call: it opens at ≥ 50% errors over ≥ 5 calls, fails runs fast with `MODEL_UNAVAILABLE`, and half-opens after 10 s. Model rejections (4xx) and aborts don't count against it. After the first token, any failure is final: a mid-stream error is `MODEL_ERROR`, 30 s with no token is `MODEL_TIMEOUT`, and the partial output is kept and flagged. The sweeper never re-queues `EXECUTOR_LOST`.

**Why it works here.** In a playground, the run *is* the experiment. The developer has already read part of an answer. At temperature > 0 a retry produces a different answer, so a transparent retry would either replace text the user was reading or splice two different generations into one incoherent output. It would also double the token bill and distort the measurements the user came for: TTFT, duration, token counts. Before the first token none of that applies, because nothing has been shown or measured, so retrying there is pure upside.

**How the alternative breaks.** A transparent retry after tokens have streamed has no clean way to undo what the log already delivered. The log is append-only, and connected clients have rendered those deltas, so you'd need a "reset" event and every client would visibly jump. Auto-retrying `EXECUTOR_LOST` is worse: if the executor was only stalled, the run now has two generations racing, which is exactly the double execution that fencing exists to prevent. It also hides a real reliability problem from operators, who would see healthy completion rates while costs climb.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Retry before first token; final after | No silently different answers; honest metrics; no double billing | Some transient failures reach users |
| ❌ Transparent retry anywhere | Fewer visible errors | Replaced or spliced output; double billing; hides incidents |
| ❌ Never retry | Simplest | Every momentary 429 from the provider becomes a user-visible failure |

**What I give up.** Some failures surface that a retry would have hidden, so the failure-rate graph looks worse than one with blind retries. I'd rather have that and alert on it: `EXECUTOR_LOST` above 0.5% of runs, or a model's failure rate above 5%. "Run again" makes the new cost a visible, deliberate choice.

---

## 🛡️ Failure Handling and Access (~2 min)

| Failure | Behavior |
|---------|----------|
| Model 429/5xx before first token | Up to 3 attempts with backoff honoring `Retry-After` |
| Model keeps failing | Breaker opens; runs fail fast with `MODEL_UNAVAILABLE`; half-open after 10 s |
| Executor crash or stall | Lease expiry → sweeper fails the run (`EXECUTOR_LOST`), partial output kept; stalled executor fenced out |
| No executor available | Runs wait; after 5 minutes the sweeper fails them (`QUEUE_TIMEOUT`) instead of spinning forever |
| Doorbell lost | Sweeper re-enqueues queued runs whose last doorbell is older than 30 s |
| Valkey restarts empty | Executors recreate the consumer group; queued runs are re-enqueued from PostgreSQL; finals are served as snapshots |
| `end` event lost | A reader idle for 15 s checks PostgreSQL and sends the `snapshot` |
| Browser loses its connection | Reconnects with 0.5–8 s backoff from its last event ID; never re-posts the run |

**Access with asynchronous work.** Every query by prompt, run or comparison ID joins workspace membership, so removing a member takes effect on their next request. The executor doesn't re-check authorization: the run was authorized at creation and carries its `workspace_id`. The stream endpoint re-authorizes on every connect and reconnect. Share links are 128-bit random tokens with no cache in front. Revocation is checked on every request (`410`), the endpoint is rate-limited to 120 views per minute per IP, and it returns only the named snapshot and run. Request logs record method, URL and status, never prompt text or output.

---

## 📈 What Breaks First and How It Scales (~3 min)

| Pressure | First symptom and evidence | Response |
|----------|----------------------------|----------|
| SSE read fan-out | A blocking read holds its connection, so Valkey client count tracks the `playground_sse_connections` gauge 1:1. At thousands of streams per instance, connection count fails before CPU does | A multiplexed reader per instance: a few connections each doing a batched blocking read over many followed runs, dispatching entries to local subscribers |
| `runs` table growth | ≈ 20 GB/day; history queries and vacuum slow down | Monthly partitions on `created_at`; drop partitions rather than delete; outputs past retention go to object storage; history reads on replicas |
| Model capacity | Queue time rises while TTFT stays flat (executors saturated), or TTFT rises (provider saturated) | Admission control: bounded queue depth, fair share per workspace, `429` with `Retry-After` instead of an unbounded queue |
| Executors | `playground_runs_in_flight` at the concurrency limit | I/O-bound: 50–100 runs per process, so 1,200 concurrent runs need 15–25 processes |
| Valkey | ≈ 24K appends/s | Comfortable for a small cluster; run keys are hash-tagged, so logs spread with no hot key; the queue can be split by workspace hash if it ever matters |

Two wrinkles I'd raise before an interviewer does:

- **Multiplexing on a cluster.** A multi-key blocking read must stay inside one hash slot, and per-run hash tags put every run in its own slot. Either the event-log tag becomes a bucket (say 1,024 buckets; the closed-flag key shares the bucket, so the atomic append still works) or the reader polls each shard with non-blocking batched reads on a short tick.
- **Partitioning versus idempotency.** PostgreSQL enforces a unique constraint on a partitioned table only if it includes the partition key. The (user, key) uniqueness would move to a small unpartitioned idempotency table mapping (user, key) to the run ID and request hash, kept for 24 hours.

> "Queue time and TTFT are separate metrics on purpose. 'Runs feel slow' has opposite fixes depending on whether runs are waiting for an executor or for the model. Once the provider is the bottleneck, scaling my services does nothing. The work becomes deciding who waits, and saying no early with a `429` beats a queue that grows until everything times out."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Prompt history | Content-addressed snapshots + version labels | Version per run / text copied onto runs | Reproducible draft runs without flooding history |
| Run ownership | Executor with PostgreSQL lease + fencing | Stream inside the POST request | Runs outlive tabs, proxies and deploys |
| Live output | Per-run Valkey stream, closed by first `end` | Pub/sub / PostgreSQL rows / Kafka | Resume from any offset without write amplification |
| Work queue | Valkey stream as a doorbell (no acks) | Queue as source of truth | Ownership lives in one place |
| Retries | Only before the first token | Transparent retry | No silently different answers or double billing |
| Run creation | Idempotency-Key + request hash, replay before limits | Client-side debouncing | Survives lost responses and concurrent retries |
| Shared edits | Append-only versions; `If-Match` presets with 428 | Locks / last write wins | No silent overwrite, no stale locks |
| Cancellation | Flag + signal; only the owner writes `cancelled` | API writes the terminal state | One writer keeps output, usage and `end` consistent |
| Transport | SSE with `Last-Event-ID` | WebSockets | One-way data, built-in resume, ordinary HTTP |
| Auth | Session cookie + Valkey | JWT | Immediate revocation, simpler |

---

## 📝 Wrap-up (~1 min)

| Follow-up | Answer |
|-----------|--------|
| A prompt is edited while its previous version runs. Which text belongs to the result? | The snapshot the run pinned at creation; edits create new snapshots and never touch it |
| Two people update one preset. How is neither change lost? | `If-Match` revision compare-and-set; `428` without it, `409` with the current preset when stale |
| A run finishes after the user navigated away. Where does it appear? | In PostgreSQL history for the whole workspace; the app-level run store raises a toast; `GET /runs/active` reattaches after a refresh |
| Side-by-side comparisons without a redesign? | N ordinary runs sharing a nullable `comparison_id`; each already pins its own snapshot and config |

> "In summary: immutable snapshots behind mutable heads make every result reproducible, including runs of unsaved drafts. A run is a durable record whose single owner is decided in PostgreSQL by a fenced lease, so it outlives the browser and records exactly one outcome, even when an executor dies or only pretends to. Live output is a per-run log any server can replay, which makes reconnects free. And I never retry after the user has seen output. With more time, I'd go into per-workspace token budgets and fair-share admission once the provider becomes the bottleneck."

### How the local implementation compares

The repo's backend runs three processes: the API (which also serves SSE), one or more executors, and a mock model service with tunable TTFT, tokens per second, failure rate and concurrency slots, so failure paths can be triggered on demand. The run lifecycle is implemented as described: idempotent creation with the replay check ahead of the limits, a 15 s lease with 5 s heartbeats, a 10 s sweeper in every executor, re-enqueue after 30 s, a 5-minute queue timeout, 50 ms delta batching, a closed event log, retries only before the first token, and a circuit breaker on stream opening. The simplifications are a single PostgreSQL and Valkey, fixed-window rate limits, and one Valkey connection per open SSE stream, which is exactly the "what breaks first" row above. Recovery paths were exercised locally: a SIGSTOPped executor was failed by a second executor's sweeper and fenced out when resumed, a lost queue entry was re-enqueued, and a deleted consumer group was recreated.
