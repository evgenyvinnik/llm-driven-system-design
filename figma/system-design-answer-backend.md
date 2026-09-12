# Figma — backend system design interview

A proposed collaborative editor backend, designed to fit a 45-minute whiteboard
conversation. Production guarantees here are design choices, not measured behavior of the
repository's local implementation.

## 🎯 Requirements and scope — 4 minutes

> “I’ll focus on one document being edited by several people. The hard question is
> what we promise when an edit is acknowledged, especially if the server crashes,
> the client retries, or someone restores an older version.”

I would scope the product to files, pages, basic design objects, online collaborative
editing, cursor presence, personal undo, and named versions. Viewers can read; editors can
change the document. Sharing changes must affect already-open sockets. Assets, comments,
components, plugins, and prototyping are extensions.

I assume that brief interruptions can be recovered, but unrestricted offline multi-writer
editing is not a launch requirement. Text can be replaced as an object property;
simultaneous editing inside a paragraph is outside this initial scope. Those choices make
a server-ordered operation model a reasonable starting point.

We want p95 committed changes delivered to regional collaborators within 200 ms at
admitted load and 99.9% regional availability. The client's local preview does not wait
for this round trip. I would measure commit latency and peer delivery separately because a
fast database write does not prove a collaborator received it.

The strongest invariant is that every accepted operation has one durable outcome and one
place in the file's order. An ACK means the transaction committed to the specified
replicated storage policy. It does not mean every client rendered it, nor does it imply
zero data loss under an unspecified multi-region disaster.

| Requirement | Backend consequence |
|---|---|
| Concurrent object edits | One committed order with defined property/structural semantics |
| Safe retries | Stable operation IDs and durable receipts |
| Short disconnects | Snapshot plus bounded log replay |
| Named restore | New ordered document state, visible to all clients |
| Shared access | Current authorization on reads, edits, versions, and streams |
| Presence | Separate expiring state that can be dropped |

## 📏 Capacity and partitioning — 4 minutes

For discussion, assume one million daily editors and 100,000 connected clients at peak. Of
those, 20,000 are actively manipulating objects. At five durable batches per active editor
per second, we receive 100,000 batches per second across files. This is an assumed peak
workload, not a benchmark or a daily average.

At 500 bytes per batch, the log receives about 50 MB/s before indexes, replication, and
protocol overhead. Sustaining that peak all day would produce 4.32 TB; actual retention
sizing needs a measured activity curve. Presence and binary assets are additional
workloads, not included in that figure.

If each edit reaches three peers, there are about 300,000 outgoing edit deliveries per
second. A heavily shared file can dominate a single process even when fleet averages look
healthy. File-level queue depth and fan-out are therefore important admission signals.

Writing a 5 MB scene for every batch would imply 500 GB/s of logical scene writes at this
peak. That motivates an operation log and asynchronous snapshots. It does not imply that
JSONB is unsuitable for a small prototype or for snapshot storage.

I would partition by file ID. One logical owner serializes a file's mutations, while many
owners share an application process or shard. Different files progress independently. The
first version caps editors and incoming work per file rather than promising unlimited
collaborative fan-out.

Splitting one file by page can come later. It complicates moving objects between pages,
permission scope, and file-wide restore. I would not introduce that boundary until a
measured hot-file limit justifies the coordination cost.

## 🏗️ Architecture and flows — 5 minutes

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│     Editor clients     │ ──▶ │     Gateway / auth     │ ──▶ │       File owner       │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│ Durable operation log  │ ──▶ │    Snapshot worker     │ ──▶ │    Snapshot storage    │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘
```

The first row is the interactive path. The file owner commits to the durable log shown
below it; snapshot workers later materialize that log into immutable versions. A broker
notifies subscribed gateways of accepted sequences. Presence uses a separate ephemeral
topic and does not pass through the durable operation log.

The gateway authenticates a session and resolves the file's owner. The owner checks
current permission, validates the semantic operation, decides its effective change, and
commits before acknowledging. The gateway can then deliver that committed change to the
origin and other subscribers.

The owner keeps an in-memory projection for low-latency decisions. It is rebuilt from a
verified snapshot and log after failure. This projection is a cache of the committed
prefix; the durable log is the recovery authority. A speculative state must never be used
to acknowledge a later operation after an earlier commit fails.

Opening a file needs a synchronization barrier. The service chooses a committed sequence
N, loads a snapshot at S, and supplies replay through N while buffering later events
within a bound. A current snapshot fetched independently of a live stream can miss or
double-apply edits around the subscription boundary.

I would start with one regional writer for each file and replicated storage in that
region. On an owner outage, clients display pending/read-only state briefly while takeover
completes. Acknowledging conflicting histories in two regions would create a harder
problem than this product scope requires.

## 💾 Data and API contracts — 5 minutes

| Record | Key fields and constraints | Purpose |
|---|---|---|
| File head | File ID, sequence, generation, owner epoch, access revision | Current coordination boundary |
| Operation | File, unique operation ID, sequence, effective patch, actor | Deterministic replay |
| Receipt | Operation ID, payload digest, status, canonical result | Resolve ambiguous outcomes and retries |
| Snapshot | File, sequence, generation, schema, checksum, storage reference | Bounded recovery |
| Object projection | Stable ID, parent/order, property groups/revisions, deletion state | Validate edits and inverses |
| Permission | File/principal, role, permission revision | Current access control |
| Named version | Name, creator, immutable snapshot reference | Human-readable history |
| Presence | File/page, connection ID, position, expiry | Replaceable collaboration hints |

Operations describe create, property change, delete, reorder/reparent, inverse, and
restore. They do not permit arbitrary paths into an unvalidated JSON object. Related
fields such as x/y are one position group. Fill can remain independent, so changing color
does not conflict with moving the same object.

Reparenting preserves object identity and validates the resulting tree. Parent and sibling
placement change together. A simple initial policy uses before/after object anchors
resolved by the owner; a missing anchor produces an explicit conflict. Array offsets
supplied against an old client list are ambiguous.

| Method | Proposed endpoint | Meaning |
|---|---|---|
| GET | `/api/v1/files/:id/bootstrap` | Authorized snapshot/stream boundary and file metadata |
| WebSocket | `/api/v1/files/:id/stream` | Edit batches, receipts, replay, and presence |
| GET | `/api/v1/files/:id/versions` | Paginated version metadata |
| POST | `/api/v1/files/:id/versions` | Name a specified committed revision |
| POST | `/api/v1/files/:id/restore` | Restore against an expected current revision |
| PATCH | `/api/v1/files/:id/permissions` | Change sharing and invalidate active capabilities |

A mutation includes a stable operation ID, base revision, generation, and immutable
payload. The server returns accepted sequence/effective patch or a typed rejection. The
base revision provides context; it does not require rejecting every edit because an
unrelated property changed in the meantime.

Replay requests identify the last applied sequence. The server bounds item count, bytes,
and retained age. It returns a reset requirement when history is unavailable. Returning a
plausible partial history without a gap indication would be unsafe.

## 🔧 Deep Dive 1: Sequencing, concurrency, and durable acceptance — 7 minutes

> “For online design editing, I would choose a server sequencer with explicit
> conflict rules. Convergence comes from applying one committed history, not from
> attaching a timestamp to an arbitrary patch.”

Consider Alice changing the fill while Bob moves a rectangle. Those property groups are
independent, so both can be accepted against the current scene. If both set its position,
the later committed position wins. This can lose one person's intended placement, but the
result is deterministic and explainable.

The server returns the effective accepted patch to the sender too. A client that ignores
its own canonical event may keep a prediction that differs from every other client. A user
ID is also not a sufficient deduplication key: one person may have several devices editing
the file.

Each file owner has a serial mutation queue. Before accepting an operation, it checks the
schema, current permission, generation, object existence, and relevant structural
invariants. Unknown properties, non-finite dimensions, excessive batches, and cyclic
parent updates are rejected before touching persistent state.

The transaction is the critical boundary:

1. Lock or conditionally update the file head under the active fencing epoch.
2. Check current access under the same serialization policy as permission changes.
3. Look up the operation ID and compare its payload digest with any prior receipt.
4. For a new valid edit, allocate the next sequence and write its effective patch
and committed result atomically.
5. Commit, update the owner's projection, and then acknowledge and publish.

A repeated ID with the same payload returns the original outcome. Reusing it with a
different payload is a conflict, not a request to reinterpret the previous edit. An
in-progress request can wait briefly or receive pending status. It must not start a second
execution merely because the cached result is not ready.

Suppose storage commits and the network drops before the ACK. The client still holds the
same ID; its retry finds the durable receipt. Suppose the process crashes before commit:
the transaction rolls back, and a later attempt can execute once. These are
effectively-once durable effects built on retries, not exactly-once network delivery.

Redis can cache receipts, but an evicted key or outage cannot determine whether an edit
already committed. A durable unique constraint plus receipt result is the backstop. A
primary-key error alone is insufficient because the client needs the accepted sequence and
effective result to finish reconciliation.

A routing lease chooses an owner, but it is not enough to prevent split ownership. An old
process can pause, lose its lease, and resume. A monotonically increasing fencing epoch
checked on every commit prevents that stale owner from writing after a replacement takes
over. Recovery verifies the log prefix before admitting work.

The owner serializes structural changes too. Two reciprocal reparent requests cannot both
create a cycle. Deleting an object makes subsequent ordinary updates fail; an update must
not implicitly recreate the object. Explicit restore/undo uses a defined identity policy
and runs through validation again.

| Choice | Why it fits | Cost |
|---|---|---|
| ✅ Fenced file sequencer | One order, clear rejection rules, straightforward replay | Per-file throughput ceiling and failover pause |
| ❌ Independent read/modify/write snapshots | Very simple single-writer persistence | Concurrent writes can lose unrelated edits |
| ❌ Decentralized CRDT from day one | Useful for unrestricted disconnected merging | More metadata, deletion/tree semantics, and operational complexity |

A CRDT would not eliminate authentication, persistence, or product choices about undo. If
offline work becomes central, I would revisit the model with those requirements
explicitly, rather than describe our sequenced patches as a CRDT.

## 🔧 Deep Dive 2: Snapshots, recovery, and ordered restore — 7 minutes

> “I would use snapshots to bound recovery time, but the operation log still
> explains every accepted change after the snapshot. Both must identify exactly
> which committed prefix they represent.”

A snapshot worker reads a complete operation range and builds the state at sequence S. It
writes immutable bytes, verifies the checksum, and only then publishes a manifest. The
manifest includes file, generation, schema version, and S. A worker crash before
publication leaves an unreferenced object that can be cleaned later.

Recovery selects the latest verified snapshot and replays the contiguous suffix. If the
snapshot is corrupt, use an earlier verified one and its retained log. Do not combine a
scene captured halfway through a mutation with a sequence obtained afterward; that would
skip or repeat a change even if the checksum is valid.

Snapshot frequency balances write/storage cost against replay latency. For an illustrative
hot file at 50 batches per second and a five-minute interval, recovery may replay 15,000
batches. I would measure the interpreter and choose a bound on both operation count and
elapsed time. A universal fixed interval ignores hot and cold file differences.

Log retention must respect recovery and the advertised reconnect window. A cleanup job
cannot delete all operations older than 30 days without checking whether a usable snapshot
covers them. Durable retry receipts may need a different horizon from the replay log,
especially if clients retain pending edits for longer.

Once a retry horizon expires, the protocol must not silently accept an ancient operation
ID as a new action. Session/generation checks and explicit outcome-expired responses let
the client ask for review. Tombstone/identity retention follows the same rule: stale
updates must not recreate deleted objects after compaction.

Named versions reference immutable state, not a mutable current-file row. Saving one
specifies the revision the user intends to name. The client waits for its pending edits to
resolve first, or the API clearly identifies the older revision being saved. Version
metadata is paginated separately from full snapshot bodies.

Restore is a new edit affecting the entire document. The requester provides the selected
version and expected current revision. If another edit changes the head before commit,
require a refreshed preview/confirmation rather than overwrite unseen work under an old
confirmation.

The owner orders the restore and advances a document generation. Connected clients install
its state at the new sequence. Disconnected clients with old-generation operations receive
a review requirement when they reconnect. Those edits remain recoverable as intent, but
cannot automatically reintroduce content the team just removed by restoring a version.

For a large snapshot, the log can reference verified immutable content rather than embed
megabytes in every broadcast. That reference must be durable before the restore
transaction commits. Receivers cannot skip the restore event and apply later patches to an
old scene while the snapshot is still downloading.

Undo is narrower than restore. A gesture inverse carries the original effect and expected
property revisions. Undoing a move can preserve a subsequent fill change; it conflicts if
another user already changed the position. Redo is derived from the accepted inverse
result, so it does not blindly replay stale values.

| Choice | Benefit | Cost or failure |
|---|---|---|
| ✅ Log plus verified snapshots | Small edit writes and bounded recovery | Snapshotter, manifests, compaction, schema compatibility |
| ❌ Log forever with no snapshots | Simple append authority | Recovery time grows with document age |
| ❌ Direct full-file overwrite for restore | Easy endpoint implementation | Bypasses order and leaves clients on incompatible states |

I would retain old schema interpreters or migrate snapshots through a tested, versioned
path. A new deployment must not replay an older operation with different meaning and still
call the result the same committed document.

## 🔧 Deep Dive 3: Fan-out, presence, and overload — 7 minutes

> “An edit and a cursor can share a socket, but they should not share the same
> reliability budget. A stale cursor can be replaced; a missing edit needs replay.”

Gateways hold connection-to-file subscriptions and deliver committed events in sequence
order. The owner can publish a lightweight notification after commit, and gateways fetch
the durable range if they detect a gap. If notifications are lost entirely, periodic head
checks or resumable log consumption discover the gap.

This avoids depending on a fragile database-write-plus-publish dual write. The operation
log itself is the source to tail. If we use a separate outbox or streaming system, its
checkpoint must advance only after committed events are available and recoverable. Pub/sub
notification alone is not durable history.

Each gateway bounds pending bytes per connection. Presence uses a latest-value slot rather
than an unlimited queue. Durable edit events can queue only to a configured limit; beyond
it, disconnect with a resync requirement or downgrade an appropriate spectator to
snapshots. Silently dropping an edit would leave an apparently connected client with an
incorrect scene.

Acknowledging persistence to the sender does not require every spectator to read the
event. A slow spectator must not hold a document transaction open. If the product needs
delivery receipts, they are a separate observable state with their own timeout and fan-out
cost.

Presence keys include connection ID, user, file, and page. That prevents one tab closing
from removing another tab's cursor. A small heartbeat refreshes expiry even when a user is
idle. Receivers expire stale entries independently, so a lost leave message cannot leave a
permanent collaborator badge.

I would initially coalesce active pointer updates to about 10 Hz and transmit only the
latest position. Presence is not written to the operation log or saved in named versions.
During a Redis/broker outage, cursors can disappear while the durable edit path remains
available if its own dependencies are healthy.

Admission happens before work piles up. Enforce per-connection payload bounds, per-user
and per-file operation budgets, and a bounded owner queue. Large restore or snapshot loads
should have separate concurrency limits. Otherwise a single shared file can consume all
database connections and affect unrelated files.

Hot files need measurements of queue delay, collaborator count, and egress. A dedicated
owner can isolate a hotspot. Read-only spectators can use additional gateways while still
consuming the same sequence. More owners cannot independently write one file without a new
coordination model.

Permission changes also cross the fan-out boundary. Serialize the access revision with the
file's mutations, reject later writes from revoked editors, and notify or close existing
streams. A gateway must refresh permissions before serving a replay or snapshot after
reconnect. Hiding controls in the browser does not enforce any of those rules.

Historical versions are private content too. Knowing a snapshot ID or possessing an old
file link is not a permanent read capability. Authorized downloads may use short-lived
URLs with an explicit revocation policy; previously delivered bytes cannot be withdrawn
from a client's memory.

| Choice | Why it works | What it costs |
|---|---|---|
| ✅ Durable edit stream and lossy presence | Protects document correctness while dropping replaceable traffic | Separate queues, expiry, and recovery logic |
| ❌ Persist every cursor movement | Gives one uniform message path | Storage and queue pressure without durable product value |
| ❌ Require every peer ACK before commit | Strong-looking delivery boundary | One slow or disconnected peer blocks editing |

## 🧪 Failure handling and validation — 4 minutes

I would test the boundaries around commit and replay rather than only a healthy two-client
session. Terminate the owner before commit, after commit, and after ACK but before
fan-out. Each test should recover the same accepted sequence and receipt.

| Scenario | Expected outcome |
|---|---|
| Same ID arrives twice concurrently | One effect and the same durable result |
| Same ID arrives with different content | Explicit conflict |
| Old owner resumes after takeover | Fencing check rejects its commit |
| Snapshot fails checksum | Recover a verified earlier prefix or fail clearly |
| Reorder races deletion of its anchor | Defined rejection, never a corrupt tree |
| Restore races an edit | Expected revision or generation rule prevents silent loss |
| Presence broker fails | Cursors expire without corrupting durable state |
| Viewer becomes revoked | Future stream/read/mutation access is denied |

Useful metrics include commit and queue latency, pending bytes per connection, sequence
gaps, replay duration, snapshot age, retry outcomes, and authorization failures. Keep
labels bounded; unbounded per-file metric series do not scale across millions of
documents. Sample diagnostics by controlled identifiers without logging private scene text
or whole operation bodies.

Readiness checks the ability to admit the required durable path, not just whether an HTTP
handler answers. Shutdown stops new admissions, drains bounded in-flight commits, tells
clients to reconnect, and releases ownership only under the fencing protocol. A log line
saying “graceful shutdown” is not that protocol.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Order | ✅ Fenced owner per file | ❌ Independent writers with wall-clock timestamps |
| Recovery | ✅ Verified snapshot and contiguous log | ❌ Unversioned canvas replacement |
| Retry | ✅ Durable receipt and payload digest | ❌ Temporary cache key alone |
| Presence | ✅ Expiring connection state | ❌ Durable cursor history |

> “The backbone is one recoverable order per file. That gives edits, retries,
> reconnect, undo, and restore a common authority. I would prove the commit and
> failover boundaries before increasing the number of editors or introducing
> unrestricted offline merging.”

The repository currently uses independent operation inserts and full JSONB writes, with no
authenticated browser identity, durable receipt replay, fenced owner, or cross-server
broadcast. Those limitations are documented in [architecture.md](./architecture.md). The
system described here is the proposed design beyond that learning demo.
