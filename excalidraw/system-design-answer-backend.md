# Excalidraw: Backend System Design Interview

## 🎯 Scope and Requirements — 5 minutes

> “I’ll design the backend for a shared drawing board. The central promise is that
> collaborators converge on the same accepted scene, and a drawing acknowledged as saved
> survives a room server restart.”

I would first clarify whether collaboration means several people editing while connected, or
independent copies merging after days offline. Those are different products. I’ll support
connected collaboration, short disconnections, and recoverable local drafts. Unrestricted
offline merging and character-by-character text collaboration are extensions that could
justify a mature CRDT library.

Users create drawings, open private or public boards, invite viewers or editors, and
manipulate rectangles, ellipses, diamonds, lines, arrows, freehand strokes, and text. Owners
manage access. Public visibility permits reading; it does not grant editing. We need
presence and cursors, but losing a cursor update is acceptable. Losing an acknowledged shape
edit is not.

I would defer image uploads, comments, rich text, and export rendering. They can be added
around a stable scene model. Export would consume a specific committed scene revision so it
cannot mix several collaborators’ intermediate states.

| Requirement | Initial target or decision |
|-------------|----------------------------|
| Editing feedback | Immediate local draft; no network round trip before drawing |
| Peer previews | Regional p95 below 150 ms under the supported workload |
| Durable acceptance | Regional p95 below 250 ms for ordinary commands |
| Availability | Proposed 99.9% regional service availability |
| Crash recovery | No acknowledged edit lost on a room process crash |
| Initial board profile | Approximately 1,000 elements and up to 20 collaborators |
| Offline behavior | Preserve drafts; reconcile before claiming acceptance |

These are design targets, not benchmark results from the repository. Durability also depends
on database configuration and the stated fault model; surviving a process crash does not
automatically imply surviving an entire region’s loss.

For a capacity estimate, assume 5,000 active boards and four connected people per board.
That gives 20,000 sockets. If 10% of those users finish two editing gestures each second, we
receive 4,000 durable commands per second. At an assumed 500 bytes per command, that is 2
MB/s, or 172.8 GB/day if that peak persisted all day, before indexes and replication.

Presence can exceed durable traffic. If one quarter of connected users send cursor updates
at 10 Hz, that is 50,000 incoming updates each second. Sending each to three peers at 200
bytes means about 30 MB/s of outgoing payload. I would size and limit these paths
separately.

## 🏗️ Architecture and Data Model — 7 minutes

> “I’ll assign one active authority to each drawing. It validates commands, commits their
> order, and distributes canonical results. Persistent connections carry both reliable edits
> and disposable presence, with different handling for each.”

```
┌──────────────────────┐     ┌──────────────────────┐
│ Browser collaborators│────▶│ Session / access API │
└──────────┬───────────┘     └──────────┬───────────┘
           │                           │
           ▼                           ▼
┌──────────────────────┐     ┌──────────────────────┐
│ WebSocket gateway    │────▶│ Drawing authority    │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ PostgreSQL log/state │
                             └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ Snapshot workers     │
                             └──────────────────────┘
```

The authority is a logical role, not necessarily a separate deployment on day one. One
process can own many rooms. A routing layer maps a drawing to its owner. Adding processes
later requires exclusive ownership with fencing, not just sharing cursor messages through
Redis.

PostgreSQL holds identities, permissions, accepted commands, receipts, and snapshot
metadata. Initial scene snapshots can also live there. Object storage becomes useful when
snapshot sizes and retention justify a separate lifecycle. Redis may cache routing or
distribute presence, but a Redis notification is not the durable record of an edit.

| Record | Important fields | Purpose |
|--------|------------------|---------|
| User | ID, username, email, password hash | Identity and session lookup |
| Drawing | ID, owner, title, visibility, generation, current sequence | Board identity and accepted revision |
| Membership | Drawing, user, view/edit permission | Authorization independent of client UI |
| Element | ID, lifecycle generation, geometry/style/text revisions | Conflict boundaries within a drawing |
| Command receipt | Drawing, actor, operation ID, body digest, outcome | Safe retries and lost-acknowledgment recovery |
| Accepted event | Drawing, sequence, canonical change, actor | Replay and ordered distribution |
| Snapshot | Drawing, covered sequence, content reference, checksum | Bound recovery cost |
| Owner epoch | Drawing, fencing epoch, owner | Reject writes from a superseded room owner |

The receipt, state transition, sequence allocation, and accepted event must commit together.
Otherwise a retry could either duplicate an effect or receive a receipt for an effect that
never became durable.

Elements have stable IDs and explicit stacking order. I would start by assigning creation
order from the accepted server sequence. If bringing objects forward becomes a feature, it
needs an explicit ordering command. Array insertion order on each browser is not a shared
ordering rule.

Geometry forms one consistency group: position, dimensions, and relative stroke points must
describe one coherent shape. Style is another group, and text content is another. That lets
a move and a recolor succeed independently without promising to merge every possible
concurrent edit.

| Interface | Purpose |
|-----------|---------|
| POST /api/drawings | Create a drawing with a retry-safe creation receipt |
| GET /api/drawings | List accessible drawing summaries with pagination |
| GET /api/drawings/:id | Read authorized metadata and a snapshot cursor |
| POST /api/drawings/:id/collaborators | Owner grants a role |
| DELETE /api/drawings/:id/collaborators/:userId | Owner revokes a role |
| WebSocket join | Authorize subscription and establish a sequence boundary |
| WebSocket command | Request a durable scene change |
| WebSocket acknowledgment/event | Return canonical outcome and accepted sequence |
| WebSocket presence | Relay bounded cursor and connection state |

These describe the proposed contract. I would not let an unrestricted HTTP whole-scene
update bypass the same authority used by WebSocket commands.

## 🔧 Deep Dive: Ordering and Concurrent Edits — 9 minutes

> “I’ll choose server-ordered commands with conditional property-group revisions. That gives
> us a small, explainable conflict model for connected drawing. It is not a claim that a
> version number turns arbitrary object replacement into a CRDT.”

Consider Alice moving a rectangle while Bob changes its color. Alice’s command names the
geometry revision she observed; Bob’s names the style revision he observed. The authority
accepts both if their respective expectations still hold. The resulting element contains the
accepted geometry and the accepted color.

Now suppose Alice and Bob both move the same rectangle from geometry revision 12. The first
accepted command advances that group. The other receives a conflict with the current
geometry. We preserve the losing user’s draft and let them reapply deliberately as a new
command. Silently accepting both against the same base would conceal that one person’s
intention displaced the other’s.

The exact boundary matters. Treating every numeric field independently could combine one
user’s x coordinate with another user’s width, creating a shape neither intended. Treating
the entire element as one field would make a harmless recolor conflict with a move. Property
groups express the invariants users recognize.

A command carries a stable operation ID, a drawing generation, its target element, the
expected group revision, and the intended change. The authenticated connection supplies the
actor identity. The server never trusts a claimed username or user ID in the payload as
authorization.

For each command, the authority follows a short sequence:

1. Validate size, shape type, finite coordinates, point count, and allowed fields.
2. Verify current edit permission and the drawing’s lifecycle generation.
3. Look up the actor-scoped operation receipt and compare its body digest.
4. Check the ownership epoch and the expected property-group revision.
5. Commit the canonical change, next sequence, event, and receipt atomically.
6. Acknowledge the sender and distribute the same canonical event to peers.

A repeated operation ID with a different body is a conflict, not a new edit. A repeated ID
with the same body returns the recorded outcome. Retries therefore do not depend on a client
clock or on whether the first response reached the browser.

The sender receives the same accepted revision as everybody else. It must replace its
pending overlay with that canonical result. Recipients do not increment versions again when
applying remote events; doing so would create different metadata on each browser even if the
pictures initially looked identical.

Deletion is an explicit lifecycle transition. It records a tombstone or equivalent
generation boundary so a delayed update cannot recreate the element. Restoring an object is
a separate authorized operation. Reusing an old ID and blindly accepting an “add” command
would undermine deletion semantics.

| Approach | Strength | Cost or failure for this scope |
|----------|----------|-------------------------------|
| ✅ Server order plus group revisions | Clear acceptance and conflict boundaries | Needs an available authority for commitment |
| ❌ Whole-element timestamp winner | Small implementation | Clock skew and replacements discard independent edits |
| ❌ Unrestricted offline CRDT from the outset | Stronger offline merge model when correctly designed | More lifecycle, ordering, undo, and compaction semantics to validate |

A mature CRDT library is a reasonable alternative if independently edited replicas must
merge without a continuously available authority. I would evaluate its actual data types,
deletion behavior, and undo model. I would not implement an ad hoc timestamp tie-breaker and
assume convergence follows.

Even a deterministic last-writer rule has a product cost: it can consistently discard an
intended edit. Our conditional approach makes that conflict visible. We give up seamless
simultaneous manipulation of the same property group in exchange for predictable behavior
that a user can recover from.

Undo follows the same model. It requests a conditional inverse of the user’s own accepted
operation. If somebody else has since changed that group, we show a conflict instead of
restoring an old scene snapshot and erasing unrelated work.

## 💾 Deep Dive: Durability, Joining, and Reconnection — 10 minutes

> “The saved indicator should correspond to a durable receipt. A broadcast or an in-memory
> scene change is not enough, because a room can crash between distributing an edit and
> writing its snapshot.”

A tempting implementation keeps the full scene in memory and writes it after two seconds
without edits. That reduces database work, but it has no two-second loss bound: continuous
editing can keep resetting the timer indefinitely. A last-client-disconnect flush also fails
if the process crashes or that final write fails.

I would instead persist completed editing commands before calling them accepted. A long drag
can send disposable previews, but its durable result is one completed gesture. We do not
need a database write for every mouse movement to obtain durable editing semantics.

The initial implementation can use short PostgreSQL transactions that serialize a drawing’s
sequence and validate the current owner epoch. Different drawings proceed independently.
Very hot drawings still serialize their meaningful changes; additional servers cannot remove
that consistency requirement without changing the model.

| Approach | What the user can rely on | Trade-off |
|----------|--------------------------|-----------|
| ✅ Durable command receipt before acceptance | Accepted edit survives room process loss | Each accepted gesture pays a persistence round trip |
| ❌ Debounced scene write as the only persistence | Latest scene survives only after a successful flush | Quiet-period scheduling can leave an unbounded unsaved interval |
| ❌ Database write on every pointer movement | Every sampled movement may be stored | High volume without corresponding user value |

Snapshots reduce replay time; they do not define when a command becomes durable. A worker
materializes state through sequence N, verifies the serialized snapshot, and only then
publishes its reference and covered sequence. Recovery loads that snapshot and replays
accepted events after N.

Publishing the pointer first would advertise a snapshot that may not exist. Trimming the log
before a valid snapshot covers it would remove the only recovery path. Retention therefore
follows verified coverage, consumer requirements, and lifecycle rules, rather than a timer
that simply deletes old events.

Joining a room also needs a precise boundary. Reading a snapshot and later subscribing
creates a gap where edits can disappear between those actions. I would have the authority
establish a cursor and either buffer new events during snapshot delivery or replay the
durable tail through a known high-water mark.

```
┌──────────────────────┐     ┌──────────────────────┐
│ Snapshot through N   │────▶│ Apply tail N+1 ... R │
└──────────────────────┘     └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ Follow events > R    │
                             └──────────────────────┘
```

The client applies events in sequence and requests catch-up when a gap appears. Duplicate
events can be ignored using their sequence and receipt identity. A drawing generation
distinguishes a deleted or replaced board from a continuation of an old one.

After disconnection, the browser keeps its last committed cursor and actor-scoped pending
commands. It reconnects, reauthorizes access, catches up, and resubmits unacknowledged
operation IDs. If the server committed a command before the connection died, its receipt
resolves the uncertainty without applying it twice.

Pending commands may now conflict with newer accepted revisions. The client must not
“repair” that by uploading its entire old scene. It presents the conflict and preserves the
draft for reapplication or recovery. This is how we support useful offline work without
promising unrestricted offline convergence.

A browser switching accounts or drawings must isolate those queues. Late responses from a
previous room need a subscription generation check. Otherwise the networking layer can be
correct while the UI overwrites the current board with a valid response for a different
board.

Tombstone and receipt retention are linked to retry support. If all evidence of a deletion
or processed command disappears while an old client can still replay it, the system can
resurrect or duplicate work. I would define a minimum supported history boundary and reject
commands older than that boundary until the client resynchronizes. Their local drafts remain
recoverable, but are not blindly replayed.

During a database outage, the server can continue forwarding bounded cursor previews if
appropriate, but it cannot label new durable edits accepted. The browser displays pending
work. Once storage recovers, receipts and revision checks determine which commands can be
applied.

The main cost of this design is operational: durable log growth, snapshot scheduling,
retention rules, and recovery testing. That cost buys a precise answer to “Is my drawing
saved?” rather than inferring safety from a connected socket.

## 🌐 Deep Dive: Room Ownership, Presence, and Access — 8 minutes

> “I’ll scale by drawing, because unrelated drawings do not need a shared edit order. Within
> one drawing, I’ll preserve one authority and spend effort bounding fanout and memory.”

With roughly 1,000 elements at an assumed 500 bytes each, a scene is about 0.5 MB
serialized. Five thousand resident scenes would be about 2.5 GB before JavaScript object
overhead, indexes, queues, and sockets. We should evict idle rooms only after their accepted
state is recoverable, and cap room and connection admission per process.

A registry assigns a drawing to a room owner with an epoch. On failover, the new owner
obtains a later epoch. Every durable write checks that epoch in storage. An expired lease
alone is insufficient: a paused old process could resume and write unless the database
rejects its stale ownership token.

The gateway routes a drawing to that owner. Affinity by user or IP is not enough because
collaborators on different networks still need the same authority. Redis pub/sub can
distribute notifications, but it cannot prevent two independent room copies from overwriting
each other’s full-scene snapshots.

| Approach | Benefit | Cost or limit |
|----------|---------|---------------|
| ✅ Drawing ownership with storage fencing | One accepted order across failover | Routing, ownership transitions, and catch-up logic |
| ❌ Several independent room maps plus pub/sub | Easy initial fanout | Broadcasts alone do not coordinate conflicting durable writers |
| ❌ One global room server | Simple local deployment | Shared capacity and failure boundary for every drawing |

A very popular board is a separate problem from many small boards. We can distribute
delivery to many viewers while retaining one editing authority. If 20 editors remain the
supported profile, a board with thousands of spectators should not force every editor
process to maintain all viewer sockets or cursor streams.

Presence is keyed by connection ID, with user identity attached for display. Two tabs from
one account are two live connections. Removing one must not erase the other. The server
records last-seen times and the client expires stale entries, even if a clean close event
never arrives.

I would coalesce cursor movement to the latest value and apply per-connection and per-room
rate limits. A ten-Hz starting limit is a tuning assumption. Cursor packets need not wait
for durable storage, and an old cursor update has no reason to queue behind newer ones.

A single expiring room hash is not sufficient for per-person liveness. If active
collaborators keep refreshing the key’s TTL, stale members can remain indefinitely.
Per-connection timestamps or independently expiring records make the intended lease
explicit.

Backpressure must also distinguish message types. When a socket is slow, replace older
presence with newer presence. Bound reliable event buffering; if the client falls too far
behind, disconnect it with a resumable cursor and require catch-up. An unbounded queue turns
one slow reader into a memory failure for healthy rooms.

Authorization applies at connection establishment, room join, and durable mutation. The
upgrade verifies the session and allowed origin. The join verifies read access. Each command
checks edit access against a current permission revision or equivalent authoritative check.
An authenticated public viewer is still a viewer.

Revocation should invalidate active subscriptions and editing rights promptly. A grant
change must be coordinated with command admission so the product has a defined boundary for
edits racing revocation. The same rule must cover HTTP updates; protecting one transport
while leaving another writable defeats the policy.

The cost is extra state and checks on a latency-sensitive path. I would cache only with
explicit invalidation and bounded staleness appropriate to the access requirement. For
private drawings, an old cached “public” flag cannot independently authorize access after
the owner makes the drawing private.

## 📊 Failure Handling and Verification — 4 minutes

I would prioritize end-to-end signals: time from command submission to durable receipt,
conflict rate, room recovery duration, sequence-gap frequency, oldest unacknowledged
command, snapshot lag, and socket backlog. Request latency alone will not reveal that
collaborators have stopped converging.

Presence drops and rejected edit commands should be separate metrics. A system can
intentionally drop cursor updates while preserving accepted editing correctness. Metric
labels should use bounded categories, never arbitrary client-supplied message types or
drawing IDs.

| Failure to exercise | Required observation |
|---------------------|----------------------|
| Crash after commit but before acknowledgment | Retry returns the original receipt |
| Edit while a new client joins | Snapshot plus tail includes it exactly once in state |
| Two moves from the same group revision | One accepts; the other reports a recoverable conflict |
| Duplicate delete or delayed pre-delete update | No repeated effect or resurrection |
| Ownership changes while old server resumes | Old epoch cannot commit |
| Access revoked with a socket open | Later unauthorized commands cannot commit |
| One slow socket or malformed large message | Bounded impact on healthy collaborators |

I would run deterministic reducer and protocol tests before load tests. Then I would test
actual sockets and database transactions with controlled failures. Mocked HTTP handlers are
useful for route behavior but cannot establish convergence, SQL validity, or durable
recovery.

Load testing should separate many small rooms from one hot room. It should include large
freehand strokes, slow consumers, connection churn, and snapshot recovery. A single average
requests-per-second result would hide the boundaries that matter here.

## 🏁 Repository Mapping and Closing — 2 minutes

The local project runs one Express and WebSocket process with PostgreSQL, Redis sessions, a
full-scene cache, and process-local room maps. It has seven element types and debounced
full-scene writes. It does not implement the durable command protocol, fenced ownership, or
snapshot-and-tail recovery described above.

Several current behaviors are important limitations. WebSocket joins and edits do not
authenticate or enforce drawing permissions. The merge helper and operation reducer disagree
on versions and ties, and clients rewrite remote metadata. The operations table is unused;
history is written only by HTTP scene updates.

An initial room load can overwrite edits made while it was pending. Continuous edits
postpone the save timer, and failed saves have no durable retry. HTTP scene saves and room
saves can overwrite each other. The collaborator insertion query is invalid and its caught
error can produce a success response containing a null collaborator.

> “My first backend milestone would be a secure, single-process authority with canonical
> events and durable receipts. I would demonstrate crash recovery and conflict behavior
> before introducing multiple room owners or claiming offline convergence.”

The [architecture document](architecture.md) separates this proposed production design from
the current schema, request paths, and local implementation limits.
