# Google Docs: backend system design interview

A proposed 45-minute design for shared rich-text documents. Numbers are sizing
assumptions, not Google usage data or measured limits of the repository demo.

## 🎯 Establish the guarantees — 5 minutes

> “I would design a document service where people can edit together, share access, leave comments, and restore history. The backend's main job is to define one accepted document history and recover it after failures. A broadcast alone is not a save.”

The first version supports bounded documents, small editing groups, basic rich text,
comments, named snapshots, and owner-managed view/comment/edit grants. Presence is
useful but temporary. I would defer arbitrary embeds, export, full tracked-change
suggestions, and indefinite offline editing to keep the interview focused.

One document has one ordered sequence of committed editor steps. A browser may display
unconfirmed changes ahead of that sequence, but the service does not acknowledge a
save until it can recover those accepted changes after the owner process crashes.

“Zero data loss” needs a failure boundary. I can promise that a process crash does not
lose acknowledged writes when their transaction is durable. Losing every replica or
failing over to an asynchronous replica is a different contract that requires an
explicit replication and recovery-point policy.

| Requirement | Backend contract |
|-------------|------------------|
| Concurrent edits | Admit one ordered history and provide contiguous catch-up |
| Retry | An immutable identified attempt has one recorded outcome |
| Open document | Snapshot content and advertised revision agree |
| Restore | Create a new guarded history event, preserving the old history |
| Sharing | Current capability governs commands, snapshots, replay, and presence |
| Presence | Expiring connection state; dropping cursor updates does not lose content |

I would propose p95 peer visibility below 200 ms in the document's home region,
bounded-document load below one second, and a 99.99% access availability target.
During a durability failure, the browser can retain local work while authoritative
writes pause. I would not trade away saved content merely to keep returning success.

## 📊 Estimate the dominant work — 3 minutes

Assume five million daily active users, each editing for twenty minutes. That is six
billion editor-seconds/day, or about 69,445 concurrent editors on average. A fivefold
peak gives roughly 350,000 concurrent connections.

At half a submitted batch per active editor per second, average admission is about
34,722 batches/second and peak admission about 175,000. A batch contains several
ordered editor steps. I would size steps, accepted batches, and delivered frames
separately instead of calling all of them “operations.”

At 500 bytes per batch, three billion daily batches add roughly 1.5 TB/day before
replication, receipts, indexes, and snapshots. If a room has five other viewers, live
content fan-out is about five deliveries per accepted batch, plus ACKs and presence.

Those assumptions justify partitioned document ownership and independent gateway
capacity. They do not establish a universal “10,000 sockets per server” limit. I
would measure memory per connection, slow-client buffers, batch CPU, and the hot-room
size distribution to determine deployment sizes.

A large paste or deeply nested formatting change can cost much more than a single
character. Per-document queue time and validation cost are as important as global
requests per second.

## 🏗️ Draw ownership, commit, and delivery — 5 minutes

I would draw the document authority explicitly between gateways and storage. Adding
WebSocket servers should not accidentally add independent writers for the same document.

```
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Browser clients        │       │ Authenticated gateways │       │ Presence routing       │
│ Batches / reads/cursor │◀─────▶│ Session + doc routing  │◀─────▶│ Connection + revision  │
└────────────────────────┘       │ Ordered replay channel │       │ Coalesce / expire      │
             ▲                   └────────────────────────┘       └────────────────────────┘
             │                                ▲
             │ review / result                │ commands / outcomes
             │                                │
             ▼                                ▼
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Authorized review API  │       │ Fenced document owner  │       │ Document partition/SQL │
│ Lists/comments/history │◀─────▶│ Validate / admit steps │◀─────▶│ Head / grants / epoch  │
│ Current access checks  │       │ Restore/grant commands │       │ Steps/receipts/outbox  │
└────────────────────────┘       └────────────────────────┘       │                        │
             ▲                                ▲                   │                        │
             │ read / version                 │ replay / publish  │                        │
             │                                │                   │                        │
             ▼                                ▼                   │                        │
┌────────────────────────┐       ┌────────────────────────┐       │ Contiguous step reads  │
│ Verified snapshots     │       │ Replay/snapshot work   │       │ Claim committed work   │
│ Pinned revision/schema │◀─────▶│ Read committed history │◀─────▶│ Commit + work progress │
│ Immutable content hash │       │ Build/verify snapshot  │       │                        │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

The owner streams accepted history to gateways. Missing live delivery is repaired by replay.
Saved ACK follows the SQL commit; snapshots and expiring presence have different lifetimes.
```

A gateway authenticates the connection and routes commands to the document's current
owner. That owner admits changes through a fenced database transaction. Accepted steps
and receipts survive its memory; an outbox feeds live delivery and snapshot work.
A missed broadcast is repaired from committed history. Presence has a separate path.

I would use a lost batch response to follow the return arrows:

1. The replacement owner reconstructs committed state and uses the current storage epoch; an old process cannot commit after takeover.
2. The client resolves the original attempt receipt. Accepted history returns its exact range; a definitive stale-base rejection permits a new rebased attempt.
3. Replay uses contiguous retained steps. An expired recovery horizon produces an explicit reset/recovery outcome, not permission to repeat uncertain edits.
4. Snapshot work verifies immutable content before publication and progress. A snapshot without its required suffix cannot be called the current document.

The diagram uses logical services. An initial deployment can combine API, gateway,
and owner code in one process, with PostgreSQL as the durable store. At scale,
partition documents and route their commands to the assigned owner without changing
the consistency boundary.

The owner's in-memory document is a fast working copy of committed state. A durable
epoch or fencing token is checked by storage on every mutation. Sticky routing helps
locality, but a restarted or partitioned old owner must not remain able to commit.

I choose centralized, schema-aware step rebasing. The server admits batches only at
the current base version. A stale client receives intervening accepted steps and uses
its editor model to rebase unconfirmed work. This avoids presenting a few flat-text
transform functions as a complete rich-text collaboration algorithm.

A CRDT is a valid alternative, particularly for long independent offline work. It
changes the merge and retention model; it does not remove authentication, durable
storage, or product semantics for restore and permissions.

## 💾 Define the records and API — 4 minutes

| Record | Key fields | Why it exists |
|--------|------------|---------------|
| Document head | Document ID, epoch, step version, schema, access revision, deleted state | Current authority and admission conditions |
| Accepted step | Document ID + version, batch ID, actor, payload | Ordered replay with unique positions |
| Attempt receipt | Document/actor/client/batch ID, digest, terminal outcome, accepted range | Resolve duplicates and uncertain writes |
| Grant | Document + principal, capability, access revision | Current authorization |
| Outbox | Event ID, document, version range, pending/claimed state | Delivery work survives the commit/publication gap |
| Snapshot manifest | Document/revision, content hash, schema, immutable object reference | Verified recovery checkpoint |
| Comment and anchor | Document/comment IDs, parent, body version, anchored revision/range | Discussion survives document changes |

Colocate a document's correctness-critical rows. A transaction that needs both the
head and current grant should not depend on an unrelated eventually consistent store.
Separate account identity can still be shared across documents.

Use a validated representation for version numbers across SQL and JSON. In particular,
a database BIGINT is not guaranteed to arrive as a JavaScript number. Compare and
advance versions intentionally instead of relying on implicit coercion.

| Method/channel | Proposed operation | Important contract |
|----------------|--------------------|--------------------|
| GET | `/api/documents` | Authorized bounded list with cursor |
| GET | `/api/documents/:id/bootstrap` | Verified snapshot + suffix + current capability |
| WS | Submit batch | Immutable ID, base version, schema, ordered steps |
| WS or GET | Changes after version | Contiguous committed steps with batch identities |
| GET | Attempt outcome | Authorized resolution of an uncertain submission |
| POST/PATCH | Comment or grant command | Current capability and expected version where needed |
| GET/POST | Version preview / restore | Pinned history; guarded new restore event |

The exact endpoint names matter less than these contracts. Both REST content commands
and WebSocket edits reach the same admission authority.

## 🔧 Deep dive 1: one admitted history despite retries and failover — 10 minutes

### Validate the batch before it changes anything

The batch identifies its document, actor, client instance, attempt ID, base revision,
and schema version. Its digest covers the immutable payload. Bound byte size, step
count, document growth, and nested structure before expensive processing.

Authentication proves the account, not permission to edit this document. The owner
checks current capability and deleted state during admission. A socket that subscribed
as a viewer must not become an edit capability merely by sending an OPERATION frame.

Apply the steps to a candidate document under the agreed schema. A list restructure,
mark change, and text insertion must all be valid in sequence. If one step fails,
reject the entire batch; do not leave a partially applied batch in memory or storage.

### Serialize acceptance with a durable condition

Within the document's admission transaction, lock or conditionally advance the head,
verify the owner's epoch and access revision, and resolve the attempt receipt. An
identical committed attempt returns its original accepted range. A different digest
under the same identity is a conflict.

Only a current-base batch can be accepted. Append its steps, advance the head by its
step count, and store the acceptance receipt and outbox event atomically. Publish the
new in-memory state and send a saved acknowledgment only after that transaction commits.

The application needs actual database serialization here. A preliminary receipt lookup
followed by independent inserts allows two concurrent duplicates to pass the lookup.
A receipt cached after a memory ACK cannot repair a crash that lost the underlying edit.

Short group commits can amortize work, but every included batch still waits for the
durable commit. Validation and batching have budgets so one giant paste cannot hold
the document's queue indefinitely.

### Explain the stale-base path

Alice and Bob both submit from revision 20. Alice's two-step batch commits at 21–22.
Bob's old base no longer matches. Record a definite no-effect result for Bob's attempt
and return the missing range or a bounded resync instruction.

Bob catches up, maps his unconfirmed editor steps, and creates a new identified attempt.
The original request remains immutable and rejected. Delayed retries of that original
request cannot later become accepted after Bob has already moved on.

This separates transport attempts from user intent. Rebased steps can represent the
same intended edit with different positions and therefore need a different immutable
wire attempt after the old attempt's no-effect outcome is established.

A missing receipt during an in-flight request is not proof that the request failed.
The client may retry the same attempt through the authority until it receives a
terminal result. It must not invent a new identity while the first attempt might
still be admitted.

### Work through the owner crash

If the owner crashes before commit, no accepted edit exists. The same attempt can be
resolved or retried. If it crashes after commit but before ACK, the receipt and step
range return the committed result. If publication fails, the outbox remains available.

The replacement owner acquires a newer epoch and reconstructs a verified committed
head. Storage rejects subsequent writes from the old epoch, even if the old process
wakes up and still believes it owns the document.

A routing hash alone cannot provide that guarantee. During reconfiguration, two
processes may temporarily believe the same document is theirs. A shared incrementing
counter is also insufficient if content application and receipts are not protected
by the same admission boundary.

If a database commit times out, its outcome may be unknown. Pause further conflicting
admission for that document until the receipt/head resolves the transaction. Retrying
arbitrary writes because a circuit breaker timed out can create another race.

| Approach | Why it fits or fails | Cost |
|----------|----------------------|------|
| ✅ Fenced document owner + atomic admission | One recoverable sequence across duplicates and process replacement | Serialized hot-document path and recovery coordination |
| ❌ Sticky routing alone | Usually keeps normal traffic together | Does not stop a stale owner after failover |
| ❌ Memory ACK then cache a receipt | Fast acknowledgment | Receipt and content can disagree after a crash |

> “I accept a single-document serialization point because users need one coherent history. I scale the number of documents and delivery connections around it instead of claiming extra gateways make one paragraph independently writable.”

## 🔧 Deep dive 2: snapshots and fan-out must be recoverable — 8 minutes

### Use the log as the accepted-change record

Accepted steps form a contiguous version range. A snapshot is a verified materialization
of one point in that range. It is not simply the database's latest JSON body paired
with whichever version counter happens to be in memory.

On open, choose snapshot S and replay through committed head H. Verify continuity and
schema compatibility before serving H. For a hot document, the owner may already have
that committed state cached, but cache misses must use the same reconstructable path.

A client starting live delivery from H needs to receive every later committed range.
Subscribe-and-replay can overlap: deduplicate by accepted version and batch identity.
If live delivery begins after bootstrap, durable replay closes that interval.

The sender's own steps also appear in the accepted stream, allowing its adapter to
confirm matching local work. An ACK is a useful shortcut, but it does not replace
the canonical history needed after a lost connection.

### Snapshot asynchronously without dropping operations

A worker reconstructs a chosen committed revision, writes an immutable snapshot, and
verifies its hash before publishing a manifest. A retry uses the same target revision.
If object storage fails, the log remains the recovery source and the manifest does not
advertise an incomplete snapshot.

Trigger snapshots by measured replay cost, bytes, and elapsed time rather than assuming
one fixed operation count fits every document. A hundred small inserts and a hundred
large structural changes have different replay and storage costs.

Compaction retains enough steps for the supported reconnect window and every snapshot
or named version that still requires them. Attempt receipts have their own retention
needs: a client can be uncertain about acceptance even after its edit is included in
a newer snapshot.

A lagging client outside the retained mapping window gets explicit resync/recovery.
Do not index a trimmed array with an absolute version or silently treat a missing
suffix as empty. Preserve unconfirmed client work rather than discarding it on reload.

### Separate delivery work from presence

The outbox publisher can repeat an event after a crash. Delivery workers deduplicate
or use sequence-aware publication, while gateways keep bounded per-document replay
positions. Every interested gateway needs the change; a worker consumer group alone
is not a broadcast protocol.

A fast live bus can lose messages. The gateway/client checks sequence continuity and
periodically reconciles the committed head, so the last lost event is detected even
if nobody edits again. Reconnect retrieves missing committed steps.

Presence is different. Each connection sends a version-relative cursor/selection with
an expiry. Coalesce it to the latest state, use connection identities to distinguish
tabs, and discard old positions. A lost cursor movement does not require historical
replay or a database write per mouse event.

| Approach | Why choose or reject it | Cost |
|----------|-------------------------|------|
| ✅ Durable steps + verified snapshots + replay | Survives missed broadcasts and bounds reconstruction | Storage, compaction policy, and repair paths |
| ❌ Debounce away intermediate edits | Few writes | Later operations can depend on edits that were never stored |
| ❌ Broadcast-only content | Small live path | Disconnected subscribers cannot recover missing changes |

> “I would debounce expensive materialization, not the existence of accepted edits. The log preserves what happened; snapshots make that history economical to reopen.”

## 🔧 Deep dive 3: permissions and review share the document boundary — 6 minutes

### Make revocation apply to active sessions

Current grants govern content reads, replay, snapshots, comments, and edits. Revoke
access through a versioned document command, invalidate subscriptions, and recheck
admission before accepting later work. A cached role from socket establishment can
outlive the grant it was meant to represent.

A metadata cache or read replica is useful only where its staleness is acceptable.
It must not become the authority for a revoked user's next protected read. The system
cannot retract a copy already delivered, but it can stop future delivery and mutation.

Keep the principal, document, and origin bound to the session. Validate WebSocket
origin and message limits. Public identifiers and TypeScript interfaces are not
permission checks or runtime input validation.

### Preserve anchored discussion

A comment anchor names a document revision, start/end positions, and boundary affinity.
Map it through accepted steps under the editor's model. Insertions before a range move
it; deleting its subject may detach it. Store enough context to explain detachment
without showing content the viewer is no longer authorized to read.

The client may be selecting text containing unconfirmed edits. It first establishes
a committed anchor base or uses a defined combined content/comment command. Raw offsets
from that speculative document cannot be interpreted against an older server revision.

Replies must belong to a parent in the same document. Resolve/reopen uses a desired
state and version condition so an old retry cannot undo a newer discussion decision.
The comment draft survives failure independently of the live document stream.

### Restore is a new event

Restore pins a historical target and an expected current head. The owner authorizes it,
preserves the current revision, and commits a new replacement/reset event with a retry
receipt. It does not write an older JSON blob around the collaboration owner.

If current edits advanced the head, reject the stale restore intent and let the user
review again. Participants with pending local edits need a recovery path when the
reset cannot be meaningfully rebased. That may require a copy rather than a forced merge.

Named snapshots and ordinary snapshots are not automatically the same as “current.”
The UI gets their revision and status, and storage retains the history the product
promises. Undo, restore, and suggestion acceptance would all require the same content
authority rather than separate handlers directly modifying the document.

| Approach | Benefit | Cost or failure |
|----------|---------|-----------------|
| ✅ Current admission checks + versioned review commands | Access and reviewed context remain meaningful | Coordination with active document state |
| ❌ Check permissions only when joining | Cheap steady-state messages | Revoked/view-only sessions can keep acting |
| ❌ Restore through an independent SQL overwrite | Short REST handler | Races with live edits and leaves peers on a different history |

> “Sharing and history look like side features, but they can invalidate the editing context. I bring their important decisions through the same authority so they cannot contradict the accepted document.”

## 🛡️ Scaling, failures, and verification — 3 minutes

Many documents scale by partitioning owners and data. Read-heavy rooms can add delivery
gateways without adding writers. For one hot document, bound editor count, batch size,
queue length, and presence fan-out before promising section-level sharding.

Splitting sections changes cross-section moves, selection, comments, and undo. I would
make that an explicit extension, not a transparent operational fix. One home region
for writes is a reasonable starting point; regional disaster recovery needs a declared
durability and failover policy.

| Failure exercise | Expected invariant |
|------------------|--------------------|
| Duplicate submissions race | One accepted range or one terminal no-effect outcome per attempt |
| Owner crashes after commit | Receipt resolves and accepted content remains reconstructable |
| Old owner resumes | Storage rejects the obsolete epoch |
| Last live event is dropped | Head reconciliation discovers the missing range |
| Snapshot publication fails | No manifest references unverified content |
| Revocation races with an edit | Admission ordering determines whether the edit was authorized |
| Restore races with typing | Stale restore cannot silently replace intervening work |

Measure admission queue time, commit latency, peer visibility, replay gaps, snapshot
lag, and unresolved-attempt age. Dependency health alone does not prove collaboration.
Use body-free operation identities in logs and bounded metric dimensions.

## ⚖️ Local implementation boundary — 1 minute

The repository has Express/WebSocket infrastructure, SQL tables, simple position
transforms, presence, and metrics. Its [operation handler](./backend/src/services/collaboration/ot.ts)
ACKs from memory; [persistence](./backend/src/services/collaboration/persist.ts) retains
only the last debounced operation and never applies it to stored content. The browser
also lacks operation send/application integration. This proposal therefore defines
missing guarantees rather than claiming the demo already provides them.

[Architecture implementation notes](./architecture.md#implementation-notes) document
those gaps, including permission enforcement, non-atomic receipts, and restore's
BIGINT version bug. The interview's central argument is the complete path from
identified local intent to one durable history and recoverable peer delivery.
