# Discord (Real-Time Chat) — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"I'm designing the browser client for a real-time chat system. The thing that makes this interesting from a frontend perspective isn't rendering messages — it's that **reads and writes travel over different transports**. The client sends commands over HTTP POST and receives everything over a Server-Sent Events stream. That split forces three decisions most chat clients never have to make: whether to render your own message optimistically or wait for the server to echo it back, how to avoid losing messages in the gap between fetching history and opening the stream, and what to do when the stream drops and comes back.

I'll spend most of the time on those, because they're where a chat client is actually correct or incorrect. The component tree is the easy part."

---

## 🎯 Requirements

### Functional

1. **Join a room** and see recent history immediately
2. **Send messages** and see them appear in the timeline
3. **Receive messages in real time** from anyone in the room, including users connected to a *different* server instance
4. **Switch rooms** without a page reload, and without leaking the previous room's stream
5. **Survive a dropped connection** — recover without the user reloading

### Non-functional

| Requirement | Target | Why this number |
|-------------|--------|-----------------|
| Message-to-render latency | < 200ms p95 | Below the threshold where typing feels "sent into a void" |
| Reconnect after network blip | < 5s, automatic | Longer and users reload the page, which is worse for the server |
| Time to first message on join | < 500ms | History comes from an in-memory ring buffer server-side, so the network is the only cost |
| Memory over a long session | Bounded | A tab left open for a workday must not accumulate unbounded message objects |

### What I'm explicitly not building

No authentication beyond a claimed nickname, no voice or video, no message editing or threading. Each of those changes the client architecture substantially, and none of them illuminate the transport problem this design is about.

---

## 🏗️ Architecture

The shape that matters is the asymmetry between the two directions:

```
        ┌──────────────────────────────────────────────┐
        │                  Browser                      │
        │                                               │
        │   ┌────────────┐        ┌─────────────────┐  │
        │   │  Command   │        │  Event stream   │  │
        │   │   input    │        │   consumer      │  │
        │   └─────┬──────┘        └────────▲────────┘  │
        │         │                        │           │
        │         │   ┌────────────────┐   │           │
        │         └──▶│  Chat store    │◀──┘           │
        │             │  (single       │               │
        │             │   writer)      │               │
        │             └───────┬────────┘               │
        │                     │ subscribe              │
        │              ┌──────▼───────┐                │
        │              │  Components  │                │
        │              └──────────────┘                │
        └───────────────┬──────────────────▲───────────┘
                        │ POST /api/command │ SSE
                        ▼                   │
              ┌─────────────────────────────┴──────────┐
              │   HTTP adapter  ·  instance 1..N       │
              └──────────────────┬─────────────────────┘
                                 │ Redis pub/sub
                        (fan-out across instances)
```

**One store is the single writer.** Both the POST response path and the SSE event path funnel into the same Zustand store, and components only ever read from it. That's the invariant that keeps the two transports from producing two competing versions of the timeline.

The store persists exactly one thing to localStorage — the session — and deliberately nothing else. Messages and room membership are ephemeral: rehydrating a stale message list on reload would show a timeline that silently diverges from the server's, and the server can hand back real history in one request anyway.

---

## 🗄️ State Shape and Why It's One Store

The store holds five things, and the discipline is about what's *derived* rather than stored:

| Slice | Stored | Why not derived |
|-------|--------|-----------------|
| `session` | Session ID + nickname | The only thing persisted to localStorage — it's the identity the server issued |
| `currentRoom` | Room name | Drives which stream is open; a single value because one stream is the invariant |
| `messages` | Array for the current room | Cleared on room switch, not accumulated per room |
| `eventSource` | The live connection handle | Held so exactly one place can close it |
| `isLoadingMessages` | Boolean | Distinguishes "empty room" from "history in flight" |

Two of those are worth defending.

**Messages are not keyed by room.** A `Record<room, Message[]>` cache would make switching back instant, and I rejected it: the client would then be showing a snapshot from whenever you last visited, with no stream to keep it current, and no way to know how stale it is. Re-fetching history on every join is one cheap request against an in-memory server buffer, and it guarantees what's on screen matches what the server thinks happened.

**The `EventSource` handle lives in the store, not in a component.** If a component owns it, the connection's lifetime is tied to that component's mount — and a re-render, a route change, or an error boundary firing can leave a stream open with nobody reading it. Putting it in the store means one owner and one rule: opening a stream closes the previous one.

> "The distinction I'm drawing is between state that describes the server and state that describes this tab. Session is the former and survives reload; message lists are the latter and shouldn't."

---

## 🔍 Deep Dive 1: Server Echo vs Optimistic Rendering (10 minutes)

This is the decision I'd lead with, because it's the one that's genuinely contested.

When the user hits Enter, the client POSTs the message. The server routes it, publishes to Redis, and every instance — including the one that received the POST — pushes it back down the SSE stream. **So the sender receives their own message as an inbound event.** The question is whether to render it immediately on send, or wait for that echo.

### The two options

| Approach | Perceived latency | Failure behavior | Ordering |
|----------|-------------------|------------------|----------|
| ✅ **Wait for echo** | One network round trip (~50–150ms local) | Message simply never appears — honest, but unexplained | Server assigns order; sender sees exactly what everyone else sees |
| ❌ **Optimistic render** | Instant | Must detect failure and roll back, or the user believes a lost message was sent | Sender's local order can differ from the server's, then jump when reconciled |

### Why I chose the echo

**The client has no way to assign a correct position.** In a multi-instance deployment, ordering is decided by whichever server handles the message and publishes it. If I render optimistically I'm guessing at a position in a sequence I don't control — and when the echo arrives with the server's actual ordering, I either leave the guess in place (now everyone sees a different transcript than the sender) or reorder the list under the user's eyes.

**Optimistic UI requires a rollback story, and rollback in chat is uniquely bad.** For a "like" button, reverting is a visual blip. For a message, reverting means text the user watched appear now vanishes — and they've already moved on mentally. To do it responsibly I'd need per-message pending state, a failure timeout, a visual "sending…" treatment, and a retry affordance. That's real complexity, and it buys latency the user may not even perceive.

**The echo is nearly free here.** The server writes to an in-memory ring buffer and publishes to Redis before it does anything durable, so the round trip is a POST plus a pub/sub hop — single-digit to low-double-digit milliseconds on a local network. Optimistic rendering optimizes away a delay that is already under the perceptual threshold.

### What I'm giving up, honestly

On a slow or lossy connection, the input clears and *nothing appears* until the echo arrives. That's a bad moment, and it's the strongest argument for the other side. The mitigation I'd build first isn't optimistic rendering — it's making the wait legible: disable the input and show a subtle pending indicator until the echo lands, and surface an explicit error if it doesn't within a couple of seconds.

> "I'd revisit this the moment we support offline or mobile networks. On a train, waiting for a server echo is unusable, and at that point I'd accept the reconciliation complexity — but I'd introduce a client-generated message ID first, so the echo can be matched to the optimistic entry instead of guessed at by content."

---

## 🔍 Deep Dive 2: The Join Race — Losing Messages Between History and Stream (10 minutes)

This is the bug class I'd want to be asked about, because it's invisible in testing and obvious in production.

Joining a room is four steps: close the previous stream, POST `/join`, fetch history, open the new SSE stream.

```
  close old stream ──▶ POST /join ──▶ GET history ──▶ open SSE
                                        │              │
                                        └──── GAP ─────┘
                                     messages sent in this
                                     window appear in neither
```

**History is a snapshot taken before the stream exists.** Any message published in the gap is missing from the snapshot *and* missed by the not-yet-open stream. The window is small — one round trip — but it's exactly when a busy room is most likely to produce a message, and the loss is silent: no error, no gap indicator, just a transcript quietly missing a line.

### Options

| Approach | Correctness | Cost |
|----------|-------------|------|
| ❌ History then stream (current) | Loses messages in the gap | Simplest; the bug is invisible until someone compares transcripts |
| ✅ **Stream first, buffer, then history, then merge** | No loss | Client must dedupe and order the merge |
| ✅ **History returns a cursor; stream replays from it** | No loss, no client merge | Requires server-side sequence numbers |
| ❌ Re-fetch history after opening the stream | Shrinks the window, doesn't close it | Two history round trips, still racy |

### What I'd build

Open the SSE connection **first** and buffer inbound events without rendering. Then fetch history. Then merge: render history, and replay the buffer on top, dropping anything already present.

That merge needs identity, and here's the catch — **it needs a stable message ID, which this system doesn't have.** Deduping by content and timestamp is wrong the moment two people send "ok" in the same second. So the honest answer is that the client-side fix depends on a server-side change: messages need a monotonic ID.

Given that, the cursor variant is strictly better. If history returns "you have everything through sequence 402" and the stream can be opened with `Last-Event-ID: 402`, the server replays the gap and the client never merges anything. That's precisely what SSE's `Last-Event-ID` header exists for, and this design isn't using it.

> "I'd push the sequence number onto the server before writing any client-side merge logic. A dedupe that guesses at identity is a bug that shows up as duplicated messages later — I'd rather fix the contract than write clever reconciliation on top of a missing field."

---

## 🔍 Deep Dive 3: Two Shapes for One Message (8 minutes)

A real defect from this codebase, and the most transferable lesson in it.

The same logical message reached the client in two different shapes:

| Source | Author field | Time field |
|--------|--------------|------------|
| Live SSE event | `user` | `timestamp` |
| History endpoint | `nickname` | `createdAt` |

The client read `user` and `timestamp`. Opening any room with history called `message.user.charAt(0)` on `undefined`, which threw and **the error boundary replaced the entire application with a generic failure screen.** Fixing that revealed the second half: every history message rendered "Invalid Date".

### Why it happened

The two shapes came from two layers that never spoke. History was served from a buffer holding the *persistence* shape — database column names. Live messages came from a router that formatted a *transport* shape. Both were internally consistent. Nothing reconciled them, and TypeScript couldn't help because the client's interface described one shape while the server returned two.

### What it teaches about frontend architecture

**A shared type between two codebases is a claim, not a guarantee.** Both sides compiled. The interface said `user: string`, the payload had no `user`, and nothing checked. Types are erased at runtime, so a declared contract is only as good as whatever validates it at the boundary.

Two things follow, and I'd apply both:

- **Normalize at the edge, exactly once.** Every inbound payload — history fetch and SSE event alike — should pass through one adapter that produces the client's internal shape. Then a server change breaks one function instead of every component that touches a message.
- **One missing field should not take down the page.** `message.user.charAt(0)` is unguarded property access on network data. An error boundary that catches it and blanks the whole app converts a cosmetic defect into a total outage. The boundary should be scoped to the message list, and the avatar should tolerate a missing name.

> "The deeper smell is that one concept had two representations and no owner. I'd rather add a normalizing layer at the transport boundary than have every component defensively handle both shapes — defensive code at the leaves means the bug reappears with the next new component."

---

## 🔀 Why SSE, From the Client's Side

The transport choice is usually argued server-side. It's worth defending from the browser too:

| | ✅ SSE | ❌ WebSocket |
|---|---|---|
| Reconnection | Automatic in `EventSource` | Hand-written backoff, every time |
| Resume after drop | `Last-Event-ID` built into the protocol | Roll your own |
| Client→server | Not supported — use HTTP POST | Same channel |
| Debuggability | `curl` shows the raw stream | Needs a WS client |

The client never needs to push on a persistent channel — commands are POSTs. So WebSocket's bidirectionality is capability we'd pay for and not use, and its reconnection burden is real code that `EventSource` gives away.

The catch worth naming: **browsers cap concurrent connections per origin over HTTP/1.1 at around six.** A user with several tabs open exhausts that, and the last tabs silently never connect. Over HTTP/2 the limit effectively disappears, so this is an argument for ensuring HTTP/2 in production rather than against SSE — but it's the failure mode I'd watch for, because it presents as "chat doesn't work" in one tab with no error anywhere.

---

## 📈 Rendering: What I'd Do and When

The message list currently renders every message and scrolls to a bottom anchor on update. That's correct for the current bound — the server caps history at 10 per room — and I'd leave it alone.

**When I'd change it:** the moment history is unbounded or a long-lived session accumulates messages. Two things break, in this order:

1. **Scroll behavior before performance.** Auto-scrolling to the bottom on every message is hostile to anyone reading scrollback — a new message yanks them away mid-sentence. The fix is cheap and comes first: only auto-scroll when the user is already near the bottom, and show a "jump to latest" affordance otherwise.
2. **Then virtualization.** Past a few thousand nodes, DOM size dominates. Virtualizing a chat list is harder than a product grid because rows have variable height, images change height after load, and the scroll anchor must stay pinned to the bottom while items are prepended above. That's why it's second — it's the expensive fix, and the cheap fix addresses the complaint users actually voice.

---

## ⌨️ Where the Command Grammar Lives

The client sends raw strings — `/join music`, `/rooms`, `/leave` — to a server-side parser. The frontend question is whether the client should understand that grammar too.

The pull toward parsing locally is strong: you want autocomplete on `/`, you want to grey out the send button for a malformed command, you want to tell someone they typed `/jion` without a round trip. All of that requires the client to know the command set, its arguments, and its validation rules.

| Approach | Feedback speed | Failure mode |
|----------|----------------|--------------|
| ❌ Full client-side parser | Instant | **Two grammars that drift.** Add a server command and the client rejects it as invalid until someone updates a second list |
| ✅ **Server parses; client hints** | One round trip for errors | Typos cost a round trip, which for a chat command is imperceptible |
| ✅ Server-published command list | Instant, no drift | Needs an endpoint returning the grammar — the right answer at scale |

**I'd keep the server as the only parser.** The failure mode of a duplicated grammar is worse than the latency it saves: a client-side validator that rejects a command the server would happily accept is indistinguishable from a broken feature, and it fails *closed* — the user simply cannot do the thing. A round trip to be told "unknown command" is a cost paid only when someone makes a mistake.

The client still owns two things that don't require the grammar. It knows that a leading `/` means "this is a command, not a message", which is enough to style the input differently and set expectations. And it renders whatever error the server returns, rather than inventing its own — so error copy lives in one place.

If autocomplete became a requirement, I'd add an endpoint that returns the command list and their argument shapes, and drive the UI from that. **Fetching the grammar is fine; reimplementing it is not.**

---

## ♿ A Chat Log Is a Hard Accessibility Problem

Worth raising unprompted, because a real-time list is one of the few UI patterns where the naive implementation is actively hostile to screen-reader users.

**Announcing every message is unusable.** Wrapping the list in `aria-live="assertive"` means a busy room interrupts the user constantly and they can never finish hearing a sentence. `polite` is better but still queues every arrival, so the announcement backlog grows unbounded behind a fast conversation.

What I'd do:

- Mark the log `aria-live="polite"` but **only announce messages that arrive while the composer has focus** — that's the moment the user is participating and wants to know. Scrollback reading is a different mode and shouldn't be narrated.
- Keep each message a list item with the author in the accessible name, so arrow-key navigation reads "Alice, 3:04 PM, message text" rather than three disconnected fragments.
- Make the auto-scroll pausable, and never move focus on new messages — stealing focus mid-typing is the single worst thing this UI can do.

The same reasoning drives the visual design: the "jump to latest" affordance mentioned above isn't only for mouse users, it's the escape hatch that makes pausing auto-scroll safe.

---

## 🔌 Designing for Clients You Don't Control

One property of this system shapes the client more than any component decision: **the browser is not the only client.** The same rooms are served over raw TCP, so a message in the timeline may have come from someone on `netcat`, and there may be participants the web client never renders as "present".

That rules out a whole category of client-side assumptions:

- **No assuming the client's own state is complete.** A web-only chat can often treat local state as authoritative between refreshes. Here, membership and message flow are influenced by clients that share no code with this one, so the server is the only complete picture.
- **No client-enforced invariants.** Anything the browser refuses to send, a `netcat` user can send anyway. Message length limits, command validation, nickname rules — the client can *hint* at all of these, but the server has to enforce them, and the client has to render whatever arrives even if its own UI would never have produced it. That includes messages with characters the composer would have stripped.
- **Presence is server-truth or nothing.** A room list derived from "users I've seen post" would be wrong the moment a TCP user joins silently.

The same logic applies to horizontal scaling, and here the client's job is pleasantly boring: because fan-out happens through Redis pub/sub *behind* the SSE endpoint, the browser has no idea whether it's talking to instance 1 or 3, and doesn't need to. **The client should not learn about instances** — no sticky-session logic, no instance IDs in the payload. If a future change made that necessary it would be a design regression, because it would put deployment topology into the browser.

### Connection state the user can act on

Because reconnection is automatic and silent, the UI has to make the invisible visible without being alarming:

| State | What the user sees | Why |
|-------|-------------------|-----|
| Connected | Nothing | Steady state should be quiet |
| Reconnecting | Inline banner, composer stays enabled | Messages typed during a blip should still send once the POST path recovers — the POST doesn't depend on the stream |
| Reconnected with a gap | "You may have missed messages" + refresh action | Honest about the `Last-Event-ID` limitation until replay exists |
| Failed after retries | Persistent banner with manual retry | `EventSource` gives up eventually; without this the app looks fine and is dead |

The composer staying enabled during reconnect is the non-obvious one. Sending and receiving are separate transports, so a dead stream doesn't imply a dead POST path — disabling input would be pessimistic and would lose messages the user could have sent.

---

## 🧪 Testing the Parts That Actually Break

The bugs in this client are lifecycle bugs, and they're invisible to the tests people usually write for chat UIs.

| What to test | How | Why it matters |
|--------------|-----|----------------|
| Join race | Publish a message between the history response and stream open | The message-loss window in Deep Dive 2 — untestable by clicking around |
| Stream leak on room switch | Switch rooms 10×, assert exactly one open `EventSource` | Leaked streams cross-post messages into the wrong room |
| Reconnect gap | Kill the stream, publish, restore | Verifies whether `Last-Event-ID` replay actually works |
| Payload shape drift | Feed history-shaped and live-shaped payloads to the normalizer | The defect in Deep Dive 3, caught at the boundary rather than in a component |
| Missing field tolerance | Render a message with no author | Confirms one bad payload can't blank the app |

Rendering assertions ("does the message appear") are the least valuable tests here, because that path is exercised constantly in development. **The valuable tests are the ones that simulate a network the developer never sees on localhost** — messages arriving during a request, connections dying mid-session, payloads changing shape.

---

## 📦 Bundle and First Paint

Briefly, because it's the one place this client is unusually cheap and it's worth saying why.

There is no WebSocket library, no state-management runtime beyond Zustand's few kilobytes, and no data-fetching layer — `EventSource` and `fetch` are browser built-ins. The entire real-time stack costs nothing at the network level. **That's a direct consequence of the transport choice**, not a separate optimization: choosing SSE deleted a dependency rather than adding one.

The first meaningful paint is the room list, which needs one request. History and the stream come after room selection, so the initial render doesn't block on either. If this grew, the first thing I'd code-split is the message view — the login and room-selection path doesn't need it.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Send feedback | ✅ Wait for server echo | ❌ Optimistic render | Client can't assign ordering it doesn't control; rollback in chat is worse than latency |
| Transport | ✅ SSE + POST | ❌ WebSocket | Traffic is one-directional; free reconnection and `Last-Event-ID` |
| Join sequence | ✅ Stream-first, then history | ❌ History-then-stream | Closes a silent message-loss window |
| Message identity | ✅ Server sequence number | ❌ Content+timestamp dedupe | Guessed identity produces duplicates under concurrent identical text |
| Payload handling | ✅ Normalize once at the boundary | ❌ Per-component tolerance | One shape change breaks one function, not every consumer |
| Persistence | ✅ Session only | ❌ Persist messages | A rehydrated timeline silently diverges from the server's |
| Rendering | ✅ Plain list now | ❌ Virtualize preemptively | History is capped at 10; scroll anchoring is the real complaint first |

---

## 🚀 What Breaks First

Asked to scale this client, the order of failure:

**Reconnection correctness, not performance.** `EventSource` reconnects on its own, which is the trap — it reconnects *without* replaying what was missed, so a laptop that slept through fifty messages comes back with a stream that works and a transcript with a hole. Nothing in the UI indicates it. This is the first thing I'd fix, via `Last-Event-ID`.

**Then room-switch leaks.** Every join closes the previous `EventSource`. If any path ever fails to — an error mid-join, a component unmount during an in-flight request — the old stream stays open and messages from the previous room append to the new room's list. The store should own stream lifetime and treat "one open stream" as an invariant, not something each call site remembers.

**Then connection exhaustion**, the per-origin cap described above.

**Then rendering**, last, and only with unbounded history.

Note that none of the first three are performance problems. They're correctness problems in connection lifecycle — which is what a real-time client mostly is.

---

## 📝 Summary

Three ideas carry this design:

1. **One store is the single writer.** Two transports converge into one state container, so the timeline has one owner and components never reconcile competing sources.
2. **Ordering belongs to the server.** That single fact decides the echo-vs-optimistic question, justifies the sequence number, and explains why the client normalizes rather than interprets.
3. **The hard parts are lifecycle, not rendering.** The join race, the reconnect gap, and the stream-per-room invariant are where this client is correct or silently wrong. Virtualization is a performance nicety by comparison — and the missing-message bugs are the ones users can't see and therefore can't report.
