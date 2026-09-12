# Facebook Live Comments — Backend System Design Answer

A 45-minute interview proposal. Production choices below extend the local demo; they are not
claims about Facebook's internal architecture. The implementation boundary appears at the
end.

## 🎯 Scope and Capacity — 5 minutes

> “I would focus on the comments beside the video. The difficult part is accepting
> meaningful posts durably while controlling what a huge audience can actually receive and
> read.”

I would clarify whether the interviewer wants a complete transcript for every viewer or a
selected live feed. That answer changes the system more than the choice of database. Video
ingest, transcoding, and CDN delivery are a separate service; comment latency should not
require rebuilding that pipeline.

The initial features are plain-text comments, recent history, six reaction types, moderator
removals and pins, bans, and recovery after a dropped connection. Replies, rich media, and
arbitrary offline posting are outside the first version. We still need removals, so the feed
cannot be treated as immutable forever.

| Requirement | Proposed target or meaning |
|-------------|----------------------------|
| Posting availability | 99.9% monthly in the initial region |
| Display latency | Healthy-path p95 under 500 ms after durable acceptance |
| Recent view | Target under 1 second, with explicit loading/reset states |
| Acceptance | A saved comment and a recoverable operation result |
| Delivery | Bounded selected feed; completeness is not implied |
| Reactions/presence | Delayed aggregate state; no billing or voting semantics |

These are design targets, not measurements. I'd ask for the audience size, comment rate,
busiest stream, retention requirements, and whether authors need to see their own posts even
when selection excludes them elsewhere.

Consider 100,000 viewers and 1,000 comments per second on one stream. At an illustrative 200
bytes per serialized comment, each viewer would receive 200 KB per second, or 12 MB per
minute. The audience receives 20 GB per second, equivalent to 160 Gbit per second, before
overhead and video.

A 100 ms batch changes roughly 100 million individual-comment sends per second into one
million batched sends, assuming a single stream publisher. It does not remove those comment
bytes. Multiple publishers can also produce more than ten frames per second at each gateway.

If the selected view is capped at 20 comments per second, payload falls to about 4 KB per
second per viewer and 400 MB per second across that audience. I would call this sampling or
selection explicitly. It is a product compromise, not a free optimization.

At a platform average of 2,000 comments per second, the same 200-byte assumption yields
34.56 GB of raw payload per day. Replication, author fields, receipts, events, and indexes
increase the storage requirement. Peak fan-out and average retention need separate
estimates.

## 🏗️ Architecture and Data Model — 6 minutes

I would draw the write authority, durable records, and fan-out path first. The browser and
video service each get one box; this is a backend discussion.

```
┌───────────────────┐       ┌───────────────────────┐
│ Session / API edge│──────▶│ Comment + moderation  │
└───────────────────┘       │ writer by stream      │
                            └───────────┬───────────┘
                                        ▼
┌───────────────────┐       ┌───────────────────────┐
│ Replay / history  │◀──────│ SQL shard             │
│ visibility checks │       │ Comment, receipt,     │
└─────────┬─────────┘       │ order, outbox         │
          │                 └───────────┬───────────┘
          │                             ▼
          │                 ┌───────────────────────┐
          │                 │ Feed + reaction       │
          │                 │ aggregation services  │
          │                 └───────────┬───────────┘
          │                             ▼
          │                 ┌───────────────────────┐
          └────────────────▶│ WebSocket gateways    │
                            │ Interested viewers    │
                            └───────────────────────┘
```

The writer owns permission checks, durable acceptance, and ordering within a stream.
Gateways own connections and bounded outbound queues. The feed service decides which
accepted comments belong in a display view and forwards that view to every gateway with
interested subscribers.

A competing-consumer group is appropriate for dividing persistence work. It is not
sufficient for delivery to all viewers: if only one gateway consumes a stream event, viewers
attached to other gateways miss it. Subscription routing and fan-out must be explicit.

I would begin with PostgreSQL shards because comments, operation receipts, and delivery work
need a transactional commit boundary. Redis or Valkey supplies recent projections, fast
distribution, admission counters, and approximate presence. An outbox relay connects SQL
acceptance to the asynchronous feed without pretending two independent writes are atomic.

| Record | Important identity and fields | Access pattern |
|--------|-------------------------------|----------------|
| User/stream | Actor, stream, owner, status, visibility | Permission and lifecycle checks |
| Comment | Stable ID, stream, accepted position, author, text | Recent and paginated stream history |
| Operation receipt | Actor + operation ID, request digest, result | Retry the same post safely |
| Outbox event | Unique ID, stream/order, change | Recoverable asynchronous publication |
| Moderation state | Target, action/version, authorized actor | Hide/pin and invalidate old views |
| Reaction snapshot | Stream, epoch/version, cumulative totals | Replaceable aggregate state |

An index must follow the actual stream-and-order query. A global comment primary key alone
can require scanning unrelated streams; an index on stream and creation timestamp is not the
same as one on stream and the chosen ordering cursor.

History retention should be a product setting rather than an accidental Redis TTL. Time
partitions support deletion or archival, while recent replay has a smaller explicitly
advertised horizon. A large stream must not become one indefinitely growing Cassandra
partition if we later introduce a wide-column history projection.

## 🔍 Deep Dive 1: What Does “Posted” Mean? — 9 minutes

> “I want the author to know that the system saved the comment, even if the socket drops
> before the reply arrives. That requires a durable operation result, not just a message
> broadcast.”

### Acceptance flow

1. Authenticate the actor and validate the stream, text length, and current write policy.
2. Look up the actor-scoped operation ID and compare the stored request digest.
3. If the same operation already succeeded, return its existing comment ID and result.
4. If that ID was reused for different text or a different stream, reject the reuse.
5. Apply admission limits and commit the comment, stream position, receipt, and outbox event
together.
6. Return an acceptance receipt; let the relay deliver the event asynchronously.

The client creates the operation ID before sending. It retains one pending comment with
recoverable text rather than queuing minutes of stale reactions to the video. A network
timeout is an unknown outcome, not proof of rejection.

A retry with the same ID must not create a second comment. The database uniqueness
constraint is the final arbiter when two retries arrive together. A cache lookup followed by
an insert leaves a race even if each individual cache command is atomic.

The operation digest includes the actor's authorized stream and relevant content fields.
Text hashing alone is insufficient: two intentional identical comments are different
operations, and a retry several seconds later is still the original operation. Parent
identity would also matter if replies were added.

The receipt lifetime must cover the supported retry period. Once it expires, the server
needs an explicit old-operation policy; silently treating an old retry as a new post
reintroduces duplication. Hidden comments also need safe receipt responses that do not
republish removed text.

### Crash boundaries

| Failure moment | Required observable result |
|----------------|----------------------------|
| Before commit | No accepted comment; client may retry the operation |
| After commit, before acknowledgment | Retry returns the saved result |
| After commit, before publish | Outbox relay eventually finds the pending event |
| Publish succeeds, relay crashes before marking it | Duplicate event is possible; consumers deduplicate |
| Cache refresh fails | Saved comment remains accepted; projection is repaired |

The outbox does not make network delivery exactly once. It makes accepted delivery work
recoverable. A feed consumer can encounter the same event twice, so stable event/comment IDs
and version checks remain necessary.

### Why I choose this boundary

| Approach | Benefit | Cost or failure |
|----------|---------|-----------------|
| ✅ Transaction plus receipt/outbox | One durable acceptance boundary | SQL latency, extra records, relay operations |
| ❌ Publish then save | Fast visible echo | A crash can show content that was never durably accepted |
| ❌ Save then publish without outbox | Simple happy path | Crash between writes leaves an accepted but undistributed comment |
| ❌ Wait for every viewer | Strong-looking acknowledgment | One slow/disconnected viewer can stall posting |

A durable log could become the acceptance boundary instead of SQL. That is a valid
alternative at a larger write scale, but I would explain how it stores operation identity
and recovers results before claiming equivalence. Publishing to a log and separately
inserting SQL with no shared authority just moves the same failure problem.

The author receipt should be independent of ordinary-feed sampling. A saved post can appear
in the author's confirmed view while other viewers receive only the selected subset.
“Accepted” cannot promise “shown to every viewer.”

A stream that is ending introduces another race. Admission should revalidate its writable
state within the same authority that commits the post. A check performed seconds earlier at
socket join cannot enforce that boundary.

## 🔍 Deep Dive 2: Fan-out, Ordering, and Replay — 10 minutes

### Batching has two different benefits

Batching reduces the number of envelopes and send operations. Selection reduces the payload
volume. I would keep those separate in the diagram and capacity estimate, because a system
can have efficient framing and still exhaust network capacity.

The feed service uses a maximum delay and maximum byte size, not only a timer. A healthy 100
ms interval fits within the latency budget; the byte cap prevents one delayed interval from
becoming an enormous frame that monopolizes the browser parser.

The selected feed includes a small reserved budget for pins or creator context, with a
stated policy for the remaining comments. It should avoid making reputation or verified
status a blanket permission to flood the feed. Product fairness and moderation are part of
selection, not consequences of the data structure.

### Identity does not establish continuity

A Snowflake-style ID is useful for identity and approximate time order only if worker IDs
are unique and clocks are handled safely. Workers do not need a coordination round trip for
every ID, but assigning worker identities still needs coordination. Clock rollback and
worker reuse need a policy.

IDs should cross JavaScript boundaries as strings. Converting a 64-bit integer to a
JavaScript number can lose identity. Sorting by a wall-clock ID is also different from
ordering durable commits.

I would assign a stream ordering position at acceptance and use it as an opaque cursor. A
cursor can cover comments and moderation changes. It is not the numerical difference between
two Snowflake IDs.

A single stream authority serializes this ordering. That creates a throughput ceiling, so
keep the critical operation small and measure it. Sharding unrelated streams improves
aggregate capacity; it cannot divide a single hot stream's total order for free.

### Join without an unexplained hole

1. Authorize a stream/view subscription and establish its generation.
2. Begin buffering subsequent updates while preparing a snapshot at watermark N.
3. Install the recent snapshot and discard buffered events already covered through N.
4. Apply compatible tail events after N in order, deduplicating by identity/version.
5. If the cursor or buffer is outside retention, return a reset with the new snapshot
boundary.

The selected feed also includes the raw cursor range it covers and its selection-policy
version. Otherwise a client cannot distinguish comments intentionally omitted by sampling
from frames lost in transport. Independent gateway-local batch numbers do not form a shared
per-stream sequence.

A policy change can invalidate the old view; return a new view generation rather than
splicing incompatible selections together. Moderation checks apply to historical reads and
replay, not just the live channel.

### Slow consumers and disconnections

Each gateway maintains a bounded queue per connection. Replaceable reaction/presence
snapshots can be coalesced. Accepted comment coverage and moderation changes cannot simply
be dropped while preserving a claim of continuity.

When that queue exceeds its budget, disconnect or send a controlled reset instruction. The
client can request a fresh bounded view. Keeping an unlimited buffer only turns a slow
device into a memory leak in the gateway.

Redis Pub/Sub is a useful fast distribution path, but a disconnected subscriber loses
messages. Durable replay and cursor checks therefore live outside Pub/Sub. A connected
browser can still miss data when its gateway loses the Redis subscription, so browser socket
reconnect alone does not solve recovery.

| Approach | Benefit | Cost or failure |
|----------|---------|-----------------|
| ✅ Bounded selected feed plus explicit replay/reset | Honest recovery and controlled resources | Omission policy and cursor machinery |
| ❌ Full firehose to every viewer | Complete live transcript in principle | Network cost and unreadable churn dominate |
| ❌ Reappend the last 50 rows | Simple reconnect path | Duplicate overlap and unrecoverable longer gaps |
| ❌ Unlimited gateway buffering | Delays visible disconnection | One slow consumer can consume unbounded memory |

> “The compromise is a bounded live experience with an explicit history boundary. I would
> rather expose that boundary than let a fast-looking stream silently imply completeness.”

## 🔍 Deep Dive 3: Reactions and Moderation Have Different Guarantees — 8 minutes

Reaction traffic can be much larger than comment traffic, but it contains less information
that a viewer needs to see. A count of loves is useful; a faithful timestamped animation for
every tap is not a requirement.

First I would define the action: repeated stream taps are reaction events. They are not
unique votes per account. If the feature were voting or payments, this relaxed aggregate
contract would be inappropriate.

### Deltas versus absolute totals

The local demo emits interval deltas. If a client has 10 loves and receives a delta of 3, it
adds to reach 13. Replacing the total with 3 is incorrect. Conversely, adding an absolute
snapshot of 13 would double-count earlier activity.

For the proposed protocol, I prefer periodic absolute totals with epoch and version. The
browser accepts only newer snapshots and replaces its values. Join/reconnect sends a
baseline; a lost interval repairs itself at the next snapshot.

The server still needs a recoverable aggregation process. Deduplicate accepted increment
batches, maintain an aggregation watermark, and persist/checkpoint totals before publishing
their version. Do not repeatedly add a retried interval to the canonical total.

The client may animate immediately on tap without adding to the authoritative total. It also
derives a small, capped animation burst from incoming activity. Animation is representative,
and missed decoration does not need replay.

| Choice | Why it fits | What it gives up |
|--------|-------------|-----------------|
| ✅ Versioned absolute totals | A newer snapshot repairs missed frames | Intermediate timing and individual identity |
| ❌ Individual reaction delivery | Faithful per-event detail | Much higher fan-out cost for little visual value |
| ❌ Unsequenced deltas forever | Small/simple updates | Lost or duplicate frames permanently drift the total |

Aggregation reduces outbound traffic, not automatically ingestion cost. The local app writes
every reaction to SQL before counting it. At scale, I would isolate reaction admission and
aggregate durable increments rather than let taps exhaust the comment writer's database
pool.

### Moderation is not disposable decoration

A removal must reach current viewers and prevent old cached history from putting the content
back. Persist the hide action and its version, emit an ordered event, and invalidate or
version the cached projection. Retry receipts must respect the latest visibility too.

A ban changes who can write. Recheck it at mutation admission and revoke existing connection
permissions as needed. A join-only ban check allows a viewer who was already connected to
continue posting.

Cheap synchronous rules can reject obvious violations before acceptance. Slower
classification and human decisions can hide content later. This buys latency at the cost of
a temporary exposure window; a stricter policy would keep content pending until review.

I would avoid claiming that a three-word substring filter is a moderation pipeline. It
produces false positives, misses evasions, and has no appeal mechanism. The important
architectural contract is how a decision propagates and survives stale reads.

A pinned comment needs a bounded special display area or priority budget. Unlimited pins
defeat selection bounds. Changing a flag in a database row without notifying gateways does
not update an already-rendered viewer.

## 🛡️ APIs, Operations, and Failure Tests — 5 minutes

I would name a few representative endpoints and messages instead of writing JSON on the
whiteboard. Both HTTP and WebSocket writes should call the same acceptance service and
produce the same durable receipt.

| Interface | Purpose |
|-----------|---------|
| POST `/api/streams/:id/comments` | Submit an authenticated operation |
| GET `/api/streams/:id/comments` | Authorized paginated history or bounded replay |
| Subscribe stream/view + cursor | Snapshot or resume with explicit generation |
| Comment receipt | Accepted/rejected/unknown resolution for the operation |
| Selected comment batch | Items, moderation changes, and cursor coverage |
| Reaction snapshot | Newer absolute totals and aggregation version |

The proposed paths can retain the demo naming, but the contracts add authentication,
receipts, validation, and cursors. A TypeScript interface is not runtime validation for an
arbitrary socket client.

Admission should constrain text bytes, message rate, concurrent connections, stream access,
and current ban/status. User identity comes from the session. Never trust a payload's user
ID simply because it matches another value that the caller supplied during join.

For viewer counts, sum leased gateway contributions and define whether “viewer” means
socket, device, or account. One server must not overwrite a global count with its local room
size. Expiring leases handle crashes, with a stated delay before the count catches up.

Useful metrics are acceptance latency, outbox age, replay/reset rate, queue bytes,
selected-versus-accepted volume, and moderation propagation delay. Bound metric labels;
putting every user ID on a rate-limit metric creates a second scaling problem.

| Fault to inject | Invariant to verify |
|-----------------|---------------------|
| Same operation arrives twice concurrently | One accepted record and one durable result |
| Writer dies after commit but before publish | Relay recovers the accepted event |
| Gateway loses Pub/Sub while socket stays open | Cursor gap triggers replay/reset |
| Hide overlaps a snapshot load | Older history cannot restore hidden content |
| Slow socket during a hot stream | Queue stays bounded and reset is explicit |
| Duplicate reaction interval | Canonical total does not increment twice |

Circuit breakers reduce repeated calls into a failing dependency. Their timeout does not
prove that the database canceled the underlying insert. Treat a timed-out write as
potentially committed until the receipt resolves it.

## 📝 Close and Local Boundary — 2 minutes

> “My design has three commitments: save the author's operation durably, bound the
> audience's selected feed honestly, and make recovery distinguish a real gap from
> intentional omission. Reactions can repair from newer totals; moderation cannot be treated
> as optional animation.”

The local implementation is much smaller. It uses PostgreSQL before an in-memory batcher,
Valkey Pub/Sub, and a recent list capped at 1,000 entries. It has no outbox, authenticated
session, replay cursor, acknowledgment message, or adaptive selection.

Its default Snowflake worker is PID modulo 1024 and does not handle clock rollback. Comment
retry suppression uses a content hash and a one-second bucket with separate cache
reads/writes. Neither transport passes the optional service idempotency key.

HTTP posting does not enter the WebSocket batcher. Bans apply only at join, and the reaction
handler does not compare payload identity/stream with the joined context. Hide/pin helpers
are not routed and do not invalidate cache. Viewer counts are local values written over a
shared field.

Those boundaries are traced to source in
[architecture.md](./architecture.md#implementation-notes). The README provides actual setup
commands. No load benchmark or full-stack runtime was performed during the documentation
review; the production capacities are assumptions for discussion.
