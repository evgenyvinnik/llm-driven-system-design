# AI Chat Client — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · a ChatGPT- or Claude-style chat product; the model API already exists*

> "A chat client looks like a message array, a text box and one streaming endpoint. That version breaks the first time a phone drops off Wi-Fi mid-answer, a user switches conversations while an answer is streaming, or two devices send at once. Four promises shape my design. An answer outlives the connection, the tab and the device that asked for it. Retrying never buys a second answer by accident. Editing or regenerating never destroys anything. And streaming text never lands in the wrong place. Most of my time goes to the seams where the browser, the API and the generation pipeline have to agree on those promises."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scope | ~5 min | What's in, what's out (inference, sharing), production targets |
| Workflow, entities, client state | ~9 min | Why a generation is its own record; where every piece of state lives |
| API contracts | ~4 min | How each request behaves when retried or raced |
| Architecture and traces | ~8 min | One successful and one failed answer, step by step |
| Deep dives | ~13 min | Resume/stop/retry, the generation-keyed store, the branching tree |
| Scale, checklist, wrap-up | ~5 min | What breaks first at 10× and 100×, and what I'd add next |

---

## 🎯 Requirements and Scope (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Is model serving in scope? | Inference interview or product interview | No. The model streams tokens and can be slow, return 429, fail or drop mid-answer |
| Does an answer survive refresh, navigation, a new device? | Generation tied to a connection or not | Yes, all three |
| Can users edit earlier messages and regenerate? | List vs tree | Yes; every version stays reachable |
| Several devices at once? | Fan-out and races | Yes: web, phone, desktop app, live together |
| Offline? | Local persistence | Recent conversations readable offline, clearly read-only |
| Shared or team conversations? | Authorization model | Out of scope; one owner per conversation |

### Functional requirements

1. Sidebar of conversations grouped by recency; rename, delete.
2. Send a message; the answer streams in as formatted markdown (headings, lists, tables, code).
3. Stop an answer and keep what was written.
4. Edit an earlier message (new branch) or regenerate an answer (another version); navigate versions with "‹ 2/3 ›".
5. Switch conversations mid-answer without cancelling it or mixing it into the other conversation.
6. Long conversations open fast and scroll back smoothly.
7. Read recent conversations offline.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| Typing and scrolling | Never drop below 60 fps while an answer streams | Streaming must not steal the composer's frames |
| Token to screen | ≤ 100 ms p95 from the model to paint | The server batches every 50 ms; the client paints once per frame |
| Resume | No lost or duplicated tokens, no second generation | Tokens cost money; a second sample is a different answer |
| One click, one answer | Even when the POST's response is lost | Same reason |
| Safety | Model output can never run script, load a resource or open a dangerous link | Output is untrusted, possibly prompt-injected |
| Accessibility | WCAG 2.2 AA; completion announced, not every token | Screen readers must not drown in fragments |
| Availability | 99.9% | Capped by the model provider anyway |

---

## 🧭 The User Workflow (~2 min)

1. Open the app: the sidebar loads, grouped Today / Yesterday / Previous 7 days / Older.
2. Type and press Enter. The message appears at once; the answer starts streaming within about a second.
3. Scroll up to re-read while it streams; the view stays put and a "New output below" button appears.
4. Click another conversation mid-answer. The first one keeps going; a toast says when it finishes, and its sidebar row shows a dot.
5. Press Stop: the answer stops, and the partial text stays with a "Stopped" note.
6. Edit an earlier question or regenerate an answer; arrows under the message move between versions.
7. On the train, offline: recent conversations still open, labelled "Offline copy · read-only".

---

## 💾 Entities (~4 min)

```
conversation ── title, model, current_leaf_id
     │
     └──▶ message (tree)
            user ──▶ assistant ──▶ user ──▶ assistant          ← visible path: root → current leaf
              │            └──▶ assistant (regenerated)        ← sibling: "answer 2/2"
              └──▶ user (edited) ──▶ assistant                 ← sibling: "version 2/2"
                                         ▲
                     generation (1:1) ───┘  status · attempt · lease · output checkpoint · usage
```

| Entity | Key fields | Notes |
|--------|------------|-------|
| conversation | id, owner, title, model, current_leaf_id, updated_at | The leaf pointer decides which branch is "the conversation" right now |
| message | id, parent_id, role, content, depth, created_at | A user message's parent is the answer it replies to; an assistant message's parent is its question. Never overwritten |
| generation | id, assistant_message_id, kind (message, edit, regenerate), status, idempotency_key, request_hash, attempt, output, checkpoint_event_id, usage | One attempt at one assistant message: `accepted → running → completed / cancelled / failed` |

> "Splitting generation from message is the most important modelling call. The message is what the conversation shows. The generation is the operational record: who owns it, how far it got, what it cost, how it ended. Without it, 'resume', 'stop' and 'retry' have nothing to point at."

---

## 🖥️ Client State: What Lives Where (~3 min)

| State | Lives in | Survives refresh? | Why there |
|-------|----------|-------------------|-----------|
| Live generations: status, text so far, last event ID, connection | Zustand store keyed by **generation ID**; streams held outside React | Rebuilt from the server's checkpoint | Must outlive route changes and never cross conversations |
| Threads: the loaded part of each conversation's visible path | Zustand store keyed by conversation ID | Refetched, and mirrored to IndexedDB | A finished answer must land in its thread wherever the user is |
| Sidebar list | Same store, keyset-paginated | Mirrored to IndexedDB | Offline reading |
| Unacknowledged sends | Same store, keyed by idempotency key | No | Shows "Sending…" or "Not sent · Retry" |
| Current conversation | The URL, `/c/:conversationId` | Yes | Links and reloads reopen it |
| Current branch | The server's current-leaf pointer | Yes, on every device | Branch choice is shared, not a browser preference |
| Scroll, edit box, Jump-to-latest | Component state | No | Purely local |

**Two client rules that matter.**

1. *A generation's status only moves forward.* The store ranks accepted < running < terminal. The Stop request's reply can arrive after the stream already delivered `end` and still say "running"; without the rule, a stopped answer would spring back to life.
2. *Reconnecting is reading, never resubmitting.* The client follows a generation by ID; no dropped connection ever leads to another POST.

---

## 🔌 API Contracts (~4 min)

```
POST   /api/v1/conversations                        → New chat + first message + generation (Idempotency-Key)
POST   /api/v1/conversations/:id/messages           → Message or edit (parentMessageId, editOfMessageId)
POST   /api/v1/conversations/:id/messages/:messageId/regenerate → Another answer (new key)
GET    /api/v1/conversations · /:id · /:id/messages?before=      → Sidebar, newest 40, older 40
PUT    /api/v1/conversations/:id/leaf               → Branch switch; returns the new visible path
PATCH  /api/v1/conversations/:id · DELETE /api/v1/conversations/:id
GET    /api/v1/generations/active · /:id            → Reattach after refresh; checkpoint + checkpointEventId
POST   /api/v1/generations/:id/cancel               → Stop
GET    /api/v1/generations/:id/events               → SSE: status · delta · end · snapshot (Last-Event-ID)
GET    /api/v1/events                               → SSE: this user's changes from every device
```

| Contract | Success | What the client does on error |
|----------|---------|-------------------------------|
| Ask for an answer | `202` with conversation, user message, placeholder, generation; a replay of the same key returns `200` and the same objects | `409 GENERATION_IN_PROGRESS` + ID: keep the text, attach to that answer. `422 IDEMPOTENCY_KEY_REUSED`, `429` (30/min, 4 in flight): show and offer Retry with a new key |
| Follow events | Frames with entry IDs; a `snapshot` once the live log has expired | `401`/`404`: stop retrying. Anything else: reconnect with backoff (0.5 s → 8 s) from the last ID |
| Stop | `202` while stopping; the outcome arrives as `end` | Never lets the reply override the stream |
| Branch switch | `200` with the new path | Toast, keep the current view |

> "Each contract answers one question: what if this is retried or raced? Creation needs a key because a lost `202` looks exactly like a failure. The `409` names the winner because the losing device isn't broken; it just learned an answer is already being written."

---

## 🏗️ Architecture and the Generation Path (~8 min)

```
┌──────────────────────────────────────────┐
│ Browser                                  │
│ ┌────────────┐ ┌──────────────────────┐  │      ┌──────────────────────────────┐
│ │ threads    │ │ generations by ID    │◀─┼─SSE──┤ Chat API (stateless)         │
│ │ sidebar    │ │ rAF-batched deltas   │  │      │ REST · generation SSE        │
│ │ pending    │ │ forward-only status  │  ├─────▶│ device SSE · admin           │
│ └─────┬──────┘ └──────────────────────┘  │ REST └───┬───────────────────┬──────┘
│       │ IndexedDB (per user, read-only)  │          │ txn               │ log read,
└───────┼──────────────────────────────────┘          │                   │ subscribe
        ▼                               ┌─────────────▼──────┐  ┌─────────▼──────────────┐
   offline copy                         │ PostgreSQL         │  │ Valkey                 │
                                        │ tree · generations │  │ gen:{id}:events log    │
                                        │ checkpoints        │  │ queue · cancel channel │
                                        └─────────▲──────────┘  │ user pub/sub · sessions│
                                                  │             └─────────▲──────────────┘
                                   claim · renew  │                       │ deltas · end
                                   checkpoint ·   │                       │
                                   finalize ┌─────┴───────────────────────┴──────┐
                                            │ Generation executors               │──▶ Model API
                                            │ 15 s lease · 5 s heartbeat · sweep │   (existing)
                                            └────────────────────────────────────┘
```

### ✅ Successful trace: one message, end to end

1. **Click Send.** The client mints an idempotency key, shows the message immediately as a pending bubble, and posts it with `parentMessageId` set to the leaf on screen.
2. **API.** Replay check by key first, then limits. One transaction locks the conversation, confirms nothing is in flight, inserts the user message, an empty assistant placeholder and the generation, and moves the leaf. Commit, then append `status: accepted` to the generation's log, ring the queue, publish `generation.created` to the user's devices, answer `202`.
3. **Client.** The pending bubble becomes the real messages; the generations store starts following `/generations/:id/events`.
4. **Executor.** Claims the row (`accepted → running`, attempt + 1, 15 s lease), builds the context by walking up the tree within the model's token budget, and streams from the model.
5. **Tokens.** Every 50 ms one `delta` goes to the log; every 2 s a checkpoint pairs the appended text with the log entry ID it covers.
6. **Paint.** The client buffers deltas and commits once per animation frame. Only the assistant message bound to that generation ID re-renders, and only its last markdown block changes.
7. **End.** The executor commits `completed` with the output, then appends `end`. The client flushes its buffer, writes the final text into the thread and the offline cache, re-reads the generation for the authoritative copy, and announces "Response complete." to screen readers.

### ❌ Failed trace: the executor dies mid-answer

1. **Crash at token 150.** The log has everything up to the last flush; PostgreSQL has a checkpoint at most 2 s older. The client's stream goes quiet; the cursor keeps blinking.
2. **Lease expiry.** No heartbeat for 15 s.
3. **Sweeper.** One executor's conditional update wins: `failed`, `EXECUTOR_LOST`. It closes the log first by appending `end`, then stores the longer of the log's text and the checkpoint, flagged as truncated.
4. **Client.** Receives `end` (status failed) on the same stream, keeps the 150 tokens, and shows "The server writing this answer stopped responding. The partial answer above was kept." with Regenerate available.
5. **No silent retry.** The user already read half an answer; replaying it would show a different one and bill twice. Regenerate is explicit and gets a new key.
6. **A stalled executor that wakes up** is fenced: its heartbeat and finalize match no row, its appends are refused because the log is closed, and it aborts the model call.

### What the user sees in each state

| State | UI |
|-------|----|
| Sending | Pending bubble "Sending…"; composer cleared |
| Accepted, before the first token | Three pulsing dots |
| Streaming | Text with a blinking cursor; Send becomes Stop; sidebar spinner |
| Reconnecting | "Connection dropped. Reconnecting and resuming where it left off…" |
| Stopped | Partial text + "Stopped — partial answer kept" |
| Failed | Partial text + red note with the reason + Regenerate |
| Not sent | Red bubble "Not sent: the connection dropped. Retrying is safe." + Retry / Discard |
| Offline | Sidebar banner; "Offline copy · saved 3 min ago · read-only"; composer disabled with the reason |

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: Resume, Stop and retry, end to end

**Decision.** A generation is a server-side record owned by an executor, with its tokens in a per-generation log whose entry IDs are the SSE event IDs. The client follows it with fetch and an explicit `Last-Event-ID`; Stop aborts the upstream model request; every create carries an idempotency key that the client reuses only while the outcome is unknown.

**Why it works for chat.** Each failure mode maps onto one mechanism.

- **"The connection drops halfway through a response. Can the client reconnect without creating another generation?"** Yes. The client reconnects to the same generation's stream with the last entry ID it applied and receives exactly the rest. After a refresh it reads the generation, paints the checkpoint, and resumes after `checkpointEventId`. Because the checkpoint only ever contains text already in the log, "checkpoint + later events" is exactly the full answer; locally that held byte for byte, including a run where the API cut every stream after five events and the client needed eight connections.
- **"Does pressing Stop only stop rendering, or does it also cancel backend work?"** Backend work. The API flags the generation and signals its executor, which aborts the HTTP request to the model; locally the mock model's active count dropped from one to zero about 130 ms after the click. The partial text is kept. The cancel reply says `202 running`, and the client ignores it in favour of the stream's `end`.
- **"What distinguishes retrying a request from asking for a new answer?"** The key. A retry is the same action, same key: the server returns the existing generation (`200`, `Idempotent-Replayed`). Regenerate is a new action, new key, new assistant sibling. The client keeps the key only while the outcome is unknown: the request failed to connect, or a gateway answered (502/503/504, or a 5xx without the API's error envelope, which is what a dev proxy sends when the API is down). After a definitive rejection like `409`, nothing was created, so Retry mints a new key and re-targets the current leaf.

**Why the alternatives break.** Streaming the model response directly from the POST ties the answer to one connection: a dropped phone connection kills it, and the only recovery is another POST, which is a second bill and a different answer. EventSource can't send a POST body or set `Last-Event-ID` on its first request, so it can't resume from a checkpoint read over REST. A WebSocket adds a bidirectional protocol, heartbeats and its own resume logic for traffic that is one-way. Retrying blindly without a key turns every flaky network into duplicate answers.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable generation + log + fetch SSE with `Last-Event-ID` + keys | Exact resume, one answer per click, Stop saves money | Executor, lease, sweeper, two stores |
| ❌ Stream from the POST | Simplest | Dies with the connection; reconnect = new generation |
| ❌ WebSocket | Bidirectional | More protocol than one-way data needs; resume still hand-built |

**What I give up.** Machinery that only pays off on failure paths, and a worst case of about 25 s before a crashed executor's answer shows as failed. I accept it because every one of those failure paths is a routine event on mobile networks.

### Deep dive 2: The generation-keyed store and the A → B switch

**Decision.** Live text lives in a Zustand store keyed by generation ID. Streams are opened by the store, not by components, and each assistant message subscribes only to the entry for its own generation ID. Threads live in a second store keyed by conversation ID and are kept after the user navigates away.

**Why it works.** Walk the scenario. Conversation A is streaming; the user clicks B.

1. A's stream is held by the store, so unmounting A's view closes nothing; A keeps streaming into A's entry.
2. B renders its own messages; each subscribes to its own generation's entry, so nothing in B reads A's entry and A's tokens can't appear there. There is no "current stream" variable anywhere to point at the wrong conversation.
3. When A's `end` arrives, the store flushes any buffered delta, writes the final text into A's thread and into IndexedDB, re-reads the generation for the authoritative copy, shows a toast "Answer finished in 'Weekend trip'", and puts a dot on A in the sidebar. Coming back to A shows the finished answer immediately.

Deltas are coalesced in a per-frame batcher: tokens append to a plain buffer and one store update per animation frame commits all generations at once. In hidden tabs, where frames don't run, a 500 ms timer takes over so a finished answer still lands. The device-sync echo of our own request is harmless because following is idempotent per generation ID.

**Why the alternative breaks.** The common implementation keeps `messages` and `streamingText` in the chat page's state and appends inside the fetch reader's loop. Switch to B and one of two bugs appears. If the effect's cleanup aborts the reader, A's answer is cut off, even though the user never pressed Stop. If it doesn't, the reader's closure calls `setMessages` on whatever conversation is mounted now, and A's tokens land in B. Keying by conversation ID instead of generation ID is closer but still breaks when a regenerate or a second device starts another generation in the same conversation.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Store keyed by generation ID, streams outside components | No cancel on navigation, no cross-talk, completion lands anywhere | More plumbing; stale entries need cleanup on sign-out |
| ❌ Component state + reader in an effect | Fewest lines | Navigation cancels or leaks; finished answers lost if unmounted |
| ❌ Store keyed by conversation ID | Simple lookup | Breaks with regenerations and multi-device generations |

**What I give up.** A store that outlives the views, so it must be reset on sign-out (it is, together with the IndexedDB copy), and two sources for an assistant's text (live entry vs stored content) with a rule for which wins: the live entry while streaming, the stored content after the authoritative re-read.

### Deep dive 3: Branches as a tree with a current-leaf pointer

**Decision.** Messages carry `parent_id`, so edits and regenerations add siblings rather than overwrite. The conversation stores one current-leaf pointer; the visible thread is the path from the root to it. Switching versions calls `PUT /leaf` with a sibling's ID, and the server resolves the latest state of that branch: the newest message in the sibling's subtree, which is always a leaf because children are newer than parents.

**Why it works for chat.** "‹ 2/3 ›" needs only each message's sibling list, which the server returns on every page. Regenerate is a new assistant child of the same user message; an edit is a new user child of the same parent; neither touches existing rows, so nothing the user once saw can disappear. Storing the pointer on the server means a reload, the desktop app and the phone all open the branch the user last chose. One generation per conversation in flight (a row lock plus a partial unique index) keeps the tree meaningful: every branch grows from a settled parent.

**"A user opens the same conversation on two devices and submits on both at once. What happens?"** Both requests lock the conversation row, so they serialize. The first creates its messages and generation; the second gets `409` naming the first. That device keeps the user's text as a "Not sent" bubble, attaches to the winner's stream (the answer appears live on both screens), and Retry re-targets the new leaf with a new key once the answer finishes. Locally, two simultaneous requests produced exactly one `202` and one `409`.

**Why the alternatives break.** A linear message list with in-place edits destroys history: the old answer the user was comparing against is gone. Storing the branch choice only in the browser makes two devices disagree about what the conversation is, and the next message's parent depends on which device sent it. Allowing parallel generations in one conversation makes them race for the leaf, so what both devices show depends on which answer finished last.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Tree + server-side current-leaf pointer | Nothing lost; same branch everywhere; cheap sibling lists | Path queries are recursive; pointer is last-write-wins |
| ❌ Linear list, overwrite on edit | Trivial queries | Destroys history; regenerate loses the old answer |
| ❌ Branch choice in the browser only | No write per switch | Devices disagree; parent of the next message is ambiguous |

**What I give up.** Recursive queries for every page and every branch switch (bounded by page size and by the subtree, both small in practice), and a pointer where the last device to switch wins. That's acceptable for a view preference that never loses data.

---

## 🎨 Rendering, Safety and Long Conversations (~3 min)

**Streaming markdown.** The answer is split into top-level blocks with a markdown lexer, and each block is a memoized component compared by its source text. While streaming, only the last block's source changes, so only it re-renders; re-lexing the whole answer once per frame costs well under a millisecond at typical lengths. An unterminated code fence renders as code mid-stream.

**Output safety.** The lexer's tokens become React elements directly: no `dangerouslySetInnerHTML`, no sanitizer to maintain. Raw HTML in the output (`<script>`, `<img onerror>`) shows as literal text. Links are allowed only for http, https and mailto, open in a new tab with `rel="noopener noreferrer nofollow"`, and show their real host. Images are never loaded, because a markdown image is the classic prompt-injection exfiltration channel (the data rides in the URL, and the browser sends it the moment it renders); they become a labelled "Image not loaded" chip. The seeded XSS conversation renders with zero script, image or `onerror` elements.

**Follow-scroll and accessibility.** The view follows the stream only while the user is within 80 px of the bottom; scrolling up stops it and shows "New output below". Sending always returns to the bottom. The list is a feed with `aria-busy` while streaming; the streaming text itself is not a live region (announcing every token would bury screen-reader users in fragments). One polite region announces "Assistant is responding." and "Response complete." (or stopped/failed) for the conversation on screen.

**"How do very long conversations change fetching and rendering?"**

- *Fetching:* opening a conversation loads the newest 40 messages of the visible path, walked up from the leaf; scrolling near the top fetches the 40 before the oldest one loaded. The sidebar pages by (updated_at, id) cursor.
- *Rendering:* the list is virtualized with `@tanstack/react-virtual` (measured heights, overscan 6), so a 300-message thread keeps only a screenful in the DOM. Prepending older pages shifts the scroll position by the added height so the reader's place doesn't jump.
- *Server-side context:* the executor walks up from the question with a running token count, stops at about twice the model's budget, and keeps the newest messages that fit; the number dropped is recorded. Summarizing older history is the next step; I didn't build it.

**Offline.** The sidebar and the newest 60 messages of the 20 most recently opened conversations are mirrored to an IndexedDB database named for the user and deleted on sign-out. If the server is unreachable at startup, the app opens read-only for the last user; a production-build service worker caches the app shell (never API responses), so a reload works with no network. It recovers on its own when requests succeed again.

---

## 📡 Multi-Device Sync (~2 min)

Each tab holds one device stream, `GET /api/v1/events`, carrying this user's changes from every device: answers created and finished, renames, deletions. The server publishes them on a per-user Valkey channel; each API instance holds one subscriber connection and subscribes only to the channels of users connected to it.

| Event | What the receiving tab does |
|-------|-----------------------------|
| `ready` (first frame of every connection) | Reconcile: reload the sidebar, then reattach to every in-flight generation in a conversation this tab has loaded |
| `generation.created` | If the new message continues the branch on screen, append it and follow the answer live. If it branched elsewhere, keep the view and add one to the affected message's version count |
| `generation.finished` | If this tab wasn't streaming it, fetch the final record and write it into the thread; clear the sidebar spinner |
| `conversation.updated` / `conversation.deleted` | Update or remove the sidebar row; an open conversation that was deleted says so, with a link to start a new chat |

> "The events are hints, never the record. Pub/sub drops whatever is published while a phone is in a tunnel, so correctness can't depend on delivery. That's why every connection starts with `ready` and a REST reconciliation: a missed event costs one extra request, never a wrong screen."

The trade-off against a durable per-device queue: I give up guaranteed delivery of each event, and in exchange there is no per-device state on the server, nothing to garbage-collect for devices that never come back, and nothing to replay in order. A second device opening the same conversation simply reads the same generation's log, which already *is* the durable part.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | PostgreSQL. A generation is accepted when its create transaction commits, before the `202`; an answer is final when the finalize commits, before `end`. Valkey holds live progress, hints and sessions; IndexedDB is a read-only copy |
| Client retries after losing the response? | Same key → the existing generation, checked before limits. Streams resume by entry ID; refresh resumes from the checkpoint. Nothing re-POSTs |
| Worker fails between two steps? | Commit without enqueue: re-rung after 30 s. Executor crash: lease expiry, `EXECUTOR_LOST`, partial kept. Valkey down at finalize: readers fall back to a snapshot from PostgreSQL |
| Which ordering is required? | Within a generation: log order and one ending, with a client status that only moves forward. Within a conversation: one generation in flight. Nothing across conversations |
| Access with caches and async work? | Every route, including both SSE streams, loads through the owner (another user's ID is `404`); long streams re-check the session; the offline cache is per user and deleted on sign-out |
| What breaks first? | Below |

---

## 📈 What Breaks First at 10× and 100× (~3 min)

Assume a production peak of ≈ 3,500 answers/s, ≈ 35K concurrent generations, ≈ 50K PostgreSQL statements/s, and one device stream per open tab.

| Rank | Component | Why it breaks | Fix |
|------|-----------|---------------|-----|
| 1 | PostgreSQL writes (10×: ≈ 500K/s) | ≈ 15 statements per answer, most of them checkpoints and lease renewals | Shard by user; checkpoint every 5 s under load; renew leases less often |
| 2 | Generation streams (10×: ≈ 450K open) | Each open stream holds a dedicated blocking Valkey connection | One multiplexed reader per stream-service instance |
| 3 | Device streams (10×: ≈ 15M) | One idle stream per tab; classic pub/sub broadcasts to every cluster node | Sharded pub/sub by user; one leader tab per browser via BroadcastChannel |
| 4 | Client memory on huge threads (100×: 10K-message threads) | Threads accumulate pages in memory | Evict pages far from the viewport; keep the virtualizer's window |
| — | The model provider | The real ceiling | Admission control, fair share per user, `429` with Retry-After |

> "The evidence for ranking PostgreSQL first is counting the executor's statements per ten-second answer. Streams come second because the handler opens one connection per viewer. I'd confirm both with the queue-time versus time-to-first-token split before scaling anything."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Generation ownership | Executor + lease + fencing | Stream from the POST | Answers outlive connections and devices |
| Transport | SSE over fetch with `Last-Event-ID` | WebSocket / EventSource | One-way data, explicit resume from a checkpoint |
| Partial output | Log + checkpoints paired with entry IDs | Completed messages only | Cheap exact refresh; survives crashes |
| Live client state | Store keyed by generation ID | Component state | No cancel or leak on navigation |
| Delta commits | One per animation frame | One per token | Paint at screen rate, not network rate |
| Markdown | Lexer tokens → React elements, per-block memo | HTML string + sanitizer | Safe by construction; last block only re-renders |
| History | Tree + server current-leaf pointer | Overwrite on edit | Nothing lost; same branch on every device |
| Conversation concurrency | One in flight, 409 + attach | Parallel generations | Deterministic leaf and complete contexts |
| Offline | Per-user IndexedDB, read-only | Offline sending queue | No conflicting sends; private on shared machines |

---

## 🚀 With More Time

- **Summarize dropped context** instead of discarding it, so very long conversations keep their early decisions.
- **One device stream per browser** rather than per tab, elected with BroadcastChannel, with other tabs fed over the channel.
- **A multiplexed stream reader** per API instance, removing one Valkey connection per viewer.
- **A real provider adapter** behind an environment variable; the mock stays the default so setup, tests and screenshots work offline.
- **Shared conversations**, which would turn the owner check into a membership check and make the current-leaf pointer per viewer rather than per conversation.

---

## 📝 Wrap-up (~1 min)

> "The server makes a generation a durable record with an owner, a replayable log and checkpoints that line up with it, so the client is only ever a viewer: drop, refresh, switch device, and nothing is lost or billed twice. The client keys live state by generation ID and streams outside components, so switching conversations neither cancels nor leaks, and a finished answer lands where it belongs. Messages form a tree with one pointer, so edits and regenerations only add. What I'd validate first is the checkpoint interval against write load, and the real-world reconnect rate on mobile."

### How the local implementation compares

The repo runs all of this locally: a Vite, React 19, TanStack Router and Zustand frontend with `@tanstack/react-virtual`, marked as a lexer only, and `idb` for the offline cache; an Express API serving REST and both SSE streams; a separate executor process with leases, checkpoints and the sweeper; PostgreSQL, Valkey, and a mock model service whose admin knobs set time to first token, tokens per second, mid-stream errors, silent disconnects and concurrency, plus an API knob that cuts browser streams after N events. I verified it in a browser: streaming, refresh mid-answer, Stop, switching conversations mid-answer, edit and regenerate branches, two tabs showing the same live answer, and offline reading. Compared with this answer, there's one database and one Valkey, each stream holds its own Valkey connection, device fan-out uses classic pub/sub, auth is a session cookie, there's no real provider adapter, and old context is dropped rather than summarized.
