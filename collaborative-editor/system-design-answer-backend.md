# 📝 Design a collaborative editor: backend interview

> “I would organize the backend around one accepted history for each document.
> WebSockets deliver edits quickly, but the service still needs to decide their
> order, make each acknowledgement durable, and recover the same history after a
> failure.”

This is a proposed production design for a 45-minute interview. The local
application includes an operation log and RabbitMQ fanout, but lacks the authority
and recovery guarantees described here. [Implementation
Notes](./architecture.md#implementation-notes) trace the checked-in behavior.

| Time | Discussion |
|------|------------|
| 4 minutes | Requirements and capacity |
| 5 minutes | Architecture and data model |
| 9 minutes | Deep dive: document ordering and OT |
| 9 minutes | Deep dive: durable acceptance and delivery |
| 8 minutes | Deep dive: snapshots and reconnect recovery |
| 6 minutes | Scaling, access control, and operations |
| 4 minutes | Verification and implementation boundary |

## 🎯 Requirements and capacity — 4 minutes

I would scope the service to collaboratively edited plain text. It supports document
creation, discovery, rename, view/edit permissions, live edits, and participant
presence. Historical preview and restore use the same durable history rather than a
separate conflicting source of truth.

The client applies typing locally without waiting for the server. The server's
responsibility is to admit authorized operations, assign a canonical order,
acknowledge durable acceptance, and make missed history recoverable. I would not
promise that an open WebSocket means every local character is already saved.

Extended offline branches, embedded media, and rich-text structure are outside the
first version. Short interruptions should recover automatically where history
permits; unsupported old drafts should remain available to their owners for explicit
recovery.

I would target p99 acknowledgement below 200 ms and peer visibility below 300 ms
within a region under normal load. A 99.95% regional availability target is
reasonable, while an uncertain document owner or unavailable durable store
temporarily stops writes for that document.

Assume 100,000 connected sessions across 20,000 active documents. If 20% of users
are actively typing and each sends two batches per second, peak admission is about
40,000 operations/s. At 600 bytes per operation before indexes and replication, the
raw peak log rate is 24 MB/s.

The sustained rate matters for storage: 10,000 operations/s on average is about 518
GB/day of raw history. I would establish retention and archival policy early. It is
not enough to say that text documents are small while ignoring years of edit
history.

A document with 50 active writers at two batches/s receives 100 ordered commands/s
and can require 4,900 peer deliveries/s. That distinction suggests a serialized
admission path with separately scalable delivery. Adding database shards helps many
documents; it does not eliminate contention on one document head.

These figures are assumptions for discussion, not a capacity claim for the
repository. I would validate workload distributions, document size, paste behavior,
and writer/viewer ratios before final sizing.

## 🏗️ Architecture and data model — 5 minutes

I would draw a document owner between connection handling and durable storage:

```
┌──────────────────┐       ┌──────────────────┐
│ WebSocket        │──────▶│ Document owner   │
│ gateways         │◀──────│ Ordered commands │
└──────────────────┘       └────────┬─────────┘
                                    │ atomic append
                           ┌────────▼─────────┐
                           │ PostgreSQL       │
                           │ Head/log/receipt │
                           │ Snapshot/outbox  │
                           └────────┬─────────┘
                                    │ committed events
                           ┌────────▼─────────┐
                           │ Fanout / workers │
                           └──────────────────┘
```

Gateways authenticate and hold connections. They route edits to a single logical
owner per document. The owner validates and transforms operations, coordinates
durable acceptance, and provides an ordered stream to subscribers. Multiple gateways
can deliver that stream without becoming independent authorities.

The first implementation can use a shared PostgreSQL cluster with document-based
partitioning later. Keep each document's head, log, receipts, and outbox in the same
transactional partition. Redis holds expiring presence and optional caches, not the
authoritative document text.

| Record | Key information | Why it exists |
|--------|-----------------|---------------|
| Document | ID, title, owner, metadata revision | Discovery and independent metadata changes |
| Access grant | Document, principal, role | Explicit read/edit/manage admission |
| Document head | Document, committed version, authority generation | One current history and fenced ownership |
| Operation | Document/version, transformed edit, actor, receipt ID | Replayable canonical history |
| Operation receipt | Document/actor/operation ID, original fingerprint, result | Resolve duplicate and ambiguous requests |
| Snapshot | Document/version, content, checksum, format version | Bound reconstruction work |
| Outbox | Event ID, document sequence, publication state | Recover delivery after the commit |

A snapshot is an exact representation of a committed version. Presence is different:
it is the latest approximate cursor and activity state for a live participant.
Persisting every cursor movement in the operation log would make document recovery
more expensive without improving text durability.

The API surface can stay compact:

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/documents` | List permitted documents or create one |
| GET / PATCH | `/api/documents/:id` | Read metadata or conditionally rename |
| GET | `/api/documents/:id/versions` | Browse retained history |
| POST | `/api/documents/:id/restore` | Restore a preview as a new edit |
| GET | `/api/documents/:id/operations/:operationId` | Resolve a submitted operation |

An authenticated WebSocket handles edit submission, acknowledgement, ordered remote
edits, baseline/replay, and presence. History, restore, and receipt endpoints are
proposed additions; they are not available in the current demo.

## 🔧 Deep dive: document ordering and OT — 9 minutes

I would choose one serialized admission stream per document. Clients may edit
optimistically in parallel, but their accepted operations enter one history. This
gives each operation an unambiguous committed base against which it can be
transformed.

Suppose Alice and Bob both open “cat.” Alice inserts X after c and commits first.
Bob had inserted Y after a using the original document. The server transforms Bob's
position through Alice's committed edit, producing the combined text “cXaYt.” The
server broadcasts the canonical transformed operation with its assigned version.

The same-position case needs a deliberate priority rule. In this proposal, an
already committed insertion precedes a newly admitted concurrent insertion. Browser
reconciliation must use the same priority between a remote committed operation and
local pending work. A pairwise transform that converges when used correctly can
still fail within an inconsistent protocol.

I would describe retain, insert, and delete at a high level, then insist on tested
operation algebra and a tested client state machine. I would not attempt to
implement every transform branch on a whiteboard. Handling partially consumed
operations and overlapping deletions is exactly where attractive pseudocode tends to
hide errors.

Input validation must establish that the operation fully consumes the stated base,
produces the declared target length, contains legal finite counts, and fits
size/work limits. The base version must exist in supported history. An operation
with a plausible base length can still contain invalid component totals or refer to
the wrong text.

The owner processes an entire command before admitting the next one, including
asynchronous storage. JavaScript running on one thread does not achieve this
automatically: another handler can run while the first awaits a database query. A
per-document command queue provides the required workflow serialization.

For failover, routing to one process is insufficient. The database head carries an
authority generation that every append checks. When a replacement owner takes over,
it advances that generation while locking the head; subsequent commits from the old
generation fail. Takeover and appends must serialize through the same authority
record.

An old owner that committed before takeover may still have a valid event to deliver.
It cannot invent a new sequence afterward. Gateways and clients deduplicate and
check sequence numbers, while the replacement owner reconstructs the committed head
before accepting new work.

| Authority model | Benefits | Costs |
|-----------------|----------|-------|
| ✅ One fenced owner per document | Single transform context and accepted history | Brief write interruption during recovery; hot-document limit |
| ❌ Independent mutable owners with fanout | Easy to accept local writes | Concurrent heads, stale transforms, and conflicting snapshots |
| ❌ Unique version constraint alone | Rejects duplicate version rows | Does not repair speculative memory or decide failover ownership |

A CRDT is a credible alternative when independent offline writers are a core
requirement. It changes operation identity and merge semantics. It does not remove
the need for authorization, durable storage, delivery, or a coherent product
history. I would choose the concurrency model based on that requirement rather than
claim OT is always simpler or CRDTs always waste memory.

The cost of central admission is intentional: when ownership is uncertain, I stop
writes for that document. Other documents can continue. Accepting edits from both
sides of a partition and promising to reconcile later would require a different
authority and merge design.

> “A load balancer chooses where a request goes. A document owner decides which edit
> becomes part of history. I would not treat those as the same guarantee.”

## 🔧 Deep dive: durable acceptance and delivery — 9 minutes

I would define acknowledgement precisely: this operation has committed to the
configured durable database authority. The acknowledgement includes its stable
operation ID and assigned version. It does not mean every peer has received it or
that a snapshot was just written.

The command flow is short enough to explain as a sequence:

1. Authenticate, authorize, validate, and resolve any existing operation receipt.
2. Transform an unseen edit against the committed suffix and compute candidate text without replacing committed memory.
3. In one transaction, check authority, advance the head, append the operation and receipt, and record an outbox event.
4. After commit, update owner memory, acknowledge the exact request, and continue the document queue.
5. Deliver committed events through the relay; recover missed delivery from durable state.

The distinction between candidate and committed memory matters. If I change memory
first and the insert fails, a later reader or disconnect snapshot can receive text
that never became part of the log. Rolling back the SQL transaction does not
automatically roll back JavaScript objects.

A database timeout during commit is ambiguous. I pause the document's queue and
resolve the receipt/head before proceeding. Retrying immediately against changed
memory could transform or duplicate an edit that actually committed.

Receipts are scoped to the authenticated actor and document, with a fingerprint of
the original payload and base. Reusing an ID for different content is rejected. The
database uniqueness rule resolves concurrent duplicate requests; a Redis check
followed by a later write leaves a race window.

After commit, a process may crash before publishing to RabbitMQ. The outbox keeps a
recoverable delivery obligation in the same transaction as the operation. A relay
may publish twice after a crash, so downstream consumers still need sequence-aware
deduplication.

The broker's publisher confirmation proves a different boundary from its consumer
acknowledgement. Neither establishes browser rendering. I would use confirmed
publication plus outbox retry, and acknowledge consumer delivery only after the
intended gateway processing. [RabbitMQ documents these separate acknowledgement
boundaries](https://www.rabbitmq.com/docs/confirms).

Deduplication scope matters in fanout. If gateway A records a global “seen event”
flag before gateway B receives its copy, B may suppress a delivery that its own
clients still need. Each subscription tracks its own last applied sequence or event
identity.

A gateway should not silently discard a missing document operation to keep up. If
its bounded queue overflows, it disconnects or pauses the affected subscription and
resumes from a known sequence. Presence can be coalesced to the newest cursor,
because its contract is different.

| Acceptance strategy | Benefits | Costs |
|---------------------|----------|-------|
| ✅ Atomic log/head/receipt/outbox commit | Durable meaning for acknowledgements and recoverable delivery | Transaction latency and outbox operations |
| ❌ Acknowledge before persistence | Lower apparent latency | A crash can erase work already labeled saved |
| ❌ Commit then publish without recovery state | Small implementation | A crash between the two leaves peers permanently behind |

I would not put a distributed transaction across PostgreSQL, RabbitMQ, Redis, and
every browser. A durable append is one atomic boundary; replayable, idempotent
delivery is another. That division gives a meaningful guarantee without requiring
all collaborators to be online at commit time.

Presence should also stay outside the critical commit path. Redis failure may hide
active cursors, but it should not turn a durably accepted text edit into an apparent
failure. Separate statuses and metrics make that degradation understandable.

## 🔧 Deep dive: snapshots and reconnect recovery — 8 minutes

I would reconstruct a document from a verified snapshot and an ordered log suffix.
Saving full content for every keystroke repeatedly writes mostly unchanged text;
loading from the first operation forever makes old documents slow to open.

A snapshot records content at exactly version V. A worker reads a committed baseline
and replays through V, verifies the result, and publishes the snapshot manifest only
after the content is durable. The previous verified snapshot remains available until
the new one is safe to use.

I would trigger snapshots by replay cost, accumulated operation bytes, and elapsed
time. A fixed interval of 50 operations is understandable in a teaching
implementation but can generate excessive full-text writes for large documents or
frequent small edits.

History retention has two uses: reconstructing past versions and transforming
clients whose base is older than the current head. Taking a snapshot solves neither
policy automatically. Deleting the whole preceding log can make an old client's
operation impossible to rebase safely.

I would define a supported automatic recovery window. Within that window, replay the
missing suffix and resolve the in-flight receipt. Beyond it, provide a fresh
coordinated baseline while preserving the client's old draft for explicit recovery.
Do not pretend that applying an old positional edit to arbitrary new text is a
merge.

Opening or reconnecting needs an exact subscription boundary. The owner supplies a
baseline at V and buffers subsequent committed events until the subscriber is ready.
Fetching a snapshot and subscribing afterward leaves a gap that can survive
indefinitely even though both requests succeeded.

A historical restore is a new command against the current head. The UI previews the
old version, and the server checks the current revision when accepting the restore.
If other work arrived meanwhile, the user should reconsider the restore rather than
overwrite it under an obsolete assumption.

| Storage strategy | Benefits | Costs |
|------------------|----------|-------|
| ✅ Verified snapshots + ordered history | Bounded replay with meaningful version recovery | Snapshot verification and retention management |
| ❌ Full snapshot on every edit | Straightforward latest-content read | High write amplification for small changes |
| ❌ Operation log without checkpoints | Minimal snapshot machinery | Open/recovery cost grows with document age |

Recovery must distinguish an invalid operation from damaged durable history. A
malformed request can be rejected without affecting the document. A missing
committed revision or snapshot checksum mismatch should stop admission and trigger
reconstruction or operator attention, rather than continue from a guessed string.

I would test snapshot restore regularly and retain the format/protocol version
needed to interpret old operations. Schema evolution is part of replay correctness:
archived bytes are only useful if the service can still decode their intended
semantics.

> “The snapshot is a shortcut to a known point in history. It is not permission to
> forget which edits committed or to overwrite a client's unresolved draft.”

## ⚖️ Scaling, access control, and operations — 6 minutes

Once the single-document protocol is correct, shard by document ID. A bounded cache
of recent committed operations avoids querying the same suffix repeatedly during
active collaboration. Older supported bases can fall back to the database.

Each document's owner cache is disposable. Moving ownership requires fencing,
loading the committed head, and replaying before admission. Consistent hashing helps
distribute documents, but changing the hash ring alone does not coordinate old and
new writers.

For a hot document, scale its delivery gateways and reduce presence traffic before
splitting text into independently owned sections. Section-level ownership changes
the semantics of operations spanning boundaries and is a substantial
product/algorithm decision.

The initial global design uses a home region per document. Other regions can serve
static assets and retained history, but active editing routes to the authority.
Cross-region disaster recovery needs an explicit data-loss and recovery-time policy;
asynchronous replicas do not justify an unqualified “never lose edits” claim.

Security checks cover metadata, baseline content, edits, history, and presence. A
user-supplied UUID is not a session. Permission revocations are ordered with
admission, prevent new writes, and remove future delivery to revoked connections.
The system cannot retract text already disclosed.

I would bound message size, operation counts, document size, reconnect frequency,
transform history, and queued bytes. These limits protect the event loop and
database from expensive malformed edits or slow peers. A broker prefetch setting
only bounds that consumer's unacknowledged messages; it is not a global system
limit.

Useful metrics include admission queue time, durable-ack latency, replay length,
operation validation failures, receipt ambiguity, owner recovery time, and delivery
sequence lag. Snapshot backlog and verification failures need their own alerts.
Count active sessions separately from approximate collaborator presence.

Readiness should reflect the dependencies needed for the advertised behavior. A
process that can query PostgreSQL but has lost its document consumer or authority is
not ready for the same traffic as a fully functioning owner. Shutdown should stop
admission, settle or preserve pending commands, and then close dependencies.

## 🧪 Verification and implementation boundary — 4 minutes

I would verify operation algebra first, then the protocol: two clients editing the
same position, overlapping deletes, buffered edits, duplicate delivery, and a lost
acknowledgement. Convergence checks compare final text and accepted sequence after
all pending work settles, rather than checking only that both sockets stayed
connected.

Durability tests inject failure before append, during an unknown commit result,
after commit before publication, and during owner takeover. Snapshot tests rebuild
from an older verified checkpoint. A broker restart test must establish that
consumers resume and missed sequences are replayed.

The repository has PostgreSQL operation/snapshot tables, a Redis presence hash,
RabbitMQ queues, structured logging, and metrics. However, it mutates memory before
persistence, lacks serialized ownership, forwards remote edits without updating
receiving server state, and does not consume its snapshot queue.

The browser sends no stable operation ID, and the optional server deduplication
cache is not a durable receipt. Isolated checks also reproduced transform/compose
failures and a same-position insertion disagreement. The existing smoke test only
checks page rendering. These are implementation gaps, not evidence against the
proposed ordering model.

| Decision | Interview choice | Main cost |
|----------|------------------|-----------|
| Authority | One fenced document owner | Per-document recovery pauses and throughput limit |
| Acceptance | Transactional head/log/receipt/outbox | Durable write latency and delivery recovery machinery |
| History | Verified checkpoints plus retained log | Replay validation, retention, and storage operations |

I would prove a single document's accepted history and recovery first, then increase
the number of owners and gateways while preserving those same boundaries.
