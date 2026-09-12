# Facebook Live Comments — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

This is a proposed design, using the local demo as a starting point. The demo has a 200-entry rendered list, interval reaction deltas, and simple reconnect/backfill; it does not implement the virtualizer, reading mode, reliable acknowledgment, or versioned reaction snapshots proposed below.

| Discussion | Minutes |
|------------|---------|
| Opening and requirements | 4 |
| Draw the architecture and establish the protocol | 4 |
| Rendering deep dive | 12 |
| Scroll-intent deep dive | 10 |
| Reaction-semantics deep dive | 9 |
| Selected recovery/accessibility/testing follow-ups | 4 |
| Close and questions | 2 |

The later short sections are follow-up notes to choose from, not a checklist to recite. The three deep dives carry the main explanation.

---

## 📋 Opening Statement

"A live comment stream inverts the usual frontend problem. Normally I'm optimizing for a client that receives occasional updates. Here the client receives **batches averaging a hundred comments every 100 milliseconds in a 1,000-comment/second stress case**, indefinitely, while the user is also typing into the same surface.

That produces three problems that don't appear in ordinary feed UIs. Rendering has to survive a sustained firehose without dropping frames. Memory has to stay bounded across a two-hour stream, which means the client must actively forget. And auto-scroll has to serve two users at once — the one watching the newest comments and the one reading something forty comments back, who must not be yanked away.

There's also a subtlety in what the server sends: comments arrive individually and are batched, but reactions arrive **already aggregated into counts whose delta-or-total semantics must be explicit**. Those need completely different rendering strategies, and treating them the same is where these UIs usually go wrong."

---

## 🎯 Requirements

### Functional

1. **Watch a stream** and see comments arrive live
2. **Post comments** into the same stream
3. **React**, and see aggregate reaction counts update
4. **Backfill on join** — recent comments appear immediately, not an empty box
5. **Read scrollback** without being interrupted by new arrivals

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Perceived latency | Healthy-path p95 acceptance-to-display < 500ms | Budget batching, transport, and rendering separately |
| Backfill on join | Target under 1 second | Show a loading state until recent context arrives |
| Sustained load | Test 1,000 incoming comments/sec; bound selected display rate | Measure typing/frame latency on a specified low-end device |
| Memory over 2 hours | Bounded | A stream left open must not grow without limit |
| Scroll integrity | Never yank a reading user | The single most-hated behavior in live chat |
| Reconnect | Automatic, with backfill | Mobile viewers drop constantly |
| Composer responsiveness | Never blocked by list rendering | Laggy typing is how users experience a render problem |

### Non-goals

No threading, editing, or rich media in the initial scope. Threading introduces insertion into the middle of a bottom-anchored list. Moderation removal still belongs in the design, so the normal arrival path is append-oriented without assuming that rows can never change or disappear.

I'd also note that there's no authentication in the local build: identity is selected from a list. In the proposal, the gateway establishes a session and authorizes the subscription before enabling the composer. Expired sessions, bans, and stream-ended states have distinct explanations; opening a socket alone is not permission to post.

---

## 🏗️ Architecture

```
┌───────────────────────┐       ┌───────────────────────┐
│ Composer + pending    │       │ Comments + reactions  │
│ Local text and focus  │       │ Bounded subscriptions │
└───────────┬───────────┘       └───────────▲───────────┘
            │                               │
            ▼                               │
┌──────────────────────────────────────────────────────┐
│ Connection controller + scoped store                 │
│ Batch ingest / snapshot + tail / reading intent      │
└───────────────────────────┬──────────────────────────┘
                            │ one authorized socket
                            ▼
┌──────────────────────────────────────────────────────┐
│ Gateway: comment batches + versioned reaction totals │
│ Durable replay / selected feed / posting receipts    │
└──────────────────────────────────────────────────────┘
```

**One connection, two message shapes.** Comments carry stable IDs for merge/deduplication. In my proposed protocol, reactions carry versioned absolute totals to replace. In the actual demo, reaction batches reset their counters after each flush and contain **deltas to add**. After a total of 10, a delta of 3 means 13; replacing with 3 would be wrong. Aggregation alone does not tell the client which operation to use.

The other thing the diagram encodes: **the store, not the components, absorbs the firehose.** Batch ingest, window eviction and scroll intent all live in one place so that components subscribe to a bounded, already-reconciled slice. Narrow selectors keep unrelated updates away from the composer. A parent re-render does not necessarily remount an input, but avoid expensive shared subscriptions and unstable keys that can disturb focus.

---

## 🔍 Deep Dive 1: Rendering a Firehose Without Dropping Frames (12 minutes)

The server uses 100ms batching to reduce send and frame-processing overhead. That can produce **about ten updates per second from one publisher** at steady load. Multiple gateway publishers, delayed timers, and bursts can produce more/larger frames; the local timer imposes no hard byte or item cap. The browser needs its own ingestion budget.

### Why the naive approach fails

Appending each comment to an array in state and rendering the array does three fatal things at this rate. Every batch re-renders the whole list. The array grows without bound. And a two-hour stream at even 100 comments/second retains 720,000 comment rows, plus their child nodes.

At 60Hz, the nominal frame budget is about 16.7ms, shared with other browser work. A single state update that reconciles thousands of nodes blows it, and the failure mode isn't a slow list — it's a page that stops responding to typing, because React's reconciliation and the user's keystrokes compete for the same main thread. **The composer becoming laggy is how users experience a rendering problem in this UI.**

### The three fixes, in order of impact

| Technique | What it solves | Cost |
|-----------|---------------|------|
| ✅ **Bounded window** — keep the last N, evict the rest | Unbounded memory and node count | Scrollback is limited; must be honest about it |
| ✅ **Virtualize** — render only visible rows | DOM size independent of list length | Variable heights make this genuinely hard |
| ✅ **Batch state updates** — one update per frame, not per message | Re-render count | Uses part of the foreground frame budget |
| ❌ Debounce rendering by hundreds of ms | Also reduces renders | Defeats the point — the stream stops feeling live |

**The bounded window comes first**, and it's the decision people skip. Keeping roughly 500 comments means the client is *designed to forget*. That is an explicit recent-view requirement, not evidence that nobody wants older history. The local cache keeps 1,000 entries with a whole-key TTL refreshed on posting; it does not promise an hour of scrollback. At 1,000 comments/second, a 500-row window lasts half a second. I would negotiate a selected feed capped near 20 comments/second, disclose selection, and keep full history in a separate paginated view if required.

**Virtualization is second** because it's the expensive one. A comment list has variable row heights — different text lengths, some with badges — so the virtualizer must measure rather than assume. And it has to anchor to the *bottom*, which is the hard direction: items are appended below while the user's scroll position must stay visually fixed relative to content they're reading.

**Batching state updates is third and cheapest.** Even with 100ms server batches, a burst can deliver several frames close together. Coalescing ingest to at most one state update per animation frame removes redundant reconciliation, but parsing, merging, and queued bytes still cost work. Bound the buffer and request a feed reset if the consumer falls too far behind; do not build an unlimited queue while the tab is hidden.

> "The insight I'd lead with is that the server's 100ms batch is a *throughput* fix and the client needs a separate *rendering* fix. They look like the same optimization and they're not — batching the network doesn't stop you from re-rendering ten thousand DOM nodes ten times a second."

---

## 🔍 Deep Dive 2: Auto-Scroll for Two Users at Once (10 minutes)

This is the behavior everyone gets wrong, and it's not a performance problem — it's an intent problem.

### The conflict

Two people are using the same view. One is watching the live edge and wants the newest comment always visible. The other has scrolled up to read something and must not be moved. **The client has to infer which one it's dealing with, from scroll position alone.**

Unconditional auto-scroll serves the first and betrays the second — the reader gets yanked to the bottom mid-sentence, ten times a second. Never auto-scrolling serves the second and makes the live experience useless.

### The rule

| Scroll position | Behavior | Rationale |
|-----------------|----------|-----------|
| At or near the bottom (within a small threshold) | ✅ Auto-scroll with new content | User is following the live edge |
| Scrolled up beyond the threshold | ✅ **Pin position, show "N new comments"** | User is reading; new content waits |
| Clicks the "N new" affordance | ✅ Jump to bottom, resume following | Explicit intent to rejoin |

The threshold matters: it must be forgiving enough that a few pixels of momentum scrolling doesn't disengage auto-follow, and tight enough that deliberate scrolling always does.

### The part that's actually hard

**Keeping a scrolled-up user visually stationary while content is appended below them is easy. Keeping them stationary while content is *evicted above them* is not.** The bounded window from Deep Dive 1 removes old comments from the top, and every removal shifts the content below it upward — so a reader jumps unless the scroll offset is corrected by exactly the height of what was removed.

That's the interaction between the two deep dives, and it's the bug that makes live chat feel broken in a way users can't articulate. Two ways out:

- **Freeze a bounded reading snapshot and keep a separate bounded live tail.** The reader stays anchored while incoming data replaces only the tail. Long reads can outlast retained history, so show that boundary instead of accumulating indefinitely.
- **Compensate the scroll offset on eviction.** Correct in all cases, and fiddly: it requires knowing the removed rows' exact rendered heights, which a virtualizer may only have estimated.

I'd ship the first with hard budgets: at most 500 reading rows and 500 live rows, plus a bounded unseen count. On returning to live, swap to the recent tail and explain any omitted interval. If moderation removes the anchor, preserve the next visible row and its pixel offset or show a stable removed-content marker. Human attention is not a reliable memory limit.

> "The framing I'd use is that scroll position is a signal of intent, not a number. Once you treat 'is the user at the bottom' as 'does the user want to follow', the rest of the behavior — pinning, the new-comment pill, choosing the frozen snapshot — follows from one explicit mode."

---

## 🔍 Deep Dive 3: Comments Merge, Reaction Snapshots Replace (9 minutes)

The two data types need different protocols. I would use versioned reaction snapshots for recoverability; that is a deliberate extension of the local interval-delta protocol.

### Two different kinds of truth

| | Comments | Reactions |
|---|----------|-----------|
| Server behavior | Selected batches with explicit cursor coverage | **Versioned absolute counts** |
| Interval | 100ms | 500ms |
| Message content | IDs, items, covered cursor range | Epoch, version, totals by like/love/haha/wow/sad/angry |
| Client operation | Merge by ID; apply moderation versions | **Replace only with a newer snapshot** |
| Volume dependence | Grows with rate | Constant — O(reaction types) |

**Reactions are not events by the time they reach the client.** Individual reaction identity is discarded at the aggregator, so the client receives a number, not a stream. Any UI implying per-user reactions — "Alice reacted", a distinct animation per person — is inventing information that doesn't exist.

### What that permits and forbids

It **permits** a much cheaper rendering path. Reaction counts are a handful of numbers updating twice per second, so they can re-render freely; no virtualization, no windowing, no memory concern. The client payload depends on the number of types rather than the number of taps. Server admission and aggregation still scale with those taps, and client animation needs its own hard cap.

It **forbids** faithful floating-heart animations. The familiar effect — individual hearts drifting up as each person reacts — requires per-event timing that the aggregator destroyed. What the client can honestly do is *derive* an animation from the delta: the count rose by 40, so emit some hearts over the next interval. That's a visualization of a rate, not a reproduction of events, and I'd be explicit that it's a synthesized effect rather than pretending otherwise.

The alternative — sending individual reaction events to preserve fidelity — reintroduces exactly the per-message cost the aggregator exists to eliminate, for the least information-dense message type in the system. **Aggregation is the right call and the animation compromise is its real price.**

### Optimistic reactions, non-optimistic comments

A reaction can animate immediately on tap, while the numeric total remains server-authoritative. I'd keep at most 60 active decorative particles, each with an absolute two-second lifetime; reduced-motion mode skips them. A comment is individually meaningful, so I prefer a visible pending receipt beside the composer and add it to the confirmed view only after acceptance. Optimistic comments with explicit status are also viable, but require reconciliation; neither design should disguise an uncertain post as confirmed. A saved comment may later be hidden or omitted from another viewer's selected feed.

---

## 🛡️ Moderation and Rate Limiting Are Client Concerns Too

The production server must enforce bans and rate limits; the client makes both comprehensible. Locally, limits run on writes but bans are checked only at socket join, fail open on query errors, and are bypassed by HTTP posting. Those are implementation gaps, not a sufficient security contract.

**A rate-limited comment must not look like a lost comment.** If a user exceeds the shared budget and a post is rejected, silently dropping it is indistinguishable from a network failure — and they'll retry, hitting the limit again. The composer should show the constraint before it's hit (a cooldown indicator) and explain the rejection when it happens, with the text preserved so nothing is retyped.

**A banned user needs to know they're banned.** A composer that accepts input and silently discards it is worse than a disabled one. The honest version disables the input with a reason.

The general principle: **every server-side rejection needs a client-side story.** Rate limits, bans, and stream-ended states are all cases where the naive client shows nothing and the user concludes the product is broken.

There's a subtlety with rate limits specifically. They're enforced in Redis across gateway instances, so the client cannot compute its own remaining budget reliably — a second tab shares the same limit. Any client-side cooldown is therefore a *hint*, and the server's rejection is the truth. The UI should treat its own timer as advisory and always defer to the response.

---

## 🔌 Connection Lifecycle and Backfill

Joining a stream needs history, and the same race applies as in any live system: fetch history, then subscribe, and anything published in between is lost.

The demo subscribes and then loads a capped recent view, using Redis when nonempty and PostgreSQL otherwise. It can deliver live frames before the history batch, and the browser simply appends both. My proposed client **subscribes, buffers, installs a snapshot at watermark N, then applies the compatible tail after N**, with a bound and an explicit reset if the history expires.

**That's the frontend payoff of separating identity from progress.** Stable comment IDs support exact deduplication; an authority-issued cursor supports replay and ordering. Snowflake IDs are represented as strings to avoid JavaScript number precision loss, but their uniqueness requires unique worker IDs and safe clock handling. Random UUIDs plus a server ordering cursor are also a valid design.

The caveat worth stating: a clock running 200ms fast produces IDs that sort later than contemporaneous IDs from another node. That is not commit order, and the local PID-based worker assignment and clock rollback handling can also cause collisions. I'd use the proposed stream cursor for progress rather than infer missing messages from numerical gaps between IDs.

On reconnect, resume from the last applied cursor or accept an explicit snapshot reset. A WebSocket provides no application replay by itself. The demo re-fetches only the most recent 50 comments, which cannot close a gap larger than that and can duplicate rows already retained. Reject messages from an old account/stream/subscription generation.

---

## 🧭 Questions I'd Ask First

**"What's the realistic peak comment rate, and what's the p99 viewer device?"** Those two together set the entire rendering budget. A thousand per second on modern desktops is a different problem from two hundred per second on low-end Android, and the second is harder.

**"Is scrollback a product requirement?"** If someone must read the whole stream, keep the bounded live window and add separately paginated history. Cache retention does not establish the product requirement, and it does not imply that the database discarded older records.

**"Do comments need moderation visible to viewers?"** Deletion means the feed needs versioned removals and an anchor fallback; it is part of the proposed contract. Removing an item from the middle of a virtualized, bottom-anchored list is meaningfully harder than appending to it.

> "The scrollback question is the one I'd insist on, because 'keep the last 500' and 'keep everything' are not the same component with a different constant — they're different architectures."

---

## 🗄️ State: Bounded by Construction

| State | Shape | Bound |
|-------|-------|-------|
| Comments | ID-indexed selected live tail, optional frozen reading snapshot | **500 entries each, independently bounded** |
| Reaction counts | Stream-scoped totals plus epoch/version | O(types); animations capped separately |
| Pending own comment | Single item | One at a time |
| Scroll intent (following / reading) | Boolean | — |
| Connection state | Enum | — |

**The eviction policy is a first-class design decision, not an implementation detail.** Most stores grow until something forces the issue; this one is designed around a cap from the start, because the alternative fails predictably on any stream left open.

In the proposed snapshot protocol, reaction totals are *the server's numbers*: accept only newer versions and replace the current total. A tap animates separately. In the demo, adding deltas is correct, but missed frames leave a short count forever because no cumulative baseline is loaded. Clear all stream-scoped state when switching subscriptions.

The pending-own-comment slot is deliberately singular. Allowing a queue of unsent comments invites the user to type three while disconnected and then dump all three at once on reconnect — which reads as spam, trips the rate limiter, and arrives out of context minutes after the moment they were reacting to. One at a time, with the composer reflecting that, is both simpler and better behaved.

---

## 🕳️ The Gap the Client Can't See

Worth raising unprompted, because it's the failure mode this architecture accepts and the frontend inherits.

Redis Pub/Sub is **at-most-once**. If a gateway instance briefly loses its Redis connection, it silently misses batches — and the viewers attached to it get a hole in their comment stream with no error, no gap indicator, and no way for the client to know. Their conversation just skips.

The client cannot detect this today, because nothing in the message carries sequencing. **An ordered cursor with explicit coverage would make gaps observable**: the client knows which accepted range a frame covers and which omissions were selection policy. This requires a shared ordering authority, durable replay, and retention/reset behavior; independently numbering batches on each gateway is insufficient. A capped recent list cannot repair an arbitrarily old gap.

Until then, the honest position is that the client displays what it received and cannot claim completeness. That argues against any UI element that implies a total — a comment counter derived from what arrived locally will drift below the true count, and slowly, which is worse than being obviously wrong.

The related case the client *can observe* is its own reconnect. A backfill repairs only the retained range. If the previous cursor is too old, show a reset rather than claiming completeness.

---

## ♿ A Live Log Is Hostile to Screen Readers by Default

The same problem as any streaming log, and worse at this volume.

**Announcing every comment is unusable.** An `aria-live` region on a list receiving a hundred items per second produces an unbroken stream of speech that can never be interrupted or navigated. `polite` doesn't help — it queues, so the backlog grows unboundedly behind the stream.

What I'd do: **don't make the live list a live region at all.** Instead, give the user explicit control — a "read latest comments" affordance that announces a small, bounded number on demand. That inverts the model from push to pull, which is the only version that works at this rate.

Reaction summaries can be announced on demand or at a slow, coalesced interval if the user opts in. Updating six totals twice a second is still too much speech; the fact that counts are compact does not make every change worth announcing.

The composer must also never lose focus when comments arrive. Remounting the focused input with an unstable key can steal focus mid-typing — the fastest way to make this UI unusable with a keyboard.

---

## 🧪 Testing Under Load and Under Failure

Manual testing on a quiet stream exercises none of what matters here.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Sustained firehose | Inject 1,000 comments/sec for a minute | Frame budget; composer stays responsive |
| Eviction while reading | Scroll up, then flood | Scroll position doesn't jump — the subtle bug |
| Auto-follow threshold | Scroll up 50px, then 500px | Follow disengages deliberately, not from momentum |
| Backfill/live merge | Publish and hide during snapshot fetch | Watermark/coverage respected; no duplicates or stale content |
| Reconnect | Drop and restore the socket | Re-backfills rather than assuming continuity |
| Reaction count drift | Miss, duplicate, or reorder snapshots after a tap | Newer totals replace; animation is not counted again |
| Rate limit | Post faster than allowed | Text preserved, reason shown |

The first two are the ones that require deliberate setup and catch the defects users actually report. **A test that renders ten comments proves nothing** — this component is only interesting at rate.

I'd drive the load test from a recorded or generated event stream rather than a live backend, and assert on **dropped frames and heap growth**, not on rendered output. Those are the failure signals; "did the comment appear" passes right up until the page freezes.

---

## ✍️ The Composer Is Half the Product

Easy to under-design, because it looks like a text input, and it's the surface every viewer touches.

**It must preserve focus and recoverable text.** A stable input key avoids remounts; local draft state and narrow store selectors reduce unnecessary work. Normal parent re-rendering does not inherently lose focus or text. Controlled-state resets and unstable component identity are the bugs to look for, alongside expensive reconciliation that delays keystrokes.

**Posting is not optimistic in the confirmed list** (per Deep Dive 3), so show the pending operation explicitly. Preserve its text and ID until a correlated receipt resolves it. An unknown result retries the same operation; a rejection offers an editable draft. An unrelated live echo cannot prove that my post succeeded, and a server-confirmed author receipt must survive feed sampling.

**For a multiline composer**, offer Enter-to-send and Shift+Enter for a newline on desktop, while avoiding sends during IME composition. On mobile, retain an explicit Send button and make return-key behavior clear. The local demo uses a single-line input, so multiline behavior would be an extension.

**Character limits should be visible before they're hit**, not enforced by silently refusing keystrokes. A counter appearing as the limit approaches is informative; an input that stops accepting characters with no explanation reads as a bug.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| List size | ✅ Bounded window, evict old | ❌ Keep everything | Bound the live view; paginate older history separately |
| Rendering | ✅ Virtualize with measured heights | ❌ Render all rows | DOM size must not track stream duration |
| Ingest | ✅ Coalesce to one update per frame | ❌ Update per message | Reduces redundant reconciliation; parsing still costs work |
| Render throttling | ✅ Per-frame | ❌ Debounce hundreds of ms | Longer delays destroy liveness |
| Auto-scroll | ✅ Follow only when near bottom | ❌ Always scroll | Yanking a reading user is the top complaint |
| Eviction while reading | ✅ Bounded snapshot plus live tail | ❌ Suspend all eviction | Long reads cannot remove memory limits |
| Comments | ✅ Merge by ID, server-confirmed | ❌ Optimistic | Individually identifiable; a vanishing comment is visible |
| Reactions | ✅ Replace versioned total; animate tap separately | ❌ Unsequenced deltas forever | Missed totals recover from a newer snapshot |
| Reaction animation | ✅ Synthesized from deltas | ❌ Per-user hearts | The data to do it faithfully doesn't exist |
| Merge/dedupe | ✅ Stable ID plus stream cursor | ❌ Infer progress from Snowflake gaps | Identity and ordering are separate contracts |
| Live region | ✅ On-demand/bounded summaries | ❌ Announce every change | Avoids an endless speech backlog |

---

## 📱 The Mobile Case Is the Real Case

I would assume a mobile-heavy audience and validate that with the interviewer. Phone constraints make several of these decisions essential to the experience.

**Memory pressure is the binding constraint.** A desktop browser will tolerate a large list; a phone will terminate the tab. That makes the bounded window non-negotiable rather than a nicety, and it argues for a smaller window than the desktop would need.

**Backgrounding is constant.** A viewer switches apps and returns; the socket dropped, the timers were throttled, and the accumulated state may be minutes stale. On foreground return, reconcile the cursor and authoritative state, using replay if available and reset otherwise. While hidden, stop decorative work and bound or suspend the subscription; pausing rendering alone still leaves incoming parse and memory costs.

**The composer competes for the viewport.** On a phone the keyboard consumes half the screen, so the comment list shrinks precisely when the user is most engaged. Auto-scroll behavior has to survive that resize without losing position — a viewport change is not a user scroll, and treating it as one disengages follow mode at exactly the wrong moment.

**Touch scrolling has momentum.** The near-bottom threshold from Deep Dive 2 needs to be more forgiving on touch than on a mouse wheel, or an inertial flick briefly overshoots and disengages auto-follow when the user intended to stay.

---

## 🚀 What Breaks First

**The composer, not the list.** The first symptom of a rendering problem is laggy typing, because reconciliation and keystrokes share the main thread. That's worth knowing because it sends people debugging the input when the cause is the list beside it.

**Then scroll anchoring during eviction**, described above — the bug users feel and can't describe.

**Then memory on mobile.** A phone with a two-hour stream open is the real constraint, and it's why the bounded window matters more than any other single decision here. The window size is the one number I'd tune with real device data rather than intuition.

**Then reconnect storms.** When a stream ends or a gateway restarts, every viewer reconnects simultaneously. The client contributes by jittering its reconnect delay rather than retrying on a fixed timer — without that, the whole audience returns in lockstep and the backfill request lands as one spike.

This is the clearest case of a client-side decision with server-side consequences: a fixed 1-second retry across 100,000 viewers is a synchronized 100,000-request burst every second against an already-struggling gateway. Jitter, a maximum retry budget, and server retry guidance spread attempts, though capacity planning and admission controls are still required. A permanent stream-ended response should stop retrying.

**Bandwidth belongs near the top of the list.** At 1,000 comments/second and only 200 serialized bytes each, one viewer receives 200 KB/second, or 12 MB/minute, before video and overhead. Batching saves framing work, not that payload. A selected feed capped at 20 comments/second would carry about 4 KB/second under the same assumption. Admission policy, parser work, memory, and rendering all need explicit budgets.

---

## 📝 Summary

Three ideas:

1. **The client needs its own version of the server's batching insight.** The gateway batches to save syscalls; the browser must window, virtualize and coalesce to save frames. They're separate fixes to the same underlying volume, and solving one doesn't solve the other.
2. **Scroll position is intent.** Treating "near the bottom" as "wants to follow" resolves auto-scroll, the new-comment pill, and when to show a frozen reading snapshot from a single mode — and it's why eviction and scroll anchoring are one problem rather than two.
3. **Let the data's semantics choose the strategy.** Comments are individually meaningful, so my confirmed view merges them by ID after acceptance and applies later moderation changes. Reactions are meaningful in aggregate: the local delta protocol requires addition, while my versioned snapshot proposal requires replacement and repairs missed updates. Animation is a separately capped approximation. The client must respect the actual wire contract rather than guess semantics from the word "counts".


## 🔎 Local Implementation Checkpoint

The proposal above extends the [current architecture](./architecture.md#implementation-notes). The local [store](./frontend/src/stores/appStore.ts) retains 200 entries, appends duplicates, and accumulates reaction deltas across stream selections. The [list](./frontend/src/components/CommentList.tsx) is not virtualized; it always scrolls on length changes and stops triggering that effect once the length stays at 200.

The [socket hook](./frontend/src/hooks/useWebSocket.ts) retries after a fixed three seconds, can reconnect from stale cleanup callbacks, and logs posting errors without restoring text. The [floating reactions component](./frontend/src/components/FloatingReactions.tsx) restarts all removal timers whenever another reaction arrives, so sustained traffic defeats its intended two-second lifetime. These are specific gaps to investigate, not performance guarantees already achieved.
