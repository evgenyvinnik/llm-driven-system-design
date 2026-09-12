# Dropbox — fullstack system design interview

A proposed production file-storage design for a 45-minute interview. The emphasis is the contract
between a browser's visible state and the backend's durable state. This does not describe Dropbox
Inc.'s internals; the repository's current implementation is compared at the end.

## 🎯 Frame the user journey — 4 minutes

> “I would design around a user uploading a presentation, editing it from two devices, and sharing it with a colleague. That journey connects the interface to the hard backend questions: when is it saved, whose edit wins, and who can read the bytes?”

I would include folders, resumable upload, consistent download, version restore, named-user folder
sharing, public file links, and updates across devices. I would clarify that this is a browser
product. A desktop filesystem watcher and collaborative document editor are separate systems.

The maximum file size is an assumed 10 GiB. That means a browser cannot simply load the whole file
into a second memory buffer and retry one giant request. It also means a progress bar needs to
distinguish sending bytes from publishing a usable file.

I would define the promises together with the interviewer:

- Saved means a complete, verified manifest has been committed and its bytes are durably available under the storage policy.
- A retry of the same upload intent produces one committed version and one quota charge.
- Concurrent edits produce an explicit conflict rather than a silent overwrite.
- A shared recipient can perform only authorized actions, including on bytes fetched outside the metadata API.
- A device that misses notifications can reconcile from durable state.

For quota, count logical bytes for every retained version and reserve capacity while uploading.
Physical deduplication savings are separate. Restore creates another retained version, and deletion
releases quota when retention expires, so users have a predictable policy.

I would propose 99.9% regional availability, p95 folder-page responses below 300 ms, and
connected-device visibility within two seconds of commit. These are design targets. Transfer time
depends on bandwidth, and object durability requires a concrete replication and recovery plan rather
than an unsupported percentage.

## 🏗️ Architecture and shared contracts — 5 minutes

Assume one million daily active users, one 20 MiB uploaded version per user per day, and ten
metadata reads per user per day. That gives about 11.6 finalizations and 116 metadata reads per
second on average. At a tenfold peak, bytes entering the system are roughly 2.26 GiB/s before
deduplication.

This suggests separating the byte path from the namespace path. Metadata traffic does not justify a
large service fleet by itself, while object traffic can overwhelm an API that buffers files.

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Browser UI       │────▶│ Metadata API     │────▶│ SQL + outbox     │
│ Routes and cache │     │ Auth and versions│     │ Namespace state  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                                                   │
        ▼                                                   ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Upload manager   │────▶│ Upload service   │     │ Change relay     │
│ Worker and queue │     │ Verified staging │     │ Socket gateways  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                  │                         │
                                  ▼                         ▼
                         ┌──────────────────┐     ┌──────────────────┐
                         │ Private objects  │     │ Other devices    │
                         └──────────────────┘     └──────────────────┘
```

React renders navigation and dialogs. The URL owns the current namespace/folder. A keyed
server-state cache owns folder pages and versions; a Zustand-style client store owns selection and
the upload queue. A worker hashes bounded slices, and the upload manager survives route changes.

PostgreSQL owns metadata, permissions, quota reservations, operation receipts, and durable changes.
Objects are immutable chunks addressed within an authorized namespace. Redis can hold sessions and
fan out notification hints; the durable recovery cursor does not live only in Pub/Sub.

| Shared concept | Browser meaning | Backend responsibility |
|----------------|-----------------|------------------------|
| File ID | Stable selection and dialog target | Identity survives rename and move |
| Base version | Revision the user edited | Reject a stale replacement |
| Upload/operation ID | Recover one user intent | Persist receipts and return the same result on retry |
| Slot receipt | Verified progress | Bind index, length, digest, and durable object |
| Namespace revision | Last reconciled state | Ordered change feed and consistent snapshot boundary |
| Effective capabilities | Enabled UI actions | Recheck authority for every operation |

I would write down these terms before detailed endpoints. If “uploaded” means network completion to
one engineer and committed file to another, the UI and backend will disagree even when every request
returns valid JSON.

## 🔧 Deep Dive 1: from dropped file to durable success — 10 minutes

> “I would make the upload task a state machine that mirrors the server's publication protocol. The user sees Preparing, Transferring, Saving, and Saved because those are different facts.”

When a file is dropped, capture its destination and create a stable task ID. A subsequent navigation
changes the browser view, not the task's target. Validate obvious size/type limits early for
feedback, while leaving security and quota enforcement to the server.

A worker slices the file into fixed 4 MiB chunks and computes digests without blocking input. Begin
with a bounded pool of perhaps three concurrent chunk transfers. Multiple dropped files share that
pool so memory and socket usage remain bounded.

Fixed boundaries make the protocol and progress bookkeeping simple. An insertion near the beginning
can change many later chunks, so this is not a promise of optimal delta synchronization.
Content-defined chunking is an extension to evaluate after measuring the workload.

The browser sends the ordered digest/length manifest, declared size, target, base version, and
operation identity. The server validates bounds and authority, then reserves logical quota with a
lease. It returns a session and upload instructions for slots that cannot already be reused within
the authorized scope.

The client must not learn or attach arbitrary other users' content by submitting a global hash.
Namespace-scoped deduplication gives up some storage savings but prevents content knowledge from
becoming access. Signed object requests also need bounded scope and expiry.

As chunks arrive, the upload service verifies digest and length, records durable slot receipts, and
protects staged objects from reclamation. A retry of the same session/index/content returns the same
receipt. A different digest for the same slot is a conflict, not another increment of progress.

At the UI boundary, distinguish bytes sent from slots verified. A request may reach 100% network
progress while the server is still verifying or committing. Transition to Saving, and announce Saved
only after a committed result is known.

Finalization is one short metadata transaction:

1. Resolve an existing actor/operation receipt and validate that its payload matches.
2. Recheck destination, permissions, base version, name constraints, and reservation.
3. Verify the complete ordered receipt set and total length, with objects protected against concurrent reclamation.
4. Create the immutable version and advance the current file pointer.
5. Convert reserved bytes to retained logical usage.
6. Write the operation result and namespace change/outbox record together.

The transaction does not contain a long object transfer. Staging bytes before publication avoids
holding database locks while a user waits on Wi-Fi. A failure before commit can leave temporary
bytes; it must not leave a visible partial file.

Now lose the final response. The browser should show Checking whether it saved and query the same
operation. A committed receipt resolves to the same version, while a pending operation remains
pending. The browser must not generate a fresh intent just because the HTTP response was lost.

The outbox prevents notification delivery from deciding the upload's result. If the relay is down,
the committed file remains saved and the change waits durably. Metrics and logs likewise must not
turn a completed transaction into a misleading failed response.

Persist upload task metadata and receipts in IndexedDB if reload recovery is required. The original
File object is not guaranteed to remain accessible after reload. Ask for reselection when necessary,
verify the file against the manifest, and resume only the server-confirmed missing slots.

Pause stops scheduling work. Cancel releases the session if publication has not committed; if it
has, the result is a saved file and deletion is a separate action. Aborting a request does not prove
the server aborted its effect.

Expired sessions need explicit recovery. Reauthorize, reserve capacity again, and reuse only
receipts or bytes permitted under the new session. A client-side progress record cannot extend quota
or permissions indefinitely.

| Approach | User effect | System cost |
|----------|-------------|-------------|
| ✅ Verified chunks and durable completion receipt | Resume work and resolve uncertain outcomes | Worker queue, session ledger, reservation, and receipt retention |
| ❌ Whole-file request with retry as a new upload | Simple initial progress bar | Large retransmission and duplicate versions after lost responses |
| ❌ Mark complete when bytes reach 100% | Immediate satisfying feedback | Claims success before the file is visible and durable |

## 🔧 Deep Dive 2: concurrent edits without confusing the screen — 8 minutes

> “I would use stable entity identity in the client and an expected version in the server. Those solve different races: which screen a response belongs to, and whether a write is still based on current data.”

Start with navigation. Folder A's request is slow; the user opens B; A completes last. One global
file array can now show A under B's URL. Key the cache by account, namespace, folder, and query so
each response retains its meaning.

Abort obsolete requests to reduce waste, and check request identity before updating the active view.
The same rule applies to a dialog that changes target while loading versions or permissions.
Cancellation is helpful but not a sufficient correctness mechanism by itself.

An upload finishing in A while the user views B should invalidate A's cache and show a link to the
new file. It should not refresh a global current-folder variable back to A. This is why the transfer
manager owns destination separately from navigation.

For rename, use a pending overlay attached to the file ID and operation ID. The server validates
uniqueness and permission and returns an authoritative revision. If the request fails, remove only
that overlay; do not restore an entire old folder array that may erase unrelated updates.

For content replacement, suppose both devices edit version 7. A commits version 8. B finalizes
against version 7 and receives an explicit conflict. Its verified bytes stay staged for a bounded
period so the UI can offer Keep both or an intentional replacement.

Version history alone is not enough. With silent last-arrival replacement, a user might never
discover that another edit disappeared from the current file. The conflict is an interruption, but
it communicates a decision that network timing cannot make for the user.

A deliberate replacement is a new guarded operation against the revision the user just reviewed. It
is not an unconditional “force” that can unknowingly erase a third edit. If the current revision
changes again, the UI must reconcile again.

Restore is similar: choose an old manifest, then publish a new current version with a base-version
check. Show the quota effect before confirmation under the retained-version policy. Do not renumber
or discard intervening history.

Downloads also need a version contract. A user who resumes a large download must receive ranges from
the same immutable version. The server pins the manifest at admission, and the browser retains that
version identity for subsequent ranges.

Folder moves require structural validation beyond content versions. The UI can hide known invalid
targets, but the server checks destination namespace, folder type, liveness, and cycles. Two
simultaneous moves can each look safe in isolation and still form a cycle.

I would begin with serialized structural mutations within a namespace. That constrains concurrency
in a very active shared workspace, but makes the tree invariant defensible. A cross-namespace move
becomes an explicit authorized copy-and-delete workflow.

Deletion introduces a retention boundary. The UI can show the entry as deleted while history remains
retained. The backend releases logical quota when that retention ends, then reclaims only bytes
unreachable from current versions, history, and active uploads.

A collector needs coordinated marking, a grace interval, and a final liveness check that excludes
new attachment. Reference counts are useful only if every attachment/removal updates them correctly.
An approximate upload-request count cannot tell whether a chunk is safe to delete.

| Decision | Why choose it | What we give up |
|----------|---------------|-----------------|
| ✅ Keyed remote state and operation overlays | Late responses cannot redefine the current screen | More explicit identities and reconciliation |
| ❌ One latest folder array and snapshot rollback | Small initial store | Navigation and concurrent mutation races |
| ✅ Base-version conflicts with retained staging | Preserves edits and asks for user intent | Conflict UI and staging retention |
| ❌ Silent replacement with hidden history | Fewer prompts | Another device's work may disappear unnoticed |

## 🔧 Deep Dive 3: sharing and synchronization across devices — 8 minutes

> “I would make a shared workspace a real authorization and ordering boundary. A recipient's file browser must follow the same authority as the owner, and reconnect must not depend on having seen every socket message.”

The server returns effective actions for entries so the UI can show sensible controls. It also
rechecks those actions on every request. A dialog opened before revocation may still offer Upload,
but the final server decision must reject it if authority has changed.

Grant inheritance should be explicit. A file's permission comes from its namespace and applicable
ancestor rules, with clear behavior for moves and revocation. Hiding a menu is not enforcement; the
download path and direct object capabilities need the same admission policy.

Public links get a distinct public page that can explain expiry, password requirements, and the
target file. Password submission should avoid URL query strings. Wait for clipboard success before
showing Copied, and expose download errors as understandable states rather than raw server messages.

If a public link follows the current file, say so. Each admitted transfer still pins one immutable
version. A limited-download link needs atomic admission; separate “check remaining” and “increment
later” operations can overrun the limit under concurrency.

I would define the count as admitted transfers, since determining exact completion after a
disconnect is ambiguous. A permitted retry can reuse its admission instead of consuming another
slot, within a bounded policy. That server rule should agree with the text shown on the public page.

Objects remain private. A short-lived signed URL may outlive revocation of the link that issued it,
so the product must choose that bounded window or require an online check at byte delivery. Already
downloaded bytes cannot be recalled, and hiding a download button does not prevent copying a
displayed file.

For live updates, the metadata transaction writes a namespace change with a monotonically increasing
revision. A relay publishes hints to socket gateways, which notify authorized subscribers. A gateway
may deliver duplicates or miss a disconnected device without losing the durable change.

Initial load returns a snapshot tied to revision R. The client applies changes after R, while socket
hints tell it that a newer revision exists. Pagination must belong to the snapshot or restart
cleanly; otherwise concurrent moves can cause missing or duplicate entries across pages.

Reconnect uses the last applied cursor. If the cursor is still retained, fetch subsequent changes.
If not, load a new snapshot. Apply changes in order or revalidate affected pages with a minimum
revision; delayed responses must not move the client backward.

A connection indicator should therefore distinguish Connected from Up to date. A socket can be open
while its change backlog is still being applied. Offline cached metadata should be labeled and
revalidated before new sensitive actions are admitted.

Permission changes reach the same reconciliation flow. On revocation, remove the shared location,
stop its subscription, and clear cached data according to policy. Reauthorize sockets periodically
or push session/membership invalidation, rather than trusting a connection forever.

Bound notification queues and coalesce changes by highest namespace revision. A slow client should
resynchronize instead of accumulating an unlimited event buffer. The browser should refresh a burst
of updates together, not launch one full folder request for every change.

WebSocket hints reduce idle request load. At 100,000 clients, one-second polling is roughly 100,000
requests per second even with no changes. Adaptive polling can be a fallback, but it does not
eliminate the need for a recovery cursor.

Redis Pub/Sub is suitable for ephemeral hints, not the recovery history: disconnected subscribers
lose messages under its [documented delivery
semantics](https://redis.io/docs/latest/develop/pubsub/). The durable feed is what makes the
interface eventually agree with committed metadata.

| Approach | Benefit | Cost or failure |
|----------|---------|-----------------|
| ✅ Authorized shared namespace and private objects | Owner and recipients use one permission authority | Permission inheritance and URL-revocation rules |
| ❌ Protected metadata with public chunks | Easy byte hosting | Raw object access bypasses sharing restrictions |
| ✅ Revision feed with socket hints | Low latency with recovery after gaps | Cursor retention, snapshot coordination, and resync UI |
| ❌ Socket-only updates | Simple connected demo | Sleeping tabs miss changes permanently |

## ⚡ Performance, accessibility, and operations — 5 minutes

Large-folder performance needs two controls: paginate metadata on the server and virtualize visible
rows on the client. Stable cursor ordering should include a file ID tie-breaker. Virtualization
alone still downloads the whole folder; pagination alone still allows the DOM to grow as pages
accumulate.

Use predictable list heights initially and handle grid column changes deliberately. Keep focused
rows mounted or move focus before recycling. Selection should be keyed by stable IDs and cleared or
reconciled explicitly when the collection changes.

Keyboard users need file actions without hover, an understandable focus model, and announced
selection. Dialogs need labels, focus containment, Escape behavior, and focus restoration. Announce
transfer phase changes rather than every percentage update.

For downloads, avoid assembling a 10 GiB JavaScript Blob or buffering the entire file in Express.
Authorize a pinned version, then stream bounded chunks with backpressure or use scoped delivery.
Treat missing bytes and integrity mismatches as failures requiring repair.

On the backend, scale object transfers independently from metadata and socket handling. Use
per-account concurrency limits, bounded queues, deadlines, and a retry budget. A circuit breaker may
prevent repeated failures, but it does not create idempotency or make a stuck request finish.

Immediate post-write reads need the committed revision. Use the namespace authority or a replica
that has reached that revision. Otherwise a successful save can appear to vanish when the browser
refreshes against lagging data.

Measure browser long tasks, peak transfer memory, time in Saving, unknown completion outcomes, quota
discrepancies, missing objects, and oldest undelivered change. These connect user symptoms to server
facts. A healthy process and a smooth progress bar do not prove that a file is retrievable.

Object replication, database backup, integrity scanning, and restore drills complete the durability
story. Multi-region failover requires writer fencing and available referenced bytes. I would
establish those recovery properties before adding active writers in several regions.

## 🧪 Walkthrough, validation, and local comparison — 5 minutes

I would finish by walking the original presentation through failure. The user drops it into
Projects, navigates away, and loses connectivity during finalization. On reconnect, the task
resolves its original operation, discovers the committed version, and offers a link without
replacing the current folder view.

A second device edits the previous version and receives a conflict. It keeps its staged bytes while
the user chooses Keep both. The colleague sees the resulting namespace revision through a socket
hint or cursor catch-up, then downloads an authorized immutable version.

The focused verification cases are:

| Scenario | Required observation |
|----------|----------------------|
| Lost response after commit | One version, one quota conversion, identical operation result |
| Repeated chunk request | One verified slot receipt; progress does not double-count |
| Competing edits | One accepted base-version transition; the other gets a recoverable conflict |
| Revocation with an open dialog | Mutation and new download admission denied |
| Sleep beyond feed retention | New snapshot and cursor restore a complete authorized view |
| Collector races finalization | Every published manifest retains all referenced bytes |
| Download after resume | Returned bytes match the pinned version exactly |

This repository is a smaller teaching implementation: React/Zustand browsing, Express metadata
operations, PostgreSQL, Valkey sessions/Pub/Sub, and MinIO chunks. It includes history transactions,
sharing controls, admin reporting, logs, metrics, and selected storage retry/breaker wrappers.

Its browser sends entire files through multipart, with an 8 MiB default limit. There is no browser
chunk worker, persisted resume queue, WebSocket consumer, or list virtualization. One global folder
result is vulnerable to late responses, and settings buttons are placeholders.

Completion does not validate a stored manifest, object existence, session expiry/status, or base
version. Default PostgreSQL string sizes break quota comparisons, and a metric throws after
completion commits. The UI can show failure for a saved file; repeating the request can create
another version and charge again.

The shared-with-me route is shadowed, ordinary file reads require ownership despite folder grants,
and copied public links open API JSON. Compose makes the chunk bucket anonymously downloadable.
Seeded sample files have no chunk bytes and download as empty payloads.

The backend's Pub/Sub fanout is ephemeral; caching/idempotency helpers are unused by file routes.
Reference counts do not represent retained reachability, and manual cleanup is not a coordinated
collector. Those details are documented in [Implementation
Notes](./architecture.md#implementation-notes).

The practical first milestone is a verified upload and download that still reports the correct
outcome after a lost response. From that boundary, add conflict handling and authorized cursor
recovery. That order lets both frontend and backend engineers use “Saved” to mean the same durable,
testable fact.
