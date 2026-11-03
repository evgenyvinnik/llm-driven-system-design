# AI Chat Client — System Design Answer (Frontend Focus)

*Senior frontend / product engineer interview · 45–50 minutes · discussion only, no code · structured with RADIO: Requirements → Architecture → Data model → Interface → Optimizations*

> "A chat client looks like a list of bubbles and a textbox. The hard parts are elsewhere. An answer takes 5 to 60 seconds, so it outlives the page, the network and sometimes the tab. Users switch conversations mid-answer, edit old messages, ask for another answer, press Stop, open the same chat on a laptop and a phone, and read history on a plane. And the text being rendered was written by a model, so I treat it as untrusted input. I'll spend most of the time on three things: where live tokens live, how streaming markdown stays fast and safe, and what resume, Stop and retry actually mean."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | Workflows, numeric targets, the trap I'm avoiding |
| A — Architecture | ~6 min | Layout, client layers, the server contract the client relies on |
| D — Data model | ~6 min | The message tree, where each kind of state lives |
| I — Interface | ~4 min | Endpoints, stream events, the errors the UI branches on |
| O — Optimizations | ~20 min | Three deep dives, then branching, long histories, offline, accessibility |
| Variants | ~5 min | Desktop app; assistant sidebar inside an existing app |
| Wrap-up | ~2 min | Traces, trade-offs, what breaks first |

---

## 🎯 R — Requirements (~5 min)

### Clarifying questions

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| How long is an answer? | Decides whether a stream can belong to a component | 5–60 s, 20–100 tokens/s, markdown with code and tables |
| Can users leave mid-answer? | Streams must outlive routes | Yes, and the answer must still land in history |
| Edit and regenerate? | Linear list or tree | Both; old versions stay reachable (‹ 2/3 ›) |
| Several devices? | Sync and concurrent submits | Yes, same account on laptop and phone at once |
| How long can a chat get? | Pagination, virtualization, context limits | Thousands of messages |
| Offline? | Local persistence | Recent chats readable offline, read-only |
| Who writes the rendered content? | Output safety | A model that can be prompt-injected: untrusted |

### Core workflows

1. Start a chat; the first Send creates the conversation, and the answer streams in token by token.
2. Keep chatting, switch models, press Stop when an answer goes wrong, and keep the partial text.
3. Switch to another conversation while an answer is still being written; come back to a finished answer.
4. Edit an earlier message (a new branch) or regenerate an answer (a new sibling); flip between versions.
5. Refresh, lose Wi-Fi or close the laptop mid-answer; nothing is duplicated and nothing is lost.
6. Open the same chat on a phone and watch the answer arrive there too.
7. Read recent conversations on a plane.

### Non-functional requirements

| Property | Target | Why |
|----------|--------|-----|
| First token visible | TTFT + ≤ 100 ms | Perceived speed is the product |
| Streaming cost | One commit per frame; only the last markdown block re-renders | 100 tokens/s must not drop typing input |
| Resume | Refresh or reconnect loses and duplicates nothing, never starts a new answer | Tokens cost money, and sampling makes a second answer different |
| One click, one answer | Even when the POST response is lost | Same reason |
| Output safety | No script, no remote image load, no `javascript:` link, ever | Model output can be attacker-controlled |
| Long history | 5,000-message chat opens and scrolls like a 50-message one | Power users keep one chat for months |
| Accessibility | WCAG 2.2 AA; screen readers hear completions, not every token | Streaming text is hostile to assistive tech by default |

**Out of scope:** model serving, billing, search across chats, attachments and voice.

> "The trap is designing a React array of messages plus one `POST /chat`. That model breaks the moment the user navigates, refreshes or edits. I'll treat each answer as a server-owned **generation** with an ID, and build the client around it."

---

## 🏗️ A — Architecture (~6 min)

### Screen layout

```
┌──────────────────────┬────────────────────────────────────────────────────┐
│ [+ New chat]         │ Weekend trip to Lisbon      (Offline copy · r/o)   │
│ ⚠ Offline, read-only │────────────────────────────────────────────────────│
│ TODAY                │                        ┌───────────────────────┐   │
│ ▸ Weekend trip ◌     │                        │ Which areas are quiet?│   │
│   Debounce helper ●  │                        └──────── ‹ 2/2 › ✎ ────┘   │
│ YESTERDAY            │  Here is how I'd think about **trams**…            │
│   Bike commute       │  1. …   ┌──────┬──────┐  ┌ code · Copy ┐           │
│ PREVIOUS 7 DAYS      │         └──────┴──────┘                            │
│   Quarterly OKR log  │  ‹ 3/3 ›  ⧉  ↻   sim-deep · 250 tok · 0.9 s TTFT   │
│                      │                  [ ↓ New output below ]            │
│                      │ ┌────────────────────────────────────────────────┐ │
│ Alice         ⎋      │ │ Message the assistant…    [Sim Swift ▾]  (■)   │ │
└──────────────────────┴─┴────────────────────────────────────────────────┴─┘
  ◌ answer in progress   ● finished while you were away   (■) Stop replaces Send
```

### Client layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Routes: /login · / (new chat) · /c/:conversationId · /admin              │
├──────────────────────────────────────────────────────────────────────────┤
│ Components: Sidebar · MessageList (virtualized) · UserMessage ·          │
│ AssistantBody (subscribes to ONE generation ID) · BranchNav · Composer   │
├───────────────────┬──────────────────────┬───────────────────────────────┤
│ conversations     │ generations store    │ ui / connectivity stores      │
│ store: sidebar,   │ live state keyed by  │ toasts, the one live region,  │
│ threads by conv,  │ generation ID, rAF   │ online / unreachable flag     │
│ pending sends     │ batched, forward-only│                               │
├───────────────────┴──────────────────────┴───────────────────────────────┤
│ Services: api (typed REST) · sse-follow (fetch + Last-Event-ID + backoff)│
│ chat-actions (send/edit/regenerate/stop, key rules) · device-events ·    │
│ offline-cache (IndexedDB, per user)                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Streams are opened by the generations store, never by a component. Components only subscribe.

### The server contract the client depends on

> "Three server behaviours make the client simple, so I'd ask for them explicitly."

1. **A generation outlives the HTTP request.** POST returns a generation ID immediately (202). A worker produces the answer; closing the tab doesn't stop it.
2. **Each generation is a replayable event log.** Every SSE event has an ID. Any API instance can replay from any ID, and PostgreSQL checkpoints store the text *together with the event ID it covers*.
3. **Writes are idempotent per user action.** The client sends an `Idempotency-Key`; a retry returns the same generation.

---

## 💾 D — Data Model (~6 min)

### Entities as the client sees them

| Entity | Key fields | Notes |
|--------|------------|-------|
| Conversation | id, title, model, currentLeafId, activeGenerationId, updatedAt | Sidebar row; spinner when activeGenerationId is set |
| Message | id, parentId, role, content, depth, siblingIds | A tree; siblingIds drive ‹ 2/3 › |
| Generation | id, status, output, checkpointEventId, outputTruncated, errorCode, usage | One attempt at one assistant message |

### The message tree

```
                 Q1 ──▶ A1
                         ├──▶ Q2  "busy areas?"  ──▶ A2 ──▶ Q3 ──▶ A3
                         └──▶ Q2' "quiet areas?" ──▶ A2' ─▶ Q4 ─┬▶ A4   (1/3)
                                                                 ├▶ A4'  (2/3)
                                                                 └▶ A4'' (3/3) ◀ current leaf
   edit = sibling user message (same parent)    regenerate = sibling assistant message
```

The visible thread is the path from the root to the conversation's current leaf. Choosing ‹ › on a message asks the server for the newest leaf under that sibling. It is newest because children are always created after their parents, so the most recent message in a subtree is a leaf. The server then stores it as the current leaf, so a reload or another device shows the same branch.

### Where each kind of state lives

| State | Lives in | Keyed by | Why there |
|-------|----------|----------|-----------|
| Sidebar list | conversations store + IndexedDB copy | conversation | Shared by every route |
| Loaded threads | conversations store (kept after navigating away) | conversation | A finished answer must land in A while B is on screen |
| Live tokens, status, connection | generations store | **generation ID** | The A→B switch (deep dive 1) |
| Unacknowledged sends | conversations store `pending` | idempotency key | Retry must reuse the key |
| Edit drafts, scroll position | component state | — | Nobody else needs them |
| Which conversation | the URL `/c/:id` | — | Refresh and paste reopen it |
| Offline copy | IndexedDB, one database per user | conversation | Survives reload; deleted on sign-out |

### Generation lifecycle on the client

```
 (click) ──▶ pending ──POST 202──▶ accepted ──status──▶ running ──end──▶ completed
    │           │                     │                    │       ├──▶ cancelled (partial kept)
    │      network error:             └── Stop ──▶ cancelled       └──▶ failed (partial kept)
    │      retry SAME key        stream drop: reconnect with Last-Event-ID (never a new POST)
    └── 409/422/429: definitive, nothing created, the next try is a NEW key
```

---

## 🔌 I — Interface (~4 min)

```
POST   /api/v1/conversations                         first message → conversation + generation
POST   /api/v1/conversations/:id/messages            new message, or edit (editOfMessageId)
POST   /api/v1/conversations/:id/messages/:m/regenerate   new answer to user message m
PUT    /api/v1/conversations/:id/leaf                branch navigation
GET    /api/v1/conversations?cursor=                 sidebar, keyset-paginated
GET    /api/v1/conversations/:id                     newest page of the visible path
GET    /api/v1/conversations/:id/messages?before=    older page, walking up parents
GET    /api/v1/generations/:id/events                SSE; Last-Event-ID resumes
POST   /api/v1/generations/:id/cancel                Stop
GET    /api/v1/generations/active                    reattach after refresh
GET    /api/v1/events                                device sync SSE (this user's changes)
```

| Stream event | Payload | Client action |
|--------------|---------|---------------|
| `status` | accepted → running | Forward-only status update |
| `delta` | text, event ID | Buffer; commit next animation frame |
| `end` | status, outputTruncated, error, usage | Flush buffer, finalize, write into the thread, announce |
| `snapshot` | the full generation | Live log expired: replace with PostgreSQL's record |

| Response | UI behaviour |
|----------|--------------|
| `202` / `200 Idempotent-Replayed` | Same handling: replace the pending bubble, follow the generation |
| `409 GENERATION_IN_PROGRESS` + generationId | "An answer is already being written (maybe on another device)"; attach to that generation |
| `422 IDEMPOTENCY_KEY_REUSED` | Client bug; log it, keep the pending bubble with Retry |
| `429` | Inline message; nothing was created |
| network error, 502/503/504, proxy 5xx | Outcome unknown: retry with the same key; flip to offline mode |
| `404` on any ID | Not yours or deleted: same message, no probing |

---

## 🔧 O — Optimizations and Deep Dives (~20 min)

### Deep dive 1: A generation-keyed stream store, and the A → B switch (~7 min)

**Decision.** All live answer state lives in one app-level Zustand store, `byId[generationId]`. Stream readers are held in a module-level registry (generation ID → abort function), outside React. An assistant message subscribes to exactly one entry: the one for *its own* generation ID. Nothing in the app ever appends tokens to "the current conversation".

**Why it works here.** The user starts an answer in A and clicks B. A's route unmounts, but A's stream belongs to the store, so it keeps writing into `byId[genA]`. B's messages subscribe to B's generation IDs, so A's tokens cannot appear in B: no code path connects them. When A's `end` arrives, the store flushes pending text and writes the final text and status into **A's thread** in the conversations store, and into IndexedDB. Because threads are kept after navigation, this works wherever the user is. If A is not on screen, the sidebar dot appears with a toast "Answer finished in 'Weekend trip'"; if it is, the polite live region says "Response complete." Following is idempotent per ID, so a refresh, the device-sync echo of our own request and a thread reload can all call `follow` without opening a second connection.

The selection itself is a performance tool. The AssistantBody that is streaming re-renders once per frame. Its siblings, the sidebar and the composer don't, because they select strings or other entries. The composer selects only the active generation's *ID*, not the entry, so it doesn't re-render per token either.

**Why the alternatives break.**

- *One `streamingText` state in the chat component, filled by a fetch reader in an effect.* This is the classic bug. The reader's callback closes over "the current conversation" and appends to whatever messages are on screen. Switch to B mid-answer and A's tokens land in B's last bubble. If cleanup aborts the fetch instead, switching cancels A: the server keeps generating (and billing), but the client never sees the result until a reload.
- *Per-conversation slot ("the stream for conversation A").* Closer, but it conflates the conversation with the attempt. A regeneration or a second device's answer is a different generation in the same conversation. A late event from the old attempt then overwrites the new one. Keying by generation ID makes each attempt its own unit.
- *Poll the conversation.* At 1 s the text arrives in lumps. At 100 ms each response carries the whole answer so far, so bytes grow with the square of its length.

| Approach | Survives A→B | Leak-proof | Connections | Cost |
|----------|--------------|------------|-------------|------|
| ✅ Store keyed by generation ID, readers outside React | Yes | By construction | One per generation | Explicit lifecycle, merge rules |
| ❌ Component state + effect reader | No (leaks or cancels) | No | One per mount | Wrong tokens or lost answers |
| ❌ Slot per conversation | Partly | No (attempts collide) | One per conversation | Races on regenerate |
| ❌ Polling | Yes | Yes | None held | Lumpy text, quadratic bytes |

**What I give up.** Global state with a lifecycle I must manage: sign-out resets the store and aborts every reader, and finished entries off screen need eviction. And there are two sources for one answer (the stream and REST responses), which is the race in deep dive 3.

### Deep dive 2: Streaming markdown, fast and safe (~6 min)

**Decision.** Use marked only as a *lexer*. Its tokens become React elements, so no HTML string is ever produced. The answer is split into top-level blocks. Each block is a memoized component keyed by position and compared by its source text. Deltas are buffered and committed once per animation frame.

**Why it works for speed.** While an answer streams, only its last block changes. Every block above it has the same source text, so React skips it, and the cost per frame is one paragraph or one code block, not the whole answer. The deltas themselves are batched twice: the server flushes every 50 ms, and the client commits one store update per frame for *all* streaming generations together. Hidden tabs have no animation frames, so they fall back to a 500 ms timer. That keeps state current (an answer still lands) without painting anything. Re-lexing the whole answer per frame is cheap at these sizes. Measured on a laptop, a full lex takes about 0.3 ms for 5 KB, 0.7 ms for 20 KB and 1.7 ms for 50 KB; budget three to five times that on a mid-range phone. For very long answers I'd lex only the tail from the start of the last block. I didn't build that yet, because it has a subtle bug class: a later line can change an earlier block (a list continuing, a setext heading underline).

Half-written constructs degrade gracefully. An unterminated code fence lexes as a code block, so code is monospaced while it streams. A half-built table renders its header row. Unclosed `**bold` shows asterisks for a moment; I accept that over "optimistically closing" syntax, which guesses wrong on code.

**Why it works for safety.** The renderer has no path to raw HTML. Because there is no `dangerouslySetInnerHTML`, there is no sanitizer to keep current with browser parsing quirks.

| Model output | Rendered as | Why |
|--------------|-------------|-----|
| `<script>`, `<img onerror>`, any tag | Literal text in a muted code style | Prompt injection can make the model emit markup |
| `[x](javascript:…)`, `data:`, relative URLs | Plain text, "link removed" tooltip | Only absolute http, https and mailto are allowed |
| `[x](https://…)` | Link, new tab, `rel="noopener noreferrer nofollow"`, real host shown | Visible host defeats look-alike link text |
| `![x](https://tracker/…?leak=…)` | A labelled chip, never fetched | Rendering an image sends its URL. That is the classic exfiltration channel for injected instructions |
| Code fences | `<pre><code>` text + Copy | Copy goes through the clipboard API as text |

A strict Content-Security-Policy (no inline scripts, `img-src 'self'`) is the second wall in production.

**Why the alternatives break.** *Render the whole answer to an HTML string per token and set innerHTML.* That is O(n) parsing and DOM replacement per token, so the selection and scroll jump. Safety then depends on a sanitizer run on every partial string. Mid-stream fragments are exactly the odd inputs sanitizers get wrong. *Plain text until the end, then markdown.* That is safe and cheap, but it causes a big layout jump at completion, and code is unreadable while streaming.

**What I give up.** I own a renderer (around 200 lines): GFM tables, task lists and nested lists are mine to get right. Syntax highlighting would be lazy-loaded and applied only to completed code blocks. Users who want inline images from trusted hosts can't have them without an allowlist I haven't built.

### Deep dive 3: Resume, Stop and retry semantics (~7 min)

**Resume.** `sse-follow` reads SSE over `fetch`, not EventSource. EventSource sends `Last-Event-ID` only on its own reconnects, never on the first request. So it can't resume from a checkpoint the client loaded over REST, and it can't carry custom headers. The reader keeps the last event ID it applied. On a drop it waits 0.5, 1, 2, 4, then 8 s (reset on the next event), then reconnects with that ID. Any API instance replays exactly what came after it. On refresh, the thread's REST response contains the in-flight generation's checkpoint text *and* `checkpointEventId`. The store seeds the text and resumes the stream after that ID, so a refresh doesn't replay 3,000 tokens. **Reconnecting is a read, never a re-POST**, so a flaky train ride can't double the bill or produce a second, different answer. The UI says "Connection dropped. Reconnecting and resuming…" under the bubble.

**Stop.** Stop is a REST call, `POST /generations/:id/cancel`. The server flags the generation and signals the worker, which **aborts the upstream model request**, so the model stops spending. Stop does not merely stop rendering. The button turns to "Stopping…" optimistically, but I never show "cancelled" before the server says so, because the answer may finish in the same instant. Either ending is final.

**The cancel race.** The executor can write the `cancelled` end within milliseconds, so the stream's `end` reaches the browser *before* the cancel request's reply. That reply was computed earlier and still says `running`. If the last write wins, a stopped answer flips back to "running" with a spinner forever. The fix is a merge rule: status only moves forward (accepted < running < terminal), and an older REST copy may never move an entry backwards.

**Retry versus a new answer.**

| User intent | Client action | Key | Server result |
|-------------|---------------|-----|---------------|
| Network failed, outcome unknown | Automatic retry (0.5, 1.5, 4 s), then a Retry button | **Same** key | The existing generation (200, replayed) |
| Server rejected it (409/422/429) | Retry button | **New** key, re-targeted at the current leaf | A new attempt, because nothing was created |
| "Give me another answer" | Regenerate | Always a new key | New generation, new sibling (‹ 2/2 ›) |
| "I asked it wrong" | Edit | New key | New user sibling and a new branch |

The rule is simple: **reuse the key while the outcome is unknown; mint a new one once the server has definitively said no.** Gateway errors (502/503/504, or a dev proxy's bare 500) count as "unknown". The request may have reached the API before the gateway gave up.

**Two devices submitting at once.** The server allows one in-flight generation per conversation (a row lock plus a partial unique index). The second device gets `409 GENERATION_IN_PROGRESS` with the winner's generation ID. Its text stays in a failed pending bubble ("An answer is already being written… Retry"), and the client *attaches* to the winner's stream. The user watches the other device's answer arrive, then chooses to resend. The alternative, parallel branches from the same parent, wins on throughput but confuses people. Two answers race into one chat, and the user sees whichever branch finished last.

**What I give up.** Explicit state machines on both sides, a merge rule that must be tested (a store test covers it), and a pending bubble that can sit in "failed" until the user acts. I prefer that to a duplicated, billed answer.

### Branch navigation

‹ 2/3 › appears on any message whose parent has more than one child. Edit opens an inline editor. Sending it creates a user sibling under the *same parent* and the thread re-renders as "path to the parent + new messages". Regenerate creates an assistant sibling under the same user message. Both are disabled while an answer is in flight in that conversation (the server would answer 409 anyway). When another device branches somewhere else in the open conversation, I don't yank the view. I only add the new sibling ID, so the counter becomes ‹ 1/2 ›.

### Long histories

- **Paginate the path, not the tree.** The first request returns the newest 40 messages of the visible path. Scrolling within 400 px of the top loads the previous page by walking up parent pointers. The client never downloads branches it isn't showing.
- **Virtualize.** `@tanstack/react-virtual` keeps only the rows near the viewport in the DOM, measuring dynamic heights, with stable keys (message IDs) so prepending doesn't remount rows. The DOM size depends on the viewport, not on the length of the conversation.
- **Follow the stream only at the bottom.** If the user is within 80 px of the bottom, each frame's growth keeps them pinned. If they scroll up to re-read, auto-scroll stops and a "New output below" pill appears. Sending a message always returns to the bottom.
- **Prepend anchoring.** When older messages load above, scrollTop shifts by exactly the added height, so the text under the user's eyes doesn't move.
- **Context truncation is the server's job.** The client never decides what the model sees. The server walks up the path until the token budget is used, and records how many messages it dropped.

### Offline (read-only)

The sidebar list and the newest 60 messages of the 20 most recently opened conversations are kept in IndexedDB. There is **one database per user**, deleted on sign-out, so a shared computer never shows the last person's chats. The app knows it is offline from a fetch that can't connect or a gateway error, not just from `navigator.onLine`. In that state the sidebar says "Offline. Showing conversations saved on this device, read-only." The thread header says "Offline copy · saved 3 min ago", and Send, Edit and Regenerate are disabled with a reason. A production service worker caches only the static app shell, never API responses, so a reload on a plane still opens. When the device-sync stream reconnects, the client reloads the list and the open thread.

### Multi-device sync

Each tab holds one device stream, `/api/v1/events`. It carries this user's changes as **hints**: answer started (with the full POST result), answer finished, renamed, deleted. If the open conversation's leaf is the new message's parent, the client appends it and follows the stream, so the phone shows the laptop's answer as it streams. Pub/sub drops anything sent while a device is disconnected. So every (re)connect begins with reconciliation from REST: reload the sidebar, then reattach to `GET /generations/active` for loaded threads.

### Accessibility

The message list is an ARIA `feed` of `article`s ("You said" / "Assistant said") with `aria-busy` on the streaming one. It is deliberately **not** a live region, because announcing tokens buries the user in half-sentences. One polite status region announces "Assistant is responding." and "Response complete / stopped / failed." for the conversation on screen. Completions elsewhere are toasts with an Open link. Branch controls are labelled ("Previous answer", group "answer 2 of 3"), and every action is a real button reachable by keyboard. Enter sends and Shift+Enter adds a newline, with IME composition respected. The caret animation should honour `prefers-reduced-motion`.

---

## 🖥️ Variant: a desktop app (~3 min)

> "Same stores, same renderer, but the trust boundary moves. In a browser, XSS steals a session. In a desktop shell with Node access, XSS runs code on the user's machine, and model output is attacker-influenced text."

| Concern | Design |
|---------|--------|
| Process model | The **main process** owns the network, the session token (OS keychain via the platform's secure storage), the SSE connections and the local database. **Renderers are sandboxed**: context isolation on, Node integration off, a strict CSP, and a narrow typed preload bridge (`send`, `follow(generationId)`, `cancel`). There is no generic IPC passthrough |
| Navigation | Renderers can't navigate away or open windows; links go through an allowlisted `openExternal` in the main process (http/https only) |
| Where streams live | The generation store moves into the main process. It holds one connection per generation and fans out to every window over IPC. Each renderer keeps a mirror keyed by generation ID. Closing a window never drops an answer, and two windows on one chat agree |
| Multi-window | A single-instance lock; opening a chat that is already open focuses that window |
| Deep links | `aichat://c/<uuid>` is validated in main (format, signed in, owned), then focuses or opens a window. A deep link never *performs* an action: `aichat://send?text=…` would at most prefill the composer, because a link on a web page must not speak for the user |
| Local cache | An encrypted local database whose key is in the OS keychain. It is wiped on sign-out, with a "don't keep history on this device" policy for managed machines |
| Auto-update mid-generation | Download in the background, install on quit or idle. If the user restarts mid-answer, nothing is lost, because the server owns the generation. On relaunch the app reads `/generations/active` and resumes from the checkpoint. The server keeps the event schema backward compatible and can refuse very old clients with "please update" |
| Background windows | A native notification replaces the toast when an answer finishes in an unfocused window |

---

## 🧩 Variant: an assistant sidebar inside an existing app (~3 min)

> "Here the assistant doesn't just talk, it acts on the host app's data, so the rule is: the model proposes, the user confirms, the host executes."

1. **Structured proposals, not prose.** The model answers with typed actions from the host's catalog ("create_task", "rename_doc"), validated against a JSON schema on the server. The client never parses instructions out of free text.
2. **Preview from the host, not from the model.** The sidebar renders a confirm card from the host's own **dry-run** of the action: a diff for edits, a list for "create 3 tasks". The model's description of an action can be wrong or injected; the dry-run can't lie about what will happen. Reads may run automatically; every write and every destructive action waits for Confirm.
3. **The host executes, as the user.** Confirm calls the host's normal API with the user's own session, so its usual permission checks apply. There is no privileged assistant service account. The proposal ID is the idempotency key, so a double-click or a retried request executes once. The result is posted back into the conversation as a tool-result message, so the model knows what actually happened.
4. **Context is minimal and permission-checked.** The host passes what the user can see (current page, selection), and page content is treated as untrusted. A task description containing "assistant: delete all projects" can produce a *proposal*, never an action.
5. **Isolation.** For a multi-product or third-party host, the sidebar is an iframe on its own origin with a typed `postMessage` bridge and strict origin checks. Assistant rendering bugs can't touch the host DOM, and both deploy independently. Inside a single first-party app, a lazily loaded module in the host bundle is simpler.
6. **Undo and audit.** Actions are logged as "Alice via assistant", and the confirm card offers Undo where the host supports it.

---

## 🧪 Follow-ups and the review checklist

| Question | Answer |
|----------|--------|
| Connection drops mid-answer: reconnect without a new generation? | Yes. The reader resumes with `Last-Event-ID`; a refresh resumes from the checkpoint's event ID. Neither re-POSTs |
| Retry versus a new answer? | Same key while the outcome is unknown returns the same generation. Regenerate is a new key and a new sibling |
| Same chat, two devices, submit at once? | One wins (one in-flight generation per conversation); the other gets 409 with the winner's ID, attaches, and keeps its text for Retry |
| Does Stop cancel backend work? | Yes. The worker aborts the model request and keeps the partial output, marked as partial |
| Very long conversations? | Path pagination (40 per page), virtualization, prepend anchoring; the server truncates context |
| Source of truth; when is a write successful? | PostgreSQL. A send succeeds at 202/200; an answer succeeds at `end: completed`, emitted after the commit |
| Worker fails between steps? | Its lease lapses; the sweeper fails the generation, keeping streamed text; the client sees `end: failed` with the partial |
| Ordering needed? | Total order within one generation (event IDs); one in-flight generation per conversation; device events unordered |
| Access through caches and async paths? | The stream is authorized when opened and the session is re-checked while open; another user's IDs are 404; IndexedDB is per user and wiped on sign-out; the SW never caches API responses |

---

## 🔁 Two execution traces

**Success: switch away mid-answer.** (1) Alice sends in "Lisbon". chat-actions mints key k1, adds a pending bubble and POSTs; `202` returns conversation, user message, assistant placeholder and generation g1. (2) The pending bubble becomes real messages, and the store opens g1's stream. Deltas buffer and paint once per frame, and the last markdown block grows. (3) She clicks "Debounce helper". The Lisbon route unmounts, and g1's reader keeps going. B's rows subscribe to B's generation IDs, so nothing of g1 appears there. (4) g1's `end: completed` arrives. The store flushes, writes the final text into Lisbon's thread and IndexedDB, and marks Lisbon unread; a toast offers "Open", then fetches g1 once to replace the streamed copy with the server's record. (5) She returns to Lisbon. The thread is already in memory, so the answer is there instantly; a background revalidation changes nothing.

**Failure: lost response, dropped stream, and the Stop race.** (1) Bob sends on a train; the POST reaches the server and creates g2, but the response is lost. (2) After 0.5 s chat-actions retries with the same key and gets `200 Idempotent-Replayed` with g2, so there is still one answer. (3) After event 41 the connection drops; the bubble says "Reconnecting…". The reader waits 0.5 s, fails, waits 1 s, then reconnects with `Last-Event-ID` = event 41, and event 42 onward arrives with no gap or duplicate. (4) He presses Stop. The worker aborts the model call, commits `cancelled` and appends `end`, which reaches the browser before the cancel reply that still says `running`. (5) The forward-only rule keeps "Stopped, partial answer kept". The live region says "Response stopped." and Regenerate is one click.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Live answer state | Store keyed by generation ID, readers outside React | Component state / per-conversation slot | Survives A→B with no leak or cancel |
| Transport | SSE over fetch with an explicit cursor | EventSource / WebSocket | One-way data; resume from a REST checkpoint |
| Reconnect | Re-read from Last-Event-ID | Re-POST | Never a duplicate, billed answer |
| Merge rule | Status only moves forward | Last response wins | Closes the Stop race |
| Rendering | Lexer → React elements, memoized blocks, rAF batching | HTML string + sanitizer | No HTML path; cost bounded by the last block |
| Images in output | Never fetched, labelled chip | Load them | Image URLs are an exfiltration channel |
| Retry key | Reuse while unknown, new after a definitive no | Always new / always same | Lost responses replay; rejections retry cleanly |
| Concurrent submits | One in-flight per conversation, 409 + attach | Parallel branches | Predictable conversations |
| History | Path pages + virtualization | Load the whole tree | Bounded payload and DOM |
| Offline | Per-user IndexedDB, read-only, wiped on sign-out | Offline sends | Safe and simple; queued sends are a later step |
| Device sync | Pub/sub hints + REST reconciliation | Rely on events alone | Hints get lost; REST is the record |

---

## 📈 What breaks first, and what I'd do next (~2 min)

- **Connections per tab.** The device stream plus one stream per in-flight generation, times tabs, hits the HTTP/1.1 limit of six connections per origin. The fixes are HTTP/2 in production, then a `BroadcastChannel` with one leader tab owning the streams for all tabs, then one multiplexed stream per tab with a cursor per generation. Evidence: count open EventStreams in field telemetry against tab counts.
- **Main-thread cost on huge answers.** Re-lexing a 50 KB answer every frame starts to show up as long tasks. The fixes are tail-only lexing with a periodic full re-lex, or lexing in a worker. Evidence: long-task entries and input delay measured while streaming.
- **Memory.** Threads and generation entries accumulate over a long session. I'd evict unpinned threads beyond about 30 and terminal entries off screen.

**Next:** queued offline sends (the idempotency key already makes them safe to replay), search over the IndexedDB copy, lazy syntax highlighting, and real-user metrics for token-to-paint.

---

## 📝 Wrap-up

> "Every answer is a server-owned generation with an ID. The client keys its live state by that ID, which is why switching conversations neither cancels nor leaks, and why a finished answer lands wherever it belongs. Streams resume by cursor and never by re-submitting, and keys are reused only while the outcome is unknown. Status only moves forward. Model output is rendered without any HTML path, one memoized block at a time. Everything else (branches, long histories, offline, two devices) is the same few rules applied consistently."

### How the local implementation compares

`frontend/` implements this design: `stores/generations-store.ts` (keyed by generation ID, rAF batching via `lib/frame-batcher.ts`, forward-only merge, completion landing and announcements), `lib/markdown.tsx` (lexer to React, memoized blocks, link allowlist, no images), `services/sse-follow.ts` (fetch SSE with `Last-Event-ID` and backoff), `services/chat-actions.ts` (key rules, 409 attach), `components/chat/MessageList.tsx` (virtualization, follow-at-bottom, prepend anchoring) and `services/offline-cache.ts` (per-user IndexedDB). Store tests cover the A→B switch, landing, resume-from-checkpoint and the Stop race. Renderer tests cover hostile markup. The desktop and sidebar variants are design only. Not built yet: tail-only lexing, the leader-tab connection sharing, queued offline sends, syntax highlighting, and reduced-motion handling for the caret.
