# Prompt Playground — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · the model-serving API already exists; the interviewer wants product and frontend design*

> "The model already exists, so I'm not going to design inference: no GPUs, no batching, no KV caches. What I'm designing is the product a developer works in: an editor, a run panel, a history and a share link. Three promises shape everything. Every result can be reproduced exactly. A run outlives the page that started it. Nobody's edit is ever silently lost. Most of my time goes to the seams where the browser, the API and the run pipeline have to agree on those promises."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scope | ~5 min | What's in, what's explicitly out (inference), production targets |
| Workflow, entities, client state | ~10 min | Why a run pins a snapshot; where every piece of state lives |
| API contracts | ~5 min | Five contracts and how each behaves when retried or raced |
| Run path and traces | ~8 min | One successful and one failed run, step by step |
| Deep dives | ~12 min | Three trade-offs that cross the stack |
| Scale, checklist, wrap-up | ~5 min | What breaks first at 100×, and what I'd add next |

---

## 🎯 Requirements and Scope (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Assumption | Design consequence |
|----------|------------|--------------------|
| Who uses it? | Developers in team workspaces | Presets and share links are workspace-scoped; every read is authorized per workspace |
| What does the model API give me? | A streaming HTTP endpoint that can be slow, answer 429, fail mid-stream or stall | I design for its failures, not its internals |
| Real-time co-editing? | No. Drafts are personal until saved | Optimistic concurrency, not CRDTs |
| Must results be reproducible? | Yes, exactly: text, variables and config | Runs reference immutable content and copy their config |
| Scale? | 100K daily developers × 20 runs each | ≈2M runs/day, ≈120 runs/s at peak, ≈1,200 concurrent generations |
| Sharing? | A read-only, revocable link to one thing | Share tokens name immutable objects only |

### Functional requirements

1. Edit a prompt: a system message plus a user template with `{{variable}}` placeholders. Unsaved edits survive a refresh.
2. Pick a model, temperature, top-p and max tokens, by hand or from a workspace-shared preset.
3. Run it, watch the output stream token by token, and stop it at any time.
4. Run the same prompt against two or three configs and compare the outputs side by side.
5. Save numbered, immutable versions with a message, and load or restore any of them.
6. List every past run with the exact text, variables, config, usage and timings it used.
7. Share a read-only link to one version or one finished run, revoke it, and let a recipient copy it into their own workspace.
8. Keep several runs in flight at once across prompts. Leaving the page never cancels them.

**Explicitly out of scope:** model serving and inference infrastructure, billing, evaluation datasets, and real-time co-editing of one draft.

> "This question has a trap. The model is the most interesting-sounding box on the board, and it's the one I was told to assume. If I catch myself talking about GPU scheduling, I've stopped answering the question. Here the model is an external dependency with a failure profile, and nothing more."

### Non-functional requirements

| Property | Target |
|----------|--------|
| Run acceptance (`POST /runs`) | p99 < 150 ms, so the click feels instant |
| Streaming overhead | A token reaches the browser within 100 ms (p95) of the model emitting it |
| Resume | A reconnecting client loses no tokens and never starts a duplicate generation |
| No silent loss | Every accepted run ends visibly as completed, cancelled or failed |
| Reproducibility | A run's prompt text, variables and config never change after creation |
| Isolation | No reads across workspaces; a share link exposes only what it names |
| Availability | 99.9%. End-to-end availability is capped by the model provider anyway |

---

## 🧭 The Product Workflow (~3 min)

I start from the screen, because the screen tells me which state exists.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Library · Presets · Admin                              [ 2 running ]     │
├────────────────────────────────────┬─────────────────────────────────────┤
│ Support triage · v3 · edited       │ A: sim-fast · temp 0.7 · 512 tokens │
│ ┌────────────────────────────────┐ │ B: preset "Careful" (rev 4)         │
│ │ System: You triage tickets for │ │ [+ C]                               │
│ │ {{product}} …                  │ ├──────────────────┬──────────────────┤
│ │ User: Ticket from a            │ │ A · streaming    │ B · queued       │
│ │ {{customer_tier}} customer …   │ │ "Treat invoices  │                  │
│ └────────────────────────────────┘ │  as primary…"    │                  │
│ Variables: product · tier · ticket │ [Stop]           │ [Stop]           │
│ [Save version]            [Run]    │ 56 in · 60 out · TTFT 0.7 s         │
├────────────────────────────────────┴─────────────────────────────────────┤
│ History  Draft · now v4 · sim-fast · completed · 2 min ago               │
│          v3 · sim-quality · cancelled (partial) · 1 h ago                │
└──────────────────────────────────────────────────────────────────────────┘
```

The workflow is edit → run → watch → compare → save → share, and each verb crosses a state boundary:

- **Edit** changes only local state. Nothing reaches the server on a keystroke.
- **Run** turns the current draft text into durable, immutable content on the server, saved or not.
- **Watch** follows a server-side run by its ID. The page is a viewer, never the owner.
- **Compare** starts several runs together.
- **Save** turns the draft into a numbered version the whole workspace sees.
- **Share** hands out a token for one immutable thing.

---

## 💾 Entities (~4 min)

```
 prompt ─────────────── mutable head: title, description, head_version
   │
   ├──▶ prompt_version ── v1, v2, v3 … append-only labels ───────┐
   │                                                             ▼
   ├──▶ prompt_snapshot ─ immutable, keyed by hash(system, template)
   │                                                             ▲
   ├──▶ run ───────────── pins one snapshot ─────────────────────┘
   │      copies config + variables; status, output, usage, timings
   │
   └──▶ share ─────────── token → one version or one finished run

 model_preset ────────── workspace config + revision (copied into runs, never referenced)
```

| Entity | Mutability | Key fields | Why it exists |
|--------|------------|------------|---------------|
| prompt | Mutable head | workspace, title, description, head version | The library entry. Renames are last-write-wins |
| prompt snapshot | Immutable | content hash of (system, template), the text, variable names; unique per prompt | "The exact text that ran", stored once however often it runs |
| prompt version | Append-only | (prompt, number), snapshot, message, author | A deliberate, human-meaningful label |
| model preset | Mutable, with a revision | workspace, name, config | A shared starting point, edited by compare-and-set |
| run | Inputs write-once; status is a state machine | snapshot, copied config, variables, rendered text, status, output, partial flag, usage, timings, attempt, idempotency key, comparison ID | The durable record of one generation |
| share | Revocable | 128-bit random token, snapshot, version or finished run | A read-only pointer to one immutable thing |

**Why a run pins its snapshot and copies its config.** This answers the first follow-up: *a developer edits a prompt while its previous version is running; which text belongs to the result?* The run's snapshot, fixed when the run was created. Edits change the draft, never the run. The config is copied rather than referenced for the same reason. Presets are mutable, so if a run pointed at the "Careful" preset, a teammate tuning that preset tomorrow would rewrite what yesterday's run claims it used.

**Draft runs.** Running an unsaved draft upserts a snapshot that has no version. If the same text is saved later as v4, that version points at the same snapshot, and history shows "Draft · now v4". The label is computed when history is read, so no run row is ever updated after the fact.

The run's lifecycle is the one every LLM product shares: queued → running → completed, cancelled or failed. The server assigns the ID, and anyone allowed to see the run can reconnect to it.

---

## 🖥️ Client State: What Lives Where (~3 min)

> "The most common bug in a tool like this is state in the wrong place: a draft that dies on refresh, or a stream owned by a component that unmounts when you click another prompt."

| State | Lives in | Survives refresh? | Why there |
|-------|----------|-------------------|-----------|
| Draft: text, variable values, 1–3 configs, the version it was based on | localStorage, one entry per prompt | Yes, in this browser | Private until saved; no server writes per keystroke |
| Saved prompt, versions, run history, presets | Server, fetched on navigation | Yes | Shared with the workspace |
| Live runs: status, output so far, connection state | App-level store; streams followed outside React components | Rebuilt: on load the app asks for the caller's active runs and re-follows each from the start of its log | Must outlive route changes |
| Selected run or comparison | URL search parameter (`?run=`) | Yes, and pasteable to a teammate | A refresh or a link reopens the same result |
| Conflict state (head moved, stale preset) | Derived in components from draft vs head | Recomputed | Never persisted |

**What a URL identifies.** I keep two kinds of URL distinct. An in-app URL such as `/prompts/:id?run=:runOrComparisonId` names resources by ID and requires workspace membership; a non-member gets a 404 that looks exactly like "doesn't exist". A share URL `/s/:token` names exactly one saved version or one *finished* run. It needs no session, is read-only, and returns 410 once revoked. A share can never point at a draft or a running run, so what the recipient sees can't change after the link is made.

**Two client rules that matter.**

1. *While a run is being followed, its stream is authoritative.* A REST response can arrive after the stream has already delivered the end event; the classic case is the Stop button's response landing after the cancellation finished. The store ranks statuses (queued, then running, then terminal) and never lets a REST copy move a run backwards. Without that rule, a cancelled run flips back to "running" with empty output.
2. *Reconnecting is reading, never resubmitting.* The browser follows a run by ID. A lost connection never leads to another `POST /runs`.

**Drafts and the head.** The draft records the head version it started from. If the server's head moves past that while the draft has edits, the editor shows a banner *before* the user saves, such as "Bob saved v3 after you started editing", with "Load v3, discard my edits" or "Keep my edits on top of v3". If the draft text equals the new head, the base advances silently.

---

## 🔌 API Contracts (~5 min)

```
POST   /api/v1/prompts/:id/versions   → Save the next version (body carries baseVersion)
POST   /api/v1/runs                   → Start a run (Idempotency-Key header required)
GET    /api/v1/runs/:id/events        → SSE: status · delta · end · snapshot (Last-Event-ID resume)
POST   /api/v1/runs/:id/cancel        → Stop a queued or running run
PATCH  /api/v1/presets/:id            → Edit a shared preset (If-Match: "<revision>")
POST   /api/v1/prompts/:id/shares     → Link to one version or one finished run
GET    /api/v1/shared/:token          → Public read-only view
GET    /api/v1/runs/active            → Caller's queued and running runs (reattach on load)
GET    /api/v1/comparisons/:id        → Every run of one side-by-side comparison
```

| Contract | Success | Error behavior |
|----------|---------|----------------|
| Save version | 201 with the new version; 200 no-op if the text equals the head | 409 HEAD_MOVED with the newer head's text, number, message and author |
| Start run | 202 with the queued run. A retry with the same key gets 200, the same run and `Idempotent-Replayed: true` | 422 IDEMPOTENCY_KEY_REUSED if the body differs; 422 MISSING_VARIABLES; 429 for the rate limit (30/min) or the active-run cap (6); 400 without a key |
| Follow events | Events with IDs, closed after `end`. Once the live log has expired, a single `snapshot` built from the database | 404 for a run the caller can't see; the client treats 401 and 404 as final and stops retrying |
| Cancel | 200 if the run is already final; 202 while the executor stops it. The final status arrives on the stream | 404 if not visible |
| Edit preset | 200 with the new revision as an ETag | 428 without If-Match; 409 REVISION_CONFLICT with the current preset and who changed it |
| Share | 201 with a token | 409 RUN_NOT_FINISHED; later reads return 410 SHARE_REVOKED |

> "Each contract answers one question: what happens when this request is retried or raced? Starting a run needs an idempotency key because a lost 202 looks exactly like a failure, and a blind retry would pay for a second generation. Saving needs a base version because a save from stale state would otherwise silently publish over a version the user never saw."

The idempotency replay check runs *before* the rate limits. A retry of an accepted request asks for nothing new, so it should never get a 429.

---

## 🏗️ Architecture and the Run Path (~8 min)

```
┌───────────────────────────┐
│ Browser (React SPA)       │
│ draft store (local)       │
│ run store (app-level)     │
└──────┬─────────────▲──────┘
       │ REST        │ SSE + Last-Event-ID
┌──────▼─────────────┴───────────────────────────────────────┐
│ Load balancer · TLS · session cookie · per-user limits     │
└──────┬──────────────────────────────────┬──────────────────┘
       │                                  │
┌──────▼──────────────┐         ┌─────────▼──────────────┐
│ Playground API      │         │ Stream service         │
│ prompts · versions  │         │ replays a run's log    │
│ runs · presets      │         │ from any offset        │
│ shares              │         └─────────▲──────────────┘
└──┬────────────┬─────┘                   │ blocking read
   │ commit     │ append "queued",        │
   │ run row    │ ring doorbell           │
┌──▼─────────┐ ┌▼─────────────────────────┴────────────────┐
│ PostgreSQL │ │ Valkey: run queue · per-run event logs    │
│ source of  │ │ sessions · rate limits · cancel pub/sub   │
│ truth      │ └──────────▲────────────────────────▲───────┘
└──▲─────────┘            │ pull run IDs           │ append deltas, end
   │ claim · lease ·      │                        │
   │ finalize  ┌──────────┴────────────────────────┴───────┐
   └───────────┤ Run executors (N): lease · heartbeat ·    │
               │ cancel listener · sweeper · breaker       │
               └─────────────────────┬─────────────────────┘
                                     │ streaming HTTP (abortable)
                          ┌──────────▼───────────┐
                          │ Model API (existing) │
                          └──────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| Browser SPA | Draft store, app-level run store, a stream follower that resumes from its cursor |
| Playground API | Stateless REST: authorization in every query, idempotent run creation, conflict checks |
| Stream service | Long-lived SSE connections that replay a run's log from any offset. The same process as the API locally; its own fleet in production |
| Run executors | The only callers of the model. Each owns a run through a PostgreSQL lease and records its single outcome |
| PostgreSQL | Source of truth for prompts, versions, presets, shares and every run's final state |
| Valkey | The run queue (only a doorbell), per-run event logs, sessions, rate limits, cancel signals |

### ✅ Successful trace: one run, end to end

1. **Browser.** The user clicks Run. The launcher generates one UUID as this click's Idempotency-Key and sends the draft's system text, template, variable values and config. On a network error or a 5xx it retries up to twice more with the *same* key.
2. **API.** It looks up (user, key) and finds nothing. It authorizes the prompt against workspace membership, renders the variables (422 if any are missing), applies the rate limit and the active-run cap, upserts the snapshot by content hash, and inserts the run as `queued`. A unique constraint on (user, key) means two concurrent retries produce exactly one row.
3. **API → Valkey.** It appends `status: queued` to the run's event log, rings the queue's doorbell with the run ID, and returns 202 with the run.
4. **Browser.** The run store starts following the run's event stream, the URL becomes `?run=<id>`, and the panel shows "Queued".
5. **Executor.** It reads the run ID and claims it with a conditional update that matches only a queued row. The status becomes running, the attempt counter increments, and a 15-second lease starts. A duplicate doorbell, or a run cancelled while queued, matches nothing and is dropped.
6. **Executor → model.** It calls the model through a circuit breaker; a 429 or 5xx before the first token is retried with backoff. On the first token it records the time to first token.
7. **Executor → event log.** Tokens are batched into `delta` events every 50 ms. Every 5 seconds it renews the lease, on the condition that it still owns this attempt, and checks the cancel flag.
8. **Stream service → browser.** The SSE handler blocks on the run's log from the client's cursor and forwards each entry, using the log entry ID as the SSE ID. The browser appends text as it arrives.
9. **Executor.** The model finishes. The executor writes the status, output and token counts with an update conditioned on (this attempt, still running), then appends one `end` event carrying usage: input and output tokens, queue time, TTFT and duration.
10. **Browser.** The `end` event closes the stream, and the panel shows usage and enables Share. If the user has moved to another prompt, a toast says the run on "Support triage" finished and links back to `?run=<id>`.

### ❌ Failed trace: the executor dies mid-stream

1. Steps 1–8 happen as above, and about 200 tokens have streamed.
2. The executor process is killed. Its HTTP connection to the model drops, so the model stops generating and stops spending tokens. Its last delta batch is already in the log.
3. The browser's stream stays open: the handler sends keep-alive pings, and the output simply stops growing. Nothing on screen is lost.
4. Fifteen seconds after the last heartbeat, the lease expires. Every executor runs a sweeper every 10 seconds, and exactly one of them wins the conditional update from running to `failed` with `EXECUTOR_LOST`.
5. The sweeper appends the `end` event, which closes the log, then rebuilds the partial output from the deltas in it and stores that with the partial flag set. Closing first means the stored output is exactly what viewers saw.
6. The browser receives `end`. It keeps the 200 tokens on screen labeled "partial" and shows EXECUTOR_LOST. "Run again" creates a *new* run with a new key.
7. If the executor was only stalled (a long GC pause or a network partition) and wakes up, it is fenced out three ways. Its heartbeat matches zero rows, so it aborts the model call. Its finalize matches zero rows, so its outcome is discarded. Its late deltas are refused because the log already holds an `end`.

> "I deliberately don't retry once the first token has arrived. The user has already read part of an answer, and a retry would replace it with a different sample, bill the tokens twice, and hide a reliability problem from the operator. Run again is one click, and it makes the cost visible."

The worst-case stall the user sees is about the 15-second lease plus one 10-second sweep interval.

### Loading, streaming, failure and cancellation in the UI

| Run state | What the user sees | Driven by |
|-----------|--------------------|-----------|
| Launching | Spinner on Run; POSTs retried with the same key | Launcher |
| Queued | "Queued" badge; Stop enabled | `status` event |
| Running, no tokens yet | Elapsed time, "waiting for first token" | `status: running` |
| Streaming | Text grows every ~50 ms; Stop | `delta` events |
| Reconnecting | Output stays; a "reconnecting…" chip; resume from the cursor with backoff from 0.5 s to 8 s | Connection state |
| Stopping | Stop disabled and labeled "Stopping…" | Local flag until `end` |
| Completed | Tokens, queue time, TTFT, duration; Share | `end` |
| Cancelled or failed | Partial output kept and labeled; error code and message; Run again | `end` |

**Cancellation that reaches the model.** A queued run is cancelled directly with a conditional update, and the API appends its `end`. For a running run, the API records that a cancel was requested and publishes the run ID. The owning executor aborts its HTTP request to the model, so generation actually stops, and finalizes the run as `cancelled` with its partial output. If the pub/sub message is lost, the next heartbeat sees the flag within 5 seconds. If a cancel races completion, whichever conditional update commits first is the outcome, and the stream reports it.

**Concurrent runs and navigation.** This is the third follow-up: *a run finishes after the user navigated elsewhere; where does its result appear?* In three places. The app-level store has it, so the header's "2 running" indicator updates and a toast links back. The prompt's run history has it, because history is a server query, not client memory. Its URL has it, so a refresh reopens it. Navigating away never cancels a run. Only Stop does.

---

## 🆚 Side-by-Side Comparisons (~2 min)

The fourth follow-up asks how to add comparisons without redesigning the data model. A comparison is N ordinary runs that share a `comparison_id`.

```
 Run with configs A, B, C ──▶ comparison K (one Idempotency-Key per config)
     │
     ├──▶ run 1 · sim-fast    · t 0.7 ──▶ executor ──▶ log 1 ──▶ column A
     ├──▶ run 2 · sim-quality · t 0.2 ──▶ executor ──▶ log 2 ──▶ column B
     └──▶ run 3 · sim-flaky   · t 0.7 ──▶ executor ──▶ log 3 ──▶ column C

 URL: /prompts/:id?run=K     deep link → GET /comparisons/K
```

- Each run has its own idempotency key, executor, event log and Stop button, so a slow model never holds up a fast one.
- If one run is rejected (by the active-run cap, say), the others still start, and the UI says "1 of 2 runs started".
- The output area shows every run in the store with that comparison ID, ordered by creation.
- The schema change was one nullable column and a partial index. It was that cheap because runs already pinned their own snapshot and copied their own config, so a run never needs its siblings to explain itself.

> "The test of an entity design is whether a new feature falls out of it. Comparison did. Comparing two *versions* instead of two configs would be the same thing with different snapshots, again with no schema change."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: Runs decoupled from the HTTP request

**Decision.** `POST /runs` only records and enqueues. A separate executor owns the model call and writes output to a replayable log, one per run. The browser reads that log over SSE by run ID, starting after its last event ID.

**Why it works here.** A generation lasts 5 to 60 seconds, which is longer than a developer stays on one page. The requirements are full of cases where the page goes away: switching prompts mid-run, refreshing, opening the run in a second tab, a laptop sleeping on a train. When an executor owns the run, each of those reduces to "a viewer stopped reading". Log entry IDs double as SSE IDs, so a reconnect sends `Last-Event-ID` and receives exactly the entries after it, with no gaps and no duplicates. Any API instance can serve any run, because the log lives in Valkey rather than in the process that started the run. The executor tier is also the single place to enforce concurrency limits and model capacity.

**How the alternative breaks.** Streaming the model's output back in the POST response ties the run's life to one TCP connection and one API process. Close the tab and the generation dies, or keeps billing with no reader. A proxy idle timeout or a rolling deploy cuts every in-flight generation at once. A reconnect has nothing to reconnect *to*, so the only recovery is a new POST: a duplicate run, duplicate tokens, and with temperature above zero a *different* answer. Pub/sub instead of a log fails differently. A delta published during the 800 ms a client spends reconnecting is simply gone, and resume needs replay from an offset, which only a log provides. Writing every delta to PostgreSQL does give replay, but costs about 24K row writes per second at peak for data that matters for an hour.

**What I give up.** A queue, an ownership protocol (leases, fencing, a sweeper) and an extra hop on the token path. Live output is only as durable as Valkey: if it's lost mid-run, viewers lose the live view, although the executor still writes the final output to PostgreSQL and readers get it as a snapshot. The client also has to be smarter, with a stream follower that tracks a cursor and backs off, owned by an app-level store rather than a component.

| Approach | Survives refresh and navigation | Resume without duplicates | Cost |
|----------|--------------------------------|---------------------------|------|
| ✅ Executor + per-run log + SSE with Last-Event-ID | Yes | Yes | Queue, leases, sweeper, one more hop |
| ❌ Stream inside the POST response | No | No: a reconnect means a new generation | Simplest; breaks on every deploy |
| ❌ Executor + pub/sub fan-out | Yes | No: messages sent during a reconnect are lost | No replay |
| ❌ Executor + delta rows in PostgreSQL | Yes | Yes | ~24K writes/s at peak on the source of truth |

On transport, I read SSE with `fetch` rather than using `EventSource` or a WebSocket. Data flows one way, SSE has resume built into the protocol, and `fetch` gives explicit control of the cursor, backoff, abort and auth. The cost is one HTTP connection per followed run, which HTTP/2 multiplexes.

### Deep dive 2: Snapshots with version labels

**Decision.** Each distinct (system, template) pair is stored once per prompt as a content-addressed snapshot. Versions are append-only numbered labels on snapshots. Runs point at snapshots and copy their own config and variables.

**Why it works here.** The product has two kinds of "text that ran": deliberate saved versions, and quick experiments on an unsaved draft, which is most runs. Both must be reproducible, and one foreign key covers both. Running the same draft 30 times while tuning temperature stores the text once. When a draft's text is later saved, its runs show "now v4" through a join at read time, with no backfill. On the frontend this keeps the version list meaningful: v1 to v7 are seven decisions someone made, each with a message.

**How the alternatives break.** *A version per run* makes every run reproducible but floods the history. A developer iterating for an hour produces 80 versions, "v62" means nothing, and the save message, the only human signal, gets lost. *Copying the text onto each run* is also reproducible, but it loses the link to versions. "Which runs used v3?" becomes a text comparison across millions of rows, and a 10 KB prompt run 500 times stores 5 MB of identical text. *Referencing the prompt's current text* is the trap behind the first follow-up: edit the prompt, and every past result silently changes meaning.

**What I give up.** An extra table and a hash on the run path, and "which version is this run?" becomes a join on an indexed snapshot ID. Content addressing also forces me to define what re-saving identical text means. I made it a no-op that returns the current head.

| Approach | Reproducible draft runs | Meaningful history | Storage |
|----------|------------------------|--------------------|---------|
| ✅ Snapshots + version labels | Yes | Yes: versions are decisions | Text once per distinct content |
| ❌ Version per run | Yes | No: hundreds of meaningless versions | Text once per run |
| ❌ Text copied onto runs | Yes | Partly: no link to versions | Text once per run |
| ❌ Runs reference the prompt's current text | No | Yes | Minimal |

### Deep dive 3: Optimistic concurrency for shared prompts and presets

**Decision.** A version save carries `baseVersion`. The API locks the prompt row for the save transaction and returns 409 HEAD_MOVED if the head has moved on. Presets carry a `revision`, and edits and deletes must send it in `If-Match`, getting 428 without it. A stale revision gets 409 REVISION_CONFLICT along with the current preset. Prompt renames are deliberately last-write-wins.

**Why it works here.** This is the second follow-up: *two people update the same preset; how do you avoid silently overwriting either change?* Shared edits here are rare and short, such as a teammate adjusting a preset's temperature once a week. An optimistic check costs nothing in that common case and turns the rare conflict into an explicit choice. For presets, the editor shows their version next to mine with "Use theirs" or "Overwrite with mine". Overwriting is a new request against their revision, so even the override is a conscious decision, recorded as a new revision. For prompts, versions are append-only, so a 409 can never lose data. It only stops someone from publishing on top of a version they never saw.

**How the alternatives break.** *Last-write-wins* is exactly the outcome the requirement forbids. Alice raises max tokens, Bob lowers temperature from a stale form, Alice's change disappears, and nobody notices until a run looks wrong. *Pessimistic locks* break on human behavior. Someone opens the preset editor and goes to lunch, and now the lock needs a lease, a heartbeat from the browser, a "take over" button, and a rule for the laptop that went to sleep holding it. That's a distributed-lock protocol to protect a five-field form. *CRDT co-editing* solves a problem this product doesn't have: drafts are personal until saved, so two people never type into the same one.

**What I give up.** Conflicts reach users, and the client has to present them well: the banner, the side-by-side preset view, the reload. A conflict shown as a generic error toast is almost as bad as a silent overwrite, so this choice commits the frontend to real conflict UX.

| Approach | Silent overwrite? | Failure mode | Fits when |
|----------|-------------------|--------------|-----------|
| ✅ Optimistic (baseVersion, If-Match revision) | Never | Conflicts surface and need good UX | Edits are rare and short |
| ❌ Last-write-wins | Yes | Lost changes nobody notices | Only for labels like titles |
| ❌ Pessimistic locks | Never | Abandoned locks need leases and takeover | Long, contended edits |
| ❌ CRDT co-editing | Never | Heavy machinery for an unneeded feature | Real-time co-authoring, which is out of scope |

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL. A run is accepted once its row commits, and the 202 is sent after that. A version is saved once its transaction commits. Valkey holds only live progress and the queue doorbell, so losing it loses neither an accepted run nor a final result |
| What happens when a client retries after losing the response? | Run creation replays the original run by Idempotency-Key, before any limit check. A stream reconnect reads from `Last-Event-ID` and never re-POSTs. A save retried after its first attempt committed returns 200 with that version: saving text that is already the head is a no-op even when `baseVersion` is stale, so the retry is idempotent |
| What happens when a worker fails between two steps? | Row committed but enqueue failed: the sweeper re-rings queued runs after 30 s. An executor dies after reading the doorbell but before claiming: the run is still queued, so the same recovery applies. An executor dies mid-stream: the lease expires, the run fails with EXECUTOR_LOST, and the partial output is kept. Valkey fails during finalize: PostgreSQL has the outcome, and an idle SSE reader checks it after 15 s and sends a snapshot |
| Which ordering is actually required? | Within a run: events in log order, exactly one terminal outcome, and a client status that only moves forward. Within a prompt: sequential version numbers. Nothing across runs; the runs in a comparison are independent |
| How is access enforced with caches and async work? | Every lookup by run, prompt or comparison ID joins workspace membership, including the SSE endpoint before it reads the log. Membership is re-checked on every request rather than trusted from the session, so removing someone takes effect immediately. Executors act only on rows that were authorized at creation. Share tokens are checked for revocation on every read. Request logs never contain prompt text or output |
| What breaks first at scale? | The SSE read path, below |

---

## 📈 What Breaks First at 100× (~3 min)

Today's peak is about 120 runs/s, 1,200 concurrent generations, 2,000 open streams, 24K log appends/s and 720 PostgreSQL writes/s. At 100×:

| Rank | Component | Load at 100× | Why it breaks | Fix |
|------|-----------|--------------|---------------|-----|
| 1 | SSE read fan-out | ≈200K open streams | A blocking log read holds its Valkey connection, so each open stream costs one connection, and connection count runs out before CPU | One multiplexed reader per stream-service instance dispatching to local subscribers, on a dedicated stream fleet |
| 2 | PostgreSQL run writes | ≈72K writes/s | About 6 writes per run (insert, claim, first token, lease renewals, finalize) is beyond one primary | Shard runs by workspace, partition by month, move old outputs to object storage, renew leases less often |
| 3 | Log appends | ≈2.4M/s | Fine per shard: run keys are hash-tagged and spread across a cluster | Add shards; widen delta batching to 100 ms under load |
| 4 | Executors | ≈120K concurrent generations | I/O-bound at 50–100 per process, so 1,200–2,400 processes | Scale horizontally; autoscale on queue time, not CPU |
| — | The model provider | 100× the tokens | The real ceiling | Admission control: a bounded queue, fair share per workspace, 429 with Retry-After instead of an unbounded queue |

> "My evidence for ranking SSE first is structural, not a guess. The stream handler opens a dedicated connection per stream, so connections per instance grow linearly with viewers. The PostgreSQL figure comes from counting writes per run. I'd confirm both with the queue-time and TTFT histograms, which are separate on purpose: 'runs feel slow' has opposite fixes depending on whether runs are waiting for an executor or for the model."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Run ownership | Executor with lease + fencing | Stream inside the POST | Runs outlive tabs, proxies and deploys |
| Live output | Per-run replayable log | Pub/sub, or delta rows in PostgreSQL | Resume from any offset without write amplification |
| Transport | SSE read with fetch | WebSocket / EventSource | One-way data, built-in resume, explicit control |
| Prompt history | Snapshots + version labels | Version per run / text on runs | Reproducible draft runs and meaningful history |
| Run config | Copied onto the run | Reference to the preset | Editing a preset never rewrites history |
| Run creation | Idempotency-Key + request hash | Client-side debouncing | Survives lost responses and concurrent retries |
| Retries | Only before the first token | Transparent retry | No silently different answers or double billing |
| Shared edits | baseVersion / If-Match revision | Locks / last-write-wins | No silent overwrite, no stale locks |
| Drafts | localStorage per prompt | Server autosave | Private until saved; no per-keystroke writes |
| Live run state | App-level store outside components | Component state | Runs survive navigation |

---

## 🚀 With More Time

- **Diffs between versions**, and comparing two versions side by side. Both reuse existing snapshots.
- **Opt-in server-side draft sync** for working across devices, with drafts still private to their author.
- **Per-workspace token budgets** and fair-share admission, once the model becomes the bottleneck.
- **Batch runs over a dataset.** One prompt × N rows of variables is N runs sharing a batch ID, the same move as comparisons, and the bridge to an evaluation product.
- **A real provider adapter** behind an environment variable. Locally, a mock model streams deterministic tokens with configurable latency, failure rate and capacity, so every failure path above can be triggered on demand.

---

## 📝 Wrap-up (~1 min)

> "To sum up: the browser owns the draft and nothing else, and everything that has to be true later lives on the server. Running a prompt snapshots its text and copies its config, so every result is reproducible, and comparisons fell out as N runs sharing an ID. Executors own runs and stream them through a replayable log, so a page is only ever a viewer: refresh, navigate away or reconnect, and you lose nothing and never pay twice. Shared edits use optimistic checks, so conflicts become choices instead of losses. What I'd validate first is queue time versus TTFT in production, because that decides whether to scale executors or negotiate model capacity. Then I'd run a kill-an-executor drill to confirm the fencing holds."

### How the local implementation compares

The repo runs this design on one machine. The frontend is Vite and React with Zustand stores: drafts persist to localStorage, and runs are followed outside components. An Express API also serves the SSE streams. A separate executor process handles leases, heartbeats and the sweeper, alongside PostgreSQL, Valkey and a mock model service with three simulated models: a fast one, a slower higher-quality one, and a flaky one that fails partway through about a third of its runs. Compared with this answer, the stream service runs inside the API process and opens one Valkey connection per stream instead of using a multiplexed reader. There's a single PostgreSQL and a single Valkey instead of replicas and a cluster, rate limits use fixed windows, each user gets one workspace at sign-in, and there's no real provider adapter yet.
