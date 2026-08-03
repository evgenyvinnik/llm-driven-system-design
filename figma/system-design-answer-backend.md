# Figma Backend — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Files, editing, collaboration, publishing | 4 min |
| Architecture | API, operation service, storage, presence | 8 min |
| Data model | Scene objects, operations, snapshots, assets | 6 min |
| Interfaces | REST, WebSocket, operation protocol | 8 min |
| Deep dives | CRDT choice, realtime, assets, recovery | 20 min |
| Trade-offs and close | Scale, isolation, rollout | 4 min |

## Opening — 2 minutes

I am designing the backend for a collaborative design editor. Users create files, manipulate a scene graph, upload assets, collaborate in real time, and share or publish a read-only representation.

The difficult backend problem is not storing rectangles. It is preserving a coherent operation history while users edit concurrently, reconnect, undo, and load large files. Presence is useful but not durable. Document operations are durable and permission-checked.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether offline editing and character-level text collaboration are launch requirements. I will support online collaborative editing with reconnect and bounded local queues, and I will describe where CRDT or OT becomes necessary.

I would ask whether plugins can be untrusted and whether files require pixel-perfect export. I will treat first-party tools as trusted clients of a capability API and isolate untrusted extensions separately.

### Functional requirements

- Create files, pages, layers, and design objects.
- Apply transforms, style, text, grouping, and reorder operations.
- Collaborate with multiple users in one file.
- Show presence cursors and selections.
- Upload and reference image, font, and other assets.
- Undo and redo through the operation protocol.
- Share read-only files and publish stable versions.
- Recover after disconnect and support operation replay.

### Non-functional requirements

- Operations for one file or partition have a deterministic order.
- A committed edit is durable before acknowledgement.
- Presence can be dropped without affecting document correctness.
- Large files load through snapshots and visible ranges, not unlimited payloads.
- Assets are verified and access-controlled.
- One malformed plugin or renderer does not corrupt scene state.

### Out of scope

I will not design the GPU renderer, full export pipeline, font licensing, or a complete universal CRDT. I will define the operation and storage boundaries.

## A — Architecture — 8 minutes

### High-level architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Editor clients                                                              │
│ file route · scene store · tool intents · renderer · local operation queue  │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS / WebSocket
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Collaboration API Gateway                                                   │
│ auth · file permissions · operation validation · connection lifecycle       │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ File and scene service │ Operation sequencer   │ Presence service            │
│ snapshots · metadata  │ ordering · ack · log  │ ephemeral cursors          │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Operation log · snapshot store · metadata DB · object storage · event bus   │
└────────────────────────────────────────────────────────────────────────────┘
```

### File ownership and partitioning

A file or hot document partition has one logical operation sequencer at a time. API gateways route operations to the owner. The owner assigns a monotonically increasing sequence and broadcasts accepted operations.

This does not mean one server stores every file. Ownership is distributed by file ID. A coordinator moves ownership through a lease or handoff protocol and ensures the new owner starts from a verified snapshot and log position.

### Persistence path

The sequencer validates permission and operation shape, appends the operation to a durable log or transactional store, then acknowledges and broadcasts. Periodic snapshots compact history. A snapshot includes revision, scene graph, pages, and object order.

Asset metadata is stored with the file, while binary content lives in object storage. The API issues signed upload and download URLs after permission checks.

### Presence path

Presence messages are routed through a low-latency broker and expire. They are not appended to the document log. A user reconnecting receives current presence where available but reconstructs document state from snapshot and operation history.

## D — Data Model — 6 minutes

| Entity | Important fields | Authority |
|---|---|---|
| `File` | file ID, owner, permissions, revision | file service |
| `Page` | page ID, file, object order | document state |
| `SceneObject` | ID, type, parent, transform, style, content | document state |
| `Operation` | ID, author, base revision, payload, sequence | operation log |
| `Snapshot` | file, revision, serialized scene, checksum | snapshot store |
| `Asset` | ID, object key, checksum, dimensions, status | asset service |
| `Presence` | user, cursor, selection, expiry | presence service |
| `PublishedVersion` | file, revision, renderer compatibility | immutable read model |

### Operation types

Operations are semantic: create object, update property, delete object, reparent, reorder, set text, attach asset, and restore snapshot. A semantic operation is easier to authorize, audit, invert, and merge than an arbitrary serialized scene replacement.

### Revision and sequence

The file revision increases with accepted durable operations. The base revision tells the server what the client observed. The sequence is the canonical order assigned by the sequencer. IDs make retries safe; revision makes conflicts visible.

### Asset integrity

An asset descriptor stores expected checksum and ownership. Upload completion verifies size and checksum before the asset becomes usable. A missing or failed asset does not remove the scene object; it produces a render placeholder.

## I — Interfaces — 8 minutes

### REST API

```
POST /api/v1/files                         → create file
GET  /api/v1/files/:id                    → metadata and permissions
GET  /api/v1/files/:id/snapshot            → snapshot at visible revision
POST /api/v1/files/:id/upload-url          → signed asset upload
POST /api/v1/files/:id/publish             → immutable published version
GET  /api/v1/files/:id/versions            → published versions
POST /api/v1/files/:id/resync              → snapshot and operation cursor
PATCH /api/v1/files/:id/permissions        → share policy
```

### WebSocket protocol

```
CONNECT /api/v1/files/:id/stream
JOIN    page:<pageId>
SEND    operation { operationId, baseRevision, payload }
EVENT   acknowledgement { operationId, sequence, revision }
EVENT   operation { sequence, operation }
EVENT   presence { user, cursor, selection, expiresAt }
EVENT   resync-required { revision, reason }
```

The gateway checks the session and file capability during connection and operation submission. A connection never grants more permissions than the authenticated file membership.

### Internal contracts

| Boundary | Input | Output | Guarantee |
|---|---|---|---|
| Sequencer | valid operation | sequence and revision | one order per file |
| Snapshotter | operation range | verified snapshot | bounded recovery |
| Presence broker | cursor update | ephemeral broadcast | expiry and best effort |
| Asset service | upload completion | verified asset | checksum and ownership |
| Publish service | file revision | immutable version | stable read path |

### Retry semantics

The client retries an operation with the same operation ID. If the server already accepted it, the acknowledgement is replayed. If the base revision is stale, the server returns canonical context or resync requirement.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: CRDT or operation sequencing

For online collaborative editing, I would begin with a server sequencer, operation IDs, base revisions, and explicit conflict handling. A single file owner creates deterministic order and makes replay and audit straightforward.

A CRDT supports offline and multi-writer convergence, but it adds metadata, tombstone cleanup, merge semantics, and difficult debugging. I would choose a CRDT for core offline or character-level collaboration, not merely because concurrent editing exists.

The trade-off is availability during an owner outage. The file may briefly become read-only while ownership fails over. That is preferable to acknowledging two conflicting sequences and repairing a design document later.

### Deep dive 2: Operation storage and snapshots

Every accepted operation enters a durable log. Snapshots periodically materialize the scene and record the last included sequence. Recovery loads the latest verified snapshot and replays subsequent operations.

Full scene saves are simpler for clients but create large writes, lose operation-level audit, and make collaboration conflicts coarse. Operation logs cost more replay and compaction work, but they support undo, incremental sync, and diagnostics.

### Deep dive 3: Realtime fan-out

The collaboration gateway maintains connection-to-file subscriptions. The sequencer publishes accepted operations to the file topic. Gateways send operations in sequence and use backpressure for slow clients.

Presence is throttled, expires, and can be coalesced. Durable operations are never replaced by presence updates. A slow presence client can miss cursors; a slow operation client must resync or disconnect.

### Deep dive 4: Undo and inverse operations

Undo creates an inverse semantic operation using the original object and property context. It enters the normal permission, revision, and sequence path. The server can reject an inverse if a collaborator changed the same property.

Directly reverting local state feels simpler but can erase another user’s change and bypass audit. Collaborative undo is more complex, but it preserves the same authority path as a normal edit.

### Deep dive 5: Assets and large files

Large assets upload directly to object storage through signed URLs. The API verifies checksum, size, ownership, and scan status before publication. A file snapshot stores descriptors, not binary content.

Large files load metadata and page structure first, then visible scene ranges or chunks. A published read-only version can use a stable snapshot and CDN-friendly asset URLs.

### Deep dive 6: Permissions and plugins

File roles control read, comment, edit, publish, and asset capabilities. The server checks operation types against role, not only the client’s UI mode. Plugins receive scoped tool and renderer capabilities rather than raw storage credentials.

Trusted first-party modules can share the editor runtime. Untrusted extensions require a sandbox or separate origin. An iframe adds hard isolation but complicates selection, keyboard focus, resize, and operation coordination.

### Deep dive 7: Failure matrix

| Failure | Backend behavior | Client behavior |
|---|---|---|
| Owner fails | controlled failover | reconnect/resync state |
| Operation timeout | idempotent lookup | pending edit |
| Stale revision | reject or rebase context | conflict review |
| Snapshot corrupt | reject checksum | recover prior snapshot |
| Asset upload fails | asset remains unverified | retry/resume |
| Presence lost | expire cursor | durable editing continues |
| Permission revoked | close or downgrade stream | read-only state |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test a file with thousands of objects, nested groups, large assets, several collaborators, and a hot shared page. The capacity budget includes operation fan-out, snapshotting, asset bandwidth, presence traffic, and recovery time.

### What I would measure

- Operation acknowledgement and sequencer queue depth.
- Broadcast lag and slow-client disconnect rate.
- Snapshot creation, checksum, and replay duration.
- Conflict and resync rate.
- Asset upload verification and CDN failure rate.
- Presence messages per active file.
- Published-version load time.

### Rollout sequence

1. Ship file metadata, permissions, and snapshot reads.
2. Add semantic operations with a single file sequencer.
3. Add durable replay and periodic snapshots.
4. Add WebSocket operation broadcast and presence.
5. Add signed assets, publishing, and read-only versions.
6. Add hot-file capacity, offline CRDT work, and plugin isolation after measurement.

### Alternative architecture review

Full-scene saves are easier to implement but make conflicts and undo coarse. Operation logs require compaction but preserve history, incremental sync, and semantic authorization.

A CRDT gives offline convergence but adds metadata, merge rules, tombstones, and debugging complexity. A sequencer with bounded local queues is a better first step when online collaboration is the primary requirement.

An iframe per tool can isolate untrusted code but makes selection, focus, resize, and shared undo harder. Trusted tools should use capability modules; separate origins are reserved for untrusted extensions.

### Backend interview checkpoints

I trace a transform from operation submission through permission validation, sequencing, persistence, broadcast, snapshotting, and undo.

I explain why a presence cursor never enters the durable document log and why an operation timeout uses the same operation ID.

I close by returning to deterministic replay, scoped asset access, and file-level failure isolation.

## Scalability and operations

Partition files by file ID and route hot files to dedicated sequencer capacity. Snapshot frequently enough to bound recovery while retaining operation history for audit and sync. Store assets separately behind CDN and use object lifecycle policies.

The first bottleneck is hot-file fan-out. The second is snapshot and operation-log storage. The third is asset bandwidth and image processing. Metrics must identify file hotness without exposing document content.

## Security and observability

Operations are authorized server-side and sanitized by type. Signed asset URLs are short-lived. Published versions are immutable and can have separate sharing permissions. Logs exclude private text, asset secrets, and document payloads unless protected diagnostics explicitly require them.

Metrics include operation acknowledgement latency, sequencer queue depth, stream lag, resync rate, snapshot age, replay duration, asset verification latency, and conflict rate. Correlation IDs connect client operation, gateway, sequencer, storage, and broadcast.

## Testing and correctness review

I would test operation duplication, concurrent transforms, reorder conflict, snapshot checksum failure, owner failover, reconnect replay, asset checksum mismatch, signed URL expiry, and permission changes during editing.

Backend tests verify deterministic sequence, inverse-operation behavior, snapshot replay, presence expiry, and published-version immutability. Integration tests connect two clients and verify that durable operations converge while cursors may disappear.

The acceptance criteria are replayable files, scoped operations, safe asset access, isolated presence, and a read-only fallback when editor features are unavailable.

## Implementation sequence

1. Build file metadata, permissions, and verified snapshots.
2. Add semantic operations with one file sequencer.
3. Add durable log replay and snapshot compaction.
4. Add WebSocket operation broadcast and acknowledgement.
5. Add expiring presence and signed asset uploads.
6. Add published immutable versions and read-only fallback.
7. Add CRDT or hot-file specialization only after offline needs are proven.

The sequence keeps document state recoverable before adding more availability and extension complexity.

## Interview walkthrough: one collaborative transform

The client sends a semantic transform operation with object ID and base revision. The file sequencer checks permission, assigns sequence, persists it, and broadcasts the operation. The renderer updates from the accepted scene projection.

An undo command creates an inverse operation through the same path. Presence cursors are broadcast separately and can expire. A reconnect uses snapshot plus operation cursor rather than trusting a local scene alone.

This scenario demonstrates deterministic ordering, collaborative undo, ephemeral presence, and bounded recovery.

## Further design decisions

The operation payload should be semantic enough to authorize and invert, but not so broad that it becomes arbitrary document replacement. This keeps audit and conflict behavior explainable.

Snapshots include checksum and revision. A corrupt or partial snapshot is rejected rather than used as a plausible scene.

Assets are not embedded into every operation. The scene references verified descriptors, while object storage and CDN handle binary delivery.

Published versions pin a compatible scene representation and renderer contract. A tool deployment cannot silently alter an existing shared prototype.

The production review asks whether a file can recover after owner failure, whether a revoked editor can still submit through an open socket, and whether presence traffic can be dropped without affecting durable operations.

### Final questions

- Who assigns operation order?
- How is a snapshot verified?
- What does undo submit?
- Can presence be lost?
- How are assets scoped?

The answers should point to the sequencer, checksummed snapshots, semantic inverse operations, and signed asset capabilities.

### Launch gate

The launch gate is deterministic replay, permission-checked operations, verified snapshots, scoped assets, and independent presence failure.

I would not launch CRDT offline editing until merge, tombstone, and garbage-collection behavior is observable and recoverable.

### Final handoff

- The sequencer owns document order.
- Snapshots and logs make recovery bounded.
- Assets are verified outside the scene log.
- Presence is ephemeral and permission-scoped.
- Published versions are immutable.
- Untrusted extensions require stronger isolation.

The presentation closes by returning to deterministic replay and capability-scoped collaboration.

The launch decision favors correctness and recovery over maximum offline availability.

That boundary remains explicit in both the API and the storage model.

It is the final criterion I would use before adding CRDT complexity.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Ordering | file-owned sequencer | multi-writer active-active | deterministic replay |
| Collaboration | semantic operations | full scene saves | conflicts and undo |
| Offline | bounded queue first | CRDT immediately | lower complexity initially |
| Presence | ephemeral channel | durable operation log | cursors can drop |
| Assets | direct signed upload | API proxy | bandwidth and scale |
| Recovery | snapshots plus log | full reload | bounded failover |
| Plugins | capability API | unrestricted code | security and ownership |

## Closing — 3 minutes

The backend treats the scene document as a revisioned operation stream with verified snapshots. The sequencer owns order, the document store owns durable state, the presence broker owns ephemeral collaboration, and object storage owns assets.

I would build one-file sequencing, snapshots, operation retry, basic presence, and signed assets first. I would add CRDT offline editing, hot-file partitioning, richer plugin isolation, and export workers only after measuring real collaboration and asset workloads.
