# LLM Chat Assistant - System Design Answer (Frontend Focus)

*60-minute system design interview format - Frontend Engineer Position*

> Reported as "Design ChatGPT" (OpenAI) and "Design Claude's chat service" (Anthropic). Candidate-reported; see [FUTURE_PROJECTS.md](../FUTURE_PROJECTS.md#sources). Full-stack loops at OpenAI reportedly expect wireframes first, then the API, then the data layer, so I start from the screen.

## 🎯 Introduction (2 minutes)

"Thanks. I'll design the web client for a ChatGPT-style assistant. On the surface it's a text box and a list of messages, but three things make it hard. First, the reply arrives as a stream of tokens over ten seconds, and every one of those tokens re-renders markdown, possibly in a code block, while the user may be scrolling, reading, or trying to stop it. Second, the stream has to survive the real world: a laptop lid closing, a phone switching networks, a page reload, and it has to come back exactly where it left off without duplicated or missing text. Third, conversations are not lists but trees, because edit and regenerate create branches, and a long thread can hold hundreds of messages with code blocks. I'll treat the backend as a contract I specify, and spend most of the time on rendering, resilience, and state."

---

## 📋 Requirements Clarification (3 minutes)

### Functional Requirements

1. **Compose and send** - Multiline composer, Enter to send, Shift+Enter for a newline
2. **Streamed replies** - Render markdown and code incrementally as tokens arrive
3. **Stop** - A Stop button halts the reply; the partial reply remains
4. **Resume** - A reply that was streaming when the network dropped or the page reloaded continues seamlessly
5. **Sidebar** - Thousands of past conversations, grouped by date, searchable by title
6. **Branches** - Edit a sent message or regenerate a reply; navigate siblings with "‹ 2 / 3 ›"
7. **Drafts** - An unsent message survives navigation and reloads
8. **Quota and capacity UX** - Show remaining messages, model fallback, queue position, and "at capacity" with retry

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Send → user message visible | Same frame | Optimistic rendering; the network can't be in this path |
| Chunk arrival → paint | < 1 frame of work (16 ms) on a mid-range laptop | Streaming must never block typing or scrolling |
| Input responsiveness during a stream | INP < 100 ms | Users type the next question while reading |
| Long thread open (500 messages) | < 500 ms to interactive | Virtualize; don't mount 500 markdown trees |
| Resume after reconnect | No duplicated or missing text | Users notice a repeated sentence immediately |
| Accessibility | WCAG 2.2 AA | Streaming text is hostile to screen readers by default |

### Assumptions About the Server

| Assumption | Why it matters to the client |
|------------|------------------------------|
| A reply streams for ~10 s at ~50 tokens/s, ~500 tokens on average | Sets the render cadence and the cost of naive re-parsing |
| The server coalesces tokens into chunks every ~100 ms, each with a gap-free sequence number | The client renders ~10 chunks/s and can resume from a sequence number |
| Streams are server-side objects that outlive the HTTP connection | Disconnect is not cancel; the client can reattach |
| Free tier: 20 messages per rolling 3 h on model A, then model B; one reply in flight at a time | Drives the quota UI and disabling the composer |

---

## 🏗️ High-Level Architecture (6 minutes)

### Wireframe

```
┌──────────────────────┬───────────────────────────────────────────────────────┐
│ [+ New chat]         │  Model A ▾                     17 of 20 left · 4:12 PM │
│ 🔍 Search            ├───────────────────────────────────────────────────────┤
│                      │                                                       │
│ Today                │   ┌───────────────────────────────────────────────┐   │
│  ▸ Postgres indexes  │   │ You: How do I index a JSONB column?      ✎    │   │
│  ▸ Trip to Lisbon    │   └───────────────────────────────────────────────┘   │
│ Yesterday            │   Assistant                         ‹ 2 / 3 ›  ↻      │
│  ▸ Résumé review     │   Use a GIN index. For example:                       │
│ Previous 7 days      │   ┌───────────────────────────────────────────────┐   │
│  ▸ …                 │   │ code block (streaming, plain until closed) ▍  │   │
│  (virtualized list)  │   └───────────────────────────────────────────────┘   │
│                      │                              [ ↓ Jump to latest ]     │
│                      ├───────────────────────────────────────────────────────┤
│                      │  ┌─────────────────────────────────────┐  [ ■ Stop ]  │
│ alice · Free  ⚙      │  │ Message…  (draft saved)             │               │
└──────────────────────┴──┴─────────────────────────────────────┴───────────────┘
```

### Component and Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Routes (TanStack Router): / (new chat) · /c/$conversationId · /admin         │
└───────────────┬───────────────────────────────┬──────────────────────────────┘
                │                               │
┌───────────────▼──────────────┐ ┌──────────────▼───────────────────────────────┐
│ Sidebar                      │ │ ThreadView                                   │
│ virtualized, grouped by date │ │ virtualized message list · branch switcher   │
│ keyset pages of 50           │ │ StreamingMessage (outside memoized rows)     │
└───────────────┬──────────────┘ │ Composer (draft, send/stop, quota banner)    │
                │                └──────────────┬───────────────────────────────┘
                │ selectors                     │ actions
┌───────────────▼───────────────────────────────▼──────────────────────────────┐
│ Zustand stores: conversations · messageTree · streams · drafts · quota       │
└───────────────┬───────────────────────────────▲──────────────────────────────┘
                │ commands                      │ chunk batches (≤ 1 per frame)
┌───────────────▼───────────────────────────────┴──────────────────────────────┐
│ Stream client: fetch + ReadableStream SSE parser · seq dedupe · reconnect     │
│ with Last-Event-ID and backoff · cancel with last_seq_seen                   │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTPS (HTTP/2)
┌───────────────▼──────────────────────────────────────────────────────────────┐
│ Chat API (black box): conversations · messages (SSE) · resume · cancel ·     │
│ quota                                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

> "The key boundary is the stream client. It's a plain module, not a React component, so its lifetime isn't tied to a component mounting. If the user navigates to another conversation mid-stream, the stream keeps running and writing into the store; coming back shows it still going. React only subscribes to the store."

### Why these choices

| Choice | Why | Alternative rejected |
|--------|-----|----------------------|
| Zustand stores with selectors | A chunk updates one message; only components selecting that message re-render | React context: every chunk re-renders every consumer |
| Stream client outside React | Streams outlive navigation; no effect cleanup kills a reply | useEffect-owned fetch: unmount cancels the reader |
| fetch + ReadableStream | Can POST, set headers, and send Last-Event-ID manually | EventSource: GET-only, no custom headers, its own reconnect logic we can't control |
| TanStack Router file routes | Typed params for /c/$conversationId, loaders prefetch the thread | Hand-rolled routing |

---

## 💾 Client State Model (5 minutes)

| Store | Key Fields | Notes |
|-------|------------|-------|
| conversations | byId, orderedIds, nextCursor, groups | Sidebar data; a new message moves a conversation to the top |
| messageTree | nodes by id (parentId, childIds, role, content, status), leafByConversation | Normalized tree; the active branch is derived, never stored |
| streams | by generationId: messageId, lastSeq, status (queued, streaming, reconnecting, done, cancelled, failed), queuePosition, error | One entry per live generation; independent of which route is mounted |
| drafts | by conversationId (or "new"): text, updatedAt | Persisted to localStorage, debounced 300 ms |
| quota | by model: remaining, resetsAt, inFlight; capacity notice | Hydrated from the meta event and GET /quota |

> "Two decisions here prevent most bugs. First, the tree is normalized and the active branch is a derived selector: walk from the conversation's leaf to the root through parentId. Switching a branch changes one field, the leaf, and the path recomputes. Second, streamed text lives in the message node, keyed by the server's message ID, and the stream entry only tracks transport state. A message doesn't care whether its text came from a live stream, a resume, or a database fetch."

### Message node lifecycle

```
optimistic user message:  sending ──▶ sent ──▶ (failed ──▶ retry ──▶ sent)
assistant placeholder:    waiting ──▶ queued ──▶ streaming ──▶ complete
                                                    │  ├──▶ cancelled (Stop)
                                                    │  ├──▶ filtered (safety retraction)
                                                    │  └──▶ failed
                                                    └──▶ reconnecting ──▶ streaming
```

---

## 🔌 Interface: The Server Contract I Need (3 minutes)

```
GET    /api/v1/conversations?cursor=&limit=50      → Sidebar page, newest first
GET    /api/v1/conversations/:id                   → Active branch + sibling counts
PUT    /api/v1/conversations/:id/current-leaf      → Persist a branch switch
POST   /api/v1/conversations/:id/messages          → Send or edit; response is an SSE stream
POST   /api/v1/messages/:id/regenerate             → New sibling reply; SSE stream
GET    /api/v1/generations/:id/stream              → Resume with Last-Event-ID; 410 if expired
POST   /api/v1/generations/:id/cancel              → Stop, with last_seq_seen
GET    /api/v1/quota                               → Remaining per model, reset times
```

| Contract detail | What the client does with it |
|-----------------|------------------------------|
| Client-generated message ID (UUIDv7) accepted as the primary key | Optimistic rendering with a final ID; retries are idempotent |
| meta event first, with server IDs, model actually used, and quota | Confirms the optimistic message, updates the quota badge, shows a fallback notice |
| queued events with position and estimated wait | "Waiting for capacity · 12 ahead" instead of a silent spinner |
| delta events whose SSE ID is a gap-free sequence number | Dedupe on resume; detect gaps |
| notice event for degraded model or retracted content | Inline banner; replace retracted text |
| 429 and 503 with Retry-After before the stream starts | Quota and capacity UI with a countdown |
| 410 on resume after the stream log expires | Fetch the finished message instead |

---

## 🔧 Deep Dive 1: Rendering a Streamed Reply (9 minutes)

### Decision: incremental block-level markdown, flushed at most once per frame

**The naive approach:** Append each chunk to a string in state and re-render the whole message through a markdown component. It works in a demo and breaks on real replies, because the cost is quadratic. With chunks of ~5 tokens, a 500-token reply means 100 renders that parse 5, 10, 15 … 500 tokens: 25,250 token-parses instead of 500, 50× the necessary work. A 4,000-token reply with a long code block is 800 renders and ~1.6M token-parses, 400× the work, and that's where laptops start dropping frames while the user is trying to scroll.

**What I do instead:**

1. The stream client appends chunk text to a per-message buffer outside React and schedules one flush per animation frame. Two chunks arriving in the same frame cause one render.
2. The renderer splits the message into top-level blocks (paragraphs, lists, code fences, tables). Every block except the last is closed: it can never change again, so it's parsed once and memoized by its index and content hash.
3. Only the last, open block is re-parsed on each flush. Its size is bounded by a paragraph or a single code block, not the whole reply.
4. An unclosed code fence renders as a plain monospace block with the text appended; syntax highlighting runs once, when the fence closes, in an idle callback. Highlighting a growing block on every frame is the single most expensive thing a naive implementation does.
5. The parser auto-closes dangling syntax for the temporary render only: an unclosed bold, an unclosed inline code span, a half-written table row. Otherwise the open block flickers between formatted and raw markdown as asterisks arrive.

**Why it works:** Total parse work becomes linear in reply length, and per-frame work is bounded by the size of one block. The memoized closed blocks also mean React reconciles one block per frame, not the whole message.

**What I give up:** A custom block splitter that must agree with the markdown library's notion of block boundaries, and edge cases where a later token changes an earlier block's meaning, for example a line that turns out to be a table header once the separator row arrives. I handle that by treating a block as closed only once a blank line or a new block start follows it, so the open block absorbs those cases.

| Approach | Work for a 4,000-token reply | Frame drops on long code | Verdict |
|----------|------------------------------|--------------------------|---------|
| ✅ Block-level incremental, rAF-batched, highlight on close | ~4,000 token-parses | No | Chosen |
| ❌ Re-render the whole message per chunk | ~1.6M token-parses | Yes | Quadratic |
| ❌ Plain text while streaming, markdown at the end | Minimal | No | Layout jumps when formatting appears; code is unreadable mid-stream |

### Decision: autoscroll only while the user is pinned to the bottom

**Rule:** "pinned" means the bottom of the thread is within 48 px of the viewport bottom, tracked by an IntersectionObserver on a sentinel element. While pinned, every flush keeps the newest text in view. The moment the user scrolls up with the wheel, touch, or keyboard, we unpin and show a "↓ Jump to latest" button. Clicking it, or scrolling back to the bottom, re-pins.

**How the alternative breaks:** Always scrolling to the bottom on each chunk yanks the page away from someone reading the beginning of a long answer, ten times a second. Never autoscrolling makes the reply disappear below the fold. Comparing scroll positions on each scroll event to infer intent misfires because our own programmatic scrolls also fire scroll events; the sentinel plus explicit user-input listeners distinguishes the user's intent from ours.

**What I give up:** Some subtlety on mobile, where the virtual keyboard resizing the viewport looks like a scroll. I re-evaluate pinning on visualViewport resize rather than treating it as user intent.

### The Stop button

The Send button becomes Stop while a reply streams, and Escape triggers it from the composer. On click:

1. Stop rendering immediately: the message is marked cancelled and the stream client stops applying chunks. The user sees the reply freeze at exactly the point they clicked.
2. POST cancel with last_seq_seen, the sequence number of the last chunk actually painted, using a keepalive request so it survives a tab close.
3. Abort the fetch reader.
4. The server truncates the saved reply to last_seq_seen, so the persisted text equals what the user saw, and frees the GPU slot. The client doesn't wait for this; it already shows the final state.

> "I send last_seq_seen rather than letting the server save whatever it had generated, because otherwise reloading the page would show a few extra sentences the user never saw, which feels like the app is making things up after the fact."

---

## 🔧 Deep Dive 2: Streams That Survive the Network (8 minutes)

### Decision: resume by sequence number, treat disconnect as "probably coming back"

**Why it works:** Every chunk carries a gap-free sequence number, and the server keeps a per-generation log independent of the connection. When the reader errors or the stream ends without a done event, the stream entry goes to "reconnecting" and the partial text stays on screen. The client reconnects with GET on the generation's stream, sending Last-Event-ID as the last sequence it applied. It applies a chunk only if its sequence is exactly one more than the last applied, ignores duplicates, and reconnects again on a gap.

**Reconnect policy:**

1. Back off 0.5 s, 1 s, 2 s, 4 s, 8 s, capped at 10 s, with jitter, so a regional blip doesn't produce a synchronized reconnect storm.
2. Retry immediately on the browser's online event and when the page becomes visible again; mobile browsers kill connections in background tabs.
3. On 410 Gone (the reply finished more than 60 s ago and the log expired), fetch the message from the conversation endpoint and replace the partial text.
4. After a page reload, the conversation fetch returns the assistant message with status streaming and its generation ID; the client attaches from sequence 0, because the server persists text only at completion.

**How the alternative breaks:** If the client treated a dropped connection as the end, the user would see half a reply and have to regenerate, paying quota and GPU time for an answer that was actually still being written. Re-sending the original POST on disconnect is worse: without idempotency it creates a duplicate turn; with idempotency it at least reattaches, but it can't say where to resume, so it would re-render from the start and duplicate text.

**What I give up:** Two transport code paths, and a "reconnecting" state that users can see. I show it subtly, as a small pulsing indicator on the message, not a modal, because most reconnects complete in under a second.

### Decision: optimistic user messages with client-generated IDs

**Why it works:** On send, the client generates a UUIDv7 for the user message, inserts it into the tree immediately with status sending, inserts an assistant placeholder with a typing indicator, clears the composer, and only then starts the request. The server accepts the client's ID as the primary key, so the meta event confirms the same ID; there's no temporary-ID-to-real-ID remapping, which is where optimistic UIs usually corrupt keys and lose focus.

**Failure handling:** If the request fails before meta, the message shows "Not sent · Retry", keeping its text. Retry re-sends the same ID, so if the first request actually reached the server, the server attaches us to the existing generation instead of creating a duplicate. For a new conversation, the client generates the conversation ID too and navigates to /c/$conversationId instantly; the title fills in later.

**How the alternative breaks:** Waiting for the server before showing the message adds a visible round trip on every send, and on a slow network the user double-clicks Send. A temporary client ID swapped for a server ID on ack re-keys the React list, remounting the row mid-animation, and any reply chunk that arrives before the swap lands on the wrong key.

### Multiple tabs

Each tab runs its own stream client, but they share drafts and conversation order through localStorage events and a BroadcastChannel. If tab B opens a conversation whose reply is streaming in tab A, it simply attaches to the same generation by ID. The server's log makes two readers free, and both show identical text.

| Approach | Network drop | Page reload | Duplicate risk | Verdict |
|----------|--------------|-------------|----------------|---------|
| ✅ Resume by seq + client IDs | Seamless | Reattaches | None (seq dedupe, idempotent send) | Chosen |
| ❌ Treat disconnect as end | Half a reply | Half a reply | None | Users regenerate and pay twice |
| ❌ Re-POST on disconnect | Restarts | Restarts | Duplicate text or turns | Breaks trust |

---

## 🔧 Deep Dive 3: Long Threads, Branches, and the Sidebar (7 minutes)

### Decision: virtualize the thread with dynamic heights, keep the streaming message outside the virtualizer's measurement churn

**Why:** A 300-message thread with code blocks and tables can easily produce tens of thousands of DOM nodes and hundreds of syntax-highlighted blocks. Mounting all of them makes opening the conversation slow and every subsequent render expensive. I virtualize with @tanstack/react-virtual: an estimated row height, measured on mount, with overscan of a few rows.

**Details that matter:**

1. Virtualize only above a threshold, around 50 messages. Short threads render everything, which keeps the browser's own find-in-page working where it matters most.
2. Reverse anchoring: when rows above the viewport change height (an image loads, a code block finishes highlighting), adjust the scroll offset by the delta so the text the user is reading doesn't jump.
3. The streaming message is the last row and grows every frame. Its height is measured on each flush, and if pinned, we scroll after the measurement, not before, so we never scroll to a stale bottom.
4. Rows are memoized by message ID and content version. A chunk arriving re-renders exactly one row.

**What I give up:** Browser find-in-page doesn't see unmounted messages in long threads. I add an in-thread search over the store's text that scrolls the virtualizer to matches. Screen readers also lose the full list; rows carry aria-setsize and aria-posinset so position is still announced.

### Decision: a normalized message tree with a derived active branch

- **Regenerate** creates a new assistant node under the same user message. The sibling switcher shows "‹ 2 / 2 ›" and the old reply is one click away.
- **Edit** turns the user message into an inline editor. Saving creates a new user node under the same parent, then a new reply stream. Cancel restores the original. The old subtree remains intact.
- **Switching siblings** moves to the most recently viewed leaf under that sibling, not merely the sibling itself; otherwise flipping back to version 1 of an answer would lose the follow-up conversation that continued from it. The client keeps a per-node "last leaf" map.
- The new leaf is persisted with PUT current-leaf, debounced, so another device opens the same branch; conflicts are last-writer-wins, and either outcome is a valid branch.

**How the alternative breaks:** Modeling a conversation as a flat array forces edit to either destroy everything after the edited message or duplicate the conversation. Both lose work users care about, and both make "‹ 1 / 2 ›" impossible.

### The sidebar

Thousands of conversations, grouped as Today, Yesterday, Previous 7 days, Previous 30 days, then by month. It loads keyset pages of 50 sorted by (updated_at, id), so new activity doesn't shift page boundaries the way offset pagination would. Rows are a fixed 36 px, which makes virtualization trivial; group headers are sticky items in the same virtual list. Sending a message moves that conversation to the top optimistically. Title search filters loaded pages instantly and queries the server for the rest.

---

## 💬 Drafts (2 minutes)

- Saved per conversation (and a "new chat" slot) to localStorage, debounced 300 ms; drafts are small and synchronous restore avoids a flash of an empty composer.
- Restored when the route mounts, with the caret at the end.
- Cleared only after the server confirms the send with the meta event, not on click; if the send fails, the text is still both in the failed message and in the draft.
- Kept local only. Drafts often contain half-written sensitive text, and syncing them adds a privacy surface for little benefit. Other tabs pick up changes through the storage event.

---

## 🚦 Quota and Capacity UX (3 minutes)

"The server is authoritative; the client's job is to make limits predictable instead of surprising."

| Situation | What the user sees |
|-----------|--------------------|
| 3 or fewer messages left on model A | Quiet badge: "3 left on model A until 4:12 PM" |
| Quota exhausted (429) | Model switcher moves to model B with a banner explaining when model A returns; the message isn't lost, it's re-sent on model B with one click |
| Free reply already in flight | Send is disabled with a tooltip, rather than a 429 after clicking |
| Queued under load | "Waiting for capacity · 12 ahead · ~6 s" from queued events, with Stop available |
| Degraded to model B by the server | Inline notice on that reply: "Answered by model B because model A is busy" |
| At capacity (503 + Retry-After) | Inline card with a countdown and an auto-retry toggle; no modal, the draft stays editable |

> "I avoid modals for all of these. A limit is information, not an error. The user should be able to keep typing their next question while waiting."

---

## ♿ Accessibility (2 minutes)

- **Don't put a live region on the streaming text.** Screen readers would announce every chunk, ten times a second, talking over everything. Instead a polite live region announces "Assistant is responding" at the start and "Response complete" at the end; the finished message is then read like any other.
- Focus stays in the composer after sending. Stop is reachable by Tab and by Escape.
- The message list is a feed with labelled articles; each message's actions (copy, edit, regenerate, sibling switcher) are real buttons with accessible names like "Show response 2 of 3".
- Respect prefers-reduced-motion: no smooth autoscroll and no typing cursor animation.

---

## 🛡️ Rendering Untrusted Output (1 minute)

Model output is untrusted. Markdown renders without raw HTML. Links get rel="noopener noreferrer" and show their destination. Remote images in model output are blocked or proxied, because a prompt-injected reply can leak conversation text through an image URL that the browser fetches automatically. Copy buttons copy the source text, not rendered HTML.

---

## 📈 Performance and What Breaks First (2 minutes)

- **First to break: long code replies without incremental rendering.** The quadratic re-parse is invisible on short answers and catastrophic on long ones.
- **Second: very long threads without virtualization.** Memory and render time grow with every message; virtualization keeps them flat.
- **Third: syntax highlighting.** Language grammars are lazy-loaded on first use, and highlighting runs only on closed blocks, in idle time.
- **Bundle:** the markdown parser, highlighter, and math renderer are split out of the initial chunk. The shell, sidebar, and composer render first, and the composer accepts input before the thread loads.

---

## ❓ Follow-up Questions (3 minutes)

**"Why SSE and not WebSocket?"** Each reply is one request with one bounded stream, which is exactly what a streamed HTTP response is. SSE keeps HTTP status codes for quota and capacity errors, works through proxies, and has resume built in with event IDs. A socket per tab would be held open for the whole session while the app is idle almost all the time. I'd switch if the product added voice.

**"Does Stop actually save GPU time?"** It does if the client sends an explicit cancel and the server propagates it to the batch. Closing the connection alone isn't enough, because with resumable streams the server must assume a disconnect means "coming back". That's why Stop is a POST, not just an abort.

**"What if a safety filter retracts a reply mid-stream?"** The notice event tells the client to replace the message body with a short explanation. It's rare, and the server holds back the newest ~20 tokens while it classifies, so retractions of visible text are uncommon.

**"10× more users?"** Nothing per-client changes; the client's cost is per user. What changes is how often users meet capacity limits, which is why queued, degraded, and at-capacity states are designed as normal UI rather than error pages.

**"A data center goes down?"** The client sees a dropped stream and reconnects with backoff; the edge routes it to the failover region, and the stream resumes or, if that region doesn't have the log, returns 410 and the client loads the finished message. Optimistic messages that never got a meta event are retried with the same ID, which is safe.

**"Two-week MVP?"** One stream path with resume, optimistic send with client IDs, the incremental renderer, and pinned autoscroll. I'd defer thread virtualization, branches UI (but keep parentId in the data), and multi-tab coordination.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Markdown rendering | Block-level incremental, rAF-batched | ❌ Re-render the whole message per chunk | Linear instead of quadratic work |
| ✅ Code highlighting | On fence close, in idle time | ❌ Highlight while streaming | The most expensive per-frame work |
| ✅ Autoscroll | Pinned-to-bottom with a sentinel | ❌ Always scroll | Never fight a reading user |
| ✅ Stop | Freeze locally + cancel with last_seq_seen | ❌ Abort the fetch only | Saved text equals seen text; frees the GPU |
| ✅ Transport | fetch + ReadableStream SSE | ❌ EventSource | POST, headers, and controllable resume |
| ✅ Resume | Last-Event-ID + seq dedupe | ❌ Re-POST on disconnect | No duplicated text or turns |
| ✅ Optimistic send | Client-generated final IDs | ❌ Temporary IDs remapped on ack | No re-keying; idempotent retries |
| ✅ Conversation model | Normalized tree, derived branch | ❌ Flat array | Edit and regenerate keep old branches |
| ✅ Long threads | Virtualize above ~50 messages | ❌ Always virtualize | Keep find-in-page for short threads |
| ✅ Drafts | localStorage per conversation | ❌ Server-synced drafts | Simple, private, instant restore |
| ✅ Limits | Inline, non-modal states | ❌ Error modals | Users keep typing while waiting |

---

## 📝 Summary

> "To summarize: the client is built around a stream client that lives outside React and treats a reply as a server-side object it can attach to, detach from, and reattach to by sequence number. That's what makes network drops, reloads, and second tabs boring. Rendering is incremental at the block level and batched per frame, with syntax highlighting deferred until a code block closes, so a 4,000-token answer costs linear rather than quadratic work. Autoscroll follows the user's intent, and Stop freezes the screen immediately and tells the server exactly what the user saw so the saved reply matches it and the GPU slot is freed. Conversations are a normalized tree with a derived active branch, which makes edit and regenerate non-destructive, and long threads and the sidebar are virtualized. Quotas and capacity limits are designed as normal, inline states. The trade-off I'd highlight is complexity in the stream client and renderer, which I accept because those two pieces are what the user experiences as the product."
