# Prompt Playground — System Design Answer (Frontend Focus)

*Senior frontend / product engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations*

> "A prompt playground looks like a textarea, a Run button and an output pane. The model API already exists, so I won't spend this interview on GPUs, batching or inference servers. The product around the call is where the difficulty is. A run lasts 5 to 60 seconds, which is longer than a developer stays on one page. Drafts have to survive a refresh without turning into versions. A result has to point at the exact text that produced it while the editor keeps changing. And the shared objects, saved versions and presets, must never be silently overwritten. Most of those are client-state questions, so that's where I'll spend the time."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | The developer's workflow, numeric targets, the trap I'm avoiding |
| A — Architecture | ~7 min | Screen layout, client layers, the one server decision the client depends on |
| D — Data model | ~6 min | Entities, the three kinds of client state, the URL as state |
| I — Interface | ~5 min | Endpoints, event stream, the error codes the UI branches on |
| O — Optimizations | ~20 min | Three deep dives, plus idempotency, comparisons, rendering and accessibility |
| Wrap-up | ~2 min | Trade-offs, what breaks first, what I'd do next |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Who uses it, alone or in teams? | Shared objects need concurrency control | Developers in a workspace; versions and presets are shared |
| Do two people type in the same prompt at once? | Real-time co-editing means CRDTs and presence | No. Drafts are personal until saved |
| How long is a run? | Decides whether a run can live inside one page view | 5–60 s, streamed token by token |
| How many runs at once? | Concurrent streams and connection budget | Several; comparisons of 2–3 configs; at most 6 active per user |
| Must results be reproducible? | Runs must pin their inputs | Yes: exact text, variable values and config |
| What can be shared? | Read-only views and revocation | A saved version or a finished run, via a revocable link that can be copied into another workspace |
| Devices? | Layout density, shortcuts | Desktop browsers, keyboard-heavy users; the share page also works on mobile |

### The developer's workflow, in order

1. Open a prompt from the workspace library (search by title, see each prompt's last run).
2. Edit the system message and the user template. Every `{{placeholder}}` gets its own input field.
3. Pick a model, temperature, top-p and max tokens, or apply a workspace preset.
4. Run with the button or Cmd/Ctrl+Enter. Output streams in; the footer fills in tokens, time to first token (TTFT) and total time.
5. Tweak and run again. Click "Compare with another config" to run two or three configs side by side.
6. Stop a run that is going wrong, and keep what it produced so far.
7. Browse the history: every run with the exact text, variables and config it used.
8. Save a version with a message once it's good; share a link to that version or to a finished run.
9. Meanwhile, switch to another prompt while a long run finishes, and get told when it does.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| Typing | Every keystroke paints within a frame; the editor never waits on the network | It's an editor first; streaming must not steal its frames |
| Token to screen | ≤ 100 ms p95 from the model emitting a token to it being painted | The server batches deltas every 50 ms; the client has to keep up |
| Resume | A dropped connection or a refresh loses no tokens, duplicates none, and never starts a second generation | Tokens cost money and sampling makes a second answer different |
| One click, one run | Even when the POST response is lost | Same reason |
| No silent overwrite | Saves and preset edits | A teammate's change disappearing is the one outcome we can't allow |
| No silent loss | Every run visibly ends completed, cancelled or failed | A spinner that never resolves destroys trust |
| Accessibility | WCAG 2.2 AA, fully keyboard operable | Developer tools are used for hours a day |

**Out of scope:** model serving, billing, evaluation datasets, real-time co-editing.

> "The known trap for this question is drifting into inference infrastructure. I'll treat the model API as a black box that streams tokens and can be slow, return 429, or die mid-stream. On the server I'll name one decision, that runs are owned by background executors rather than by the HTTP request, because the whole client design depends on it. Then I'll come back to the browser."

---

## 🏗️ A — Architecture (~7 min)

### Screen layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Header: Prompts · Presets · Admin                    [ 2 running ▾ ]  Alice  │
├──────────────────────────────────────────────────────────────────────────────┤
│ < Support triage  v3 saved 5m ago by Bob   [Load version ▾] ● Unsaved [Save] │
├──────────────────────────────────────────────────────────────────────────────┤
│ (!) Bob saved v4 after you started editing  [Load v4, discard] [Keep mine]   │
├────────────────────────┬────────────────────────────────┬────────────────────┤
│ SYSTEM                 │ ┌─ A sim-fast · v3 ─┐┌─ B ───┐ │ CONFIG A           │
│ ┌────────────────────┐ │ │ streamed text ▌   ││ ...   │ │ model ▾  preset ▾  │
│ └────────────────────┘ │ │          [Stop]   ││       │ │ temp ──●── 0.70    │
│ USER MESSAGE           │ │ in/out · TTFT · s ││       │ │ CONFIG B  ...      │
│ ┌────────────────────┐ │ └───────────────────┘└───────┘ │ [+ Compare]        │
│ │ Ticket: {{ticket}} │ │ HISTORY                        │                    │
│ └────────────────────┘ │ ●● sim-fast vs sim-quality v3  │ [▶ Run 2 side by   │
│ VARIABLES              │ ●  sim-fast · Draft · now v4   │     side  Cmd+↵]   │
│ ticket [............]  │ [Load older runs]              │                    │
└────────────────────────┴────────────────────────────────┴────────────────────┘
                                     Toasts: "Run on Refund FAQ finished · View"
```

Three columns, because a developer's eyes move left to right through the loop: write, read, adjust. The output sits above the history, so the latest result is never below the fold. The version bar is pinned at the top: it answers "what am I editing, and is it saved?" at all times. The conflict banner only appears when it's needed, between the bar and the editor, so it's visible before the user clicks Save.

### Client layers

```
┌────────────────────────────────────────────────────────────────────────────┐
│ BROWSER TAB                                                                │
│  ROUTES (unmount on navigation)           APP SHELL (always mounted)       │
│  ┌────────────────────────────────────┐   ┌─────────────────────────────┐  │
│  │ /prompts/:id?run=                  │   │ header: active-runs chip    │  │
│  │ editor · config · output · history │   │ toasts: "finished · View"   │  │
│  └───┬────────────┬─────────────────▲─┘   └───────────────▲─────────────┘  │
│      │ 1 edits    │ 2 Run           │ 7 read by id        │ 6 end event    │
│  ┌───▼──────┐ ┌───▼───────────┐ 3 ┌─┴─────────────────────┴─────────────┐  │
│  │ Draft    │ │ Run launcher  │──▶│ Runs store (app-level)              │  │
│  │ store    │ │ key per click │   │ runs by id · stream registry        │  │
│  │ persisted│ │ same-key retry│   │ forward-only status merge           │  │
│  └───┬──────┘ └───────┬───────┘   └───────────────────▲─────────────────┘  │
│      │                │                               │ 5 status·delta·end │
│  ┌───▼─────────┐      │                     ┌─────────┴─────────┐          │
│  │ localStorage│      │                     │ Run stream reader │          │
│  │ per prompt  │      │                     │ fetch SSE · cursor│          │
│  └─────────────┘      │                     │ backoff · abort   │          │
│                       │                     └─────────▲─────────┘          │
└───────────────────────┼───────────────────────────────┼────────────────────┘
  3 POST /runs          │      4 GET /runs/:id/events   │
    Idempotency-Key     ▼               Last-Event-ID   │
┌───────────────────────────────────────────────────────┴────────────────────┐
│ SERVER: API · stream service · run executors · existing model API          │
└────────────────────────────────────────────────────────────────────────────┘
```

**Walking the arrows for one run:**

1. Keystrokes update the draft store. It persists to localStorage synchronously; nothing goes to the network.
2. Run hands the current draft to the launcher, which mints one idempotency key per run.
3. The launcher sends `POST /runs`. The server returns `202` with a queued run, and the launcher registers it with the runs store.
4. The store asks the stream reader to follow that run ID.
5. Status, delta and end events flow into the store.
6. On `end`, the store checks which prompt is on screen. If it's a different one, the shell shows a toast.
7. Components only read the store. They never own a connection.

### The one server decision the client depends on

The API never streams model output inside the request that created the run. `POST /runs` records the run in PostgreSQL and enqueues it. A separate executor claims it with a 15-second lease renewed every 5 seconds, calls the model, and appends batched deltas to a per-run event log in Valkey. It records exactly one final outcome, fenced by an attempt counter. A sweeper fails runs whose lease expired (`EXECUTOR_LOST`, partial output kept) and runs that waited five minutes for an executor (`QUEUE_TIMEOUT`). I'm stopping there on the backend. For the client, this means three things: closing a tab never kills a run, any API instance can replay a run from any offset, and every run ends visibly.

---

## 💾 D — Data Model (~6 min)

### Entities as the client sees them

| Entity | What it is | Key fields the UI uses | Mutable? |
|--------|-----------|------------------------|----------|
| Prompt | The mutable head | title, description, headVersion | Title yes (last write wins); head only moves forward |
| Snapshot | One exact system + template pair, content-addressed | snapshotId, text, variable names | Never |
| Version | A numbered label on a snapshot, with a message | version, message, author, time | Never; append-only |
| Run | One execution, pinned to a snapshot plus a copied config | status, output, outputTruncated, usage, errorCode, version or null, savedVersion, comparisonId | Only forward through its lifecycle |
| Comparison | N runs that share a comparisonId | The id itself | — |
| Preset | A shared, named model config | config, revision, updatedBy | Yes, guarded by revision |
| Share | A token naming one version or one finished run | token, kind, revoked | Revocable only |

**Follow-up: "A developer edits the prompt while its previous version is still running. Which text belongs to the result?"** The run's snapshot, fixed when the run was created. The run sends the draft's text in the POST body; the server hashes it and pins the snapshot. The output card labels each run with *its own* text identity: "v3", "Draft", or "Draft · now v4" if that exact text was saved later. The editor's current state is never used to label a result. The run also carries its rendered input and config, so the history can show exactly what ran.

### Three kinds of client state, and why each lives where it does

| State | Lives in | Survives | Why there |
|-------|----------|----------|-----------|
| Draft: system, template, variable values, 1–3 configs, **baseVersion** | localStorage, one entry per prompt | Refresh, navigation, browser restart | Private until saved; zero server writes per keystroke; synchronous read so the editor renders instantly |
| Server data: prompt head, version list, history pages, presets, model catalog | Fetched; small Zustand catalog for models and presets | Refetched at known moments | Shared with the workspace; PostgreSQL is the source of truth |
| Live runs: status, streamed output, connection state | App-level Zustand store, with stream readers in a registry outside React | Navigation (not a refresh, which rebuilds it) | A run outlives the page that started it |
| Selection: which run or comparison is shown | URL search param `?run=` | Refresh, copy-paste, back button | A result is addressable |
| Ephemeral UI: save-message input, open dialogs | Component state | Nothing | Nobody else needs it |

> "The test I apply: who else needs this, and how long must it outlive the component that shows it? A draft is needed by nobody else but must outlive everything, so it goes in local persistence. A live run is needed across routes but only for minutes, so it goes in an app store. Versions are needed by teammates, so they go on the server."

**The URL as state.** `/prompts/:id?run=<runId or comparisonId>` selects what the output pane shows. Clicking a history row, finishing a launch, and clicking "View" in a toast all just navigate. On a deep link, the output pane resolves the id: if the run isn't in the store, it fetches `GET /runs/:id`; if that run has a comparisonId, it fetches the whole comparison; if the id isn't a run, it tries it as a comparison id. Then it hands each run to the store's follow action. Finished runs are only stored, and in-flight runs are streamed. One code path serves history clicks, toasts, the back button and pasted links.

### Run lifecycle on the client

```
         202 from POST     status: running              ┌──────────────────────────┐
 (Run) ───────────▶ queued ──────────▶ running ── end ─▶│ completed                │
                      │                                 │ cancelled (partial kept) │
                      └──────────── end ───────────────▶│ failed (partial kept)    │
                        (cancel or timeout)             └──────────────────────────┘
 stage:               0                1                  2

 Rule 1: while a stream follows a run, only the stream writes its status and output.
 Rule 2: any other copy (a REST response) is applied only if its stage is not lower.
```

These two rules exist because of a real race, covered in deep dive 2.

---

## 🔌 I — Interface Definition (~5 min)

```
GET    /api/v1/prompts/:id                  → prompt, head version text, version list
GET    /api/v1/prompts/:id/versions/:n      → one version's text (load / restore)
POST   /api/v1/prompts/:id/versions         → save next version with baseVersion → 409 HEAD_MOVED
GET    /api/v1/prompts/:id/runs?before=     → history page of 25, output preview only

POST   /api/v1/runs                         → start a run (Idempotency-Key) → 202, or 200 replay
GET    /api/v1/runs/active                  → caller's queued and running runs (re-follow on load)
GET    /api/v1/runs/:id                     → full run, including the full output
POST   /api/v1/runs/:id/cancel              → 200 if already final, 202 while stopping
GET    /api/v1/runs/:id/events              → SSE: status · delta · end · snapshot
GET    /api/v1/comparisons/:id              → all runs of a comparison

GET    /api/v1/presets                      → workspace presets with revision
PATCH  /api/v1/presets/:id                  → If-Match revision → 428 / 409 REVISION_CONFLICT
POST   /api/v1/prompts/:id/shares           → link to a version or a finished run
DELETE /api/v1/shares/:token                → revoke
GET    /api/v1/shared/:token                → public read-only view (410 when revoked)
POST   /api/v1/shared/:token/fork           → copy into the caller's workspace
```

### What the UI branches on

| Signal | Client behavior |
|--------|-----------------|
| `Idempotency-Key` on POST /runs | Minted once per run per click; reused by every retry of that request |
| `200` + `Idempotent-Replayed: true` | Treated exactly like `202`: follow the returned run |
| `409 HEAD_MOVED` (details: the newer head) | Reload the prompt; the conflict banner appears |
| `409 REVISION_CONFLICT` (details: current preset) | Show theirs next to yours |
| `428` (no If-Match) | A client bug; surfaced as an error, never retried without a revision |
| `422 MISSING_VARIABLES` | Shouldn't happen, since Run is disabled until every variable is filled; shown inline if it does |
| `429` / `TOO_MANY_ACTIVE_RUNS` | Inline message under the Run button; for a comparison, "1 of 2 runs started" |
| Stream `401` / `404` | Stop following; show "Signed out" or "Run not found", no reconnect loop |

### The event stream

| Event | Payload | What the store does |
|-------|---------|---------------------|
| `status` | queued or running, attempt, timestamp | Advance status; record start time |
| `delta` | Text since the previous delta (batched every 50 ms) | Append to output |
| `end` | Final status, finish reason, error, usage (tokens, queue ms, TTFT, duration), truncated flag | Finalize, stop following, maybe toast |
| `snapshot` | The whole run from PostgreSQL | Replace; used when the live log expired (1 h) or its end was lost |

Every event's SSE `id` is its position in the run's log. That id is the resume cursor.

---

## 🔧 O — Optimizations and Deep Dives (~20 min)

> "I'll go deep on three decisions: where live run state lives, how streams resume, and where drafts live. Each one has an obvious alternative that breaks in a specific way."

### Deep dive 1: Where live run state lives (~6 min)

**Decision.** Every run the tab knows about lives in one app-level Zustand store, keyed by run ID. The stream readers are kept in a module-level registry (run ID → abort function), outside the React tree. Components subscribe to the store and never own a connection.

**Why it works here.** A run takes 5–60 seconds, and developers don't wait. They start a slow run on prompt A, open prompt B, and start another. The route for A unmounts, but the store and its readers are unaffected. When A's `end` event arrives, the store compares the run's prompt with the prompt on screen. If they differ, it pushes a toast, "Run on 'Support triage' finished · View", that links to `/prompts/A?run=<run or comparison id>`. Meanwhile the header chip counts unfinished runs anywhere in the app, and its popover links to each one. On a refresh, the shell calls `GET /runs/active` once after auth and follows each run again. With no cursor, the stream replays from the first event, so the output rebuilds completely and then continues live. The registry also makes following idempotent: if a run is already followed, a second follow is a no-op. So a history click, a toast link and the URL resolver can all call it without opening a second connection.

**Follow-up: "A run finishes after the user navigated elsewhere. Where does its result appear?"** In four places, so nothing depends on catching a toast. (1) The toast, held 12 seconds, with a View link to the exact result. (2) The header chip, while the run is still going. (3) The run's prompt history, which refetches whenever a run of that prompt finishes. (4) If the tab was closed, the run still completes on the server. It shows up in history on the next visit, or it is followed again through `/runs/active` if it is still running.

**Why the alternatives break.**

- *Stream owned by the output component (an effect that opens the fetch).* Navigation unmounts the component, and its cleanup aborts the fetch. The run keeps going on the server, but the client loses track of it: no toast, no chip, and returning means replaying from zero. Two components showing the same run (the output card and the header popover) would open two connections. Lifting the state to the route doesn't help, because the route unmounts too.
- *No live state; poll `GET /runs/:id`.* At a 1-second interval, text arrives in one-second lumps, which defeats the point of streaming. At 100 ms, that's 10 requests per second per run, and each response carries the whole output so far, so the bytes transferred grow with the square of the output length. Polling is fine for status dots in a list, but not for tokens.

| Approach | Survives navigation | Toast on finish | Connections per run | Cost |
|----------|--------------------|-----------------|---------------------|------|
| ✅ App store + registry outside React | Yes | Yes | Exactly one | Explicit lifecycle and a merge rule |
| ❌ Component-owned stream | No | No | One per viewer | Lost runs, duplicate streams |
| ❌ Refetch polling | Yes | Delayed | None held | Lumpy text, quadratic bytes, request load |

**What I give up.** Global mutable state now has a lifecycle I have to manage. Logout must close every stream (the store has a reset). The map grows as the user opens runs, so terminal runs that aren't on screen need eviction. And a run now has two sources, the stream and REST responses, which is exactly what creates the race in the next deep dive.

### Deep dive 2: Resumable streaming, and the cancel race (~7 min)

**Decision.** Server-sent events, read with `fetch` and a stream reader, with the client managing the `Last-Event-ID` cursor, the backoff and the abort.

**Why it works here.** Data flows one way. The client sends nothing on the stream, because Stop is a REST call that has to be durable anyway. The reader keeps the id of the last event it processed. When the connection drops, it waits 0.5, 1, 2, 4, then 8 seconds (capped, reset as soon as a message arrives) and reconnects with `Last-Event-ID`. Whichever API instance answers replays exactly the events after that id, because the log lives in Valkey, not in a process. `end` or `snapshot` finishes the loop. A `401` or `404` is fatal, so the UI says "Signed out" instead of retrying forever. The card shows "reconnecting…" next to the status while this happens. Most importantly, **reconnecting is a read and never a re-POST**. The run already exists, so a flaky network can't double the token bill or produce a second, different answer.

```
log ids   1 queued · 2 running · 3 delta · 4 delta · 5 delta ··· 9 end
conn A    ◀────────── reads 1..4 ──────────▶ ✕ Wi-Fi drop, cursor = 4
                                             wait 0.5 s
conn B                                       GET …/events, Last-Event-ID: 4
                                             ◀────── 5 … 9 end ──────▶
refresh   GET …/events, no cursor  ◀── 1 … 9 replayed into an empty output ──▶
```

Two server details make the client simple. A comment ping every 15 seconds keeps proxies from closing idle streams. And if the log is idle for 15 seconds, the stream service checks PostgreSQL: if the run already ended (its `end` event expired or was lost when Valkey failed), it sends a single `snapshot` instead of leaving the client waiting forever.

**Why the alternatives break.**

- *EventSource.* It does resume with Last-Event-ID, but on its own terms. Retries happen on a fixed interval with no exponential backoff or jitter, so when a deploy drops 2,000 streams they all reconnect in sync. Its error event doesn't expose an HTTP status, so the UI can't tell "signed out" from "server restarting". It can't set request headers, so it can't start from a cursor the page already has, and if auth ever moves from cookies to a header token, EventSource can't carry it.
- *WebSocket.* Bidirectionality is wasted here, and I'd lose HTTP's resume semantics. I'd have to build subscribe-with-offset, acks, heartbeats and per-socket auth myself, plus upgrade support at every proxy. One socket multiplexing all runs sounds efficient, but a reconnect then resubscribes every run with its own cursor, which reinvents SSE. I'd use WebSockets where the client pushes in real time, as in chess.

| Transport | Resume | Backoff and errors | Auth | Verdict |
|-----------|--------|--------------------|------|---------|
| ✅ fetch + SSE parser | Explicit cursor | Ours: exponential, fatal on 401/404 | Same cookie as REST | Chosen |
| ❌ EventSource | Built in, not controllable | Fixed retry, no status | GET with cookies only | Too opaque |
| ❌ WebSocket | Build it yourself | Build it yourself | Custom | Wrong shape |

**What I give up.** I own a small SSE parser (unit tested) and one HTTP connection per followed run. That second cost is serious. Under HTTP/1.1, a browser allows six connections per origin, and the active-run cap is also six, so six streaming runs would starve every REST call from the tab, *including the Stop button*. Production must serve the streams over HTTP/2. If that's not guaranteed, I'd multiplex all of a tab's runs over one stream.

**Cancellation UX and the race.** Pressing Stop immediately switches the button to a disabled "Stopping…". That shows the *intent* optimistically, not the outcome. The client sends `POST /runs/:id/cancel`. If the run is queued, the server cancels it directly. If it's running, the owning executor aborts the upstream model request, so tokens stop being spent, and then finalizes the run as `cancelled` with the partial output. The stream delivers `end`, and the card says "Stopped. The output above is what had been generated."

```
t →        Stop clicked
stream     … delta ─▶ end { cancelled, partial } ─▶ store: cancelled
REST       POST /cancel ─────────────────────────────────▶ 202 { running }
store                                                      stage 1 < 2: ignored
```

The cancel response is often `202` with the state *at the moment it was read*, which is "running". The stream's `end` can arrive before that response. If the store simply applied the REST copy, a cancelled run would flip back to "running" with an empty output. A browser test caught exactly this. Hence the two rules: while a stream follows a run, it alone writes status and output, and any REST copy that would move a run to a lower stage is ignored. I don't mark the run cancelled optimistically, because a cancel can lose to completion: whichever conditional update commits first wins. If the run completed, saying "cancelled" would be a lie about an answer the user can read in full.

### Deep dive 3: Drafts, versions and conflicts (~6 min)

**Decision.** Unsaved edits live in localStorage, one entry per prompt. Each entry holds the text, variable values, 1–3 configs, and the **baseVersion**: the head version the draft started from. Saving is a deliberate action that creates an immutable, numbered version with a message. Running a draft does *not* save it. The run sends the text itself, and the server pins a content-addressed snapshot of it.

**Why it works here.** Drafts are private until saved, so nobody else needs half-typed edits, and there are no server writes per keystroke. The draft survives a refresh, an accidental Back and a browser restart, and reading it is synchronous, with no request of its own. Once the prompt's head arrives, the page reconciles the two:

- No draft yet: seed it from the head.
- Draft text equals the head's text: it's clean, and its base silently advances to the head.
- Draft differs *and* head > base: show the banner **before** the user clicks Save: "Bob saved v4 ('Ask for plain language') after you started editing", with **[Load v4, discard my edits]** and **[Keep my edits on top of v4]**.

If the head moves while they're typing, the save sends baseVersion 3 and gets `409 HEAD_MOVED` with v4 in the details. The page reloads the prompt and the same banner appears. "Keep mine on top" sets the base to 4, so the next save becomes v5. Nothing is lost either way, because versions are append-only and v4 still exists. A save whose response was lost is safe to retry: the server checks whether the submitted text is already the head *before* it compares baseVersion, so the retry gets `200 created: false` ("No changes since v4") instead of a conflict naming the user's own save. Restoring an old version works the same way: loading v2 puts its text in the draft with base = the current head, so saving adds it on top as a new version instead of rewinding history.

**Why the alternatives break.**

- *Server autosave.* If autosave writes to the prompt itself, teammates see half-edited text, and their runs pick it up. If it writes to a per-user server draft, that's localStorage plus a round trip, a write every few seconds per open editor, and a new conflict surface when two tabs autosave. It also blurs what "the prompt" means. The only thing it buys is cross-device drafts.
- *A version per run.* A developer runs a prompt dozens of times a session, so history floods with v1 to v200 of nearly identical text, and "v12" stops meaning anything. Worse, every teammate's run would move the head, so everyone else's save would hit `HEAD_MOVED` all day. Snapshots give reproducibility without that noise. If the same text is saved later, the old run shows "Draft · now v4", computed at read time.

| Approach | Keystroke cost | Reproducible runs | History stays meaningful | Cross-device |
|----------|----------------|-------------------|--------------------------|--------------|
| ✅ localStorage draft + explicit save + snapshot per run | None | Yes | Yes | No |
| ❌ Server autosave | A write every few seconds | Yes | Muddied | Yes |
| ❌ Version per run | None | Yes | No, and constant conflicts | — |

**What I give up.** Drafts are per device and per browser profile, so clearing site data loses unsaved edits. localStorage is about 5 MB per origin and synchronous, so I'd prune drafts that haven't been touched in weeks, and move to IndexedDB if prompts grow to hundreds of KB. Two tabs on the same prompt overwrite each other's draft. I'd listen for the `storage` event and show "edited in another tab". On a shared machine, drafts must be namespaced by user and cleared on sign-out.

**Follow-up: "Two people update the same saved preset. How do you avoid silently overwriting either change?"** Presets are shared objects, not drafts, so they use optimistic concurrency. The editor remembers the revision it loaded and saves with `If-Match: "7"`. If a teammate saved revision 8 first, the server answers `409 REVISION_CONFLICT` with their preset. The editor shows **Theirs** and **Yours** side by side, with **[Use theirs]** (load their values; base becomes 8) or **[Overwrite with mine]** (re-send with `If-Match: "8"`, which becomes revision 9). Overwriting is still allowed, but only as an explicit choice made after seeing what would be replaced. Requests without If-Match get `428`, so a client bug can't skip the check. Delete needs If-Match too. Applying a preset to a config card *copies* its values, and runs store their own config copy. So editing a preset later never changes what an old run claims to have used.

### Run button: one click, one run

Each click mints one UUID per run. If the request fails with a network error or a 5xx, the launcher retries up to three attempts (400 ms, then 800 ms) **with the same key**. The server looks up the key before applying rate limits, so a retry of an accepted request returns the original run (`200`, replayed) and never a 429. Disabling the button only stops double clicks. It doesn't help when the POST reached the server, the run was created, and the response was lost: a naive retry would start a second generation and bill it twice. The key is minted after the body is fixed, so our client never trips the server's "same key, different body" `422`. The button is also disabled, with a reason, while the template is empty or a variable is unfilled ("Fill in: ticket"). Cmd/Ctrl+Enter works from either textarea.

### Comparisons without a new data model

**Follow-up: "How would you add side-by-side comparisons without redesigning the data model?"** A comparison is N ordinary runs sharing a client-generated comparisonId. The data model needed one nullable column, because runs already pinned their own snapshot and config copy. The launcher fires N POSTs in parallel, each with its own idempotency key, and waits for all of them to settle. If one is rejected (say, by the active-run cap), the others still start, and the UI reports "1 of 2 runs started", with the reason. The URL becomes `?run=<comparisonId>`. The output pane renders 2 or 3 columns labelled A/B/C in creation order, each with its own stream, Stop button and usage footer. History collapses the comparison into one row with a status dot per run. A deep link resolves through `GET /comparisons/:id`.

### Rendering performance

- **Bounded update rate.** The executor batches tokens into a `delta` every 50 ms, so each run causes at most about 20 store updates per second, however fast the model is.
- **Narrow subscriptions.** Each output card should select only its own run, so a delta for run B doesn't re-render run A, the history or the editor. The editor must never re-render because of a stream, because keystroke latency is the budget that matters most.
- **Long outputs.** I'd render plain text with preserved whitespace. If Markdown rendering is added, I'd split the output into completed blocks (memoized) and a live tail, so only the tail re-parses on each delta. Auto-scroll only while the user is pinned to the bottom; if they scroll up to read, stop following and show "Jump to latest".
- **Many runs at once.** Three columns at 20 updates per second each is 60 commits per second. If profiling shows jank, coalesce all deltas into one store commit per animation frame.
- **Long history.** Pages of 25, cursor-paginated with "Load older runs". The list endpoint returns a short output preview, not full outputs; the full text loads on select. Rows have a fixed height, so once a session loads a few hundred rows I'd virtualize the list with `@tanstack/react-virtual`, as the repo's other long lists do. The history overlays live statuses from the store, so its dots never lag the stream.

### Accessibility

- **Never make the streaming output an aria-live region.** A screen reader would announce every 50 ms delta and talk over itself. A separate polite live region announces *transitions*: "Run A started", "Run A completed, 412 tokens", "Run B failed: model error, partial output kept". The output region is marked busy while it streams.
- **Toasts** are polite status messages, and failure toasts are alerts. They pause while hovered or focused. A toast is never the only record: the chip and the history persist.
- **Keyboard.** Everything is reachable by Tab, Cmd/Ctrl+Enter runs, and focus never jumps when output arrives. The conflict banner is announced once, and its buttons name the version they act on ("Load v4, discard my edits") instead of saying "OK".
- **Not color alone.** Status badges carry words, status dots carry labels, and a partial output is described in text ("the output above is partial"). The blinking caret respects reduced motion.
- **Labels.** Every textarea, select and slider has a visible label, and sliders show their numeric value. Icon-only buttons have accessible names.

### Failure and degradation

| Condition | What the developer sees |
|-----------|-------------------------|
| Connection drops mid-stream | "reconnecting…" beside the status; output resumes from the cursor with no duplicate text |
| Refresh mid-run | Output rebuilds from the start within a second, then continues live |
| Tab closed mid-run | Run finishes on the server; it's in history on return, or followed again if still running |
| Executor dies | Partial output plus "EXECUTOR_LOST: the output above is partial"; no auto-retry, since a retry would bill again and sample a different answer |
| Model fails or stalls mid-stream | `MODEL_ERROR` / `MODEL_TIMEOUT`, partial kept, Run again is one click |
| Rate limit or active-run cap | Inline message under Run; a comparison reports how many started |
| Share link revoked | Share page says "This link was revoked by its owner" (410) |

### Two execution traces

**Success, with navigation.** (1) Alice presses Cmd+Enter on "Support triage". The launcher mints a key and gets `202`; the URL becomes `?run=r1`. (2) The store follows r1, and the card shows "Queued…", then "Waiting for the first token…", then streaming text. (3) She opens "Refund FAQ". The route unmounts, the r1 stream continues, and the header shows "1 running". (4) The `end` event arrives. The store sees that the prompt on screen differs and pushes "Run on 'Support triage' finished · View". (5) She clicks View. The route mounts with `?run=r1`, finds r1 already in the store, and renders it with no fetch.

**Failure, with a lost response and a dropped connection.** (1) Bob clicks Run on a train. The POST reaches the server and creates r2, but the response is lost. (2) The launcher retries after 400 ms with the same key and gets `200` replayed with r2, so there's still only one generation. (3) Mid-stream, the connection drops after event 4, and the card shows "reconnecting…". (4) The reader waits 0.5 s, fails once more, waits 1 s, then reconnects with `Last-Event-ID: 4`, and events 5 onward arrive. (5) Meanwhile the executor died. Its lease expires 15 s after the last heartbeat, the next sweep fails r2 with `EXECUTOR_LOST`, and the `end` event carries the partial flag. (6) Bob sees the partial text, the error code and "Run again". Nothing was duplicated, nothing was silently retried, and the run ended visibly.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Live run state | App-level store, readers outside React | Component-owned stream / polling | Runs outlive pages; one connection per run |
| Transport | SSE read with fetch | EventSource / WebSocket | One-way data; explicit cursor, backoff and errors |
| Reconnect | Re-read from Last-Event-ID | Re-POST the run | Never a duplicate generation |
| Run vs REST copy | Stream owns status; forward-only merge | Last response wins | Closes the cancel race |
| Stop | Optimistic "Stopping…", server decides the outcome | Optimistic "cancelled" | Cancel can lose to completion |
| Drafts | localStorage per prompt with baseVersion | Server autosave / version per run | Private, free per keystroke, meaningful history |
| Save conflicts | baseVersion → 409 HEAD_MOVED, banner before save | Last write wins | Explicit choice; append-only means nothing lost |
| Preset conflicts | If-Match revision → 409 theirs vs yours | Locks / last write wins | No stale locks, no silent overwrite |
| Run creation | Idempotency key per click, retries reuse it | Disabled button only | Survives lost responses |
| Comparisons | N runs sharing a comparisonId | A comparison entity with nested results | One nullable column; each run independent |
| Selection | `?run=` in the URL | Component state | Refresh, back and paste reopen the result |
| History | Paginated previews, virtualize when long | Load everything | Bounded payload and DOM |

---

## 📈 What Breaks First, and What I'd Do Next (~2 min)

**What breaks first at scale.**

- **Connections per tab.** Power users run comparisons of three across several prompts. HTTP/2 is mandatory, and past a handful of runs I'd multiplex one stream per tab carrying events for many runs, each with its own cursor. On the server, the first thing to break is SSE fan-out: one blocking Valkey reader per open stream becomes a connection-count problem at thousands of streams per instance. The fix is one multiplexed reader per instance. The evidence I'd watch is the SSE connection gauge against Valkey client counts.
- **Client memory.** The runs map only grows. I'd evict terminal runs that aren't on screen and aren't in the URL, keeping the most recent fifty.
- **Many tabs.** Each tab follows its own runs, and every tab toasts. A BroadcastChannel with one leader tab owning the streams would dedupe connections and notifications.
- **Head freshness.** Today a teammate's save is noticed on load or on save. For busy shared prompts I'd push head changes (a light SSE channel per open prompt), so the banner appears while the user is still typing.

**With more time:** a diff view between versions and between comparison outputs; drafts that sync across devices as a per-user server copy, kept separate from versions; keyboard shortcuts for Stop and for switching comparison columns; and real-user monitoring of token-to-paint and input delay while three streams run.

---

## 📝 Wrap-up

> "To summarize: three kinds of state, each placed by who needs it and how long it must live. Drafts are local and private, with the base version that makes conflicts detectable. Versions and history live on the server, append-only. Live runs live in an app-level store whose streams don't care which page is mounted. Streams resume by cursor and never by re-submitting, run creation is idempotent per click, and every shared edit is a compare-and-set that turns a conflict into an explicit choice. The hardest calls were refusing to show 'cancelled' before the server says so, keeping drafts out of the version history, and accepting per-device drafts in exchange for zero writes per keystroke."

### How the local implementation compares

The repo's `frontend/` implements this design. The draft store persists per prompt with baseVersion. The runs store follows streams outside React with the forward-only merge; that rule was added after a browser test caught the Stop response flipping a cancelled run back to running. The fetch-based reader resumes from Last-Event-ID with 0.5–8 s backoff, the launcher reuses one key per click across retries, `?run=` drives selection, and both conflict flows are wired up. The gaps relative to this answer: output cards subscribe to the whole runs map rather than to one run each, the history paginates but doesn't virtualize yet, and drafts are neither namespaced by user nor synced across tabs. On accessibility, there's no live region for run transitions, toasts don't pause on hover, status dots have only a tooltip, and the caret ignores reduced motion.
