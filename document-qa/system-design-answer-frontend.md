# Document Q&A — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45–50 minutes · Requirements → Architecture → State → Screens → Deep dives → The key question → Traces → Wrap-up*

> "Users upload documents to an assistant. The system extracts, chunks, embeds and indexes them, then answers questions with citations, and it has to support new versions, sharing changes and deletion. The backend round is about the pipeline and the index. The frontend round has its own trap: the browser ends up holding copies of the content. That means an open document page, a chat history in a store, and a citation chip, and every one of them goes stale the moment a document is unshared or deleted. Three ideas carry my answer. First, the server is the only authority, so the client asks it again through the same access-checked endpoints instead of trusting what it already holds. Second, a question is a durable run that the server owns. The browser posts it, then follows its event stream only while it's generating, and it can reconnect through any API instance. Third, everything else is polled, because pipeline state changes over seconds and every poll is a fresh authorization."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Surfaces, client-facing targets, the trap |
| Architecture and state | ~8 min | Routes, who owns which state, the API surface |
| Screens | ~5 min | Library, document page, answer card, ops |
| Deep dives | ~15 min | The answer run, polling vs streams, writes the server can refuse |
| The key question | ~5 min | Stale client copies of content that has become inaccessible |
| Traces, checklist, scale | ~7 min | One success, one failure, six review questions, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Which file types and sizes? | Upload path, error copy | `.txt`, `.md`, `.html` up to 5 MB here; large PDFs at production size go through a presigned PUT |
| How fresh must processing state be? | Push vs poll | A few seconds; a 20-page document takes ~30 s to become ready |
| Multi-turn chat, or independent questions? | Whether old answers become prompt context | Independent questions; each run retrieves fresh. No conversation memory |
| Who can read a document? | What the UI shows and hides | Private, one group, or org-wide; a revoke applies to the next question |
| What does "delete" promise? | Copy and progress UI | Gone everywhere at once, then a tracked purge with a completion time |
| Must a citation open the exact passage? | URL design | Yes: character offsets into the extracted text, highlighted |
| Operators? | A separate surface | Pipeline health with ids and counts, never titles, text or questions |

### Users and surfaces

| User | Needs | Constraint |
|------|-------|------------|
| Member | Upload, watch processing, ask, open citations, share and delete their own documents | Sees only what they can read *right now* |
| Org admin | Everything a member does, plus group membership | Removing someone takes effect on that person's next question |
| Operator | Queue depth, jobs by stage, poisoned jobs, purge backlog, stale index rows, fault switches | No content at all |

### Functional requirements

1. Drag-and-drop upload with a duplicate notice, and a retry that can't create a second document.
2. A library with per-stage pills (extract → chunk → embed → index) showing progress and attempts, failed documents with the reason and a Retry button, and "v2 processing" while v1 keeps serving.
3. Owner controls: sharing, a new version, delete. A "Recently deleted" panel shows purge progress per artifact and the completion time.
4. A document page with the extracted text, the cited span highlighted from the URL, chunks with offsets, versions, and the processing timeline with every attempt.
5. Ask: a streamed answer with numbered citation chips, Stop, honest terminal states, a cache badge, a retrieval line and a usage line.
6. An operator page.

### Non-functional requirements (client-facing)

| Property | Target | What it forces |
|----------|--------|----------------|
| First token visible | p50 < 1.5 s, p99 < 4 s after submit | Token streaming over SSE, not polling for the answer |
| Revocation on screen | An open page drops a document within one poll (≤ 2 s); history is redacted on the next read | The client never treats its copy as authority |
| Stream resilience | A drop, or a reconnect that lands on another API instance, loses no text and repeats none | A cursor (`Last-Event-ID`) the client holds |
| One file, one document | A retry or a double drop never creates a second document | A per-file `Idempotency-Key` |
| Processing visibility | Stage, progress, attempts and failure reason within ~2 s | Short polling intervals while work is in flight |
| Honesty | No state shown before the server confirms it; "partial output kept" when an answer stops early | Confirmed actions, terminal events from the server |
| Accessibility | WCAG 2.2 AA; status never by colour alone | Every chip carries a word |

> "The trap I want to avoid is building a chat widget that caches answers and document text in the browser and serves them back as if they were still true. The backend makes the index a copy that's never the authority on access. The client has to follow the same rule, because the browser is one more cache."

---

## 🏗️ Architecture (~8 min)

### The Ask screen

```
┌──────────┬───────────────────────────────────────────────────────────────────┐
│ Library  │ Ask your documents                                                │
│ Ask    ◀ │                   How long do I have to submit expense receipts?  │
│ Groups   │ ┌───────────────────────────────────────────────────────────────┐ │
│          │ │ Completed  [Cache entry rejected: a source document has a     │ │
│          │ │             newer version]                        2m ago      │ │
│          │ │ 9 candidates · 5 kept · 2 dropped by access re-check:         │ │
│          │ │ private to its owner ×2 (index said readable: 2) · 48 ms      │ │
│          │ │ Receipts must be submitted within 30 days of purchase.(1)     │ │
│          │ │ Claims over $500 need manager approval.(2)                    │ │
│          │ │ [1] Expense policy v2 · chunk 3 · Receipts · chars 812–866    │ │
│          │ │ [2] Expense policy v2 · chunk 4 · Approvals · chars 901–957   │ │
│          │ │ 412 in / 38 out tokens · queue 4 ms · retrieval 48 ms ·       │ │
│          │ │ first token 310 ms · generation 1.2 s                         │ │
│          │ └───────────────────────────────────────────────────────────────┘ │
│ carol ⎋  │ [Ask a question about your documents…]                     [Ask]  │
└──────────┴───────────────────────────────────────────────────────────────────┘
```

Everything on that card is server data: the status, the cache decision, how many candidates the access re-check dropped and why, the sources with version and offsets, and usage. The chips (1) and (2) are links to the exact span. The card says *why* this answer can be trusted, not just what it is.

### Client layers

```
┌────────────────────────── Browser (React 19 + TanStack Router) ──────────────────────────┐
│ Routes: /documents  /documents/$documentId?version&start&end  /ask  /groups  /ops  /login │
│                                                                                           │
│ ┌──────────────────────────┐  ┌──────────────────────────────┐  ┌──────────────────────┐ │
│ │ usePoll, one per resource│  │ Ask store (Zustand)          │  │ Auth store (Zustand) │ │
│ │ library 2 s · deleted    │  │ runs · event reducer         │  │ user, role, org      │ │
│ │ 2.5 s · detail 2 s ·     │  │ open streams: run id → abort │  │ login / logout reset │ │
│ │ chunks 2.5 s · text once │  │ (module level, outside React)│  │ the ask store        │ │
│ │ skips hidden tabs        │  └──────┬──────────────▲────────┘  └──────────────────────┘ │
│ └────────────┬─────────────┘         │ POST         │ SSE over fetch + ReadableStream    │
│              │ typed API client: errors carry the HTTP status and the server's code       │
└──────────────┼───────────────────────┼──────────────┼────────────────────────────────────┘
               ▼                       ▼              │ Last-Event-ID resume
        ┌──────────── API instances (any one serves any request) ────────────┐
        │ REST: documents · versions · sharing · delete · retry · groups     │
        │ POST /answers → 202 + run, executed on the accepting instance      │
        │ GET /answers/:id/stream ◀── per-run event log in Valkey            │
        └──────────┬────────────────────────────────┬────────────────────────┘
                   │ every read re-checks access    │ job rows → queue → workers
                   ▼                                ▼
     PostgreSQL (truth): documents, ACL,      Pipeline: extract → chunk → embed → index,
     tombstones, versions, chunks, jobs, runs retire, sync_acl, purge (vector index = a copy)
```

**Walking the arrows for one question:**

1. The composer calls the ask store, which POSTs only the question text. Nothing the client holds (old answers, document text) is sent back as context.
2. `202` returns a server-assigned run in `queued`. The store appends it, and the card renders before any token arrives.
3. The store opens one stream for that run, keyed by run id in a map outside React, so navigating to the library and back doesn't abort it.
4. Events go through one reducer: status, cache, retrieval (with sources), text deltas, then `completed`, `failed` or `cancelled`.
5. At the terminal event the stream closes and the store re-reads history, which brings final usage and any redaction the server applies on read.

Pages that show pipeline state never touch the store. Each one polls its own resources.

### Route map

| Route | Who | Polls | Purpose |
|-------|-----|-------|---------|
| /login | Anyone | — | Session sign-in; redirect by role afterwards |
| /documents | Member, admin | list 2 s, deleted 2.5 s | Upload, library, recently deleted |
| /documents/$documentId | Readers of the document | detail 2 s, chunks 2.5 s, text once per version | Text with highlight, chunks, timeline, versions, owner controls |
| /ask | Member, admin | stream while generating; history on mount and after each run | Questions and answers |
| /groups | Member (read), admin (edit) | 3 s | Group membership |
| /ops | Operator only | 2 s | Pipeline health and fault switches |

The root route checks the session once and redirects in an effect: signed out goes to /login, an operator only ever sees /ops, and members never see it. That's navigation convenience only. The API enforces every role.

### API surface the client uses

```
POST   /api/v1/auth/login · /auth/logout     GET /auth/me
GET    /api/v1/documents                     readable live documents + per-stage state
GET    /api/v1/documents/deleted             my tombstoned documents + purge progress
POST   /api/v1/documents                     multipart + Idempotency-Key → 201 | 200 duplicate | 415 | 422 | 503
POST   /api/v1/documents/:id/versions        same key semantics → 201 | 200 unchanged
GET    /api/v1/documents/:id                 detail: versions, jobs with attempt logs, events (404 if unreadable)
GET    /api/v1/documents/:id/text?version=   extracted text for the highlight view
GET    /api/v1/documents/:id/chunks?version= chunks with offsets, embedded / indexed flags
PATCH  /api/v1/documents/:id/sharing         scope + group (owner)
DELETE /api/v1/documents/:id                 tombstone + purge (owner) → 202
POST   /api/v1/documents/:id/retry           retry a poisoned stage (owner)
GET    /api/v1/groups · POST|DELETE /groups/:id/members[/:userId]
POST   /api/v1/answers                       question → 202 + run
GET    /api/v1/answers · /answers/:id        history, re-validated and redacted on read
GET    /api/v1/answers/:id/stream            SSE; Last-Event-ID resumes on any instance
POST   /api/v1/answers/:id/cancel            → 202 | 409 NOT_RUNNING
GET    /api/v1/ops/overview · POST /ops/jobs/:id/retry · PUT /ops/chaos|embedder|model
```

---

## 🗂️ State Ownership (~3 min)

| State | Lives in | Refreshed by | Why there |
|-------|----------|--------------|-----------|
| Session user, role, org | Auth store | Probe on load; login and logout | Root redirect and nav |
| Library and deleted lists | `usePoll` on the library page | 2 s / 2.5 s, plus a reload after any action | The page owns one consistent snapshot |
| Document detail, text, chunks | `usePoll` on the document page | 2 s / once per version / 2.5 s | A 404 on detail replaces the whole page |
| Answer runs (history and live) | Ask store | Stream events while live; a full re-read on mount and after every stream ends | A run outlives the Ask page |
| Open streams | Module-level map of run id → abort handle | Closed at the terminal event, or on logout | Exactly one connection per run |
| Upload rows and their keys | Upload zone component state | — | One `Idempotency-Key` per file (deep dive 3) |
| Viewed version and highlight | URL search params (`version`, `start`, `end`) | Navigation | A citation is a link you can paste and reopen |
| Picked chunk | Component state, reset when the viewed version changes | — | A chunk belongs to exactly one version |

> "I keep server data out of global state on purpose. The library needs a per-stage summary per document, and the document page needs one document with every attempt. A normalized cache would make me reconcile two shapes of the same document from two polls taken at different moments. Worse, it would keep a revoked document's title and text alive in memory after every page that showed it was gone. Each page asks for a snapshot and replaces what it had. Answer runs are the one exception, because a live stream must survive navigation. Even there, the store re-reads from the server rather than trusting itself."

Login and logout both reset the ask store and abort every open stream, so a second account on the same tab never sees the first account's answers.

---

## 🖥️ Screens (~5 min)

**Library.**

- A drop zone with a "Choose files" button, so drag and drop is never the only way in. Each file gets a row: "Uploading…", "Uploaded; processing started", or an amber "Already in your library: *Expense policy* (same content, nothing new created)" with a link. An error row shows the server's reason, such as "PDF extraction is not enabled in this build", and a **Retry upload** button that resends with the same key.
- A table with title, file and size, chunk count, owner, an access chip (Private, Group: Engineering, Org-wide), the version, status, stage pills and when it was updated.
  - The version column shows "v1", plus an indigo "v2 processing" or "v2 failed" while v1 keeps serving.
  - Each stage pill pairs a word with a mark (extract ✓, embed …, index ✕). It shows progress such as "3/5", "×2" after a retry, and a tooltip with the last error and "attempt 2/3".
  - A failed document shows the reason inline ("embed failed after 3 attempts: Embedder returned 500…"), and its owner gets a Retry button.
- **Recently deleted** shows titles struck through with "deleted 2m ago", and a purge block: "purged 4/5 · retrying", a progress bar, one chip per artifact (cache −3, index −17, embeddings −17, chunks −17, blobs retry 2) and the last error. When it's done it turns green: "purged 5/5 · completed 14:06:12".

**Document page.**

- **Header:** status and scope chips, the owner, "serving v1 · v2 processing", and the failure reason. Owners see a sharing select, "Upload new version" and Delete. After a sharing change the page says "Sharing saved. It applies to the next question; index metadata syncs in the background." While the sync is behind it says "Index metadata syncing (3 stale index rows). Access is already enforced from the source of truth."
- **Extracted text · v2.** The text is rendered as plain text, never as HTML. When the URL carries `start` and `end`, the span is wrapped in a mark, scrolled to the centre and labelled "highlighting characters 812–866". Offsets that fall outside the text are ignored instead of highlighting the wrong passage.
- **Chunks** for the viewed version: ordinal, character range, heading, token count, embedded and indexed ticks, and the text. Clicking a row highlights its span. A retired version says "No chunks for this version (not chunked yet, or retired)".
- **Processing timeline**, grouped by version with the newest first. Each job shows its stage, status, "attempts 2/3", progress and any waiting reason. Under it, every attempt lists the worker id, an outcome chip (Succeeded, Will retry, Worker lost, Poisoned), the time, the duration and details such as "wrote 12/17 chunks, then the worker exited", "embedded 2 (3 already done)" or "3 rate-limited retries".
- **Versions:** each one links to `?version=`, with its status (Ready, Superseded, Retired, Failed), a "current" chip, its chunk counts, a sha256 prefix and when it was activated, superseded and retired. An **Activity** list shows uploads, sharing changes and switches.

**Answer card** (the mock above): the question bubble; a status chip and a cache badge; Stop while the run is live; the retrieval line; the answer with citation chips; the numbered source list; the usage line once the run is terminal. A redacted run shows a lock and one sentence instead of the text.

**Operations.**

- Tiles for queue ready, unacked, consumers, dead-lettered, stale index rows ("2 documents awaiting metadata sync") and the purge backlog.
- A stage × status jobs matrix with running jobs per worker, and the purge backlog by document id.
- Poisoned jobs with Retry, recent runs with usage, and every fault switch: kill a worker mid-chunk, a blob outage, hold the version switch, pause the metadata sync, pause purges, and the embedder's and model's latency, failure and armed-error knobs.
- The subtitle states the rule: ids and counts only.

---

## 🔧 Deep Dives (~15 min)

> "Three decisions carry the client: how an answer gets from the server to the screen, why everything else is polled, and how writes behave when the server can say no or the response gets lost."

### Deep dive 1: A question is a durable run the client follows, not a request it holds (~6 min)

**Decision.** Asking is two steps. `POST /answers` creates the run and returns `202` with its id. Then the store opens `GET /answers/:id/stream` with `fetch` and a `ReadableStream`, through a small incremental SSE parser, *only while the run is queued or running*. It closes at the terminal event. The reader keeps the id of the last event it applied. On a network error, or a stream that ends before a terminal event, it waits 0.4, 0.8, 1.6, 3.2 and then 6.4 s (reset whenever a message arrives) and reconnects with `Last-Event-ID`. The server first writes a `snapshot` with the current status, then replays the run's event log after that cursor. Whichever API instance answers can do this, because the log lives in a per-run Valkey stream, not in the executing process.

**Why it works here.**

- **The run survives the connection.** The run executes on the instance that accepted it, heartbeating every second and flushing partial output as it goes. If the user's Wi-Fi drops after event 14, the reconnect asks for "after 14" and gets 15 onwards. It doesn't matter whether the load balancer sends it to the same instance.
- **A reload is handled too.** The Ask page loads history, finds runs still queued or running, and follows each one from the first event into an empty text buffer, so the text is rebuilt, not doubled.
- **Navigation is free.** Streams sit in a module-level map, so leaving for the library mid-answer doesn't abort anything. Following is idempotent: a second follow of the same run does nothing.
- **Stop is a REST call, not an abort.** `POST /answers/:id/cancel` sets `cancel_requested_at` and publishes on a cancel channel every instance hears. The executor aborts the model request, and the run ends `cancelled` with its partial output. The card doesn't flip on click. It flips when the `cancelled` event arrives. A Stop that arrives after the run finished gets `409 NOT_RUNNING`, and the completed answer stays.
- **Terminal states say what's true:**
  - `completed` turns the `[n]` markers into chips that point at the exact span the server located verbatim in source n.
  - `failed` shows the reason plus "partial output kept" when the model dropped mid-stream. If the executing instance dies, the sweeper fails the run after 15 s of stale heartbeats, and a following client still receives `failed` with the text flushed so far.
  - `cancelled` shows "Stopped · partial output kept".
  - Runs are never retried automatically, because a retry would bill again and could produce a different answer. The user asks again.
- **The stream carries the trust signals before the text.** The `cache` event drives the badge: "Served from cache (validated 2 sources)", or amber "Cache entry rejected: a source document was deleted". The `retrieval` event brings the numbered sources and the line "9 candidates · 5 kept · 2 dropped by access re-check: private to its owner ×2 (index said readable: 2) · 48 ms". The server strips the ids of dropped documents first, so the asker learns that something was filtered, never what it was.

**How the alternatives break.**

- *Streaming the answer in the POST response.* The run lives and dies with one connection. A Wi-Fi drop or a reload loses the answer, and the only recovery is to POST again: a second run, a second model bill, possibly a different answer. Stop could only mean "close the socket", which can't reach the run if the socket is already gone.
- *EventSource for the GET.* It resends `Last-Event-ID` only on its own automatic reconnect, not from a cursor the page holds. It hides the HTTP status, so "signed out" and "instance restarting" look the same. It also retries on a fixed interval, so a deploy makes every open client reconnect at the same moment.
- *Polling the run every 500 ms.* Tokens would arrive in half-second lumps, average added latency would be ~250 ms on every token, and 600 questions/s at peak would turn into thousands of extra requests per second for text the server already has as a stream.
- *Stream owned by the Ask component.* Navigating to the library unmounts it, and the cleanup aborts the fetch. The run finishes on the server, but the client forgets it until the next history load.

| Approach | Survives a drop or reload | Another instance can resume | Duplicate runs on recovery | Token latency |
|----------|---------------------------|-----------------------------|----------------------------|---------------|
| ✅ POST → 202, then fetch-SSE with a cursor, only while live | Yes | Yes | Never | Real time |
| ❌ Stream in the POST response | No | No | Yes (re-POST) | Real time |
| ❌ EventSource | Partly | Yes | No | Real time |
| ❌ Poll the run | Yes | Yes | No | +250 ms average, lumpy |

**What I give up.** Two requests per question, and my own SSE parser. The store now has a lifecycle: logout must abort every stream. A lost `202` means a second run, because `POST /answers` carries no idempotency key. I accept that because a question is cheap and read-only, and I'd add a key once runs gained side effects. The reader gives up after five failed reconnects with "lost the answer stream; reload to see the final result". The run is still safe on the server, so a reload shows the truth.

### Deep dive 2: Poll the pipeline; open a stream only for a generating answer (~5 min)

**Decision.** Every page polls the resources it shows, every 2–5 s, skipping ticks while the tab is hidden and reloading at once after any action. There is no always-open push channel. The only streams are answer runs, and each one is opened when a run starts and closed at its terminal event.

**Why polling works for this problem.**

- **Pipeline state changes over seconds.** Extract and chunk finish in well under a second for a typical file, an embed batch takes about a second, retries back off from 1 s to 15 s, the metadata sync waits 3 s and retirement 5 s. A 2 s lag on a stage pill is invisible next to the work it describes.
- **Every poll is a fresh authorization.** The library list is the "readable live documents" query, run again. When Alice unshares a document, it simply isn't in Carol's next response. No invalidation message has to find Carol's tab.
- **Each response is one consistent snapshot**, such as a document with all its versions, jobs and attempts. Rows never update piecemeal from two event sources. History is append-only, so a skipped intermediate state still leaves its attempt row in the timeline.
- **API instances stay stateless.** There are no subscriptions to route and nothing to drain on deploy.

**Why an always-open stream fails here.**

1. *Its authorization is the key question in miniature.* A per-tab channel that pushes "document X changed (title, stage, progress)" has to decide at publish time who may hear about X. Readers change with every sharing edit and group removal. A subscription list computed when the tab connected is a copy that lags, exactly like the index's access metadata. Either every pipeline event is re-checked against every subscriber, which is a re-check fan-out on ~4,000 chunk updates/s at peak, or a revoked user keeps receiving titles and progress for a document they lost.
2. *Volume vs value.* Progress changes per chunk batch and per attempt. I'd coalesce the pushes into "something changed, refetch" hints within a second or two, which is polling rebuilt with more parts.
3. *Connections.* An idle stream per tab holds one of HTTP/1.1's six connections per origin, shared with answer streams and polls. Load balancers need pings to keep it alive, and every deploy drops tens of thousands of idle streams that all reconnect at once.
4. *Reconnects still need a refetch*, because events sent while the tab was disconnected or asleep are gone. The polling code has to exist anyway.

**Why the answer stream is different.** Token latency is the product (first token in under 1.5 s at p50). A stream's lifetime is bounded, about 3–8 s. It is authorized once, by run ownership, and its content was access-checked at retrieval in one database snapshot. The architecture sizes for ~3,000 concurrent answer streams at peak. An always-open stream per tab would mean one per visible tab, most of them idle.

| Approach | Revocation | Freshness | Server cost | Failure mode |
|----------|------------|-----------|-------------|--------------|
| ✅ Poll 2–5 s, hidden tabs paused, plus SSE per live run | Next poll, by construction | ≤ one interval | Many cheap, mostly unchanged reads | Up to 2 s stale |
| ❌ Always-open push per tab | Only if every event is re-checked per subscriber | Instant | Fan-out plus held connections | Leaks to stale subscribers; reconnect storms |
| ❌ WebSocket | Same as push | Instant | Same, plus a second protocol | Same; nothing needs pushing upstream |

**What I give up.** Up to one interval of lag, and many responses that say nothing new. At scale I'd add ETag / 304 and an adaptive interval: 2 s while anything on screen is processing or purging, 30 s otherwise. The "your document is ready" moment arrives up to 2 s late, which nobody notices after a 30 s wait.

### Deep dive 3: Writes the server can refuse — per-file idempotency keys, nothing optimistic (~4 min)

**Decision.** Each file gets its own `Idempotency-Key` the moment it is picked or dropped. "Retry upload" resends the same file with the same key. A new version gets a key per chosen file, so choosing the same file again after a failure retries rather than uploads twice. Every write (upload, sharing, new version, delete, retry) waits for the server's answer and then reloads. Nothing is shown before it's confirmed.

**Why it works here.**

- **Lost response.** The upload committed, but the response died on the way back. The row shows an error, the user clicks Retry upload, and the server finds the key and replays the stored response (`Idempotent-Replayed: true`). It's the same document, so the row just turns into "Uploaded; processing started".
- **Rolled-back upload.** If the first attempt failed with `503` because the object store was down, nothing was recorded, so the same key proceeds as a fresh upload.
- **Double drop.** Two concurrent requests with one key serialize on the server's lock and produce one document.
- **Client bug.** The same key with different bytes is `422 IDEMPOTENCY_KEY_REUSED`, shown rather than retried.
- **The duplicate notice is a separate, content-level feature.** A new key with identical bytes returns the existing document only if the uploader can read it, and the copy says "Already in your library", with a link. If the same bytes sit in someone else's private document, the upload proceeds as new and the UI shows a normal success. The client never says "someone already has this file", because that would confirm a hidden document exists.
- **Confirmed writes.** The sharing select is bound to the server's scope, disabled while the PATCH is in flight, and followed by the "applies to the next question" notice. Delete asks for confirmation in words ("It disappears immediately; its files, chunks, embeddings and cached answers are then purged"), waits for `202`, and returns to the library. The row is gone because the server's list filters tombstones, not because the client removed it. A poisoned stage's Retry waits for the server to reset its attempts, and the pills show the real transitions on the next polls.

**How the alternatives break.**

- *No key, relying on content dedupe.* A retry of your own lost upload comes back as "Already in your library (same content, nothing new created)". That's wrong: the first attempt created it. For a new version, the retry reads "Unchanged", which is wrong too. Dedupe answers "does this content exist?", while a retry needs "did my request happen?".
- *A new key per click.* The guarantee disappears exactly when it's needed.
- *One key per drop batch.* Retrying file 2 replays file 1's response.
- *Optimistic writes.* An optimistic delete that hides the row before `202` reappears if the server refuses, and it trains the user to treat the client list as the authority. The effects that follow a write (purge tasks, a version switch, stale index rows, reset attempts) can't be predicted on the client anyway. An optimistic sharing chip claiming "Private" before the commit would be the worst kind of lie: one about access.

| Approach | Lost response | Concurrent double drop | Honest copy | Cost |
|----------|---------------|------------------------|-------------|------|
| ✅ Key per file, minted at pick, reused by Retry | Replayed, same document | One document | "Uploaded" / "Already in your library" when true | Keys held in memory |
| ❌ No key, content dedupe only | Wrong notice | One document (hash lock) | Misleading | None |
| ❌ New key per click | Second attempt not recognised | Two requests race | — | None |
| ❌ Optimistic writes | Flip-backs | — | Shows states the server refused | — |

**What I give up.** The keys live in component state, so a reload loses them. A retry after a reload falls back to content dedupe, whose notice is then slightly off. I'd keep keys in sessionStorage by file fingerprint if that mattered. A click shows a moment of nothing but a disabled control. A multipart `fetch` has no upload progress, so at production sizes I'd use a presigned PUT with progress events, hash the file in a Web Worker, and commit with the hash.

---

## 🔐 The Key Question, From the Client's Side (~5 min)

> **"A document becomes inaccessible while its content remains in an index or cache. How does the design avoid returning it?"** On the server, the answer is that the index and the answer cache are never the authority: every candidate chunk is re-checked against PostgreSQL, and every cached answer is validated for this reader on every read. On the client, the browser is one more cache, and it follows the same rule.

**Decision.** The client's copies are views, never authority. Every place the browser holds content is refreshed through an endpoint that re-checks access, so a revoked document drops out on the next read. Nothing the client holds is ever sent back as prompt context.

| Where the browser holds content | What could go stale | What corrects it | How fast |
|---------------------------------|---------------------|------------------|----------|
| Library list (titles, scope) | An unshared or deleted row | The 2 s poll re-runs the "readable live documents" query | ≤ 2 s |
| Open document page (text, chunks, timeline) | The full extracted text | The detail poll gets `404`, and the page replaces everything with "It may have been deleted, or it is no longer shared with you" | ≤ 2 s |
| Chat history in the ask store | Answer text, sources, citation quotes | The server redacts history on read: empty text, no sources or citations, and "You no longer have access to a source document of this answer" (or "…was deleted"). Re-read on every mount of /ask and after every stream ends | Next mount or next question |
| Citation chip | A doc id, version, offsets, and the title and quote in its tooltip | It's only a pointer: opening it goes through the same re-authorized detail fetch and hits the 404 page. Redaction removes the chip itself on the next history read | On click; next re-read |
| A cached answer (server side) | A whole answer built from the old state | Validation rejects it, and the card's badge says "Cache entry rejected: a source document was deleted" | Next question |
| An answer streaming during the revoke | Its sources were checked in the run's snapshot | Bounded by one answer (3–8 s). The next question re-checks, and the next history read redacts the finished run | One answer |

**Why it works.** Four details make it hold:

- **A `404` is authoritative; a network error isn't.** The poll hook keeps the last data on a transient error, because a blip shouldn't blank a page. A `404` on the detail resource drops the text, the chunks and the highlight together. The server returns `404` for both "deleted" and "not shared with you", so the copy is deliberately ambiguous and confirms nothing.
- **The client never launders content.** `POST /answers` carries only the question, and there is no client-side conversation memory. A stale answer sitting in the store can never become context for a new prompt.
- **Citations are server records.** The server places each citation by finding the claim verbatim in the source chunk. The renderer links a `[n]` marker only when a server citation or source matches it; otherwise it renders a dimmed "Unknown source" with no link. The client never builds a link from model text.
- **Immutable doesn't mean authorized forever.** A version's text never changes, which makes it tempting to cache it in the client indefinitely. Access to it does change, so the detail poll stays the gate for everything else on the page.

**How the alternatives break.**

- *Push invalidation to the client* ("document X revoked"). Someone has to know every tab that holds X. A tab that was asleep, offline or mid-reconnect misses the event and shows the content until the user reloads. The push channel must itself be authorized for viewers whose rights just changed.
- *Fetch everything and filter in the client.* Hiding isn't security. The content is already in the response.
- *Persist chat history in localStorage for instant loads.* Revoked answers survive reloads, sign-outs and shared machines. The store is in memory and reset on login and logout.

**What I give up.**

- An open page can show a revoked document for up to one poll interval, and history is redacted only when it's re-read (every 15 s on /ask).
- Polling costs requests that mostly return nothing new.
- No system can un-show what the user already read. The guarantee is that there's no *new* exposure after the revoke commits.
- Every API response carries `Cache-Control: no-store`, so the browser's HTTP cache and back-forward cache don't keep copies of their own.

---

## ♿ Accessibility and ⚡ Performance (~2 min)

- **Not colour alone.** Every chip pairs its colour with a word (Will retry, Worker lost, Poisoned, Superseded), stage pills carry ✓ … ✕ marks next to the stage name, and progress bars expose their value as a progressbar.
- **Tooltips aren't accessible.** The stage pills' attempt counts and last errors live in tooltips. I'd move them into visible text or a described-by note, since keyboard and screen-reader users can't reach a tooltip.
- **Citations are real links**, with accessible names such as "Citation 2: Expense policy". The source list repeats the title, version, chunk and characters as text. The highlight uses a semantic mark, and its label announces the character range.
- **Streaming text is not a live region**, or a screen reader would talk over itself on every delta. Only the status line is one, so a single polite announcement fires when a run ends ("Completed", "Cancelled · partial output kept"). Enter sends and Shift+Enter adds a line. Smooth scrolling and the pulsing caret should respect reduced-motion preferences.
- **Scroll follows the stream.** Today the page always scrolls to the newest text. It should follow only when the reader is already at the bottom.
- **Delete uses the native confirm dialog.** It's accessible but blunt. I'd use a proper dialog that names the document.
- **Render cost.** Each delta updates the runs array, and the Ask page re-renders every card. That's fine at 30 runs; at scale I'd give each card its own selector and memoize finished runs.
- **Immutable text fetched once.** The document text never changes for a version, so it's fetched once per version id, and the detail poll is the access gate. The chunk table scrolls inside a fixed height and would need virtualization past a few hundred rows.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a revoke the index hasn't caught up with, and a reconnect to the other instance

1. Alice unshares "Deploy guide" from Engineering, and Ops has paused the metadata sync, so its index rows still say Engineering. Carol, in Engineering, is on /ask.
2. Carol types "At what time does the deploy freeze begin on Fridays?" and presses Enter. The composer trims it and calls the store, which POSTs only the question. API instance 3000 inserts the run as `queued` and returns `202`. The card appears with a Queued chip and Stop.
3. The store records an abort handle under the run id, clears the run's text and opens the stream. The server writes a `snapshot` (queued), then `status` (running), and the chip changes. The `cache` event is a miss, so no badge appears.
4. The `retrieval` event arrives. The ANN query matched the deploy guide through the stale rows, and the same-snapshot re-check dropped those chunks as `not_owner`. The card shows the sources and "8 candidates · 4 kept · 2 dropped by access re-check: private to its owner ×2 (index said readable: 2)".
5. Deltas append to the answer text, and a caret pulses. After event 14, Carol's Wi-Fi blips: the read throws, the reader waits 0.4 s and reconnects with `Last-Event-ID: 14`, and the load balancer sends it to instance 3001. That instance writes the snapshot and replays events 15 onwards from the run's log. Nothing is repeated or lost.
6. `completed` arrives with citations. Each `[n]` becomes a chip pointing at the verbatim span. The reader returns, the store deletes the stream and re-reads history, and the usage line appears.
7. Carol clicks chip 1. The router opens the document page with that run's version, `start` and `end` in the URL. The detail, text and chunk fetches each re-check access. The text viewer validates the offsets, wraps the span in a mark and scrolls it into view: "highlighting characters 812–866".

The revoke took effect on the very next question, and the client never saw the unshared document.

### Failed trace: a delete races an open page, a cached answer and an object-store outage

1. Carol has "Expense policy" open with a cited span highlighted. Her history holds an answer citing it, and the server's answer cache holds that answer too. Ops arms a blob-store outage.
2. Alice, the owner, clicks Delete on the document page and confirms. `DELETE` returns `202` after one transaction: the tombstone, the cancelled pending jobs, and five purge tasks. Her page navigates to the library. The next poll no longer lists the document, and "Recently deleted" shows it struck through, "purged 0/5 · in progress".
3. Within 2 s, Carol's detail poll returns `404`. The page drops the text, chunks, timeline and highlight, and shows "It may have been deleted, or it is no longer shared with you" with a link back. The text and chunk polls also return `404`, and nothing renders them.
4. Carol opens /ask. The mount re-reads history, the server re-validates each run's sources, and the old answer comes back with empty text, no sources and no citations, plus a lock and "A source document of this answer was deleted."
5. She asks the same question again. If the purge hasn't reached the cache artifact yet (or purges are paused, as the e2e does), validation rejects the entry, and the card shows "Cache entry rejected: a source document was deleted". If it has, it's a plain miss. If any index rows survive, the re-check drops them, and the retrieval line reads "dropped by access re-check: document deleted ×3". The answer is "That information was not found in your documents.", with no sources, and it isn't cached. Either order is safe, because correctness never waits for the purge.
6. Alice's purge block shows cache, index, embeddings and chunks done with their counts. Blobs fail: "purged 4/5 · retrying", an amber bar, "blobs: connection refused", "blobs retry 2". The purge job retries with capped backoff, and the four finished artifacts are never redone.
7. The store comes back. The next retry deletes every version's object, and the block turns green: "purged 5/5 · completed 14:06:12".

---

## ✅ Design Review Checklist, From the Client (~2 min)

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL behind the API; the client's stores are views. An upload succeeds at `201`/`200`, a question is accepted at `202` and answered at the `completed` event, a delete succeeds at `202` (the tombstone has committed), a sharing change at the PATCH response. The UI shows none of these before the response |
| What happens when a client retries after losing the response? | Upload: the same per-file key replays the stored response; the same key with different bytes is `422`; a new key with the same bytes gets the duplicate notice. Question: a lost `202` makes a second, harmless run. A lost stream resumes with `Last-Event-ID` on any instance. A repeated Stop is harmless; one after the run finished gets `409` and the answer stays |
| What happens when a worker or server fails between two steps? | The client assumes nothing and polls. Pills and the timeline show Worker lost, Will retry or Poisoned with the reason; a job that was never published shows as pending until the sweeper sends it. An API instance dying mid-answer drops the stream; the reconnect reaches another instance, and the sweeper's `failed` arrives with the partial output kept |
| Which ordering or consistency guarantee is actually required? | Events within a run, in log order (an SSE id is a position); a fresh follow rebuilds the text from the first event. One version per answer, and every source and citation names its version, so a v1 citation opens v1's text after the switch. The header flips from "serving v1 · v2 processing" to "serving v2" once. No ordering across separately polled resources |
| How is access enforced when caches, indexes or asynchronous jobs are involved? | The client filters nothing. Every poll and link re-authorizes, a `404` replaces the stale copy, history is redacted on read, the cache badge exposes rejections, and the retrieval line counts drops without naming documents. Duplicate notices appear only for readable documents, and operators see ids and counts |
| What breaks first at much larger scale, and what evidence supports that? | Polling volume, by arithmetic (next section). Then client rendering of long documents and long histories. On the server: vector-index memory and the embedding provider's rate limit, from the measured 6.6 row writes per chunk and ~8 TB of vectors at 1.25B chunks |

---

## 📈 Scalability: What Breaks First (~2 min)

**API, first: polling, not streaming.**

- Assume 2M users and 5% with a visible tab at peak, which is 100k tabs. The library page makes ~0.9 requests/s (2 s + 2.5 s), and a document page ~0.9/s (2 s + 2.5 s; the text is fetched once).
- That's ~100k reads/s, about 150× the 600 questions/s peak, and each library poll recomputes per-stage state for every row.
- Fixes, in order:
  - an adaptive interval (30 s when nothing on screen is in flight);
  - ETag / 304 keyed on the newest `updated_at`;
  - polling only rows in non-terminal states;
  - paginating the library.

  Those bring it down to roughly 10k cheap reads/s. Answer streams stay at the architecture's ~3,000 concurrent, so the next step there is one multiplexed log reader per instance instead of a blocking read per open stream.

**Client, first: re-fetching and re-rendering large things.**

- A 100-page manual is ~400 KB of extracted text. Re-fetching it every 5 s per open page would be 80 KB/s for nothing, which is why it's fetched once per version id.
- One giant text block with a mark works up to a few hundred KB. Beyond that, render by chunk windows and virtualize around the highlighted span.
- Chat history grows, and every delta re-renders the list, so use per-run selectors and memoized cards, page older runs from the server, and virtualize with `@tanstack/react-virtual`.

**Platform behind it.** The vector index (~8 TB with graph overhead at 1.25B chunks) is sharded by tenant first, and the embedding provider's rate limit governs ingestion. Neither changes the client. The access re-check stays one batched primary-key lookup per question, so revocation stays immediate at any scale.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Client authority | Server re-read through access-checked endpoints | Trust the client cache | The browser is one more stale copy |
| Pipeline freshness | Poll 2–5 s, paused in hidden tabs | Always-open push per tab | Every poll re-authorizes; push subscriptions lag like index metadata |
| Answer transport | POST → 202, then fetch-SSE only while live | Stream in the POST / EventSource | Survives drops and reloads; explicit cursor; any instance resumes |
| Stream ownership | Module-level map in the store | Effect in the Ask component | Survives navigation; one connection per run |
| Stop | REST cancel, wait for the `cancelled` event | Abort the fetch | Reaches the executor on any instance; partial output kept |
| Upload retries | Idempotency key per file, reused by Retry | Content dedupe only / new key per click | "Did my request happen?" is not "does this content exist?" |
| Duplicate notice | Only for documents the uploader can read | Any matching hash | Never confirms a hidden document exists |
| Writes | Confirmed, then reload | Optimistic | Server effects (purge, switch, sync) aren't predictable |
| 404 handling | Replaces the whole page | Keep the last data | Authoritative "you can't see this" vs a transient blip |
| Citations | Server-placed spans; unmatched markers aren't links | Links from model text | No invented links; every chip re-authorizes on open |
| History | In memory, redacted by the server on read | localStorage | Revoked answers don't survive reloads |
| Retrieval transparency | Drop counts and reasons, no document ids | Hide the re-check / list dropped titles | Shows why to trust the answer without leaking what was filtered |

---

## 📝 Wrap-up (~1 min)

> "The client treats the server as the only authority on what a user may see. Pages poll through endpoints that re-check access, a `404` replaces whatever was on screen, history is redacted on read, and citations are server records that re-authorize when opened. A question is a durable run. The browser posts it and follows its log only while it's generating, resumes with a cursor through any instance, and stops it with a REST call whose result arrives as an event. Uploads carry a per-file key, so a retry can't create a second document, and the duplicate notice never reveals a document you can't read. The hardest calls were refusing an always-open push channel, whose subscriptions would be one more lagging copy of access, and accepting up to one poll interval in which an open page still shows a revoked document."

### How the local implementation compares

The repo's `frontend/` is Vite + React 19 + TanStack Router + Zustand + Tailwind, and it implements this design:

- per-page `usePoll` at 2–5 s that skips hidden tabs; the document text is fetched once per version, not polled;
- an ask store with streams in a module-level map, whose history load keeps a live run's on-screen text;
- a 15 s history refetch on /ask, so server-side redaction reaches an open page;
- a fetch-based SSE reader that resumes from `Last-Event-ID` with 0.4–6.4 s backoff and stops at once on a `4xx`;
- per-file upload keys reused by Retry, and the duplicate notice;
- stage pills with progress and attempts, "v2 processing", and purge progress per artifact;
- a document page that highlights the span from URL params and replaces itself on a `404` (by status code);
- redacted history cards, the cache badge, the retrieval line, the usage line, and a polite live region that announces when a run ends;
- `Cache-Control: no-store` on every API response.

Several of these were defects found while writing this answer and then fixed. One was live text glitching after navigating back to /ask mid-answer. Others were the stream reader retrying a `401`, a 404 detected by error message, history never refetched, and text re-fetched every 5 s.

Still open: stage details live only in tooltips, scroll always jumps to the newest text, delete uses the native confirm dialog, and the chunk table isn't virtualized.
