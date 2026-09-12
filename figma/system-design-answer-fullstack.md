# Figma — fullstack system design interview

A proposed collaborative design editor, paced for a 45-minute interview. The architecture
is intentionally broader than the local demo; implementation limitations are documented
separately in [architecture.md](./architecture.md).

## 🎯 Requirements and user journey — 4 minutes

> “I’ll design the path from a designer dragging a rectangle to another designer
> seeing the committed result. Then I’ll show what happens if the connection drops
> and the first designer tries to undo the gesture.”

I would clarify whether we need the entire design suite. For this answer, the core is
files, pages, simple shapes and text, layer order, properties, simultaneous editing,
cursor presence, and named versions. Comments, image uploads, components, prototyping,
plugins, and exports are later extensions.

The product is primarily online. We support short interruptions with bounded pending work,
but unlimited offline multi-writer merging is not assumed. Text is edited as an object
property rather than a collaborative character sequence. Those decisions keep the hardest
consistency problem focused on scene operations.

I assume a typical active page has around 10,000 objects and several collaborators. The
fleet might have 100,000 concurrent connections, with 20,000 actively editing. These are
interview assumptions that guide partitioning and performance tests; they are not verified
capacities of the repository.

Local pointer feedback should be visible within 50 ms at p95, with a 60 Hz rendering goal
on a specified desktop. Committed changes should reach regional collaborators within 200
ms at p95 under admitted load. We target 99.9% regional availability, allowing a brief
read-only pause during controlled owner failover.

Durability has a concrete definition: an accepted edit is stored with its retry receipt
before ACK. A shape moving locally is only a preview until that happens. The UI must
distinguish pending, saved, rejected, disconnected, and read-only states.

| User action | Frontend obligation | Backend obligation |
|---|---|---|
| Open file | Show the correct scene and current access | Consistent snapshot/stream boundary |
| Drag/style object | Immediate feedback with pending status | Validate and commit the effective patch |
| Collaborate | Reconcile canonical events and display cursors | One file order, separate expiring presence |
| Reconnect | Preserve intent and resolve unknown outcomes | Receipt lookup and bounded replay |
| Undo/restore | Explain scope and conflicts | Ordered conditional mutation |

## 🏗️ Architecture and ownership — 5 minutes

I would draw the browser and one file's durable path, then explain how it is replicated
across files. The diagram should fit on a whiteboard without becoming a catalog of every
infrastructure service we might add later.

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│  Controls + renderer   │ ──▶ │  Scene + sync client   │ ──▶ │    File owner / API    │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│     Operation log      │ ──▶ │    Snapshot worker     │ ──▶ │    Version storage     │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘
```

React owns the file route, toolbar, layer navigation, properties forms, and dialogs. A
normalized scene store contains committed object state. A sync coordinator adds pending
edits, receipts, and the applied sequence. A tool controller produces local previews,
while the renderer consumes derived state and dirty object updates.

The renderer is not a database. It can dispose and rebuild a Pixi container without losing
the object. Stable document IDs connect graphics, layer rows, property controls,
selection, and undo entries. Viewport pan/zoom does not mutate the stored coordinates of
every object.

An authenticated gateway routes edits to one logical owner for the file. That owner
serializes mutations, validates permissions and object invariants, commits the operation
and receipt, then publishes the result. PostgreSQL or another transactional store can hold
the durable log and file head; snapshot workers materialize complete prefixes into
immutable storage.

The owner maintains an in-memory projection for fast decisions. On failure it recovers
from a verified snapshot and contiguous log. A fencing epoch checked by storage prevents
an old owner from continuing to commit after takeover. Different files use different
owners and can make progress independently.

A broker may notify gateways about new committed sequences, but durable recovery comes
from the operation log. Presence uses expiring records and replaceable notifications.
Losing a cursor update should not require replaying document history.

File, account, and connection generation scope every client callback. Leaving a file
disposes its tools and socket and rejects late results. The shell can retain a small view
checkpoint, but private scene content is reauthorized before being shown again under a
different session.

## 💾 Data and interface contracts — 4 minutes

| Concept | Important fields | Authoritative owner |
|---|---|---|
| File head | ID, committed sequence, generation, owner epoch | Durable coordination store |
| Scene object | Stable ID, parent/order, transform, style, content | Committed document projection |
| Edit | Operation ID, immutable payload, base revision, effective patch | Durable log and receipt |
| Snapshot | File, sequence, schema version, checksum, reference | Verified version storage |
| Pending gesture | Preview and unsent intent | Client tool/sync state |
| Undo entry | Accepted gesture effect and expected property revisions | Scoped client history, validated by server |
| Presence | Connection ID, page, cursor, expiry | Ephemeral service |

Object properties have explicit consistency boundaries. Position is an atomic x/y group;
fill can change independently. Parent and sibling placement also move together.
Reparenting checks cycles and missing parents. Reordering uses stable object anchors
resolved against the owner's current order rather than trusting an index from an old
array.

The initial protocol supports semantic create, update, delete, reorder, inverse, and
restore commands. A patch cannot write arbitrary nested paths or change identity. Finite
values, permitted fields, batch size, object existence, and current access are validated
on the server. TypeScript types alone do not validate network bytes.

| Proposed interface | Purpose | Response boundary |
|---|---|---|
| GET `/api/v1/files/:id/bootstrap` | Open an authorized file | Snapshot/stream boundary and current capabilities |
| WebSocket `/api/v1/files/:id/stream` | Edits, replay, receipts, presence | Canonical sequence or explicit rejection |
| GET `/api/v1/files/:id/versions` | Browse history | Paginated metadata rather than every snapshot body |
| POST `/api/v1/files/:id/versions` | Save a named revision | Immutable version reference |
| POST `/api/v1/files/:id/restore` | Restore against expected revision | New ordered generation |

A versioned runtime schema can be shared across client and server builds, but backward
compatibility remains a protocol responsibility. The server derives the actor from the
session, not the subscribe payload. Old clients receive a clear upgrade/reload requirement
if they cannot interpret the scene or operation schema.

## 🔄 Trace one edit from pointer to persistence — 4 minutes

Alice presses on a rectangle, and the tool records its initial position and selection.
Pointer movements update a local preview on animation frames. The properties panel and
canvas read the same derived position, so they cannot disagree about what the user is
currently manipulating.

The client sends a bounded semantic position patch with a stable operation ID. The owner
checks current access and validates the patch against committed state. Within one
transaction it checks the active fencing epoch, looks up a previous receipt, allocates a
sequence for a new edit, and records the effective change and result. It ACKs only after
commit.

The client incorporates the effective accepted patch into its canonical base, removes the
corresponding pending overlay, and updates saving status. Other clients apply the same
sequence. The origin does this too; skipping all events from the same user would hide
another tab's edits and server-adjusted outcomes.

If Bob changed the rectangle's color while Alice moved it, the independent patches both
survive. If Bob also changed its position, server commit order determines which absolute
position becomes canonical. The UI can show the remote selection and settle on that result
once its own pending work resolves.

For a first implementation I would keep one durable batch in flight per file and coalesce
unsent previews. A final patch on pointer release ensures the final intent is sent. If
this throughput is insufficient, pipeline with an explicit client sequence instead of
relying on asynchronous message handlers to finish in order.

A failed edit leaves an explicit rejected/pending state, not a silent optimistic shape.
Removing a rejected overlay exposes the current canonical scene while preserving other
accepted changes. That is why the frontend maintains a committed base separately from what
the user is previewing.

## 🔧 Deep Dive 1: Fast local editing versus durable write volume — 7 minutes

> “I would make rendering follow the pointer, while persistence follows meaningful
> document patches. Those are different rates, and coupling them would make both
> the browser and the database do unnecessary work.”

A pointer can produce many events during a drag. Writing the complete scene for every
event serializes thousands of unchanged objects and generates an unusable undo history.
With multiple selected objects, that amplification is even larger. A slow network would
also make the apparent interaction lag behind the pointer.

The tool therefore keeps a temporary transform and samples the latest input once per
animation frame. It emits coalesced durable patches and one final state on release.
Intermediate presence can be sent separately. Coalescing happens before an operation gets
its immutable transmitted payload; a retry must never change the contents associated with
an existing operation ID.

At the assumed peak, 20,000 active editors sending five 500-byte batches per second
produce 100,000 batches/s and about 50 MB/s of log ingress before overhead. Writing a 5 MB
scene instead would produce about 500 GB/s of logical scene writes. This explains why an
operation log matters even if individual files are modest.

The server owner resolves a patch against an in-memory committed projection. The durable
transaction records only the accepted change and coordination state. A snapshot worker
handles full scene serialization at bounded intervals. The cost is maintaining
deterministic replay, snapshot manifests, and retention rules.

The browser has a similar separation. React renders semantic controls, while a retained
scene renderer updates object transforms and styles. A dirty set identifies changed
objects. Moving one rectangle should not recreate every text object and cursor graphic on
the page.

GPU rendering is not automatically faster for every workload. Large text/layout costs,
texture uploads, and repeated allocations can dominate before drawing. I would benchmark
CPU preparation and GPU work separately, using real scene mixes rather than a claim that a
certain number of rectangles always runs at 60 Hz.

Viewport culling uses conservative transformed bounds and a small margin. A spatial index
can accelerate hit testing when a linear reverse-layer scan becomes expensive. The final
hit test happens in local object coordinates, so rotation and ellipse geometry behave
correctly. Hidden layers do not become invisible interactive targets.

Culling only limits drawing. The layer tree, object records, pending queue, and history
still occupy memory. I would load inactive page metadata first and keep page/resource
caches bounded. The layer list can use virtualization with stable IDs and deliberate focus
management.

Pointer capture, cancellation, and keyboard equivalents are part of the interaction model.
A drag outside the canvas should not become stuck. Escape can cancel an uncommitted
preview; undoing already committed intermediate movement goes through the ordinary inverse
protocol. Text fields and IME composition suspend canvas shortcuts to avoid deleting
objects while editing their labels.

The accessible path uses labeled forms and a semantic layer tree to select, move, resize,
reorder, and delete. A canvas element plus decorative handles does not provide those
capabilities to keyboard or screen-reader users. Rendering failure should preserve pending
intent and provide a clear retry path through the shell.

| Approach | Benefit | Cost or failure |
|---|---|---|
| ✅ Local previews plus bounded patches | Immediate interaction and controlled storage volume | Reconciliation and gesture grouping |
| ❌ Persist full scene per pointer event | Simple single-user prototype | Write amplification and concurrent overwrite risk |
| ❌ Render every visual as a React/SVG node at any scale | Strong native semantics for smaller scenes | Larger scenes need profiling of browser update costs |

If a smaller SVG or Canvas 2D implementation meets the benchmark, it remains a valid
choice. The non-negotiable part is separating durable state, preview state, and render
resources so performance changes do not rewrite the collaboration model.

## 🔧 Deep Dive 2: Reconnect, retries, and concurrent edits — 7 minutes

> “When a socket drops, neither side can infer whether the last edit committed.
> I would recover that outcome before retrying or replacing the document.”

The server stores a receipt under a unique file/operation ID with a payload digest. A
repeated ID and identical payload returns the accepted sequence and effective result. A
different payload under that ID is rejected. A duplicate arriving while the original is
processing waits briefly or receives pending status.

A Redis cache can accelerate this lookup, but a five-minute key cannot be the only proof
of acceptance. Eviction, outages, or an in-progress marker do not mean an operation is
safe to execute again. The durable unique record and atomic commit provide that proof.

The file owner serializes accepted edits. It validates current permission and object state
before committing, and storage checks its fencing epoch. An old owner that resumes after
losing its lease cannot write another history. This is the availability trade-off: the
file may pause during takeover instead of accepting conflicting outcomes from independent
writers.

Client state is canonical scene plus pending overlay. Incoming events advance the
canonical scene in sequence order, while a newer local preview can remain visible. When an
ACK or rejection resolves that intent, the overlay disappears. This avoids both
distracting flicker and permanent divergence from the server.

Opening/reopening a file establishes a barrier. A snapshot at S and replay through N
describe a complete prefix; later events are buffered within a bound. A separate HTTP
fetch and socket snapshot without a common revision can race and replace newer state with
older bytes.

A reconnect follows a specific order:

1. Reauthenticate and create a fresh file/connection generation.
2. Recover the canonical prefix through replay or a verified snapshot.
3. Resolve receipts for operations with unknown outcomes.
4. Retry unresolved IDs with their original payloads, or show explicit rejections.
5. Resume new edits after the pending overlay has been reconciled.

If the client detects a sequence gap, it stops applying later events to canonical state
and asks for the missing range. Duplicate events are harmless. If the range is too old,
the server requests a snapshot reset rather than returning an incomplete list that looks
like a successful catch-up.

A snapshot includes schema version and checksum as well as sequence. The worker publishes
its manifest only after the bytes are durable and verified. Retention cannot remove the
only log needed after the latest usable snapshot. Retry receipts and deleted-object
identity may need longer retention than replay data.

The pending queue has count, byte, and age limits. A short in-memory queue can survive a
network gap but not a browser crash. If crash recovery is required, store scoped pending
intents in IndexedDB with account cleanup and a defined retention policy. That does not
remove the need for permission checks after reconnect.

An operation whose content must change after recovery is a new intent. Resolve the old
unknown outcome first, then create a new ID if the user accepts the revised operation.
Reusing one ID for changed content undermines the receipt contract.

Presence can expire during all of this without affecting the document. Records use
connection IDs, and a small idle heartbeat refreshes them. Intermediate cursor positions
are coalesced; durable events have a bounded queue and explicit resync when a slow client
exceeds it. One slow spectator must not hold a database transaction open for every editor.

| Approach | Why it fits | Cost |
|---|---|---|
| ✅ Sequenced edits with durable receipts | Explainable online convergence and unknown-outcome recovery | Owner failover and client reconciliation state |
| ❌ Full reload with no pending journal | Simple reconnect code | Overwrites unsent intent and does not resolve accepted edits |
| ❌ Full offline CRDT at launch | Supports broader disconnected collaboration | More tree, deletion, undo, and access semantics to define |

## 🔧 Deep Dive 3: Undo and versions across client/server boundaries — 7 minutes

> “Undo is personal intent; a version restore is a shared document decision. Both
> still need to enter the same ordered, authorized mutation path.”

A drag's undo entry records the gesture's initial value, accepted effect, and resulting
property revision. Many intermediate previews become one user-visible history item. Memory
then grows with meaningful gestures and their affected fields, rather than full canvas
copies per pointer event.

Suppose Alice moves a rectangle, then Bob changes its fill. Alice's inverse restores the
position while preserving the fill. If Bob moves it again, the position revision has
changed and the inverse conflicts. The server must check that condition in the same
transaction as accepting the inverse, not in an earlier unprotected read.

I would initially choose all-or-nothing undo for one multi-object gesture. If a guarded
target changed, return the conflicting object IDs and let the user review. Partial undo
could be added later, but it needs explicit per-target results and a redo entry based on
what actually succeeded.

This sacrifices the expectation that undo always works as it does in a single-user
application. The benefit is avoiding a silent overwrite of a colleague's later work. The
UI should name the affected action and offer a comprehensible recovery, rather than
display a generic network error.

Redo is constructed from the accepted inverse and its new property revisions. It is not
blindly replaying the original payload. A rejected inverse does not create a successful
redo entry, and an unknown inverse outcome remains pending until its receipt is resolved.

Deletion needs a defined restoration rule. An ordinary stale update to a deleted ID should
fail, not recreate the object. Undo may explicitly restore copied content under a new
identity or a carefully specified restore operation, with parent and placement validation.
The rule must be deterministic for remote clients and replay.

Named versions capture a committed revision. Before requesting one, the client establishes
a barrier for its pending edits. It either waits for them to resolve or clearly saves an
identified earlier revision. A server endpoint that merely copies its current row can omit
changes still visible as local previews.

Version listings return metadata and load full snapshot content on demand. A version's
identity is immutable even as the live file changes. Current file permission still
controls access to older versions; an old version URL is not a permanent authorization
grant.

Restore previews the selected version and the current head, then asks the user to confirm
that concrete action. The server requires the expected head revision. If intervening edits
change it, the caller must review the new situation before a destructive whole-file change
is accepted.

The restore commits as a new log event and advances the document generation. If its
content is stored outside SQL, the verified immutable snapshot reference must already be
durable before commit. All clients install that event before applying later edits, even if
downloading the new snapshot takes time.

An offline editor returning with the old generation does not automatically replay its
queue over the restored design. The client preserves the intent for review, resolves any
old receipts, and asks the user how to proceed. A whole-file restore is one of the
clearest cases where unrestricted optimistic replay is wrong.

Client history, selected objects, and asynchronous work are scoped by file and generation.
After restore, old inverse guards are invalid. After navigation, a late HTTP response,
worker result, or reconnect callback cannot apply to another file. Resource cleanup and
document consistency meet at that lifecycle boundary.

| Approach | Benefit | What it gives up |
|---|---|---|
| ✅ Conditional inverse gestures | Preserve unrelated collaborator work | Some undo requests require review |
| ✅ Ordered restore with generation change | All clients agree on the new document | Pending old work needs explicit resolution |
| ❌ Local snapshot history for shared undo | Very easy to prototype | Erases shared changes and does not persist the undo |
| ❌ Isolated REST snapshot replacement | Simple storage operation | Races live editing and leaves peers on the old scene |

## 🧪 Scaling, failure handling, and validation — 5 minutes

I would scale ordinary load by file ID, keeping one logical owner per file. Gateways scale
connection count independently from snapshot workers. Hot files get admission limits and
isolated owner capacity. Cross-page partitioning is a later change because it introduces
coordination for moves and whole-file restore.

Slow clients have bounded outgoing queues. Replace presence with its newest value, but
disconnect/resync a durable stream that falls too far behind. A commit does not wait for
every peer ACK. Broker notifications are backed by durable log tailing or head checks so
missed notifications cannot leave a client stale indefinitely.

Permissions are checked at join, every mutation, snapshot/history reads, and reconnect.
Revocation advances the access revision and closes or downgrades existing streams.
Previously delivered bytes cannot be recalled, but further disclosure and writes are
blocked at the server, independent of whether the browser hides controls.

| Test | What it proves |
|---|---|
| Two users edit independent properties | Both changes survive |
| Two users edit the same position | A common canonical result after pending work resolves |
| Kill owner after commit before ACK | Durable receipt prevents duplicate effect |
| Resume obsolete owner after takeover | Fencing rejects stale writes |
| Switch file while loading/reconnecting | Generation guards reject old callbacks |
| Restore while another client is offline | Old intent is reviewed rather than silently replayed |
| Undo after a conflicting remote movement | Conditional guard preserves the remote change |
| Drop presence and overload one spectator | Durable editing remains coherent |

Browser checks cover rotated hit tests, pointer cancellation, keyboard access, IME entry,
resource disposal, and long-session memory. Server checks cover concurrent receipt claims,
log gaps, corrupt snapshots, stale schema versions, and permission changes during a
mutation. A file grid smoke test proves none of these invariants.

I would measure local pointer-to-pixel latency, frame preparation, pending age, commit
latency, peer delivery, replay duration, snapshot age, and per-file queue pressure. Keep
telemetry free of design text and asset secrets. Use bounded metric labels and sampled
diagnostics instead of retaining one time series per file forever.

Readiness means the instance can serve its required path. Shutdown stops admitting work,
drains bounded commits, notifies clients to reconnect, and transfers ownership under
fencing. Snapshot cleanup respects recovery watermarks. These controls make the commit,
recovery, and ownership boundaries testable under normal operational failures.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Interaction | ✅ Local preview plus semantic patches | ❌ Persist every pointer event |
| Authority | ✅ One fenced committed order per file | ❌ Concurrent whole-scene replacements |
| Recovery | ✅ Receipts, snapshot, and log replay | ❌ Blind resend after full reload |
| History | ✅ Conditional undo and ordered restore | ❌ Local full-file rewind |

> “The browser predicts quickly, and the backend gives that prediction a durable
> outcome. A consistent contract between them makes retries, undo, and restore
> understandable. I would prove that contract with two clients and failure injection
> before adding more tools or promising unlimited offline collaboration.”

The local project provides a useful canvas and API skeleton. Its random browser identity,
racing full-canvas writes, ignored ACKs, local history defects, and missing
restore/cross-server broadcasts prevent the guarantees described here. The README and
architecture state those source-backed limits explicitly.
