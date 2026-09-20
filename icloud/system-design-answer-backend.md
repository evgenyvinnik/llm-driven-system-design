# Design iCloud Sync — backend interview

> “I’ll design file synchronization and a private photo library. The hardest part
> is deciding which revision became durable, preserving independent edits, and
> making that decision discoverable after a device disconnects.”

This is a proposed 45-minute architecture, independent of Apple's implementation.
The repository demonstrates a smaller online system; its limits are stated at the end.

## 🎯 Requirements and estimates — 5 minutes

I would clarify whether we need a backup service, a shared filesystem, or a sync
service. I’ll assume authenticated users have several devices that can edit files
independently, including while offline.

The service must support upload, download, folder operations, deletion, and recovery
of missed changes. It must preserve concurrent content revisions and support an
explicit choice between them. Photos add thumbnail and preview generation.

I would defer collaborative text editing, arbitrary application databases, and
cross-account sharing. They need additional merge and permission models.

The main correctness requirement is that an acknowledged revision cannot silently
lose its bytes or disappear behind a concurrent write. Devices may be temporarily
behind, but they need a reliable way to catch up.

“Synced” has several possible meanings. I would expose cloud commitment separately
from delivery of a notification and from materialization of bytes on another device.
No backend can promise that an offline phone has already downloaded a new file.

For a planning workload, assume:

| Assumption | Consequence |
|------------|-------------|
| One million active accounts | Account ownership is a natural partition boundary |
| Three devices per account | Several independent histories, not unlimited actors |
| Ten mutations per account per day | About 116 writes/second average |
| 10× mutation peak | About 1,160 writes/second peak |
| 20 GiB retained logical content per account | About 19 PiB before replication and derivatives |
| 1 MiB new bytes per mutation | About 9.5 TiB/day of ingress |

These are hypothetical inputs, not Apple statistics. Physical storage depends on
retention, compression, replication, and actual reuse; I would not assume a large
deduplication discount before measuring representative content.

Proposed targets are 99.9% monthly metadata availability, p95 metadata reads below
200 ms in the home region, and online hints within two seconds of commit. We prioritize
correct publication over accepting conflicting writes during a metadata partition.

## 🏗️ High-level architecture — 6 minutes

> “I’ll separate the byte-transfer path from metadata admission. Large files should
> not occupy a database transaction while they travel over a mobile connection.”

```
DEVICES AND AUTHENTICATED EDGE — commands, receipts, and catch-up pages

┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Device A                   │1 cmd/ACK   │ API gateway / sessions     │2 replay    │ Device B / other devices   │
│ Local pending command      │◀──────────▶│ Account / device identity  │◀──────────▶│ Saved replay cursor        │
│ Selected bytes + base      │            │ Request and quota bounds   │            │ Verified local revisions   │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
               ▲                                         ▲                                         ▲
               │                                         │                                         │
               │ 3 staged bytes                          │ authorized command                      │ 6 WS hints
               │                                         │                                         │
               ▼                                         ▼                                         ▼
┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Transfer service           │verify      │ Sync admission             │            │ Push gateway               │
│ Upload sessions + leases   │◀──────────▶│ Ownership + base revision  │            │ Account subscriptions      │
│ Verify digest and length   │            │ Verified manifest / quota  │            │ Hints trigger change pull  │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
               ▲                                         ▲                                         ▲
               │                                         │                                         │
               │ put / get                               │ 4 commit / read                         │ publish hints
               │                                         │                                         │
BYTE STORAGE   │                          COMMIT STORE   │                          ASYNC EVENTS   │
               │                                         │                                         │
               ▼                                         ▼                                         │
┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Private object storage     │            │ PostgreSQL account shard   │5 events    │ Outbox relay / job queue   │
│ Verified immutable chunks  │            │ Heads, receipts, feed      │───────────▶│ Retry committed events     │
│ Originals + derivatives    │            │ Outbox in same transaction │            │ Deduplicate event IDs      │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
               ▲                                         ▲                                         │
               │                                         │                                         │
               │                                         │ 7 readiness commit                      │
               │                                         │                                         │
               │ read / write                            │                                         │ jobs
               │                                         │                                         │
               │                          ┌────────────────────────────┐                           │
               │7 derive                  │ Photo workers              │                           │
               └◀────────────────────────▶│ Original / transform ID    │◀──────────────────────────┘
                                          │ Commit derivative status   │
                                          └────────────────────────────┘
```

The gateway establishes account/device identity; sync admission owns namespace and
revision decisions. The transfer service authorizes upload sessions and stages bytes.
Object storage holds immutable blobs; the metadata shard determines which manifests
are committed and who may read them.

I would walk three paths on this diagram:

- **Write and acknowledgement (1, 3, 4):** stage bytes, verify the manifest, then commit
  the revision, receipt, feed entry, and outbox together. The receipt returns through
  the gateway; a lost response is recovered with the same command identity.
- **Delivery and catch-up (5, 6, 2):** relay committed events, notify Device B, and let
  it pull ordered changes through the gateway. Reconnect uses this same replay path.
- **Photo processing (5, 7):** a durable job reads the original, writes derivatives,
  and commits readiness back to metadata, producing another discoverable change.

The outbox is written in the same transaction as the metadata decision. Its relay
schedules derivative jobs and emits push hints. Other devices pull the durable change
feed; a missed hint therefore delays reconciliation without losing the change.

The transaction boundary is the PostgreSQL box. Object transfers and background jobs
sit outside it, protected by staged-object leases and repeatable worker operations.

I would initially deploy these as a modest set of services, with clear modules inside
the metadata service. The diagram describes responsibilities, not a requirement to
create a microservice for every box.

Follow one upload. A device creates an upload session, sends absent chunks, and waits
for verified acknowledgements. It then submits a manifest, a base revision, and a
stable command ID to the sync API.

The API checks account ownership, staged-byte readiness, quota, and current heads.
One transaction admits a new head or retained conflict sibling and writes the command
receipt, feed record, and outbox entry. The response identifies that durable outcome.

A second device receives a hint, pulls changes after its saved cursor, and fetches
missing chunks from authorized manifests. It reports local availability only after
verifying and retaining the bytes.

Metadata and object storage have different ownership roles. An object existing in a
bucket does not make a file visible. A metadata head must never point to an incomplete
upload that cleanup can remove underneath it.

## 💾 Data model and API contracts — 5 minutes

I would draw stable file identity separately from path and revision. Renaming a file
should not change its identity or invalidate every reference to it.

| Entity | Key information | Why it exists |
|--------|-----------------|---------------|
| Account | Identity, logical quota, admission state | Ownership and partition boundary |
| Device installation | Account, actor ID, epoch, acknowledged cursor | Causality and safe retirement |
| Namespace entry | File ID, parent ID, name, current heads | Stable identity and live sibling-name uniqueness |
| Revision | Revision ID, causal context, size, digest, immutable manifest | Preserve accepted content |
| Revision chunks | Revision, index, verified blob identity, length | Reconstruct exact bytes |
| Upload session | Account, staged chunks, expiry, quota reservation | Recover transfer without publishing early |
| Command receipt | Account, command ID, payload digest, outcome | Resolve retries and lost responses |
| Change feed | Account, ordered position, revision or tombstone | Durable device catch-up |
| Outbox | Committed event and publication state | Recover external work after commit |
| Photo derivative | Original revision, transform version, readiness | Retry image jobs deterministically |

A revision manifest must preserve order, expected lengths, and the complete-file
identity. A bag of hashes cannot reconstruct a file containing repeated chunks.
History is useful only if it retains the manifests and bytes required to restore it.

Proposed interfaces expose intent and outcomes rather than database internals:

| Method | Endpoint | Contract |
|--------|----------|----------|
| POST | `/upload-sessions` | Reserve an authorized, expiring transfer |
| PUT | `/upload-sessions/:id/chunks/:index` | Verify a chunk and acknowledge its identity |
| GET | `/upload-sessions/:id` | Report durable transfer progress |
| POST | `/files/:id/commands` | Admit a version-conditioned mutation |
| GET | `/commands/:id` | Return the original durable outcome |
| GET | `/files/:id/revisions/:revisionId` | Authorized immutable manifest |
| GET | `/changes?cursor=...` | Ordered page or explicit reset requirement |
| POST | `/conflicts/:id/resolve` | Resolve exactly the siblings the user observed |
| GET | `/photos` | Stable photo page with derivative readiness |

The same command ID with the same payload returns the same admitted outcome. Reusing
it with another payload is an error. An ordinary transient failure before admission
can remain retryable; a durable business rejection should be explicit.

List queries can tolerate some staleness. Revision admission, quota changes, and receipt
lookup after an ambiguous response need an authoritative view.

## 🔧 Deep dive 1: Causality and atomic revision admission — 8 minutes

> “I would preserve concurrent edits rather than infer intent from a wall clock.
> But a correct vector comparison is only useful inside a correct write boundary.”

### What the causal comparison tells us

Imagine a laptop and phone both start from revision R. The laptop changes a paragraph
while offline; the phone changes a different paragraph without seeing that edit.
Their histories are concurrent even if one device's clock says its edit is newer.

A version vector records observed progress for each actor. A history dominates another
when it includes all of the other's progress and has advanced somewhere. If each has
progress the other lacks, neither is a causal successor.

| Relationship | Admission behavior |
|--------------|--------------------|
| Same known revision or repeated command | Return the known outcome; do not create another revision |
| New edit based on the current accepted head | Advance the head atomically |
| Edit based on an older branch | Preserve or reject according to the explicit branch policy |
| Independent histories | Retain siblings and surface a conflict |

The server validates the actor and submitted context; clients cannot impersonate another
device's counter or submit unbounded vectors. A display name such as “Chrome on Mac”
is not a stable installation identity.

### The transaction is the actual decision point

Two requests can each read the same current head and each conclude that their edit is
acceptable. If both then perform an unguarded update, the later write destroys the
first regardless of how accurate the comparison function was.

I would lock the file's admission record or use a conditional update against the
observed revision, then evaluate the causal relationship against the current state.
Namespace uniqueness and quota must participate in that same decision.

The transaction writes the immutable revision, changes current heads, records the
receipt, appends a change, and creates the outbox entry. The response follows commit.
Object transfer has already finished outside this transaction.

```
┌──────────────────────────┐
│ Verified staged manifest │
└──────────────────────────┘
              │ admission transaction
              ▼
┌──────────────────────────┐
│ Head + receipt + change  │
│ + outbox committed       │
└──────────────────────────┘
              │ durable outcome
              ▼
┌──────────────────────────┐
│ Reply or receipt lookup  │
└──────────────────────────┘
```

A timeout after commit is not a new mutation. The client retries or looks up the same
command ID and receives its original revision. If the transaction did not commit,
there is no partial head or successful receipt to confuse recovery.

### Resolution preserves real bytes

For binary files, I would retain both manifests and let the user choose. For a known
text format, a three-way merge might use a shared base and produce a new revision,
but that is a separate content algorithm with its own conflict cases.

Taking the maximum vector component does not merge a document. “Keep both” must retain
two complete byte histories, not copy current metadata into a second filename.

A resolution command names the observed siblings. If another sibling appears before
resolution commits, the server rejects or expands the decision explicitly. It must
not mark every conflict resolved based on a stale screen.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Causal siblings with transactional admission | Preserves independent accepted edits | More metadata, retained bytes, and conflict UX |
| ❌ Wall-clock last-write-wins | Small state and simple reads | Clock skew and offline edits can silently destroy work |

For a personal file service, silent loss is worse than asking the user to resolve a
conflict. I would accept the complexity while limiting actor count and offering a
clear retention policy.

If the product were online-only with a single authoritative editor, a base revision
and conditional update could be sufficient. Vectors are justified by independent
histories, not by the general desire to sound distributed.

## 🔧 Deep dive 2: Chunk storage, publication, and reclamation — 8 minutes

> “Deduplication is an optimization. A committed manifest remaining readable is
> the invariant. I would design upload and cleanup around that invariant together.”

### Staging and verification

Start with fixed 4 MiB chunks. The transfer service accepts bounded uploads, hashes
the bytes, and checks expected length. It records which verified chunks belong to an
authorized upload session before acknowledging them.

A known hash can identify reusable content, but the server still checks whether the
account is allowed to reference it. Arbitrary hash knowledge cannot grant read access
or prove possession of private content.

The session pins staged blobs until publication or expiry. Publication transfers
protection to immutable revision references. Cleanup observes those protections through
a shared lifecycle protocol, so there is no unprotected gap between the two.

An object-store timeout may leave an object written despite a failed response. Retrying
an immutable, verified object identity can be safe; discovering that object does not
by itself mean the user's file command committed.

### Reconstructing the exact file

A download authorizes the revision, reads its complete manifest, and streams chunks
in order. It verifies expected indexes, lengths, and digests, and fails if the manifest
is incomplete. A missing chunk is not permission to return a shorter successful file.

The client can cache verified chunks and request only missing ones. The manifest remains
necessary because order and repeated chunks matter. Transfer concurrency is bounded
so one large file cannot consume every connection or all process memory.

For large downloads, range support and backpressure matter more than concatenating
all chunks into a single application buffer. Integrity failures should identify the
revision and storage object for repair without exposing content in logs.

### Fixed versus content-defined boundaries

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Fixed chunks initially | Simple offsets, bounded units, easy parallel transfer | Insertions can invalidate reuse across the remaining file |
| ❌ Content-defined chunks initially | Better reuse when content shifts | More CPU, boundary metadata, and implementation complexity |

I would choose content-defined chunking later if edit workloads show that shifting
boundaries dominates transfer cost. Already-compressed photos and videos may offer
little reuse across different files; that must be measured.

I would initially deduplicate within an account. Global deduplication can leak whether
another account holds particular content and complicates ownership, encryption, and
erasure. Randomized account encryption also limits global reuse.

That choice spends more physical storage in exchange for a clearer privacy boundary.
I would not introduce convergent encryption without revisiting the threat model and
product requirements.

### Safe deletion is part of storage design

Reference counts are useful accounting, but a collector cannot simply read zero,
delete the object later, and assume no writer attached it in between.

I would use explicit blob lifecycle states. A collector claims an unreferenced candidate
under the same coordination rule that writers use to attach references. Once claimed,
new publication must retry or create a safely protected replacement.

The collector rechecks staging leases and retained revisions, removes the object, and
records completion. A crash leaves a recoverable state. Delayed and duplicate workers
must not double-decrement or remove a newly live object.

Periodic reconciliation compares counts with authoritative manifests. It must count
repeated chunk occurrences consistently and include conflict siblings and historical
versions. Otherwise a “cleanup optimization” can become data loss.

This protocol costs additional state and operational work. It is justified because
storage reclamation runs concurrently with normal usage and cannot rely on a quiet
maintenance window at production scale.

## 🔧 Deep dive 3: Durable change feeds and offline devices — 8 minutes

> “Push makes sync feel immediate. A durable feed makes it recoverable. I would
> never use a live socket as the only record that a file changed.”

### Choosing a cursor that cannot skip commits

A query for files modified after a timestamp is not a complete change log. Multiple
updates collapse into one current row; timestamps can tie; a transaction may commit
after a later timestamp has already been returned to the client.

I would append a change record in the same transaction as admission. For the initial
scale, a locked per-account counter can serialize position assignment through commit.
The next transaction cannot publish past an uncommitted earlier position.

A global sequence allocated before commit does not provide that property by itself.
At higher scale, a partitioned durable log can provide ordering, but its cursor and
recovery semantics must be defined explicitly.

The client requests a bounded page after its cursor, applies the page, and saves the
new cursor atomically with its local state. Replaying a page is safe because changes
carry stable identities and revisions.

New devices need a snapshot paired with a feed boundary. I would create a consistent
snapshot or a server-supported listing session tied to that boundary, then replay later
changes. “List everything, then read the current cursor” can miss intervening writes.

### Outbox and notification behavior

The outbox relay can publish twice after a crash. Consumers deduplicate by event or
revision identity. It marks progress only after the broker or downstream delivery
boundary acknowledges the publication.

Gateways keep account-scoped subscriptions and send small hints. A disconnected client
catches up on reconnect; a connected client periodically reconciles if necessary.
Hints can be coalesced because the feed carries the complete ordered information.

If notification delivery fails, commits remain discoverable. If metadata admission is
unavailable, clients retain local pending work instead of inventing a successful cloud
acknowledgement.

### Tombstones and device retirement

Suppose a phone stays offline for months while a file is deleted elsewhere. Removing
the tombstone too early can let the old phone reintroduce that file as apparently new.

I would retain deletion history until active devices acknowledge the relevant position,
subject to a documented offline lease. A device beyond that lease is retired and must
rebootstrap before sending old commands.

Retirement also changes actor epochs. Simply pruning an old vector component after
90 days can erase causal information while an old installation still exists. The server
must reject that retired epoch and provide an explicit recovery path for unsent work.

Users should be able to recover local unsent bytes as a new deliberate upload after
rebootstrap. That is different from silently replaying stale mutations into the current
namespace.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable feed plus lightweight hints | Recovers missed changes and supports bounded replay | Feed retention, cursor lifecycle, and snapshot protocol |
| ❌ Push-only updates or mutable timestamp scans | Less persistent infrastructure | Disconnections, ties, and delayed commits can lose changes |

Polling the durable feed alone is a valid simpler option when freshness requirements
are loose. For an interactive multi-device service, hints reduce latency and unnecessary
polling while preserving the same recovery mechanism.

The cost is retained history and explicit reset behavior. I would budget that storage
and monitor the oldest active cursor rather than promising infinite offline replay.

## 📈 Photos, security, and operating the system — 4 minutes

Photo processing runs after original publication. Workers generate a thumbnail and
preview for a named original revision and transform version. They publish readiness
only after both output objects exist, and retries target the same immutable result.

CPU and memory limits protect the worker pool from unusually large decoded images.
The user can see an original as uploaded while a preview is still processing or failed.
Favorites and album membership are separate metadata commands.

Every media read must authorize the account and revision. A shared cache must perform
that check on hits as well as misses; private content must not become publicly reusable
merely because its URL is difficult to guess.

Session caching has a bounded revocation and expiry policy. Existing sockets need
reauthorization or explicit revocation, and album membership checks must authorize
both the album and each photo being added.

The first bottlenecks I expect are byte buffering, image CPU, hot-account admission,
and notification fanout. I would stream transfers, isolate derivative workers, partition
metadata by account, and use shared event delivery across gateways.

A single busy account can eventually outgrow serialized feed admission. Splitting its
ordering domain requires a cursor and namespace strategy; adding random shards without
that protocol only moves the correctness problem.

I would monitor admission latency, replay lag, oldest upload session, derivative backlog,
missing-object errors, and reference mismatches. Tests would lose commit responses,
interleave two edits, expire a device, and race a collector with publication.

Backups must restore metadata and retained objects consistently. A database-only restore
that points to deleted blobs is not a usable recovery plan.

## ⚖️ Trade-offs and implementation boundary — 1 minute

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Concurrent edits | Causal siblings and atomic admission | Retained versions and resolution workflow |
| Bytes | Staged immutable manifests | Transfer and reclamation lifecycle |
| Delivery | Commit-ordered feed plus hints | History retention and reset protocol |
| Privacy | Account-scoped reuse initially | Less cross-account storage saving |

The local app implements PostgreSQL metadata, server-side 4 MiB chunking, MinIO objects,
vector-comparison helpers, synchronous photo derivatives, and in-process WebSockets.
It does not implement the proposed transactional admission, immutable version manifests,
resumable uploads, durable feed, safe reclamation, or device retirement protocol.

Its current metadata writes can race, timestamp changes can be missed, and conflict
copies do not preserve chunk manifests. The proposed guarantees therefore describe
what I would build next, not what the demo already proves.

> “The core design is one durable revision decision with recoverable bytes and a
> replayable record. Everything else—push, caching, deduplication, and thumbnails—
> improves cost or experience around that decision.”

[Implementation details](./architecture.md) · [Run the demo](./README.md)
