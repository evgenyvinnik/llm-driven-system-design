# 📝 Design a collaborative editor: fullstack interview

> “I would follow one edit from the user's input to a durable document version and
> then to another person's screen. That path exposes the important boundaries:
> optimistic text, concurrent edits, persistence, and recovery when the browser and
> server disagree about what happened.”

This is a proposed production design for a 45-minute interview, using the
repository's plain-text editor as a learning example. The demo has correctness gaps
and does not implement every mechanism below. See [Implementation
Notes](./architecture.md#implementation-notes) for the source audit.

| Time | Discussion |
|------|------------|
| 4 minutes | Product scope and guarantees |
| 5 minutes | End-to-end architecture and contracts |
| 9 minutes | Deep dive: one edit through concurrent views |
| 9 minutes | Deep dive: save status, durability, and recovery |
| 8 minutes | Deep dive: text, presence, and permission state |
| 6 minutes | Scaling, user experience, and operations |
| 4 minutes | Verification and implementation boundary |

## 🎯 Product scope and guarantees — 4 minutes

I would build document discovery, creation, rename, shared plain-text editing,
participant presence, and explicit view/edit/manage permissions. A useful first
product lets a small team write together and understand whether their work is saved.

I would leave rich text, inline comments, media, and extended offline collaboration
outside the initial scope. They add document-tree operations, anchored ranges, and
long-lived branches. Brief connection interruptions still need automatic recovery
where possible and a preserved local draft when automatic reconciliation is unsafe.

The document model is shared text, not a stream of whole-page replacements. The
service assigns each accepted operation a monotonically increasing version within
its document. There is no need for a single global order across unrelated documents.

The browser shows local edits immediately, targeting a 16 ms input frame for a
typical 100 KB document. The service targets p99 durable acknowledgement below 200
ms and peer visibility below 300 ms within a region under normal load. These are
design targets, not measurements of the current code.

I would distinguish three facts: text is visible locally, the operation has
committed, and peers have caught up. The first enables responsive input; the second
permits a Saved indicator; the third describes delivery freshness. One green
connection dot cannot represent all three.

Assume 100,000 concurrent sessions, 20% actively typing at two operation batches/s.
That gives roughly 40,000 admitted edits/s at peak. Most documents have a few
writers, with an initial limit of 50 active writers on a single document.

That workload suggests many independently ordered documents rather than one giant
synchronization loop. It also makes presence traffic worth separating: cursor
movement can be more frequent than text changes, but does not require durable
history.

> “I would define the save promise before choosing the queue. Otherwise it is easy
> to build a fast interface that acknowledges work the system cannot recover.”

## 🏗️ End-to-end architecture and contracts — 5 minutes

I would draw the browser's optimistic state beside the server's committed state:

```
┌──────────────────┐       ┌──────────────────┐
│ Browser editor   │──────▶│ Gateway/session  │
│ Base + local ops │◀──────│ Document routing │
└──────────────────┘       └────────┬─────────┘
                                    │
                           ┌────────▼─────────┐
                           │ Document owner   │
                           │ Ordered OT edits │
                           └────────┬─────────┘
                                    │ atomic commit
                           ┌────────▼─────────┐
                           │ PostgreSQL       │
                           │ Log + snapshots  │
                           │ Receipts/outbox  │
                           └────────┬─────────┘
                                    │ committed delivery
                           ┌────────▼─────────┐
                           │ Fanout gateways  │
                           └──────────────────┘
```

The browser adapter turns text input into operations and preserves selection. A
synchronization controller owns the committed baseline, submitted edit, unsent
edits, and connection generation. React renders the document list, status, and
participant UI around that controller.

The gateway checks the user's session and routes a document's edits to its owner.
One owner serializes admission for that document. Delivery gateways can scale
independently; they do not each maintain a separately writable authority.

PostgreSQL stores the current document head, canonical operations, receipts,
snapshots, access records, and outbox. Redis holds expiring presence and optional
caches. A relay distributes committed events to gateways and snapshot workers.

| Data | Authoritative owner | Important identity |
|------|---------------------|--------------------|
| Unsent input | Browser model | Document/account and local operation order |
| Submitted request | Browser plus durable server receipt | Stable operation ID and original request |
| Committed text history | Document service/database | Document ID and committed version |
| Title and permissions | Metadata/access service | Document and metadata/access revision |
| Presence | Transient session service | Participant session and freshness |

I would share operation semantics and protocol types across client and server where
practical. That avoids accidental drift, but both sides still validate incoming
data. Sharing a buggy transform function or using it with inconsistent priorities
reproduces the same problem across the stack.

The contracts stay small enough to explain verbally:

| Interaction | Required information |
|-------------|----------------------|
| Open | Authorized document, content at version V, coordinated subscription |
| Submit edit | Stable operation ID, original base version, operation components |
| Acknowledge | Same operation ID, committed version, accepted outcome |
| Remote edit | Document identity, ordered version, canonical operation |
| Recover | Receipt lookup plus missing history or a new baseline |
| Presence | Participant, cursor/selection, position version, freshness |

HTTP handles discovery and metadata changes; WebSocket messages carry live edit and
presence traffic. The transport choice does not replace request identity, sequence
validation, or access checks. The same application guarantees would still be needed
with separate HTTP submission and event streaming.

## 🔧 Deep dive: one edit through concurrent views — 9 minutes

I would choose optimistic operation-based editing with one request in flight per
client. Waiting for the server before displaying text would make typing feel like
the network. Sending complete document strings would make unrelated concurrent
changes vulnerable to overwrite.

Take “cat” as the shared baseline. Alice inserts X after c while Bob inserts Y after
a. Each sees their own edit immediately. If Alice's edit commits first, Bob's
original offset must be transformed through that insertion before the server accepts
Bob's edit. The resulting shared text is “cXaYt.”

The browser first derives the operation from its previous model. It applies that
operation exactly once, updates the visible selection, and records pending work.
Replacing the model with the new DOM string before applying an old-base operation
would violate the operation's precondition.

If there is no submitted edit, the controller sends the new operation. Otherwise it
buffers subsequent local edits. When the matching acknowledgement arrives, it
retires the submitted operation and composes the next pending batch before sending
it.

A remote operation arriving while local work is pending must be transformed through
that work. The transform also updates the pending operations' contexts. The
controller cannot simply replace the visible text with the server's latest string,
because that view does not yet contain its unsent changes.

Same-position insertions need a consistent protocol policy. For this design,
committed insertions precede newly admitted concurrent insertions. The server's
transform priority and the browser's committed-versus-pending priority must agree.
Using one function on both sides is insufficient if their operand order implies
opposite winners.

The server serializes the complete async command for a document, including storage.
It validates that the operation consumes the stated base, produces a valid target,
and refers to supported history. It computes candidate text without exposing it as
committed.

After the database append commits, the owner advances its committed memory and
acknowledges that operation. Another client's remote event carries the same
canonical version. The sender retires its optimistic request rather than applying
the insertion twice.

| Synchronization approach | Benefits | Costs |
|--------------------------|----------|-------|
| ✅ Optimistic operations + ordered admission | Responsive input and defined concurrency semantics | Client/server context management |
| ❌ Render only after server acceptance | Simple authoritative display | Round-trip latency affects every keystroke |
| ❌ Last-write-wins document replacement | Easy save endpoint | One writer can erase another's unrelated change |

OT suits the centrally ordered, connected plain-text scope. A CRDT is a serious
option if offline work becomes fundamental. For example, [Yjs supports local
persistence through
IndexedDB](https://docs.yjs.dev/getting-started/allowing-offline-editing). Choosing
it would also require a suitable editor binding and a clear permission/history
policy; it is not a promise that the existing OT demo supports offline editing.

I would keep the submitted request immutable for retry, even as the local in-flight
representation is transformed through remote edits. The retry identity refers to
what was originally submitted, not whatever transformed operation happens to be in
browser memory later.

I would also bound pending work by bytes and time. A slow connection can otherwise
collect an unbounded array of edits. Coalescing is useful only when the composed
operation preserves the same semantics and remains within server size/work limits.

> “The browser and server can legitimately show different text while work is
> pending. The invariant is that the difference is explained by known local
> operations, and disappears when those operations and the committed sequence are
> reconciled.”

## 🔧 Deep dive: save status, durability, and recovery — 9 minutes

I would make the durable acceptance boundary one transaction containing the document
head, operation, receipt, and outbox event. The service acknowledges only after that
transaction commits. A snapshot is not required for each acknowledgement because the
committed operation log is replayable.

The receipt maps a document, authenticated actor, and stable operation ID to the
original request fingerprint and accepted result. A repeated identical request
returns that result. Reusing the identity for different text or a different base is
rejected.

This handles the key ambiguous case: the operation commits, then the connection dies
before the acknowledgement arrives. The browser retains the original request and
asks for its receipt after reconnect. It must not interpret a timeout as proof that
the edit failed.

The browser's status should reflect this uncertainty. Saving means a local request
remains unresolved. Reconnecting means the transport or sequence needs repair. Saved
means all local edits have resolved durable receipts, not merely that the socket is
open or the pending array was cleared.

On the server, candidate text remains separate from committed memory until
persistence succeeds. A failed transaction cannot be allowed to leave the owner
serving a newer in-memory version than the database. If the commit result itself is
unknown, pause admission and resolve the receipt/head before accepting another
operation.

The outbox handles the next failure window: commit succeeds, but the process crashes
before publishing the event. A relay can retry publication from durable state.
Duplicate delivery remains possible, so gateways and clients use sequence-aware
deduplication.

A publisher confirmation, a gateway consuming a message, and a browser applying an
edit are different observations. I would not use a broker success counter as
evidence that every peer is current. Delivery lag should be measured against the
committed document sequence.

Reconnect needs both receipt resolution and a continuous history suffix. If the
client has version 10 and receives version 12, it obtains version 11 before applying
12. Equal string lengths do not make missing operation context safe.

Opening a new baseline also needs a boundary: the owner supplies state at V and
buffers events after V until subscription is active. Otherwise an edit committed
between the snapshot read and stream attachment can disappear from that client's
view.

| Recovery approach | Benefits | Costs |
|-------------------|----------|-------|
| ✅ Durable receipt + ordered replay | Resolves ambiguous saves without duplicating edits | Receipt storage and reconnect state machine |
| ❌ Clear pending work and load latest text | Quickly displays current server content | Can silently lose unsent local work |
| ❌ Resubmit under a new operation ID | Simple retry button | Can apply an already committed edit twice |

A verified snapshot plus a retained suffix keeps replay bounded. Snapshot workers
operate on an exact committed version and verify the result before advertising it.
Retention policy must account for historical viewing and the oldest client base the
service promises to rebase automatically.

When a base is too old or a local operation cannot be reconciled, preserve the draft
and show the current document separately. The user can recover a paragraph
intentionally. Blindly applying old positional edits to a fresh snapshot is not
automatic conflict resolution.

The connection controller uses a generation per document/account session. Reconnect
timers and old message/close callbacks check that generation before changing state.
Switching documents must not allow an old acknowledgement to clear a new document's
in-flight edit.

For a future restore feature, previewing history does not replace the shared current
document. Restoring submits a new authorized edit with a current-head check. A
concurrent update should force a fresh decision, rather than silently erase work
that arrived after the preview.

## 🔧 Deep dive: text, presence, and permission state — 8 minutes

A collaborative screen contains several kinds of state with different consistency
needs. I would make text durable and ordered, presence ephemeral, and permissions
authoritative at admission. Treating all three as one generic shared store either
wastes work or weakens important guarantees.

Cursor movement is latest-state information. If an intermediate movement is lost,
the next update usually repairs it. I would coalesce each participant's cursor, send
at a modest rate, and expire participants using heartbeat freshness. I would not
persist every cursor message in the document history.

A cursor still needs context. An offset from version 8 may point at the wrong word
after version 10 inserts a sentence before it. Include the position's version and
transform it through relevant edits, or omit it until a current position is
available.

Local selection deserves stronger care than decorative presence. When remote text
arrives, transform both selection endpoints and preserve scroll position as part of
an editor transaction. Clamping old numeric offsets to the new document length
prevents out-of-range positions but does not keep the caret beside the same text.

IME composition introduces an additional browser boundary. The browser may be
constructing a character sequence before it emits final input. The editor adapter
should preserve that composition session while remote operations arrive, then
reconcile the resulting operation against a valid base.

For the initial plain-text product, a native textarea and participant roster are
reasonable. Accurate remote caret overlays need layout measurement for wrapping,
scrolling, and fonts. Rich-text editing needs a document model and selection-aware
editor engine, not arbitrary HTML plus a plain-string diff.

Permissions follow a different policy. The gateway checks a real session before
sending baseline content. The owner checks edit permission when admitting the
command. A caller naming another user ID in a query string must not be enough to
edit as that person.

If an administrator revokes edit access while the user has pending work, the system
orders that revocation against admissions. Already committed edits remain in
history; later edits are rejected. The browser becomes read only and preserves
rejected local work privately for recovery.

Revoking view permission also removes future content/presence delivery. It cannot
recall text already shown. Recovery requests and history endpoints must recheck
permission, since an old socket subscription is not a permanent access grant.

| State model | Benefits | Costs |
|-------------|----------|-------|
| ✅ Durable text, transient presence, ordered access changes | Guarantees match the meaning of each state | Separate paths and explicit UI statuses |
| ❌ Put every event in one durable edit history | Uniform storage model | Cursor traffic bloats replay and delays useful work |
| ❌ Trust browser controls for access | Easy demo implementation | Direct requests bypass disabled controls |

Title changes also need their own metadata revision. They should not consume
character offsets or force the editor to replace its content. Two simultaneous
renames can use a conditional update with a visible conflict, instead of pretending
that text OT resolves metadata edits.

This separation improves failure handling. Redis can fail and hide presence while
durable editing continues. A failed metadata refresh can leave the text editor
usable with a stale title. A failed text commit, however, must remain visibly
unresolved rather than be disguised as a cosmetic sidebar issue.

> “I would spend strong consistency on who may edit and which text committed. I
> would allow a collaborator's cursor to lag briefly, because that failure has a
> much smaller consequence.”

## ⚡ Scaling, user experience, and operations — 6 minutes

First establish correct single-document behavior, then partition owners by document
ID. Each owner keeps a bounded recent-operation cache and recovers from PostgreSQL.
Cache eviction affects load time, not the meaning of the accepted history.

Moving a document between owners requires a database-checked authority generation. A
new owner advances it and rebuilds committed state; stale owners cannot append
afterward. Consistent hashing can choose placement, but does not itself fence a
process that still believes it owns the document.

For a hot document, distribute delivery across gateways while retaining one
admission order. Fifty writers at two batches/s produce 100 commands/s but almost
5,000 peer deliveries/s. Reader fanout is a different bottleneck from transform and
commit latency.

The browser's first bottlenecks are full-string copying, whole-document diffing, and
repeated layout measurement. I would measure realistic long text, pastes, and remote
bursts. As needed, use an editor model that emits deltas and avoids rebuilding all
content for a small change.

Slow consumers need bounded queues and an explicit replay path. Dropping arbitrary
text events breaks their operation context. Presence can be coalesced more
aggressively, and long document lists can be virtualized independently of the
editing surface.

The UI should expose document-load errors separately from an empty list, save
uncertainty separately from disconnection, and permission changes separately from a
generic failure. Keyboard focus stays in the writing area during remote edits;
status announcements should report meaningful changes without reading every
keystroke aloud.

For accessibility, label the text surface and controls, show visible focus, and
avoid using color alone to identify collaborators. On a small screen, move the
roster into an accessible disclosure rather than squeeze the editing column until it
becomes unusable.

Useful operational signals are local input latency, time waiting for durable
acknowledgement, owner queue length, peer sequence lag, reconnect outcomes,
unresolved receipt count, and snapshot verification failures. Socket count alone
says little about whether participants see the same document.

I would start with one home region per document and explicit recovery objectives.
Supporting independent regional writers changes the conflict and authority design.
Replicating RabbitMQ or running more Node processes is not enough to provide that
guarantee.

## 🧪 Verification and implementation boundary — 4 minutes

I would verify the contract through concrete failure cases: concurrent insertion at
one position, overlapping deletions, typing during remote delivery, delayed
acknowledgement, and reconnect after commit. The final assertion is equal text at
the same committed version with no unresolved local work.

Browser checks include paste, selection replacement, emoji boundaries, IME
composition, and switching documents while old socket callbacks arrive. Server
checks inject database failures, broker loss after commit, and owner takeover. A
history check reconstructs from an older verified snapshot plus its suffix.

The local repository has a React textarea, Zustand operation state, WebSocket
messages, PostgreSQL snapshots/operations, Redis presence, and RabbitMQ queues. It
does not have sessions, enforced access grants, a shared protocol package, runtime
semantic validation, durable operation receipts, offline draft recovery, or a
snapshot worker.

Its input handler updates content before applying the old-base operation, and
isolated checks reproduced an insertion failure before transmission. The OT classes
also fail some valid transform/compose cases, while opposite same-position
priorities can produce different client/server text. Cross-server broadcasts do not
update the receiving server's document memory.

Those findings belong in the implementation audit; they do not need to dominate the
interview. The interview's argument is the relationship between responsive input,
one accepted history, and recoverable user work. A page-load smoke test or build
cannot establish those guarantees.

| Decision | Interview choice | Main cost |
|----------|------------------|-----------|
| Collaborative text | Optimistic operations with one ordered document authority | Context-aware reconciliation |
| Save and recovery | Durable receipts, outbox, replay, preserved drafts | Recovery state across browser and service |
| Supporting state | Separate presence, metadata, and access semantics | More explicit contracts and failure states |

The first delivery milestone is reliable typing with two clients and a recoverable
lost acknowledgement. More participants, richer documents, and additional regions
should preserve that proven contract rather than expand an unverified one.
