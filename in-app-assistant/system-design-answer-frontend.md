# In-App Assistant — System Design Answer (Frontend Focus)

*Senior frontend / product engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations*

> "The prompt is: an established tool like Gmail, Docs or Word adds an LLM chat that does things in the app from natural language. The trap is to draw a chat widget with a message array and a `POST /chat`. Two things make this harder than a chat client. First, the panel lives inside an app that already owns its data, its permissions and its undo. So the assistant has to propose changes and let the host carry them out, and the user has to see and approve the ones that matter. Second, a turn isn't a stream of text. It's a timeline of streamed text, tool progress, browser-side tool calls and confirmation cards, and it can pause for minutes. I'll keep the agent loop on the server as a box and name the one property the client depends on. Then I'll spend the time on the panel: what context it sends, how a turn renders and survives navigation, how confirmations and edits look, and how untrusted model output is rendered."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | The user's workflow, client-facing targets, the trap |
| A — Architecture | ~8 min | Panel layout, client layers, the server as one diagram |
| D — Data model | ~6 min | Client context, the turn as a timeline, where state lives |
| I — Interface | ~4 min | Endpoints, events, the codes the UI branches on |
| O — Optimizations | ~20 min | Three deep dives, plus rendering, templates, settings, accessibility, traces |
| Wrap-up | ~2 min | Trade-offs, what breaks first |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Which apps? | Context and tools differ per app | One suite, "Lumen Workspace": Mail, Docs, Calendar. One panel, one conversation per app |
| Answer only, or also act? | Acting means confirmations and undo | Both: answer from the user's data, and draft, edit, schedule, send |
| Does the editor have real-time co-editing? | Decides who applies document edits | Not here; I'll say what changes if it does |
| Whose permissions? | Decides what can leak | Always the signed-in user's, never a service account |
| How long is a turn? | Decides whether a turn can live inside a component | 2–20 s running; a confirmation can wait 10 minutes |
| What must never happen? | Sets the confirmation rules | A send, invitation or irreversible edit without an explicit click |
| Devices? | Layout | Desktop web; panel docked right at 400 px |

### The user's workflow, in order

1. Opens "Q3 Offsite Plan" and clicks a paragraph. The panel header says *Sees "Q3 Offsite Plan" · 1 selected*.
2. Types *"Add a short summary of Dana's thread from last week under the intro."*
3. Sees progress rows ("Searching your mail…", "Reading the thread…"), then a streamed answer with citation chips.
4. Sees a green suggested paragraph in the document itself, with Keep and Undo.
5. Switches to Mail before the answer finishes. The Docs turn keeps going, and the answer is waiting when they come back.
6. In Mail, asks for a reply draft. It is saved silently. Then "Send it" shows a confirmation card with the full email.
7. Clicks "Summarize thread" above an email: a one-shot template, not the agent.
8. Presses Stop on a turn that's going wrong, and opens "What I did" to see each step.
9. In Settings, turns off sending or requires confirmation for every change.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| First feedback | First event (status or text) painted ≤ 300 ms after submit (p95) | Multi-step turns take 10–20 s with a real model; silence reads as broken |
| Host unaffected | An assistant failure never breaks Mail or Docs; the panel shows an error line | The assistant is additive |
| Resume | A dropped connection or refresh loses no text, repeats none, never starts a second turn | A turn costs several model calls and may already have written data |
| One submit, one turn | Even when the POST response is lost | Same reason |
| No unconfirmed outward action | Sends, invitations and direct edits wait for a click; never auto-execute on timeout | Text injected into an email can steer the model |
| No invented links | Every clickable reference resolves to a real item the user can open | Model output is untrusted |
| Accessibility | WCAG 2.2 AA; screen readers hear completion, not every token | It's a panel people keep open all day |

**Out of scope:** model serving, the general chat product, a co-editing engine, voice.

> "The known trap is drifting into the agent loop and retrieval, which is the backend round. I'll draw them as boxes and come back to the browser. The other trap is treating the assistant as a chatbot that writes to the app. It isn't. The host app keeps ownership of its data, and the panel is where the user sees, approves and undoes what the assistant proposes."

---

## 🏗️ A — Architecture (~8 min)

### Screen layout

```
┌──────┬───────────────────────────────────────┬────────────────────────────────┐
│ Mail │ < Documents              v13 · Alice  │ Assistant  [Docs]       [+] [x]│
│ Docs │                                       │ Sees "Q3 Offsite Plan" · 1 sel │
│ Cal  │ Q3 Offsite Plan                       ├────────────────────────────────┤
│      │ Introduction                          │     Add a short summary of     │
│      │ p_3 We meet in Lisbon the week of...  │     Dana's thread under intro  │
│      │ ┌─────────────────────────────────┐   │ ✓ search_mail  3 messages      │
│      │ │ Summary of Dana's thread: venue │   │ ✓ get_thread   Offsite budget  │
│      │ │ confirmed, total $48,000, ...   │   │ ✓ insert_text  suggestion p_11 │
│      │ │ ✦ Suggested by the assistant    │   │ Added a 3-sentence summary     │
│      │ │ [Keep] [Undo]                   │   │ under "Introduction" [Budget]  │
│      │ └─────────────────────────────────┘   │ [Re: Offsite] [Venue]          │
│      │ Agenda                                │ 3 model calls · 63% cached     │
│      │ p_4 Day 1: arrivals and dinner        │ What I did                     │
│ Set. │                                       ├────────────────────────────────┤
│ Ops  │                                       │ [Ask about or edit…]   [Stop]  │
└──────┴───────────────────────────────────────┴────────────────────────────────┘
```

The panel belongs to the app shell, not to a route, so it stays mounted while the user moves between apps. The header's context line says exactly what the assistant can see right now (the open doc and selection, the open email, or "acts as you, with your permissions"). That tells the user what goes into each request. The suggestion appears in the document, not in the panel, so the user reviews an edit where the text lives. The empty panel shows suggestion chips per app, which double as a menu of what the assistant can do there.

### Client layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ BROWSER TAB                                                                  │
│  HOST ROUTES (unmount on nav)            APP SHELL (always mounted)          │
│  ┌──────────────────────────────┐        ┌────────────────────────────────┐  │
│  │ /docs/:id · /mail · /calendar│        │ Assistant panel, one slot/app  │  │
│  │ editor · thread · agenda     │        │ TurnView · ActionCard · chips  │  │
│  └───┬─────────────────────▲────┘        └───┬────────────────────────▲───┘  │
│      │ 1 open doc,         │ 8 revision      │ 2 send(app, text)      │ 7    │
│      │   selection, msg    │   bump, refetch │                        │      │
│  ┌───▼─────────────────────┴────┐ 3 context ┌▼────────────────────────┴───┐  │
│  │ Workspace store              │──────────▶│ Assistant store             │  │
│  │ paragraph IDs + outline,     │◀──────────│ turns by ID · event reducer │  │
│  │ selection, open message,     │ 6 client  │ stream map (outside React)  │  │
│  │ revision counter             │   tools   │ answered-call replay guard  │  │
│  └──────────────────────────────┘           └───┬────────────────────▲────┘  │
│                                                 │ 4 POST /turns      │ 5 SSE │
│                                                 │   Idempotency-Key  │ resume│
└─────────────────────────────────────────────────┼────────────────────┼───────┘
                                                  ▼                    │
                                Assistant API · per-turn event log (any instance)
```

**Walking the arrows for one turn:**

1. Host routes publish what only the browser knows into a small workspace store: the open document with its paragraph IDs, the selection as a list of IDs, the open email.
2. The composer calls the store's send action with the app and the text.
3. The store reads the workspace store and builds the client context for this app.
4. It posts the turn with a fresh idempotency key and gets `202` with a turn ID.
5. It follows that turn's event stream. Events go through one reducer into the turn's timeline.
6. When the server asks for a browser tool, the store runs it against the workspace store or the router and posts the result back.
7. Components only read the store. None of them owns a connection.
8. When a write tool succeeds, the store bumps a revision counter, and every open host view refetches.

### The server, in one diagram

```
        ┌───────────────────────── Assistant API ──────────────────────────┐
Panel ─▶│ POST turn · confirm / decline · client tool result · cancel      │
Panel ◀─│ GET events (SSE, Last-Event-ID) ◀── per-turn event log ◀──┐      │
        └─────────────┬─────────────────────────────────────────────┼──────┘
                      │ claim turn (lease)                          │ append
        ┌─────────────▼─────────────────────────────────────────────┴──────┐
        │ Orchestrator: agent loop · budgets · retries · suspend / resume  │◀─▶ Model
        └─────────────┬────────────────────────────────────────────────────┘    gateway
                      │ every tool call
        ┌─────────────▼────────┐   ┌────────────────────┐   ┌──────────────────────┐
        │ Policy engine        │──▶│ Tool service       │──▶│ Host services        │
        │ allow · confirm ·    │   │ OBO token, typed   │   │ mail · docs · cal    │
        │ deny (effect, taint, │   │ tools, idempotency │──▶│ Retrieval index      │
        │ settings)            │   │ key per write      │   │ hybrid, ACL in query │
        └──────────────────────┘   └────────────────────┘   └──────────────────────┘
```

**The loop.** The orchestrator sends the conversation to the model, runs the tools it asks for, adds the results and calls again until the model ends the turn or a budget (steps, tokens, time) runs out. Text deltas are batched every ~40 ms into a per-turn event log. If a model stream dies after text reached the screen, the step is redone and the log carries a `text.discard` for that step first.

**The policy engine.** Every tool declares its effect (read, write, send) and whether it's reversible. Reads and reversible writes (a draft, a tracked suggestion) run. Sends and irreversible edits wait for confirmation. Once the turn has read content the user doesn't control, such as an external email, it is *tainted*, and outside sends get a warning, or are denied if the user's settings say so. This is code the model can't argue with, and it's why the client must render confirmations faithfully.

**Retrieval.** Hybrid keyword and vector search over the user's mail and documents, with the permission filter inside the query, fusion and reranking. Every cited ID is checked against what was retrieved before the answer is final.

**The one property the client depends on.** A turn is a saved state machine on the server, not a held request. Waiting on a confirmation or the browser frees the worker. Any API instance can replay the turn's events from any offset, and can resume it when an answer arrives. So the panel never owns a turn. It follows one.

---

## 💾 D — Data Model (~6 min)

### What the panel sends, and why

| App | Client context | Why only the browser has it |
|-----|----------------|-----------------------------|
| Docs | Doc ID, title, version; selected paragraph IDs; an outline of every paragraph's ID, kind (title, heading, body, bullet) and first 120 characters | The selection is UI state; the open version is what the user is looking at |
| Mail | The open message ID | Decides what "this email" means |
| All | Time zone | "Tomorrow at 3pm" must mean the user's 3pm |

**Follow-up: "Why not send the editor's document, or character offsets?"** Offsets go stale. Collaborators keep typing while the model thinks for 10–20 seconds, so "insert at character 1,842" lands in the wrong place. Stable paragraph IDs (`p_1`, `p_2`, short and counter-based because the model copies them reliably) let the model say "after p_3", and the docs service maps that back. The editor's internal format is large, tied to an editor version, and full of formatting noise that costs tokens. The 120-character outline is a token budget: enough to anchor "under the intro", while `read_document` fetches full text when needed. When the document reloads, the selection is filtered to IDs that still exist, so the context never names a deleted paragraph.

The context sent at submit is a snapshot. If the model needs the *live* selection later in the turn, it asks the browser through the `get_selection` client tool.

### A turn is a timeline, not a message

| Item | Created by | Rendered as |
|------|-----------|-------------|
| Text, per step | `text.delta {step, text}` appends to the last text item of the same step | Markdown, with a blinking caret on the live tail |
| Tool row | `tool.status` → running; `tool.request` → waiting; `tool.result` → done or failed | One compact line: tool name, label, then summary; "(in your browser)" while waiting on a client tool |
| Notice | `notice` (retry, untrusted, budget, loop, compaction, recovered) | One colored line; `untrusted` also sets the turn's taint flag |
| Action | `action.proposed` → pending; `action.resolved` → approved, declined or expired | Confirmation card |
| Footer | `turn.end` | Taint marker, usage (model calls, tokens, % cached), "What I did" |

> "I key text by step because the server can redo a step. When `text.discard {step: 2}` arrives, the reducer drops exactly step 2's partial text and leaves step 1's text and every tool row alone. With one concatenated string, I couldn't tell which characters to remove."

### Where each kind of state lives

| State | Lives in | Survives | Why there |
|-------|----------|----------|-----------|
| Open doc, selection, open message, revision counter | Workspace store, written by host routes | Navigation inside the app; cleared when the view unmounts | The panel reads it at submit; client tools read it mid-turn; host views watch the revision |
| Conversation per app (ID, ordered turn IDs) | Assistant store, one "slot" per app | Navigation; rebuilt from the server on refresh | Each app has its own conversation |
| Turns: status, timeline, citations, usage, taint, last event ID | Assistant store, one map keyed by turn ID | Navigation and closing the panel; a refresh rebuilds it by replay | A turn outlives every view that shows it |
| Open streams | Module-level map from turn ID to an abort function, outside React | Same | Exactly one connection per turn |
| Client calls already answered | Module-level set of call IDs | Tab lifetime | The replay guard (deep dive 2) |
| Turn history, steps, pending actions, drafts, suggestions | Server (PostgreSQL) | Everything | Source of truth |
| Composer text, "What I did" toggle | Component state | Nothing | Nobody else needs it |

### Turn lifecycle on the client

```
 send ─▶ 202 ─▶ running ─┬─▶ waiting_client ──(browser posts result)──▶ running
                         ├─▶ waiting_confirmation ──(approve / decline)──▶ running
                         │            └──(expires after 10 min)──▶ completed, nothing done
                         └─▶ completed | failed | cancelled          (turn.end)

 Composer: [Stop] in any of the three active states, [Send] otherwise
 Rule: only the stream writes a live turn; a REST copy never overwrites it
```

---

## 🔌 I — Interface Definition (~4 min)

```
POST /api/v1/assistant/turns                 Idempotency-Key → 202 { turn } | 200 replayed
GET  /api/v1/assistant/turns/:id/events      SSE; Last-Event-ID resumes
GET  /api/v1/assistant/turns/:id/steps       "What I did"
POST /api/v1/assistant/turns/:id/tool-results  { callId, output | error }
POST /api/v1/assistant/turns/:id/cancel
POST /api/v1/assistant/actions/:id/confirm   POST /api/v1/assistant/actions/:id/decline
GET  /api/v1/assistant/conversations/current?app=docs   → conversation + turns
POST /api/v1/assistant/quick                 { action: summarize_thread, messageId }
POST /api/v1/docs/:id/paragraphs/:pid/accept | reject    Keep / Undo
GET|PUT /api/v1/settings
```

### What the UI branches on

| Signal | Client behavior |
|--------|-----------------|
| `202`, or `200` replayed | Follow the returned turn; both mean "this is your turn" |
| `409 TURN_IN_PROGRESS` + turn ID | "Still working on your last request", and attach to that turn instead of starting another |
| `422 IDEMPOTENCY_KEY_REUSED` | A client bug (same key, different body); surfaced, never retried |
| Stream `401` / `404` | Stop following; no reconnect loop |
| Confirm sent twice | Same decision is a no-op `202`; a different one is `409` |
| Tool result after the turn stopped waiting | No-op on the server |
| Docs save `409 VERSION_CONFLICT` | Reload the document rather than overwrite |
| Template `404` | The user isn't on that thread; show the error inline |

### The event stream

| Event | What the reducer does |
|-------|-----------------------|
| `turn.status` | Set status (running, waiting_client, waiting_confirmation) |
| `text.delta` | Append to the current step's text item, or start one |
| `text.discard` | Remove that step's text items |
| `tool.status` / `tool.request` / `tool.result` | Add or update the tool row by call ID; a request also triggers the client tool |
| `action.proposed` / `action.resolved` | Add the card / set its outcome |
| `notice` | Add a notice row; `untrusted` sets taint |
| `turn.end` | Final text, verified citations, usage; any card still pending becomes expired |
| `snapshot` | Replace the turn with the server's copy (live log expired) |

Every event's SSE `id` is its position in the turn's log, and that id is the resume cursor.

---

## 🔧 O — Optimizations and Deep Dives (~20 min)

> "Three decisions carry this design: who owns a turn's stream, how the UI renders the moments a turn waits for the browser or the user, and how the assistant's edits reach the document. Each has an obvious alternative that breaks in a specific way."

### Deep dive 1: A turn belongs to the store, not to the panel (~7 min)

**Decision.** Every turn the tab knows about lives in one Zustand store, in a map keyed by turn ID. Each app has a slot holding its conversation ID and the ordered list of its turn IDs. Streams sit in a module-level map from turn ID to abort function, outside React. Streams are read with `fetch` and a `ReadableStream`, through a small SSE parser, with the client holding the `Last-Event-ID` cursor.

**Why it works here.** A user asks Docs for a summary and clicks over to Mail while it runs. The panel re-renders for the Mail slot, but nothing aborts the Docs stream. Its events keep reducing into `turns[docsTurn]`, which only the Docs slot lists, so Docs text can't appear in the Mail conversation. When the turn ends, the answer is in the Docs conversation whichever app is on screen, and returning to Docs renders it with no fetch. Closing the panel unmounts it, and the stream keeps running there too. Following is idempotent: if a turn is already followed, a second follow does nothing, so a history load, a submit and a 409 can all call it safely.

Resume is a read, never a re-submit. The reader keeps the id of the last event it applied. On a drop it waits 0.5, 1, 2, 4, then 8 seconds (reset when a message arrives) and reconnects with `Last-Event-ID`. Whichever API instance answers replays exactly the events after that id. A replay can deliver many events in one chunk, and they're reduced as one batch.

```
log ids  1 status · 2 tool.status · 3 tool.result · 4 delta(step 2) · 5 delta(step 2)
conn A   ◀──────────── reads 1..5 ────────────▶ ✕ Wi-Fi drop, cursor = 5
server   step 2's model stream dies → 6 text.discard{step 2} · 7 delta(step 2) … 12 turn.end
conn B   GET …/events  Last-Event-ID: 5   ◀──── 6 discard · 7 … 12 ────▶
store    step-2 text dropped at 6 and rebuilt from 7; tool rows and step-1 text untouched
refresh  no cursor → replay 1 … 12 into an empty timeline, then live
```

Submitting is protected the same way. The composer mints one idempotency key per submit, and a retry after a lost response reuses it, so the server returns the same turn. If a turn is already active in this conversation (another tab, a double submit), the server answers `409` with that turn's ID. The client fetches the turn if it doesn't know it, adds it to the slot, and follows it. On a refresh, the panel loads the app's current conversation: finished turns are rendered from the REST copy, and active turns start empty and are rebuilt by replay. A history load never overwrites a turn this tab is already streaming, because the live copy is newer.

**Why the alternatives break.**

- *Stream owned by the panel component (an effect that opens the fetch).* Switching apps changes the panel's app prop and closing the panel unmounts it. Either way the effect's cleanup aborts the fetch. The turn keeps running on the server, but the client loses it: no answer when the user returns, and a confirmation card that never appears because nobody is listening.
- *One messages array for "the current conversation".* A delta that arrives after the switch is appended to whatever is on screen, so Docs text appears in the Mail conversation. This is the classic bug, and keying by turn ID removes it structurally.
- *Re-POST on reconnect.* That's a new turn, so new model calls and a different answer. Worse, the server's exactly-once protection for writes is keyed by turn ID plus tool call ID. A new turn has new keys, so the same request can create a second draft or a second suggestion.
- *EventSource.* It can't start from a cursor the page already holds, hides the HTTP status (signed out and server restarting look the same), and retries on a fixed interval, so a deploy makes every client reconnect at once.

| Approach | Survives app switch | Connections per turn | Duplicate writes on reconnect | Cost |
|----------|--------------------|----------------------|-------------------------------|------|
| ✅ Store keyed by turn ID, streams outside React, cursor resume | Yes | Exactly one | Never | Explicit lifecycle, own SSE parser |
| ❌ Component-owned stream | No | One per viewer | No, but turns are lost | Lost answers and cards |
| ❌ Array for the visible conversation | Corrupts | One | No | Text lands in the wrong app |
| ❌ Re-POST on reconnect | Yes | One | Yes | Double model cost, duplicate drafts |

**What I give up.** Global state now has a lifecycle: logout must abort every stream, and finished turns that aren't in any visible slot need eviction. A turn has two sources, the stream and REST loads, so I need the "live copy wins" rule. And each active turn holds an HTTP connection. With one active turn per conversation and three apps, that's up to three streams per tab. Under HTTP/1.1 the browser allows six connections per origin across all tabs, so two tabs could starve the confirm POST. Production serves streams over HTTP/2.

### Deep dive 2: Client tools and confirmations are suspension points the UI must render (~7 min)

**Decision.** A turn can stop and wait on the browser for two reasons: the server needs something only the browser has (a client tool), or it needs the user's permission (a confirmation). Both are server states (`waiting_client`, `waiting_confirmation`), both arrive as events, and both are answered with one REST call. The UI renders server state and sends back exactly one answer. It never decides on the server's behalf.

**Client tools.** There are two. `get_selection` returns the selected paragraphs (ID, kind, text) and the doc version from the workspace store. `open_item` navigates the router to a message, doc, event or draft. When `tool.request` arrives, the row changes to "Reading your selection (in your browser)". The store runs the tool and posts the result, and the server resumes the turn on whichever instance receives it. Errors are written as instructions for the model ("No document is open in the editor. Ask the user to open one."). If the browser never answers, the call fails after 30 seconds with "the browser didn't respond", and the turn continues.

**The replay guard.** Replays are where this goes wrong. After a reconnect or a refresh, the log replays `tool.request` events for calls answered long ago. A naive client would run `open_item` again and yank the user to another page, or post a second result. The guard has two parts. First, the whole replay batch is reduced before any tool runs, and only calls whose row is still *waiting* afterwards are answered. If the `tool.result` was in the same batch, the call is already done. Second, a module-level set records answered call IDs, so a call is answered once per tab. If the POST fails, the ID is removed so a retry can answer it. The server also accepts a result only while the turn waits on that call, so a duplicate is a no-op there too.

**Confirmations.** A card shows a full preview built by the server *from the tool's arguments*, not from the model's prose. For an email that's To, Subject and body. For an event it's the date, time, duration, time zone and attendees. For an edit it's the text and whether it's a tracked suggestion or a direct edit. The card also shows the policy's reason. The buttons name the action ("Send", "Create & invite", "Apply edit"), and Decline has equal weight. A click puts the card in a submitting state, which shows the intent, not the outcome. The outcome arrives as `action.resolved`. When `turn.end` arrives, any card still pending becomes "Expired", and nothing ever auto-executes on a timeout. If the turn is tainted, the card turns amber and says: the assistant read content from outside your organization in this conversation, make sure you asked for this. The "Read content from outside your control" notice appears in the timeline when the taint happens, not only on the card.

**Follow-up: "The assistant wants to change data in the host app. Who performs the change, and what does the user confirm?"** The host performs it, on the server. The tool service calls the host's own services with an on-behalf-of token for this user, so the host's permission checks apply and the write carries an idempotency key. The browser never writes host state for the model. Its tools only read or navigate. The user confirms the exact arguments that will execute, shown from the app's own rendering of those arguments. After the click, the server records the decision, claims the turn and runs the call.

**Why the alternatives break.**

- *Confirm by typing "yes" to the model.* The answer goes back through the model, which is the component a prompt injection may have steered. Nothing binds the "yes" to the arguments: the model could describe one email and send another. There's also no durable decision for the audit trail.
- *The model returns a command and the browser executes it after a click.* Now the client is where policy and exactly-once live. A double click, or a retry after a lost response, sends twice. The server never reliably learns the outcome, so the turn can't resume on another instance, and the trace has a hole.
- *Run client tools as they arrive, with no guard.* Correct on a fresh stream, wrong on every replay: unexpected navigation and duplicate results.
- *Confirm everything.* Every draft and suggestion asks for approval, people start approving without reading, and the card stops protecting anything. Reversible actions run, and "confirm every change" is a setting for users who want it.

| Approach | Bound to exact arguments | Survives refresh | Injection-resistant | Friction |
|----------|-------------------------|------------------|---------------------|----------|
| ✅ Server state + card preview from arguments + one REST answer | Yes | Yes (replayed) | Yes | One click for outward actions |
| ❌ "Yes" in chat | No | Yes | No | Low |
| ❌ Browser executes model commands | Partly | No | Partly | Low |
| ❌ Confirm everything | Yes | Yes | Yes | High; leads to rubber-stamping |

**What I give up.** A pause can last minutes, so the timeline must show "waiting for you" across refreshes and app switches, and Stop must stay available while waiting. Every tool with a card needs a preview shape the UI knows how to render. A new tool isn't done until its preview is.

### Deep dive 3: Edits as tracked suggestions, and who applies them (~6 min)

**Decision.** Assistant document edits are tracked suggestions by default, addressed by paragraph ID and applied on the server by the docs service, with Keep and Undo shown in the document. After any successful write tool result, the panel bumps the workspace revision, and open host views refetch.

**Why it works here.** A tracked suggestion is reversible, so the policy engine lets it run without a confirmation card, and the flow stays fast. Review happens in place. An insert is a green underlined paragraph labeled "Suggested by the assistant". A rewrite shows the old text struck through in red next to the new text in green. Keep applies it and Undo removes it, and each is recorded as `edit_kept` or `edit_undone`. That gives a live quality signal: offline evals say whether the assistant *can* do a task, and this says whether people wanted what it did. Viewers don't get the buttons. Double-click editing is disabled on a paragraph with a pending suggestion, and the user's own saves send a base version, so a `409 VERSION_CONFLICT` (the assistant changed the doc meanwhile) reloads the document instead of overwriting it.

The revision bump is how host views stay true. The store knows which tools write (insert and replace text, create and send draft, create event). When one succeeds, it bumps a counter that the editor, mail list, thread view and calendar all depend on. A draft created from a Docs turn shows up in the Drafts list with an "Assistant" chip, and a suggestion appears without a reload. A citation to a paragraph opens the doc scrolled to that paragraph, with a brief highlight.

**Why the alternatives break.**

- *Direct overwrite.* It isn't reversible, so policy must confirm every edit. Either every "tighten this paragraph" costs a click, or edits run unconfirmed and the user's only recovery is to spot the change and retype it. It also loses the kept-versus-undone signal.
- *Character offsets.* They go stale while anyone types, as covered in the data model.
- *Client-applied editor commands.* This is the right answer once the editor has real-time co-editing, and it's the main thing I'd change. The orchestrator sends edits down as client tool requests, and the editor applies them the way a toolbar button would. They go through the operational-transform or CRDT layer, sync to collaborators and land on the user's own undo stack, so Ctrl+Z works. The result is posted back like any client tool. I didn't build it this way because this editor has no co-editing engine. Server-side suggestions with a version check keep the undo property through Keep and Undo instead.

| Approach | Needs confirmation | Undo | Works with co-editing | Quality signal |
|----------|--------------------|------|-----------------------|----------------|
| ✅ Server-applied tracked suggestion by paragraph ID | No | Keep / Undo | Needs a version check | Yes |
| ❌ Direct overwrite | Yes, every edit | None | Conflicts | No |
| ❌ Character offsets | — | — | Breaks on concurrent typing | — |
| ✅ (with co-editing) Client-applied commands | No if tracked | Ctrl+Z | Native | Yes |

**What I give up.** Suggestions clutter the document until someone decides. The revision bump is coarse: one write refetches every open view, which is fine for three apps but wasteful at scale, where I'd invalidate by resource instead. Ctrl+Z doesn't undo a server-applied suggestion; the Undo button does. With client-applied commands, an edit can't complete if the tab closes mid-turn: the call times out after 30 seconds and the model reports that it couldn't apply it.

### Rendering untrusted output, and citations from the app's own data

The model's text is untrusted. A model fooled by an injected email can write a link with a friendly label that points somewhere hostile. So the renderer is a small markdown subset (paragraphs, bulleted and numbered lists, headings, bold, inline code) that builds React elements directly. There's no HTML parsing and no raw-HTML path at all. Markdown links render as plain text and images aren't supported. Half-finished syntax while streaming, like an unclosed `**`, shows as text until it closes, so a stream never produces broken markup.

The only clickable things in an answer are citations. The model cites IDs such as `[m_off1]` or `[doc_offsite#p_8]`. At turn end the server checks each one against the items retrieved in this conversation and returns a record from the app's own data: kind, title, subtitle and an in-app href. The chip renders that record (icon, title, tooltip) and navigates through the router. While the turn streams, IDs show as neutral monospace chips because they aren't verified yet. After the end, an ID the tools never returned is struck through, with the tooltip "The assistant cited something it never retrieved". Using an off-the-shelf markdown library plus a sanitizer would also work. But its allowlist is a large surface, and I'd still need a rule for which links may render, so links would still come only from verified IDs.

### Template actions are not the agent

"Summarize thread" is a button above an email, not a panel prompt. It calls the quick endpoint: one fixed prompt, the thread loaded with the user's permissions, one model call and no tools. The summary renders inline in the thread with the same markdown and citation renderer, labeled "one model call, no tools · 1.2 s". It creates no turn and never touches the panel conversation. The UI rule: fixed jobs get buttons, open-ended requests go to the panel. A template is cheaper, faster and predictable, and because it has no tools it never needs a confirmation.

### Settings change what the server offers, not what the UI hides

The settings page has toggles: let the assistant send email, let it edit documents, confirm every change, block outside sends after reading outside content, and search before asking the model. A slider sets the step limit (1–30 model calls). Each control explains its effect in plain words: when sending is off, "the send tool is not offered to the model at all, so it cannot even try". The policy engine and the tool list read these on every request. A setting that only hid a button in the client would do nothing, because the model never clicks buttons.

### Accessibility and scroll

- **Scroll follows the stream only while the reader is at the bottom** (within 40 px). If they scroll up to read, they keep their place. I'd add a "Jump to latest" button.
- **The streaming text is not a live region**, or a screen reader would talk over itself every 40 ms. A separate polite region announces "The assistant finished answering". A confirmation card needs its own announcement ("The assistant needs your approval to send an email") because the turn is blocked on the user.
- **Keyboard.** Enter sends and Shift+Enter adds a line. The composer is labeled, and Stop replaces Send while a turn is active, with an accessible name. Card buttons name the action rather than saying "OK".
- **Not color alone.** The taint warning is text plus an icon, tool rows have words next to their icons, and an expired card says "Expired". The blinking caret should respect reduced-motion preferences.

### Rendering performance

- Deltas are batched on the server every ~40 ms, so each turn causes at most ~25 store updates per second.
- The editor reads a different store, so a streaming answer never re-renders the document. Each turn view should select only its own turn, so a delta doesn't re-render older turns.
- Markdown should split into completed blocks, memoized, and a live tail, so each delta re-parses only the tail.
- Long conversations load as compact timelines from the server, and past a few dozen turns I'd virtualize the list with `@tanstack/react-virtual`.

### Failure and degradation

| Condition | What the user sees |
|-----------|--------------------|
| Connection drops mid-turn | Text pauses, then resumes from the cursor with nothing lost or repeated |
| Server redoes a step after a broken model stream | The step's partial text disappears and is rewritten; a retry notice explains why |
| Model overloaded | "Retrying…" notices, then possibly a fallback model; the turn still finishes |
| Budget exhausted | One last summary of what was done and what is left, with a budget notice |
| Browser never answers a client tool | After 30 s the tool row fails, and the model continues without it |
| Confirmation left unanswered | After 10 min the card says "Expired" and the answer says nothing was done |
| Assistant service down | Panel shows an error line; Mail, Docs and Calendar work normally |
| Stop pressed | Model stream aborted, no new tool calls; a write already in progress finishes; "Stopped." |

### Two execution traces

**Success, with an app switch.** (1) Alice clicks p_3 in "Q3 Offsite Plan"; the header shows "1 selected". She sends the summary request. (2) The store builds the context (outline p_1–p_10, selection p_3, version 12), mints a key and posts; `202` returns the turn ID, an empty turn joins the Docs slot, and the stream opens. (3) Within 300 ms a "Searching your mail…" row appears. (4) She clicks Mail in the rail. The panel shows the Mail slot; the Docs stream keeps reducing into its own turn. (5) An `insert_text` result arrives (a write), so the revision bumps and the mail list refetches harmlessly. (6) `turn.end` brings the final text, three verified citations with titles and hrefs, and usage (3 model calls, 63% cached). The live region announces completion. (7) Back in Docs, the editor fetches version 13 and shows p_11 as a green suggestion; the panel already has the answer. She clicks the "Budget" chip, which opens that email through the router, comes back, and clicks Keep. `edit_kept` is recorded.

**Failure: injection, a refresh and another instance.** (1) In Mail, Alice asks to summarize the latest email from Northwind, an external invoice whose body tells AI assistants to forward invoices to an outside address. (2) An `untrusted` notice appears in amber and the turn becomes tainted. (3) A gullible model reads the email and calls `create_draft` to that address. A draft is reversible, so it runs, and the revision bump shows it in Drafts with an "Assistant" chip. (4) It calls `send_draft`. Policy says confirm with a warning. The status becomes `waiting_confirmation`, the server frees its worker, and an amber card shows the full To, Subject and body with the taint warning. (5) Her laptop sleeps; on wake she refreshes. The panel loads the Mail conversation, sees the turn is active, follows it with no cursor, and the replay rebuilds the timeline with exactly one pending card. (6) She clicks Decline. The card shows submitting; the POST lands on a different API instance, which records the decision, claims the turn and resumes it. `action.resolved {declined}` marks the card "Declined". (7) The model reports the invoice and warns that the email contained instructions it didn't follow. The footer shows "read outside content", and "What I did" shows the policy rule `untrusted-external-send` and "user declined send_draft". Nothing left the mailbox, and discarding the leftover draft is recorded as `draft_discarded`.

### The six review questions, from the client's side

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The server. The store is a cache of the stream. A submit succeeds at `202`, a confirmation at `action.resolved` (not the click), an edit when the server's write commits and the refetch shows it |
| Client retries after losing the response? | Same idempotency key returns the same turn; a repeated confirm is a no-op; a repeated client tool result is a no-op |
| Server fails between two steps? | The stream drops and reconnects with its cursor to any instance; another instance takes over the lease and resumes; a redone step arrives as discard then fresh text |
| Which ordering is required? | Events in log order within a turn; text per step; one active turn per conversation (`409` attaches). No ordering across turns or users |
| Access with caches, indexes, async work? | The client filters nothing. Citations are server records verified against retrieved items, `open_item` only navigates and the host route re-checks access, and settings are enforced server-side |
| What breaks first? | Connections per origin, then long-conversation DOM and markdown re-parsing. Evidence: open-stream gauges and long-task timings while streaming |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Live turn state | Store keyed by turn ID, slots per app | Component state / one visible array | Turns outlive views; no cross-app text |
| Stream ownership | Module map outside React | Effect in the panel | One connection per turn; survives close and switch |
| Transport | fetch + SSE parser, Last-Event-ID | EventSource / WebSocket | Explicit cursor, status codes, cookie auth, one-way data |
| Reconnect | Re-read from cursor | Re-POST | No second turn, no duplicate writes |
| Redone steps | Text keyed by step, `text.discard` | One string per turn | Remove exactly the redone text |
| Document context | Outline with stable paragraph IDs | Editor model / char offsets | Robust to concurrent typing; cheap in tokens |
| Client tools | Run once after the replay batch, answered-ID set | Run on every request event | Replays never re-navigate or double-answer |
| Confirmation | Card from tool arguments, one REST answer | "Yes" in chat / browser executes | Bound to exact arguments; injection can't approve |
| Doc edits | Tracked suggestions, Keep/Undo | Direct overwrite | Reversible without a card; live quality signal |
| Host refresh | Revision bump after write results | Manual reload | Views stay true; coarse but simple |
| Output rendering | Markdown subset to React elements | HTML + sanitizer | No HTML path; links only from verified IDs |
| Fixed jobs | Template button, one call | Route through the agent | Cheaper, faster, predictable |

---

## 📈 What Breaks First, and What I'd Do Next (~2 min)

**What breaks first at scale.**

- **Connections.** One SSE stream per active turn per tab. HTTP/2 is mandatory. With many tabs, a BroadcastChannel with one leader tab owning the streams would dedupe connections and announcements. On the server, one blocking reader per open stream becomes a connection-count problem; one multiplexed reader per instance fixes it.
- **Long conversations.** The turns map only grows and every turn is in the DOM. I'd evict finished turns outside the visible slot, page older turns from the server, and virtualize.
- **Streaming cost on the main thread.** Re-parsing a long answer on every delta shows up as long tasks. Memoized blocks plus a live tail, and one commit per animation frame if several turns stream at once.
- **Coarse refresh.** The revision bump refetches every open view on any write. With more apps I'd make write results carry the resource they changed and invalidate only that.

**With more time:** client-applied commands for a co-editing editor; a "Jump to latest" control; announcing pending confirmations; showing the connection state ("Reconnecting…") on the active turn; and real-user monitoring of first-event latency and token-to-paint.

---

## 📝 Wrap-up

> "To summarize: the panel sends what only the browser knows, as stable IDs rather than offsets. A turn is a timeline owned by a store keyed by turn ID, with streams outside React that resume by cursor and never by re-submitting. The two moments a turn waits on the browser, client tools and confirmations, are server states the UI renders and answers exactly once, with a replay guard and cards built from the real arguments. The host app performs every change through its own APIs, edits arrive as suggestions the user keeps or undoes, and model output can't produce a link to anything the tools didn't return. The hardest calls were keeping execution off the client, accepting a confirmation click on every outward action, and choosing server-side suggestions over client-applied commands because this editor has no co-editing engine."

### How the local implementation compares

The repo's `frontend/` implements this design. The assistant store keeps turns keyed by ID with one slot per app, streams sit in a map outside React, and the reducer handles every event above, including `text.discard` by step. The fetch-based reader resumes from `Last-Event-ID` with 0.5–8 s backoff and stops on `401`/`404`. Client tools answer once, after the replay batch, guarded by an answered-ID set. Confirmation cards render server previews with the taint warning. The markdown renderer builds React elements only and links verified citations. Paragraphs show tracked suggestions with Keep and Undo, a revision counter refreshes host views, "Summarize thread" is a single-call template, and the panel follows the scroll only at the bottom and announces completion. Gaps relative to this answer:

- The panel subscribes to the whole turns map rather than per-turn slices, so every delta re-renders the visible conversation.
- Markdown re-parses the full text on each delta instead of only the last block, and updates aren't coalesced per animation frame.
- There's no "Jump to latest" control when the reader has scrolled up.

Writing this answer against the code found two real defects, since fixed: a refresh mid-turn seeded the timeline from the REST copy and then replayed the stream from the start, so rows and the confirmation card appeared twice (active turns now start empty and the replay rebuilds them); and a `409` attached to a turn the tab hadn't loaded, so its events were dropped (the tab now fetches the turn first). The submit now retries a lost POST once with the same key, the panel shows when it is reconnecting, pending confirmations are announced, and the caret respects reduced motion.
