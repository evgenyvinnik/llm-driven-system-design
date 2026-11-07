# LLM Inference API — System Design Answer (Frontend Focus)

*Frontend interview · 45 minutes · Users → Contract the UI depends on → Architecture → State → Streaming → Cancel → Admin console → Deep dives → Traces*

> "Two UIs sit on top of an inference API. The developer console lets someone pick an API key, send a request in sync, stream or async mode, watch tokens arrive, cancel, and see exactly what it cost and where the time went. The operator console shows whether the system is short of capacity or something is slow: queues per lane, how full batches are, each replica's slots, cache hit rate and version, usage per tenant, and controls to drain a replica or inject a failure. The frontend's job is to be honest about a backend with real concurrency. Tokens arrive in chunks that don't align with events. A Cancel click can lose a race with the last token. A 429 and a 529 mean different things to the person reading them. And queue time must never look like a slow model."

| Phase | Time | Focus |
|-------|------|-------|
| Users and requirements | ~4 min | Developer and operator, what each must see |
| The contract the UI depends on | ~4 min | Modes, ownership, events, errors |
| Architecture and state | ~7 min | Routes, stores, the run state machine |
| Streaming and cancel | ~6 min | fetch + stream parsing, cancel per mode |
| Admin console | ~5 min | Snapshot polling, panels, controls |
| Deep dives | ~12 min | Streaming client; cancel UX; live operator data |
| Traces, checklist, follow-ups | ~5 min | One success, one failure |
| Wrap-up | ~2 min | Trade-offs |

---

## 🎯 Users and Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses each console? | Information density, permissions | Developers (members of orgs) and platform operators (admins) |
| Does the console call the real API? | Fidelity of what it shows | Yes: it acts through one of the user's API keys, through the same admission and queues |
| How fast do tokens arrive? | Render strategy | 30–100 tokens/s per stream, in network chunks of one to many tokens |
| How fresh must operator data be? | Push vs poll | About one second; it is a dashboard, not a trading screen |
| Mobile? | Layout | Desktop first; the console must stay usable on a tablet |

### Functional requirements

**Developer console**
1. Pick an API key (grouped by org) and see the tier's limits and the tokens available right now.
2. Compose a request: mode, lane (interactive or bulk), system prompt, message, max_tokens (labelled as reserved).
3. Watch streamed tokens; see which replica served it, whether the prompt prefix was cached, and every re-route.
4. Cancel, with mode-correct semantics, and see whether the cancel won.
5. History with status, tokens in / cached / out, and the latency split; a durable page per request id.

**Admin console**
1. Queue depth per lane against its bound, and which tenants occupy it.
2. Batch fill, and why each batch left (full, max wait, deadline).
3. Per replica: slots in use (prefilling vs decoding), cache hit rate, version, draining; controls to drain, roll a version, switch batching mode, and arm chaos switches.
4. Usage per tenant, with 429s and 529s separately; the latency split per lane; live dispatcher settings.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Token render | Visible within one frame of arrival; 100 tok/s without jank | Append-only text state; no re-parse of the whole output |
| Honesty | Never show a token from a request that was cancelled first; never call a 529 "your fault" | Render only server events; map error types to distinct messages |
| Operator freshness | ≤ ~1 s, with an explicit stale indicator | A polling hook that keeps the last good snapshot |
| Resilience | A reload doesn't lose an async request | The id is shown at once; the request page fetches by id |
| Accessibility | Status changes announced; charts have text equivalents | aria labels on meters and bars, a timeline list, roles on controls |

---

## 📜 The Contract the UI Depends On (~4 min)

| Mode | Owner | Disconnect | Result |
|------|-------|------------|--------|
| Sync | Connection | Cancels the request | One JSON message |
| Stream | Connection | Cancels the request | SSE events |
| Async | Request id | Nothing | 202 + id; attach to events, or fetch by id |

**Stream events**, in order:

- message_start carries the id.
- inference_status is an extension event: queued; running, with backend, version, cached prefix tokens, queue ms and TTFT ms; or requeued, with a reason.
- content_block_start, then one content_block_delta per chunk of text, then content_block_stop.
- message_delta carries the stop reason, usage and the latency split, then message_stop.
- On failure, an error event replaces the end of that sequence. A cancelled stream ends with stop reason "cancelled".

**Errors the UI must tell apart:**

| Status / type | User-facing meaning | UI |
|---------------|--------------------|----|
| 429 rate_limit_error + Retry-After | You are over your own limit | "Over your limit, retry after N s" |
| 529 overloaded_error | The service is over capacity | "Service overloaded, try again shortly" |
| 400 invalid_request_error | The request can never succeed as is | The server's message, e.g. lower max_tokens |
| 500 api_error mid-stream | The replica failed after output started | Keep the partial text, show the error, offer retry |
| Proxy 500 with an empty body | The gateway is down | "Gateway unreachable", never an app error |

> "The cancel endpoint returns the final record and a flag saying whether the cancel won. That one field is what lets the UI tell the truth when a Cancel click races the last token."

---

## 🏗️ Architecture and State (~7 min)

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Root layout: auth check once, redirects in an effect, app shell + nav    │
 ├───────────────┬──────────────────────┬───────────────────┬───────────────┤
 │ /login        │ /console             │ /requests/:id     │ /admin        │
 │ form          │ Composer │ Output    │ lifecycle, usage, │ queues, batch │
 │               │ KeyPicker  Timeline  │ latency bar,      │ fill, replica │
 │               │ History table        │ output, input     │ cards, usage, │
 │               │                      │ (polls while open)│ latency, cfg  │
 │               │                      │                   │ /routing      │
 └───────────────┴──────────┬───────────┴─────────┬─────────┴───────┬───────┘
                            │                     │                 │
              ┌─────────────▼─────────┐  ┌────────▼────────┐ ┌──────▼───────┐
              │ console store         │  │ request fetch + │ │ usePoll(1 s) │
              │ orgs · keyId · run    │  │ poll hook       │ │ snapshot     │
              │ historyVersion        │  └────────┬────────┘ └──────┬───────┘
              └─────────────┬─────────┘           │                 │
                            ▼                     ▼                 ▼
              ┌──────────────────────────────────────────────────────────────┐
              │ api service: JSON calls, raw submit/attach, SSE frame parser │
              └──────────────────────────────────────────────────────────────┘
```

**Routing.** File-based routes: login, console, request detail by id, admin, routing. The root layout checks the session once and redirects in an effect when the auth state changes, never by rendering a redirect element during render (that loops). Admin pages check the role and show a plain message to non-admins; the server enforces it anyway.

### State, by kind

| State | Where | Why there |
|-------|-------|-----------|
| Session user | Small global store | Read by the shell, nav and route guards |
| Orgs, keys, selected key | Console store | The picker, the composer and the budget line share it |
| The current run | Console store, one object | Streamed into by an async loop outside React; components subscribe to slices |
| History | Component state, refetched every 5 s and when a run ends | Server state; a version counter in the store triggers refetch |
| Request page | Poll hook while open | One id, durable server state |
| Admin snapshot | Poll hook, 1 s, keeps the last good snapshot | One aggregate; stale is shown, never blanked |
| Composer fields | Local component state | Nobody else needs them |

### The run state machine (client side)

```
 idle ──submit──▶ submitting ──message_start / 202──▶ queued ──status: running──▶ running
                      │                                  │                           │
                      └── 4xx/5xx ──▶ failed              ├── requeued (stays queued)  ├── message_delta ──▶ completed
                                                          │                           ├── stop: cancelled ──▶ cancelled
                                                          └── error ──▶ failed         └── error ──▶ failed
 async only:  queued/running ──Detach──▶ detached (the request keeps running server-side)
```

> "The UI state machine mirrors the server's, plus two client-only states: submitting, where we have no id yet, and detached, where an async request is still running but we stopped watching. Every transition is driven by a server event, never by a guess. Clicking Cancel doesn't set 'cancelled'. The stream's own terminal event does, or the cancel endpoint's answer does. That's what keeps the console truthful when Cancel loses the race."

**The run object** holds the id, mode, phase, the text so far, the backend, version and affinity, cached prefix tokens, attempts, queue and TTFT, usage and latency on completion, an error with its Retry-After, and a timeline of notes ("Queued in the interactive lane", "Running on b2 (primary, 1,500 cached prefix tokens)", "Re-routed before output started: backend_crashed", "Cancel lost the race: already completed").

---

## 📡 Streaming and Cancel (~6 min)

### Reading the stream

The console POSTs with fetch and reads the response body as a byte stream. It decodes incrementally and splits on blank lines (the SSE frame boundary), keeping any partial frame in a buffer for the next chunk. Each complete frame yields an event name and a JSON payload, which a single handler maps onto the run state. Deltas append to the text; nothing re-renders the whole output from scratch.

> "Network chunks don't respect event boundaries. One read can hold half an event, or twelve. The parser must buffer partial frames and must never assume one chunk is one token. Tests for that are cheap and catch the classic 'garbled last word' bug."

**Why not EventSource?** It can only GET, can't send a body, and reconnects automatically. For a connection-owned stream, an automatic reconnect would be a *second request*. For async attach, I want resume with Last-Event-ID under my control, after a deliberate reconnect.

### Cancel, per mode

| Mode | What Cancel does | What the user sees |
|------|------------------|--------------------|
| Stream | Calls the cancel endpoint with the id from message_start | "Cancel won" and the stream ends with stop reason cancelled, or "Cancel lost: already completed" with the full text |
| Sync | Aborts the fetch; closing the connection is the cancel | "Connection closed. The gateway cancels a sync request whose client disconnects." The history row turns cancelled a moment later |
| Async | "Detach" closes only the viewer; "Cancel by id" calls the endpoint | Detach: "keeps running; open it from history". Cancel: won or lost, as for stream |

> "Sync is the interesting one. There's no id until the response arrives, so the only lever is the connection, and the copy says so. That's the product contract showing through the UI."

**Reloads.** For stream and async, the id appears in the output panel at the first event and links to the request page, so a reload never loses an async request: the page fetches it by id and polls while it's open.

---

## 📊 Admin Console (~5 min)

| Panel | Encoding | Why |
|-------|----------|-----|
| Queue depth per lane | Meter against the bound; amber above 70%, red at full ("new requests get 529"); top tenants as small bars | Saturation and who's causing it, at a glance |
| Batch fill | The last 60 batches as bars (height = fill; colour = why it left: full / max wait / deadline; faded = bulk) plus a summary table per lane and trigger | Shows the latency-vs-efficiency knob working, and why low fill under saturation is fine |
| Replica cards | Slots meter (prefilling vs decoding), cache hit rate, cached prefixes, tokens generated, version; Drain/Undrain, Roll version, Static/Continuous, chaos switches with armed counts | One card = one replica's whole story, with its controls next to its state |
| Usage per tenant | Requests, tokens in (cached), out, refunded, queue p50/p95, TTFT p50, 429s, 529s | 429s (the tenant's limit) and 529s (ours) side by side |
| Latency split | Queue p50/p95 in amber, TTFT p50/p95 in blue, per lane | The same colours as the per-request bar everywhere |
| Settings | Batch size, max waits, queue bounds, bulk shares, Apply / Reset | Live knobs, applied within a second |

**Controls.** Each control calls the admin API and triggers an immediate refetch, so the operator sees the effect (a draining chip, an armed count) without waiting for the next tick. Chaos switches are counts, not rates: "Crash mid-stream ×1" fires exactly once and then reads 0. The UI shows armed counts in red with a disarm button.

**Routing page.** A bar shows each replica's share of the key space. Two cards simulate adding and removing a replica: before and after bars, "23% of prefix keys move" next to "75% would move with hash mod N". Tables show observed affinity (prefix owner vs spilled, TTFT on hit vs miss) and the busiest prefixes, with their ring owner and where they actually ran.

### Request page

A durable view of one id, reachable from the output panel and the history. It shows:

- **Lifecycle**: created at the edge, dispatched to which replica, first token (the moment it was pinned), finished, attempts, primary or spilled, model version, cancel reason.
- **Usage and latency**: reserved at admission, input (cached), output, refunded, total time, decode speed, and the latency bar.
- **Output**: partial text, labelled as such, if the request was cancelled or failed; the error with its type.
- **Input**: system prompt (clamped to three lines) and messages.

It polls while the request is open, so the page is also the "fetch the async result later" screen.

---

## 🧪 Edge Cases the UI Must Handle (~2 min)

| Case | What can go wrong | Handling |
|------|-------------------|----------|
| A chunk ends mid-event | Half a JSON payload parsed as an event | Buffer until the blank-line frame boundary |
| One chunk holds many events | Only the first rendered | Loop over every complete frame in the buffer |
| Cancel clicked after the last token | "Cancelled" shown next to a full answer | Render the cancel endpoint's verdict and the stream's terminal event |
| Submit clicked twice | Two requests billed | Send disabled while submitting, queued or running |
| Key revoked between load and send | Confusing 401 | Show the server's message; refetch keys |
| Reload during an async run | Lost request | The id is linked at once; the request page fetches by id |
| Gateway down in dev (proxy 500, empty body) | "Internal error" blamed on the app | Mapped to "gateway unreachable" |
| A replica crash mid-stream | Partial text vanishes | Keep the text; show the error under it |
| Admin poll fails once | Dashboard blanks during an incident, the worst moment | Keep the last snapshot, label it stale |
| Long-running admin tab | Background polling cost | Pause while hidden; skip overlapping polls |

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: The streaming client and the run state machine

**Decision.** fetch with a ReadableStream and a hand-written SSE frame parser feeds one event handler. The handler updates a single run object in a store, outside React's render cycle. Components subscribe to slices: the text, the phase chip, the timeline. The UI phase changes only on server events.

**Why it works here.** fetch lets the console send a POST body, so the request itself starts the stream: one round trip, no "create then subscribe" race. Cookies and headers work, which is needed because the console authenticates by session and names an API key. A ReadableStream gives us backpressure-free incremental reads. Appending each delta to a string in the store is cheap, and only the output component re-renders on deltas, while the composer and history don't. Driving phases from server events means the state machine can't drift from the server's: "running" appears when the server says the first token was produced on b2, not when we sent the request.

**Why the alternatives fail.** EventSource can't POST, so the console would need a two-step create-then-subscribe. A request created by the first step could start generating before the subscription exists, and we'd miss the first tokens. Its silent auto-reconnect would also re-issue connection-owned work. WebSockets bring a bidirectional channel we don't need, a separate auth path, and proxy and load-balancer configuration, for traffic that only flows one way. Re-rendering the full output on every delta, for example by re-parsing markdown for the whole text, turns a 2,000-token answer into a quadratic amount of work and drops frames at 100 tokens a second.

**What I give up.** A hand-written parser is code I own: frame splitting, partial frames, multi-line data fields, and ignoring unknown events. Reconnect policy is mine too: I implement Last-Event-ID resume only for async attach, and deliberately not for connection-owned streams. Per-token appends to a store still trigger one React commit per network chunk. At very high token rates I'd batch appends into one update per animation frame, which costs a few milliseconds of display latency.

### Deep dive 2: Cancel that tells the truth

**Decision.** Cancel never sets the UI to "cancelled" by itself. For stream and async, it calls the cancel endpoint and renders the endpoint's answer (won, or lost with the final status). The stream's own terminal event (stop reason cancelled, or the completion) settles the phase. For sync, Cancel aborts the connection and the copy explains that this is the cancel.

**Why it works here.** The server decides a cancel/complete race with one guarded state transition, and exactly one of them wins. If the UI flipped to cancelled optimistically, it would sometimes say "cancelled" next to a complete answer, or hide a completed answer the user was billed for. Rendering the server's verdict, "Cancel lost: the request had already completed", turns the race into an understandable message, and the full text stays on screen. For sync there is no id until the response arrives, so the connection is the only handle; aborting it is exactly what the contract says cancels the request.

**Why the alternatives fail.**

- **Optimistic cancel** (mark it cancelled and hide the output at once) lies whenever completion wins, and those races cluster at the end of short requests, where users click Cancel because the answer "seems done".
- **Disabling Cancel near the end** guesses at timing, which a client cannot know.
- **Cancelling a sync request by id** would require the server to send the id before the response. That breaks the "one JSON response" contract or forces early headers that commit the status code before we know it.

**What I give up.** Cancel feels slower: there's a round trip before the UI changes phase. I cover it with an immediate "Cancelling…" note in the timeline. For sync, the history row turns cancelled only after a refetch, because the client never learns the id. The user sees "connection closed" first and the confirmed status a moment later.

### Deep dive 3: Live operator data — polling a snapshot vs pushing events

**Decision.** The admin console short-polls one overview endpoint every second, through a hook. The hook skips overlapping requests, pauses while the tab is hidden, keeps the last good snapshot on errors, and labels the view as stale with the error message. Token streams, by contrast, use SSE.

**Why it works here.** The overview is an aggregate of three stores computed on request: queue sizes and per-tenant depths from Valkey, replica health from the dispatcher's snapshot, and usage, batch fill and latency percentiles from PostgreSQL. It isn't a stream of events; it's a picture of now. Polling it once a second is honest about that, costs one cheap query bundle per operator per second, needs no reconnect logic, passes through every proxy, and doesn't hold a connection open while the tab sits in the background. A practical bonus: an always-open stream keeps a page from ever going network-idle, which breaks headless screenshot and smoke tooling.

**Why the alternatives fail.** Pushing every queue change, batch and token count over SSE floods the browser with updates nobody can read at that rate, because a busy cell dispatches hundreds of batches a second. The client then has to aggregate, which duplicates server logic and drifts from it. Pushing a snapshot over SSE every second gives the same freshness as polling with more moving parts: reconnects, heartbeats, and proxy buffering. Polling every 5 seconds is too slow to see a drain take effect or a queue fill during an incident.

**What I give up.** Up to one second of staleness and a fixed query load per open admin tab. With hundreds of operators, I'd cache the snapshot for a second at the gateway so their polls share one computation. Fast transients between polls, like a queue spiking and draining within half a second, are invisible here; the Prometheus histograms are the place for those.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a streamed request in the console

1. **Load.** Alice opens the console. The root layout confirms her session; the console store loads her orgs and keys and selects "Acme / production". The budget line reads "200,000 tokens/min · 186,420 available now".
2. **Compose and send.** She chooses Stream, the long support prompt, max_tokens 256 and output length 60, and clicks Send. The run becomes submitting, and the Send button disables.
3. **Request.** fetch POSTs to the console endpoint with the key id and mode, and the reader starts consuming the body.
4. **Queued.** message_start arrives: the run stores the id and becomes queued, and the output panel shows the id as a link. inference_status "queued" adds "Queued in the interactive lane" to the timeline.
5. **Running.** The "running" status arrives with backend b2, primary, 1,500 cached prefix tokens, queue 38 ms, TTFT 140 ms. The chips update and the timeline adds "Running on b2 (primary, 1,500 cached prefix tokens)".
6. **Tokens.** Deltas arrive in chunks of one to three tokens. Each appends to the text, and the blinking cursor follows the end of the text.
7. **Completion.** message_delta brings stop reason end_turn, usage (1,520 input, 1,500 cached, 60 output) and the latency split. The phase becomes completed, the latency bar renders three labelled segments, and the usage line appears.
8. **Refresh.** The store bumps the history version: the table refetches, the new row appears with its compact latency bar, and the budget line updates after the refund.

### Failed trace: overload, then a crash mid-stream

1. **The interactive queue fills.** The operator drains two of three replicas, and the admin console's interactive meter turns red ("48 / 48 queued · full: new requests get 529").
2. **Alice gets a 529.** Her next send returns overloaded_error. The run becomes failed and the panel shows "Service overloaded, try again shortly" (not her limit; her budget line is unchanged).
3. **Bob gets a 429.** Bob, on the free tier, sends a request reserving more than his remaining tokens, and sees "429 rate_limit_error … Retry after 4 s". The admin usage table puts this in the 429 column for his org, and Alice's 529 in the 529 column for hers.
4. **Capacity returns; a crash is armed.** The operator undrains the replicas and arms "Crash mid-stream ×1" on b1; the count shows 1 in red. Alice sends again, and her stream lands on b1.
5. **Mid-stream crash.** After 40 tokens b1 crashes. The stream delivers an error event: api_error, "Backend b1 failed after 40 output tokens. Output had started, so the request cannot move to another backend; retry it." The run becomes failed, the 40 tokens stay on screen, and the error renders below them.
6. **The admin console reacts.** b1's card shows restarting with the crash count back to 0, then ok with a cold cache (the hit rate resets). The history shows Alice's request as failed. Two async requests that were prefilling on b1 show 2 tries on b3, and their timelines read "Re-routed before output started: backend_crashed".

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer (frontend view included) |
|----------|----------------------------------|
| Source of truth; when is a write successful? | The server's request record. The UI treats a request as submitted when it has an id (message_start or the 202), and as finished only on a terminal event or the request page's status, never on a local guess |
| Client retries after losing the response? | The id is shown at the first event and links to a durable page, so a reload refetches by id. API clients use Idempotency-Key: a completed request replays its result, one in progress returns 409 + id |
| Failure between two steps? | Server sweeps re-queue or fail stranded work. The UI shows re-routes in the timeline and renders failures with partial output kept; a dropped connection on a sync request is reported as a cancel, which it is |
| Ordering or consistency needed? | Per-request event order (one writer server-side; append-only client state); one terminal state. No ordering across requests; the history sorts by creation time |
| Access with caches and async work? | Every console call is scoped to the user's orgs on the server; the key picker lists only the user's keys; admin routes check the role, and the server enforces it again |
| What breaks first? | Server side, replica slots: the admin console shows queue time rising with TTFT flat. Client side, very long outputs at high token rates; batch appends per animation frame and virtualize long histories |

---

## ❓ Follow-ups the Answer Must Handle

**Two requests have similar payload sizes but very different execution costs. How should admission treat them?**
> "The server charges the reservation (input estimate plus max_tokens) and refunds the rest. The UI labels max_tokens as 'reserved', shows the budget available now, and shows reserved versus refunded on each request page, so a developer sees why one small prompt with a huge max_tokens drained their bucket."

**The API server times out while the model is still working. Who owns the request?**
> "The id. For async, the console can detach, reload, or open the request page on another device and fetch the result. For sync, the connection owns it, and the copy says so: closing it cancels, and long work belongs in async."

**How do you correlate queued work with the original caller?**
> "The edge-minted id, carried in message_start, the request-id header, every status event and the history. The console links it the moment it arrives."

**When cancellation races with completion, what result does the caller observe?**
> "Whichever server transition won. The cancel response says won or lost; the timeline shows it, and if completion won the full answer stays on screen."

**How do you keep one customer from consuming all available capacity?**
> "The server shares queues and dispatches fairly by cost, weighted by tier. The admin console makes it visible: per-tenant queue depth, and 429s versus 529s per tenant in separate columns."

**When traffic is low and a batch never fills, how long does a request wait?**
> "At most the lane's max wait, 25 ms for interactive. The batch-fill panel shows those batches as short amber bars, which left on max wait at size one."

**During overload, what stops the queue from growing forever?**
> "A bound per lane. The meter turns red at the bound, and new requests get a 529 that the console renders as the service's problem, not the user's."

**Can a request move to another backend after output has begun? What about stale routing information?**
> "No. Before the first token, re-routes appear in the timeline. After it, a replica failure ends the stream with an error and the partial output stays. Stale routing costs a refused round trip and a re-route, which the user sees only as a slightly longer queue time."

**Does adding a server invalidate existing assignments? What happens during a rolling model-version change?**
> "The routing page simulates it: adding a fourth replica moves about a quarter of prefix keys, versus three quarters with mod N. During a rollout, the admin console shows one replica draining, then on the new version with a cold cache. The output panel's version chip tells the developer which version answered."

---

## ⚡ Performance and Accessibility (~1 min)

- Delta appends touch only the output component; the composer, history and admin panels don't re-render on tokens.
- The history is capped at 25 rows; a longer history would be virtualized.
- Polling pauses while the tab is hidden, and overlapping polls are skipped.
- Meters and bars carry aria labels with their values. The latency bar has a text legend with every number, the timeline is an ordered list, and the mode switch is a radiogroup.
- Colours are never the only signal: trigger colours have a legend, and status chips carry the status word.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Streaming transport | ✅ fetch + ReadableStream | ❌ EventSource / WebSocket | POST body, cookies, no silent re-request |
| UI phase source | ✅ Server events only | ❌ Optimistic local phases | The cancel race is decided server-side |
| Sync cancel | ✅ Abort the connection | ❌ Cancel by id | No id exists until the response; the connection is the owner |
| Run state | ✅ One store object, sliced subscriptions | ❌ Component state | Written by an async loop; read by several panels |
| Operator data | ✅ 1 s snapshot polling | ❌ SSE event push | Aggregate data; no reconnect logic; network goes idle |
| Latency display | ✅ Three labelled segments, same colours everywhere | ❌ One total | Queue time is never read as model time |
| Errors | ✅ 429 / 529 / 500 / unreachable rendered differently | ❌ One generic error | Each tells the user something different to do |

---

## 📝 Wrap-up (~1 min)

> "The console is honest because it renders only what the server decided. The phase follows server events, Cancel reports whether it won, and the latency bar splits queue from model time. Streaming uses fetch, so the request and its stream are one round trip. The operator console polls one snapshot a second and shows saturation, batch fill and each replica's story next to its controls."

| Production design | Local build |
|-------------------|-------------|
| SSO, thousands of developers | Session login: alice (two orgs), bob, admin |
| Real fleet | Three mock replicas with chaos switches the admin console arms |
| Proof | Six screenshots, generated Playwright smoke tests, and a live end-to-end script that drives the same API the console uses |
