# Facebook Live Comments — Full-Stack System Design Answer

A 45-minute interview proposal for a live comments experience. The production design
deliberately extends the local demo; it is not a description of Facebook's internal
implementation.

## 🎯 Frame the Experience — 4 minutes

> “I would design the path from pressing Send to receiving a durable result and showing
> useful conversation to the audience. The browser's rendering budget and the server's
> delivery contract have to agree.”

The viewer watches a video, reads recent comments, posts plain text, reacts, and moves
between following the newest messages and reading older ones. A moderator can remove
content, pin a limited amount of context, or ban a writer. Video ingest and delivery are
separate; I would draw that system as an external dependency.

I would clarify whether everyone must see every accepted comment. For a huge live event,
that can be both expensive and unreadable. My starting assumption is a selected live feed
with an explicit cap, separate from the durable record of accepted comments.

| Requirement | Proposed behavior |
|-------------|-------------------|
| Posting | One recoverable pending comment; explicit acceptance or rejection |
| Latency | Healthy-path p95 acceptance-to-display below 500 ms |
| Join | Recent context within a target of one second |
| Reading | Do not move a reader merely because new comments arrive |
| Long sessions | Bound list data, queued frames, and animations |
| Recovery | Resume a supported cursor or explain a reset |
| Availability | 99.9% monthly regional posting target |

These are requirements to validate, not measured results. I would ask about low-end devices,
network conditions, peak comment volume, history retention, and moderation expectations.
Offline queues that replay old comments minutes later are outside the initial scope.

## 🏗️ Draw the Boundaries — 5 minutes

```
┌───────────────────────┐       ┌───────────────────────┐
│ Composer + receipt    │       │ Video / live feed UI  │
│ Recoverable text      │       │ Reading / follow mode │
└───────────┬───────────┘       └───────────▲───────────┘
            │                               │
            ▼                               │
┌──────────────────────────────────────────────────────┐
│ Browser controller + stream-scoped store             │
│ Subscription generation / merge / resource budgets   │
└───────────────────────────┬──────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────┐
│ Session-aware API + WebSocket gateways               │
└────────────┬───────────────────────────▲─────────────┘
             ▼                           │
┌───────────────────────┐       ┌───────────────────────┐
│ SQL writer            │──────▶│ Outbox / feed service │
│ Comment + receipt     │       │ Selection + replay    │
│ Ordered change        │       │ Reaction snapshots    │
└───────────────────────┘       └───────────────────────┘
```

The composer owns draft text and a pending operation. The connection controller owns
transport and subscription lifecycle. The stream store owns normalized comments, bounded
view state, and aggregate versions. Components subscribe narrowly so reaction animation does
not invalidate the entire page.

The server owns actor identity, writable stream state, moderation, durable acceptance, and
replay boundaries. Gateways distribute a selected stream view to their connected audience. A
static asset CDN is useful, but it does not supply the live mutation semantics shown here.

I would use React and TypeScript with a small store such as Zustand, a measured virtualizer,
and a same-origin authenticated socket. PostgreSQL stores accepted comments, operation
receipts, and an outbox transactionally. Redis/Valkey can accelerate recent views and
Pub/Sub fan-out, with replay supplied by durable data rather than Pub/Sub itself.

At 100,000 viewers and 1,000 comments per second, a 200-byte comment assumption gives 200 KB
per second per viewer and 20 GB per second across the stream. That is 12 MB per minute per
viewer before video and protocol overhead.

Batching every 100 ms lowers frame/send frequency without lowering those payload bytes. A
selected feed capped at 20 comments per second reduces the same estimate to 4 KB per second
per viewer. I would label the selection policy and independently confirm the author's own
accepted post.

This choice connects the backend directly to the UI: a 500-entry window lasts only half a
second at the full 1,000-comment rate. A virtualizer cannot make that conversation readable
or eliminate network and parsing costs.

## 🔍 Deep Dive 1: The Send Button Needs a Contract — 10 minutes

### Draft, pending, and confirmed are different states

> “A socket send succeeding tells me that the browser queued bytes. It does not tell me that
> the server saved the comment. I would make the pending operation visible instead of
> letting the user infer success from an empty input.”

The composer keeps text locally. On submit it validates basic length and session state,
creates an operation ID, and retains the original text with that ID. I would allow one
pending comment at a time in the first version; a queue of stale comments arriving after a
long outage is poor behavior for a live conversation.

| State | UI behavior | Allowed next step |
|-------|-------------|-------------------|
| Draft | Editable text and clear character budget | Submit |
| Pending | Visible sending receipt; original text recoverable | Wait or retry the same operation after uncertainty |
| Accepted | Stable comment ID; confirmed author view | Start a new draft |
| Rejected | Reason and editable original text | Correct content or wait for policy cooldown |
| Unknown | Explain connection/timeout uncertainty | Query/retry the same operation |

I would not insert the pending item as confirmed audience content. It can appear beside the
composer as a status row. Fully optimistic comments are also possible, but they require
identity reconciliation and a truthful failed state; they do not remove the receipt
requirement.

Normal React re-renders do not inherently lose input focus. Unstable keys, remounts, and
state resets do. Keep the composer identity stable, use local draft state, and avoid
subscribing it to every incoming comment array.

For a multiline composer, handle IME composition and make Enter/Shift+Enter behavior
explicit. On mobile, a visible Send control matters. A keyboard viewport resize is not
evidence that the user intentionally left follow mode.

### The backend resolves the operation

1. Authenticate the actor from the session, not a supplied user ID.
2. Check stream access, current live status, ban policy, and bounded content.
3. Resolve an existing actor/operation receipt with the same request digest.
4. Reject operation-ID reuse with different text or another stream.
5. Commit comment, accepted stream position, receipt, and outbox work together.
6. Return a correlated acceptance receipt and publish through the recoverable relay.

A retry can race the original request. Database uniqueness on the actor/operation identity
resolves that race; separate cache GET and SET commands do not. The receipt's digest
distinguishes a real retry from accidental ID reuse.

The receipt should survive the promised retry horizon. An operation older than that horizon
needs an explicit expiry policy, rather than silently becoming a fresh post. The frontend
must know when automatic recovery is no longer supported.

If the server commits and the connection closes before the acknowledgment reaches the
client, the user sees an unknown outcome. Retrying the same operation returns the same
comment. Clearing the draft and generating a new operation would turn a transport problem
into duplicate conversation content.

If the outbox relay publishes twice after a crash, the feed deduplicates by stable event
identity. The acceptance transaction does not imply exactly-once network delivery. Consumers
and the browser still need duplicate handling.

### Sampling must not erase the author's receipt

A selected feed may exclude a perfectly valid accepted comment for ordinary viewers. The
author therefore receives a direct receipt and a confirmed author view independent of
sampling. That receipt means saved; it does not claim that the entire audience read the
post.

If moderation hides the comment later, the author can see the updated status. The server
should not replay the old text from a cached receipt into a view where it is now hidden.
Acceptance and current visibility are separate facts.

| Decision | Why I choose it | Cost of the choice |
|----------|-----------------|--------------------|
| ✅ Pending receipt outside confirmed feed | Honest status through retries and sampling | Slightly more composer state |
| ✅ Transaction plus outbox | Saved operations survive the publish gap | Database round trip and relay maintenance |
| ❌ Treat live echo as acknowledgment | Easy on the happy path | Sampling, duplicates, and lost frames make it ambiguous |
| ❌ Queue many offline comments | Lets users keep submitting | Stale bursts, rate-limit collisions, unclear recovery |

A rate limit is enforced on the server across tabs and gateways. The client may show an
advisory cooldown, but it cannot calculate the global remaining budget by counting its own
sends. Correlated rejection and retry timing preserve text and explain what happened.

## 🔍 Deep Dive 2: Live Updates, Reading, and Reconnect — 9 minutes

### One store, different views

I would normalize comments by stable ID and retain their accepted position and moderation
version. The live list is a bounded ordered set of IDs, not an ever-growing transcript. A
measured virtualizer renders only visible rows with some overscan.

The store owns the resource budget, while the list owns measured layout and the current
anchor. Coalescing ingress to an animation frame reduces redundant state work; it is not
permission to buffer unlimited frames before the next render.

| Mode | Data retained | Scroll behavior |
|------|---------------|-----------------|
| Following | Latest selected tail, perhaps 500 entries | Follow after layout if the user remains near the bottom |
| Reading | Frozen snapshot up to 500 plus a separate 500-entry live tail | Keep the anchor and show bounded unseen activity |
| Returning to live | Current bounded tail | Explicit jump; show if older context expired |
| Historical browsing | Separately paginated authorized history | Stable paging independent of live arrivals |

I would not suspend all eviction while the reader is scrolled up. That makes memory
proportional to how long someone reads or leaves the tab open. Human attention is not a
reliable bound.

A frozen snapshot simplifies anchoring but creates an explicit history boundary. If
moderation removes the anchored row, choose the next retained row and preserve its offset,
or replace it with a stable removed-content marker. Do not restore hidden text merely to
avoid a layout shift.

Auto-follow is an intent state, not just a call to scroll to the bottom. Measure proximity
before applying the update, and avoid treating programmatic scroll or keyboard resize as a
deliberate user departure. The new-comment pill provides an explicit way back to live.

### Snapshot and tail must share a boundary

Fetching history and then subscribing creates a gap. Subscribing first and blindly appending
history creates overlap and ordering problems. I would use a snapshot watermark and a
bounded buffer:

1. Authorize the subscription for a stream and selected-view policy.
2. Begin buffering updates for that subscription generation.
3. Load a snapshot whose watermark N states exactly what it covers.
4. Install the snapshot and discard buffered changes already covered through N.
5. Apply the compatible tail after N, deduplicating IDs and respecting visibility versions.
6. If retention or the buffer is exceeded, explicitly reset to a newer bounded snapshot.

The selected feed carries cursor coverage and a selection-policy version. A jump between
displayed comment IDs can be intentional selection; it is not automatically a lost frame.
Raw Snowflake gaps are also meaningless as missing-message counts.

A durable per-stream authority supplies ordering. Clock-sortable IDs help with identity but
need unique worker IDs and clock-rollback handling, and do not prove commit order. Keep
64-bit IDs as strings rather than losing precision in JavaScript numbers.

### Account and stream switches are cancellation events

The connection controller associates asynchronous work with an account, stream, and
generation. On selection change, cancel the old subscription and its retry timers, clear
incompatible state, and reject late callbacks that belong to the previous generation.

Closing a socket is not sufficient if its close callback schedules another reconnect. The
controller needs an explicit disposed/canceled state. It should also guard against duplicate
connecting sockets, not only an already-open socket.

On foreground return, reconcile the subscription cursor and aggregate baseline. If replay is
available, use it; if not, show a reset. While hidden, stop decorative work and cap or
suspend ingestion so throttled timers do not accumulate a hidden backlog.

| Approach | Benefit | Failure/cost |
|----------|---------|--------------|
| ✅ Snapshot watermark plus scoped tail | Deterministic overlap and gap handling | Protocol and lifecycle state |
| ✅ Frozen bounded reading view | Stable reading without unlimited memory | Long reads can require a history transition |
| ❌ Reappend recent history after every reconnect | Simple implementation | Duplicates overlap and loses long gaps |
| ❌ Always scroll on each batch | Keeps the live edge visible | Interrupts readers and keyboard users |

## 🔍 Deep Dive 3: Aggregates and Degradation Across the Stack — 10 minutes

### “Counts” is not a complete protocol

The local demo aggregates reactions into interval deltas and resets them after every flush.
A client with 10 loves that receives 3 should add to reach 13. A cumulative snapshot saying
13 should replace the current value. Confusing those two contracts causes either
undercounting or runaway totals.

I would propose absolute snapshots with a stream epoch and monotonically increasing version.
Join provides a baseline, a newer version replaces the current totals, and an old or
duplicate snapshot is ignored. A missing frame repairs itself when another snapshot arrives.

The server's aggregator must also recover without counting the same input interval twice.
Accepted increment batches need identities and a durable watermark/checkpoint. Sending
totals does not make upstream duplication disappear.

| Information | Delivery policy | Browser behavior |
|-------------|-----------------|------------------|
| Accepted comment | Durable receipt, selected live coverage | Merge identity and position |
| Moderation change | Durable/versioned, replayable | Remove/update even if an older snapshot arrives |
| Reaction total | Periodic versioned absolute snapshot | Replace newer state |
| Decorative particle | Best effort, bounded lifetime | Skip freely under load or reduced motion |
| Viewer estimate | Periodic approximate state | Replace and label meaning clearly |

The user's tap can create immediate visual feedback without incrementing the authoritative
numeric total. Incoming totals can drive a representative animation burst, but the UI must
not imply that every heart corresponds to an identifiable viewer.

I would cap active particles, for example at 60, and give each an absolute two-second
deadline. A new particle must not restart the older particles' removal timers. Per-batch
limits alone do not cap the total retained over a sustained stream.

For screen readers, announce a small summary on request or at a deliberately slow, coalesced
interval. Neither hundreds of comments nor six totals changing twice per second make a
useful live-region announcement. Preserve keyboard focus and offer reduced-motion behavior.

### A budget is needed at every hop

The backend limits incoming comment/reaction rates, batch bytes, and queue growth. The
gateway limits outbound bytes per connection and coalesces replaceable snapshots. The
browser limits parsed buffers, retained comments, measured rows, and animation elements.

The ordinary selected feed could cap at 20 comments per second while keeping a small pin
budget. If the service is overloaded, state the changed policy instead of silently delaying
every comment indefinitely. A comment received minutes late can lose its conversational
meaning.

If a socket queue exceeds its cap, send a controlled reset or close the connection. The
client reconnects with exponential backoff, jitter, and a maximum retry policy, honoring
server guidance. A permanent stream-ended response should not produce a reconnect storm.

Avoid choosing degradation solely by viewer count. A small audience with huge comments or
slow devices may be more stressed than a larger quiet room. Observe bytes, processing time,
consumer lag, and actual device performance.

### Moderation cannot share the animation loss policy

A hide event changes what is allowed to remain visible. It must update connected browsers,
invalidate cached views, and constrain later backfill. Keeping only the SQL flag leaves
existing and reconnecting viewers with stale text.

Bans must be enforced on writes and propagated to already-connected users. A banned composer
should explain the state and preserve the draft as appropriate. A server-side ban check
performed only during join does not protect a long-lived socket.

There is a real latency trade-off in moderation. A cheap synchronous filter permits fast
posting but misses more cases, requiring later removals. A stronger prepublication review
delays appearance and needs a pending-review state. I'd ask which exposure window the
product accepts rather than promise instantaneous complete screening.

| Choice | Why it fits | What we give up |
|--------|-------------|----------------|
| ✅ Versioned aggregate snapshots | Recoverable totals with bounded payload | Exact per-tap timing and attribution |
| ✅ Separate durable moderation events | Visibility stays consistent across replay | More state and invalidation work |
| ❌ Individual reaction firehose | Preserves all event detail | Expensive fan-out for mostly decorative information |
| ❌ One drop policy for all message types | Simple queue implementation | Hidden content can reappear or remain visible |

> “The protocol reflects how much each piece of information matters. A missed animation is
> acceptable. A saved post with no recoverable result, or a removed comment that reappears
> on reconnect, is a different class of failure.”

## 🧪 Integration and Verification — 5 minutes

I would define the small contract shared by browser and server, then test the boundary with
real serialization and controlled failure timing. A shared TypeScript package can reduce
drift, but it is still necessary to validate untrusted payloads at runtime.

| Contract | Fields worth discussing |
|----------|-------------------------|
| Submit comment | Operation ID, stream, text; session supplies actor |
| Result receipt | Operation ID, accepted comment ID or structured rejection |
| Subscribe/resume | Stream, view policy, generation, last applied cursor |
| Snapshot | Compatible view identity, watermark, recent visible records |
| Feed update | Covered range, selected items, moderation versions |
| Reaction snapshot | Stream, epoch/version, absolute counts |

A same-origin HTTP route can provide history and operation lookup, while WebSocket carries
live updates. Both write transports should call the same acceptance service. There is no
reason for a REST-created comment to be durably saved yet omitted from all connected viewers
due to a separate code path.

| Test scenario | Expected result |
|---------------|-----------------|
| Commit succeeds but receipt is lost | Same-operation retry recovers one accepted comment |
| Publish overlaps snapshot load | No duplicates, missed covered range, or stale visibility |
| Switch streams during reconnect | Old callbacks cannot repopulate the new stream |
| Freeze reading view during a long flood | Position and memory remain bounded |
| Drop or reorder reaction snapshots | Only a newer version replaces totals |
| Continuous reactions for two minutes | Particle count stays within its lifetime/count budgets |
| Slow device plus typing and video | Input latency stays within the chosen measured budget |

I would use generated event streams for browser load tests and fault injection for
transactional and replay tests. Check heap trends, queued bytes, input latency, and reset
behavior, not just whether one comment rendered.

Telemetry needs clear boundaries. Writer processing time ends before batching and rendering;
it is not end-to-end display latency. Browser and server wall-clock subtraction also needs
clock-skew handling. Measure each stage and correlate sampled operations without putting
every user ID into metric labels.

## 📝 Close and Implementation Boundary — 2 minutes

> “The frontend stays usable because the server sends a bounded, explicit view. The server
> can acknowledge independently of fan-out because it saves an operation receipt. Recovery
> works because identity, ordering, selection, and subscription lifetime are separate parts
> of the contract.”

The current demo uses React/Zustand and Express/Valkey/PostgreSQL, but it does not implement
that complete protocol. It has a 200-entry nonvirtualized list, a fixed three-second
reconnect, no explicit posting receipt or resume cursor, and separate browser/server types.

Comments are saved synchronously before entering a gateway-local batcher. HTTP posting skips
that batcher. Reaction messages are unsequenced interval deltas; totals are accumulated
without a baseline or stream reset and are not shown numerically. Sustained animation
updates restart old cleanup timers.

Identity selection creates no session, join-only ban checks are incomplete, and the reaction
handler can accept IDs different from the joined context. Moderation helpers do not have
routed UI actions or cache invalidation. The local cache and Pub/Sub do not establish replay
completeness.

Those findings and exact source links are in
[architecture.md](./architecture.md#implementation-notes); actual setup is in the
[README](./README.md). The proposed load figures are discussion assumptions. This review
used source inspection and isolated checks, not a full-stack runtime or performance
benchmark.
