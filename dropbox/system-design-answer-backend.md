# Dropbox — backend system design interview

A 45-minute production design discussion for cloud file storage. The architecture is a proposal, not
a claim about Dropbox Inc. or this repository's deployed capabilities. The local implementation is
compared at the end.

## 🎯 Requirements and invariants — 4 minutes

> “I would separate the file users see from the bytes we store. A file has an identity, a place in a namespace, permissions, and a current version. A version is an immutable ordered manifest of byte chunks.”

The functional scope is folder navigation, resumable upload, consistent download, version recovery,
named-user sharing, public links, and change propagation across devices. I would assume files up to
10 GiB and explicitly leave collaborative document editing and desktop filesystem monitoring outside
this interview.

The system should publish a new file only after every referenced byte is verified and protected by
the storage durability policy. An interrupted transfer may leave temporary objects, but it must not
create a visible file with missing content.

The second invariant is that a stale client cannot silently replace a newer version. The third is
authorization: neither knowledge of an object hash nor receipt of an old notification grants access
to somebody else's bytes.

Quota is a product rule we need to settle early. I would charge logical bytes for every retained
version, reserve capacity during upload, and release it when retention ends. Physical deduplication
savings are an infrastructure metric, not an unpredictable change in a user's quota.

I would propose 99.9% monthly regional availability for metadata and download admission, p95 folder
pages below 300 ms, and connected-device visibility within two seconds of commit. Finalization
should usually finish within 500 ms after verified staging is complete. These are targets to
validate, not benchmark results.

For durability, I would specify replicated objects, database backups, integrity checks, and tested
recovery procedures. Quoting many nines without a failure model would not establish that metadata
and bytes can actually be restored together.

## 🏗️ Capacity, architecture, and data model — 5 minutes

Assume one million daily active users, one uploaded version per active user per day, and an average
of 20 MiB per version. At ten metadata reads per user per day, metadata and bytes have very
different scaling characteristics.

| Quantity | Working estimate |
|----------|------------------|
| Finalization rate | 11.6/s average, about 116/s at tenfold peak |
| Metadata reads | 116/s average, about 1,160/s peak |
| Chunk writes | Five 4 MiB chunks/version: about 58/s average, 580/s peak |
| Incoming logical bytes | About 19.1 TiB/day before deduplication |
| Thirty-day incoming versions | About 572 TiB before retention deletion and replication |
| Concurrent connections | Assume 100,000; gateway capacity must be measured |

I would not assume a 30% storage saving. Reuse depends on the actual file population, and downloads
may dominate network cost. The estimates mainly tell us to keep file bytes off the metadata
service's critical path.

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Clients          │────▶│ Metadata API     │────▶│ SQL authority    │
└──────────────────┘     └──────────────────┘     │ + durable changes│
        │                         │               └──────────────────┘
        ▼                         ▼                         │
┌──────────────────┐     ┌──────────────────┐               ▼
│ Upload service   │────▶│ Private objects  │     ┌──────────────────┐
│ Verified staging │     │ Immutable chunks │     │ Change relay     │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ Socket gateways  │
                                                  └──────────────────┘
```

The metadata service owns namespace mutations and permissions. Upload services manage resumable
staging and verify receipts. A relay moves committed changes to gateways. These are responsibility
boundaries; a first implementation can keep several within one deployable service.

A namespace is the transaction and sharding boundary. It can be a personal drive or a shared
workspace. Sharding only by the currently authenticated user would scatter shared-folder operations
and make ownership semantics difficult to preserve.

| Record | Important fields and constraints | Purpose |
|--------|----------------------------------|---------|
| Namespace | ID, revision, owner/account, quota policy | Authority and ordering scope |
| Entry | ID, namespace, parent, name, kind, current version, deletion state | Stable identity and folder hierarchy |
| Version | ID, entry, revision, size, manifest, creator | Immutable file contents |
| Upload/session slots | Actor, operation, manifest, base version, expiry; unique session/index receipt | Resumability and verified bytes |
| Quota reservation | Namespace/account, bytes, expiry, state | Prevent concurrent oversubscription |
| Permission/link | Namespace or entry, principal/capability, actions, expiry | Authorization |
| Receipt/change | Actor-operation identity, payload digest, result; namespace sequence | Retry resolution and synchronization |

Large manifests can use separate ordered slot rows. Chunk storage is content-addressed within an
authorized scope. The metadata database should not use an object key as a substitute for a
permission relationship.

## 🔧 Deep Dive 1: publishing complete files despite retries — 10 minutes

> “I would stage bytes first and publish the manifest in a short SQL transaction. That makes temporary unreferenced bytes an expected cleanup problem, while a visible incomplete file remains a correctness violation.”

A client begins with a target namespace and parent, file identity or new name, expected base
version, declared size, ordered chunk digests, and stable operation ID. Validate integer bounds,
file limits, slot count, digest format, and the sum of lengths before creating a session.

Creation reserves prospective logical quota transactionally. Reservations have expiry and ownership;
active sessions cannot reserve unlimited capacity indefinitely. Rechecking quota only before
transfer lets several clients each spend the same remaining capacity.

Each slot is identified by session and index. A receipt records verified digest, length, and durable
object identity. If the same slot arrives again with the same content, return its receipt. If it
arrives with different content, reject the mismatch. Incrementing a generic uploaded-count field on
every request is not resume tracking.

The upload service can issue short-lived signed transfer capabilities. Those capabilities must be
scoped to the intended object and session, with length/integrity verification before accepting the
receipt. A successful object request is not sufficient evidence that it belongs in this user's
manifest.

Initially choose fixed 4 MiB chunks. This limits retransmission cost and makes range mapping
straightforward. Content-defined boundaries can preserve reuse after insertions, but require more
hashing and a more complex client/server agreement. I would add that only after measuring a workload
where shifted boundaries materially increase costs.

Do not offer unrestricted global hash membership. A client may know the digest of a sensitive
document without being allowed to read it. Reuse within an authorized namespace avoids that
disclosure and attachment problem, at the cost of reduced cross-namespace deduplication.

Finalization does the following in one metadata transaction:

1. Look up the actor-scoped operation receipt and verify the payload identity.
2. Lock or otherwise serialize the relevant namespace/file and reservation state.
3. Recheck current permission, live parent, entry type, name constraints, and base version.
4. Require a complete ordered set of valid slot receipts with matching total bytes.
5. Publish an immutable version, advance the current pointer, and convert reserved quota to retained usage.
6. Record the committed operation result and a durable namespace change/outbox entry.

The transaction also ensures the staging objects remain protected from reclamation as they become
referenced. A collector must not inspect the database before commit and delete those objects while
finalization is using them.

The object upload does not run while holding a file lock. A slow connection can take minutes,
whereas the transaction should only validate existing facts and publish references. SQL and object
storage do not become atomic merely because a function calls both sequentially.

There are three important crash points. Before any bytes arrive, the reservation expires. After
bytes arrive but before publication, protected staging eventually becomes reclaimable. After
publication but before the response, the operation receipt returns the original result on retry.

Post-commit notification failure should not change a successful publication into an unresolvable
failure. The outbox was committed with the version; a relay retries delivery. Metrics and logging
must also be prevented from throwing away the successful response path.

An operation key needs an actor and payload boundary. Reusing it with a different manifest or target
returns a conflict. Receipt retention must be long enough for the supported retry window; an expired
operation should have an explicit terminal response rather than silently becoming a new write.

A generic Redis cache around the endpoint cannot independently guarantee one publication. The result
and the metadata effect must share the transaction, or there must be another equivalent durable
uniqueness mechanism. Otherwise a crash can happen between effect and cached response.

| Approach | Why it works here | What it costs |
|----------|-------------------|---------------|
| ✅ Verified staging plus metadata transaction | Small retries; atomic visible file and receipt | Session ledger, quota leases, and cleanup coordination |
| ❌ One whole-file request | Simple first implementation | Large retransmission and ambiguous timeout outcome |
| ❌ Publish the manifest before verifying objects | Fast metadata acknowledgment | Readers can encounter missing or unauthorized bytes |

## 🔧 Deep Dive 2: concurrent versions and safe reclamation — 8 minutes

> “I would make conflict handling explicit and garbage collection conservative. Recoverable history is valuable only if we preserve the manifests and bytes that history references.”

Suppose devices A and B edit version 7. A publishes version 8. B's request still names base version
7, so its publication is rejected as a conflict while its staged content remains temporarily
retained. B can create a conflict copy or deliberately replace the revision the user has now
reviewed.

Last arrival wins is simpler, but it lets transport timing decide whose work becomes visible.
Keeping history softens that failure without making it obvious to the person whose edit disappeared.
For a file-storage product, a visible conflict is a reasonable cost to protect intent.

A unique version number is not the same as a conflict protocol. A uniqueness exception may stop one
database transaction, but it does not communicate a recoverable user decision or preserve a stable
operation outcome. The API should return current revision and staged-upload identity.

Restore uses the same publication rules. It creates a new version pointing to a retained manifest
and checks the current base version. Under our retained-logical-byte policy, it consumes logical
quota for that new version even if no physical chunk is uploaded.

Downloads pin an immutable version at authorization time. Read the ordered manifest for that version
and stream its chunks with backpressure. A resumed range must identify the same version; reading
current metadata and then a separately changing current manifest can otherwise mix generations.

Range mapping needs chunk lengths, particularly for the final chunk and any future variable-size
chunking. Validate retrieved lengths and integrity; a missing object is a storage failure to repair,
not a successful empty download.

The namespace tree has independent integrity rules. Entry creation must prove the parent is a live
folder in the same namespace. Name uniqueness must also work at the root, where a nullable parent
can otherwise weaken a unique constraint. Stable entry IDs survive rename and move.

A single-request “is destination a descendant?” check does not handle two concurrent moves into each
other. Start with serialized structural mutations within a namespace, with a consistent lock order
or equivalent transaction mechanism. This limits write concurrency in hot shared folders, but
prevents a cycle that could break every recursive traversal.

Now consider deleting a file. With retention, deletion hides the entry while older versions remain
recoverable. Logical quota is released at the retention boundary we defined. The object collector
cannot simply delete chunks referenced by the removed current file, because other versions or files
may share them.

The liveness roots are:

- Current file manifests.
- Retained historical versions, including deleted files still inside retention.
- Active upload sessions and their verified staging slots.
- Any explicitly retained download/repair work covered by the delivery policy.

I would mark candidates that are unreachable, wait through a grace interval, and recheck under a
reclamation protocol that excludes new attachment. Finalization must reject or revive a candidate
safely before attaching it. Grace time alone does not prevent a new reference from racing with
deletion.

Delete the object idempotently and retain a retryable reclamation record until metadata cleanup
completes. If the process crashes after deleting the object but before the final database update,
repeating an absent-object delete is safe. If storage fails first, the candidate remains available
for retry.

Reference counts can accelerate candidate discovery, but every attachment, version copy, restore,
cancellation, and retention purge must maintain them correctly. Reconcile counts against
reachability. A counter incremented per upload request is neither a logical-version count nor a
reliable liveness count.

| Decision | Benefit | Cost |
|----------|---------|------|
| ✅ Base-version publication | Stale writes become explicit recoverable conflicts | Clients must handle conflict and staging expiry |
| ❌ Silent latest-arrival replacement | Fewer user prompts | Network timing can hide another device's work |
| ✅ Coordinated reachability and delayed deletion | Protects current, historical, and staged bytes | Extra retention space, scans, and deletion states |
| ❌ Delete from approximate reference counts | Cheap query and simple worker | Incorrect counts can leak storage or destroy reachable bytes |

## 🔧 Deep Dive 3: sharing and recoverable change delivery — 8 minutes

> “I would put permission checks at every admission point and durable revisions underneath notifications. Neither a socket connection nor an object hash is a permanent authorization grant.”

Named-user sharing belongs to a namespace or an explicit inherited folder grant. Evaluate ownership,
ancestor grants, deletion state, and requested action using a well-defined rule. Cache effective
permissions only with a revision/invalidation strategy and recheck on mutations and byte admission.

Shared namespaces are why I prefer namespace sharding to user sharding. The owner and recipient
should reach one authority for that folder's version and permission decisions. A move across
namespaces is an explicit copy-and-delete workflow with independently authorized steps.

Public links are capabilities with high-entropy tokens, optional password verification, expiry,
allowed actions, and a chosen file/version policy. For example, a link may follow the current file,
but each admitted download pins a particular version. State that behavior so overwrites do not
surprise recipients.

A limited-download counter needs an atomic admission transaction. Checking count and incrementing
later allows several simultaneous requests to all pass. Define whether the product limits
admissions, started transfers, or completed deliveries; exact completion is difficult when a client
disconnects at the end.

I would count admitted transfers and disclose that rule. A retry should reuse its admission when
permitted, without issuing unlimited independent capabilities. Passwords should not travel in URL
query strings, and logs must exclude them and capability tokens.

Keep the object bucket private. A signed URL remains usable within its validity window even if its
parent link is revoked afterward. If immediate revocation is required, route delivery through an
online permission check; otherwise use short validity and clearly define that boundary.

Notifications include a namespace revision and affected entry identities. The SQL commit records the
change durably. A relay may deliver it more than once, and clients must handle duplicates. The
gateway does not need to maintain the sole authoritative copy of every event.

For initial synchronization, obtain a snapshot tied to revision R and then apply changes after R.
For reconnect, request changes after the last applied cursor. If that cursor is older than the
retained feed, reload a snapshot. This closes the gap between taking a snapshot and establishing a
live connection.

Folder pagination must preserve the snapshot/revision semantics. Otherwise an item moved between
pages can be skipped or duplicated. A stable continuation token can encode the snapshot or cause a
clean restart when the server cannot preserve it.

Permission changes also produce changes for affected recipients, but the feed itself must be
authorized. A former member must not keep receiving file names because a socket was authenticated
before revocation. Gateways need session/membership invalidation or bounded reauthorization, plus
checks when granting subscriptions.

With 100,000 mostly idle clients, frequent fixed polling wastes requests. WebSocket hints improve
latency, while durable cursors make missed hints recoverable. Redis Pub/Sub can serve the hint
layer, but it does not retain messages for disconnected clients; its [delivery
documentation](https://redis.io/docs/latest/develop/pubsub/) makes that limitation explicit.

Bound outgoing queues, coalesce revision advances, and disconnect slow clients with a resync
instruction. A reconnect storm should receive paginated catch-up with admission control rather than
exhaust the database through simultaneous full-drive snapshots.

| Approach | Fit for this problem | Trade-off |
|----------|----------------------|-----------|
| ✅ Private bytes and scoped admission | Authorization governs access rather than hash knowledge | URL expiry and revocation semantics must be explicit |
| ❌ Public chunk bucket behind a protected metadata API | Easy object delivery | Object access bypasses application permissions |
| ✅ Durable namespace feed plus socket hints | Recovers after gaps without polling every idle client rapidly | Outbox relay, cursor retention, and resync paths |
| ❌ Pub/Sub as the only change history | Small infrastructure footprint | Disconnected clients cannot replay missed changes |

## ⚙️ Scaling and operational failure handling — 5 minutes

I would first measure finalization contention, object throughput, and folder size distributions. The
initial metadata rate is modest compared with byte volume; splitting every function into a
microservice would not fix a process that buffers whole files in memory.

Scale upload admission and object transfer separately from metadata workers. Add per-account
concurrency, size limits, bounded queues, and deadlines that propagate cancellation. Retries need
jitter and an overall budget; a finite attempt count does not bound a network call that never
returns.

Use replicas for reads only when staleness is acceptable or a minimum revision is enforced.
Immediately after saving, route the client to an authority that can see its committed version. A
replica returning the old file should not make a successful upload appear to vanish.

A hot shared workspace can become a namespace bottleneck. Isolate it on a shard, page large folders,
and measure structural-mutation serialization. Partitioning one table inside one database does not
by itself distribute writes across machines.

Object storage should verify integrity and keep sufficient replicas or erasure-coded fragments under
a documented durability policy. Backups need recovery drills that restore both namespace metadata
and reachable bytes. Cross-region failover requires writer fencing; accepting writes in two isolated
authorities can recreate the conflict problem at a larger scale.

Important alerts include oldest undelivered change, unresolved operation outcomes, missing objects,
quota drift, retention backlog, and repeated reclamation failures. Process liveness is separate from
readiness to authorize or finalize a transfer.

| Failure | Response |
|---------|----------|
| Object upload unavailable | Retry within budget; retain session; do not publish |
| Finalization response lost | Query durable receipt for the same operation |
| Notification relay down | Keep changes in outbox; monitor lag |
| Quota reservation expires | Reauthorize and reserve again before publication |
| Missing object on download | Fail explicitly and repair from a valid replica |
| Collector crashes | Resume its durable deletion state safely |

## 🧪 Validation and implementation comparison — 5 minutes

The strongest initial check is a fault-injected upload: lose the response after commit and show that
retry returns one file version, one quota conversion, and the same manifest. Then download and
compare bytes. Page rendering alone cannot establish any of those properties.

Next I would race two finalizations against the same base version, two quota reservations against
the remaining capacity, and a structural move against another move. Exercise collector/finalization
interleavings and revocation during download admission. These tests target invariants rather than
the number of API handlers.

The local implementation has one Express process, PostgreSQL's ten-table schema, MinIO chunks, and
Valkey sessions/Pub/Sub. It has a real SQL transaction for completion and history updates, plus
Cockatiel, Pino, and Prometheus helpers. There is no RabbitMQ worker or durable change feed.

Its browser uses whole-file multipart uploads with an 8 MiB default limit. Upload sessions record
only counts, and completion does not bind the original manifest, validate object existence, enforce
expiry/status, or guard the base version. Repeating completion can create another version and
increment usage again.

Default PostgreSQL BIGINT strings also break quota comparisons. A metric increment rejects the
string size after commit, preventing the successful response and notification path. Isolated source
execution reproduced that outcome; no full-stack runtime test is claimed here.

Folder grants do not authorize normal file operations, and shared-with-me is shadowed by the earlier
token route. Compose enables anonymous bucket downloads. The server has WebSockets but the browser
does not subscribe. Downloads buffer every chunk and return empty bytes for seeded metadata without
chunk rows.

Reference counts are not maintained as reachability, cleanup removes SQL rows before object
deletion, and there is no scheduled retention collector. Folder caching and idempotency helpers are
not wired into file routes. A detailed mapping appears in
[architecture.md](./architecture.md#implementation-notes).

I would therefore implement verified slots, durable completion receipts, and exact quota handling
before claiming reliable sync or scaling the number of API instances. Those changes establish what
“saved” means; the remaining delivery and recovery design can then depend on a trustworthy published
version.
