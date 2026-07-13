# iCloud Sync - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for iCloud: a file and photo synchronization service that keeps data consistent across all of a user's Apple devices. The defining challenges are causality — knowing whether two edits to the same file were sequential or concurrent, across devices that spend hours offline — and bandwidth economics: at a billion users you cannot re-upload a 2GB file because one paragraph changed. I'll focus on the sync infrastructure: version vectors for conflict detection, content-addressed chunk storage with deduplication, and an idempotent sync protocol that survives flaky mobile networks.

## 🎯 Requirements Clarification

Questions I would ask up front:

- **Latency or bandwidth first?** I'll optimize for bandwidth on transfer (chunking, dedup) and latency on notification (push within seconds).
- **Conflict resolution UX?** Auto-merge where safe, "keep both" as the universal fallback — silently discarding a user's edit is the one unforgivable failure.
- **Which data is end-to-end encrypted?** I'll design for per-file keys so E2E categories (passwords, health) can be layered on without re-architecting.

### Functional Requirements

- **File sync**: Bidirectional sync of files and folders across Mac, iPhone, iPad, Web
- **Photo library**: Sync with storage optimization (thumbnails on device, full-res in cloud)
- **Conflict resolution**: Detect concurrent edits; auto-merge or create conflict copies
- **Offline support**: Full functionality offline; reconcile on reconnect
- **Sharing**: Files and albums shared across accounts
- **App data sync (CloudKit)**: third-party apps sync structured records through the same infrastructure

Out of scope for this session: device backup/restore (a different workload — bulk, scheduled, cold), the Find My network, and mail/calendar sync (protocol-specific).

### Non-Functional Requirements

- **Consistency**: Eventual consistency with *reliable* conflict detection — never silent data loss
- **Sync propagation**: < 5 seconds from save on device A to notification on device B
- **Durability**: 11 nines for stored content; petabytes of user data globally
- **Availability**: 99.99% for the sync API — devices retry gracefully, but photo upload from a wedding must not fail permanently

### Scale Estimates

- 1B+ Apple IDs, 3–5 devices per user
- 50GB average per user (5GB free tier to 2TB paid) → hundreds of petabytes
- Billions of sync events/day; writes are bursty (photo bursts, document saves)
- Most files are small; most *bytes* are photos and video

Working the numbers briefly:

- 1B users × 50GB average = ~50 exabytes nominal; realistically hundreds of PB after dedup and the long tail of near-empty free-tier accounts
- 5 billion sync events/day ≈ 60K/sec average, with peaks 5–10x during evenings and photo-heavy moments (holidays)
- Each sync event is a small metadata write (~1KB) plus zero or more chunk transfers — so the metadata tier sees high QPS of tiny writes while the storage tier sees fewer, much larger transfers. These scale independently, which justifies splitting them architecturally
- Fan-out multiplier: every accepted change must reach 2–4 other devices, so the read/notify side runs at roughly 3x the write rate

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│           Clients: iPhone │ iPad │ Mac │ Watch │ Web         │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTPS (sync API) + push channel
                           ▼
┌──────────────────────────────────────────────────────────────┐
│            API Gateway (auth, rate limiting, routing)        │
└─────────┬────────────────────┬────────────────────┬──────────┘
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Sync Service   │  │  Photo Service  │  │    CloudKit     │
│ metadata, delta │  │ derivatives,    │  │ app key-value + │
│ detection,      │  │ shared albums   │  │ structured data │
│ conflicts       │  │                 │  │                 │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────────┬──────────────────────┬───────────────────┐
│   PostgreSQL     │   Object Storage     │     Cassandra     │
│ file metadata,   │ content-addressed    │ sync state,       │
│ users, quotas    │ chunks + photo       │ version vectors,  │
│                  │ derivatives          │ change feeds      │
└──────────────────┴──────────────────────┴───────────────────┘
```

The structural split that matters: **metadata and content travel separately**. Metadata (names, paths, version vectors) flows through the sync service and relational storage; content flows as immutable, content-addressed chunks to object storage. A device can learn "file X changed" in milliseconds and pull the bytes lazily — this is what makes thumbnail-only photo libraries and selective sync possible.

### The Sync Round

The end-to-end flow from a save on device A to visibility on device B:

```
Device A                      Sync Service                  Device B
   │ 1. save file locally           │                           │
   │ 2. chunk + hash locally        │                           │
   │──3. POST manifest─────────────▶│                           │
   │◀──4. "missing: h2, h7"─────────│                           │
   │──5. PUT missing chunks────────▶│──▶ object storage         │
   │──6. commit manifest───────────▶│                           │
   │                                │ 7. append to change feed  │
   │                                │──8. push "changes"───────▶│
   │                                │◀──9. GET changes?cursor───│
   │                                │──10. metadata + manifest─▶│
   │                                │◀──11. GET needed chunks───│
   │                                │──12. chunk bytes─────────▶│
```

Steps 1–6 are the upload half; steps 3–5 transfer only what the server lacks. Steps 8–12 are the download half: the push (8) is a hint, and the cursor pull (9) is what guarantees delivery — a device that slept through the push gets identical results on its next pull. Device B applies metadata first, so the file appears in listings immediately with content streaming behind it.

## 💾 Data Model

Described as prose tables rather than DDL:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), apple_id (unique), storage_quota, storage_used | apple_id | Quota checked before upload, reconciled async |
| files | id (UUID PK), user_id, name, path, size, content_hash, version (JSON version vector), is_deleted | (user_id, path) | Soft delete — tombstones must sync too |
| file_chunks | file_id, chunk_index, chunk_hash, chunk_size | PK (file_id, chunk_index) | The manifest: ordered list of chunks composing a file |
| chunk_store | hash (SHA-256, PK), size, reference_count, storage_key | — | Global dedup table; chunk deleted only at refcount 0 |
| device_sync_state | device_id, user_id, last_sync_token, sync_cursor | PK (device_id, user_id) | Where each device left off; enables incremental sync |
| photos | id, user_id, hash, taken_at, location, metadata, is_deleted | (user_id, taken_at DESC) | Library queries are always time-ordered |
| audit_log | event_type, user_id, device_id, resource, action, ip | (user_id, created_at DESC) | Append-only; sync bugs are debugged from this trail |

Three deliberate choices here:

- **Version vectors live in the file row as a JSON map** of deviceId → sequence number. They're read and written together with the metadata they protect, so conflict detection never races against a separate store.
- **Sync state is per-device, not per-user.** Each device carries its own cursor into the change stream. A device offline for a month resumes from its own cursor; other devices are unaffected. At production scale this table is the highest-write-rate relational data we have, which is why the ideal design puts it in Cassandra — it's partition-keyed by (user, device), never queried across users, and tolerates eventual consistency.
- **The manifest (file_chunks) is separate from the file row.** A file's identity and its current byte composition change on different schedules and are read by different paths — listings never need the manifest, downloads always do. Separating them keeps the hot metadata rows small and lets manifest history double as version history for the three-way merge ancestor lookup.

```
files (metadata + vector) ──1:N──▶ file_chunks (manifest) ──N:1──▶ chunk_store ──▶ object storage
```

## 🔌 API Design

```
POST   /api/v1/sync/changes         → Push local changes (batch, idempotency key required)
GET    /api/v1/sync/changes?cursor= → Pull changes since cursor (incremental sync)
POST   /api/v1/files/manifest       → Declare chunk list; server replies which chunks it lacks
PUT    /api/v1/chunks/:hash         → Upload one chunk (content-addressed, idempotent by nature)
GET    /api/v1/chunks/:hash         → Download one chunk
GET    /api/v1/files/:id            → File metadata + manifest
POST   /api/v1/conflicts/:id/resolve→ Apply resolution (merged | keep-both | pick-one)
GET    /api/v1/photos?before=       → Time-paginated library listing
WSS    /ws                          → Push notifications: "changes available", not payloads
```

The push channel carries only *invalidations* — "something changed, pull when ready." Payloads always go through the pull path, so a device that misses a push (asleep, offline) loses nothing: the next pull from its cursor returns everything. Push is an optimization; pull is the correctness mechanism.

Design notes on the API surface:

- **Batching is first-class**: `/sync/changes` accepts and returns batches — a device reconnecting after a week has thousands of operations, and per-op round trips would make reconnect take minutes on mobile RTTs
- **Manifest-before-chunks ordering** is enforced server-side: chunk PUTs for hashes not declared in any pending manifest are rejected, which stops clients from streaming orphan bytes and keeps the sweeper's workload bounded
- **Conflict resolution is its own endpoint** rather than an overload of the update path — resolving a conflict must reference both competing versions explicitly, so a stale client can't accidentally resolve a conflict it hasn't seen
- **Everything is cursor-paginated**; there is no "list all files" call at this scale, only "changes since" and bounded listings

## 🔧 Deep Dive 1: Version Vectors and Conflict Detection

This is the heart of the system. Two devices edit the same document while one is on a plane — when it lands, how do we know whether that's a conflict or just a stale copy?

**The mechanism**: every file carries a version vector — a map of deviceId → sequence number. When a device edits a file, it increments its own entry. Comparing a local vector L and server vector S:

1. For each device appearing in either vector, compare its sequence number (missing = 0)
2. If L is ahead on some devices and behind on none → local strictly newer, upload wins
3. If S is ahead on some and behind on none → server strictly newer, download wins
4. If each is ahead on *different* devices → the edits were concurrent: a true conflict
5. If equal everywhere → already in sync

The two situations, side by side:

```
Sequential edit (no conflict)          Concurrent edit (true conflict)
──────────────────────────────         ────────────────────────────────
local  {A:3, B:2}                      local  {A:3, B:2}
server {A:2, B:2}                      server {A:2, B:3}

local ≥ server on every entry          local ahead on A, behind on B
→ fast-forward: upload local           → neither dominates: CONFLICT
```

In the left case, A edited after seeing everything B had done — a clean fast-forward. In the right case, A and B each edited without seeing the other's change. No timestamp comparison can distinguish these two situations; the vectors make it a mechanical check.

**Why version vectors over timestamps?**

> "Last-write-wins by timestamp is the tempting answer, and it's wrong in a way users experience as data loss. Device clocks drift — an iPhone with a skewed clock 'wins' every conflict and silently overwrites a Mac's genuine edits. Worse, timestamps can't distinguish concurrent from sequential: if I edit on my Mac at 2:00 and on my phone at 2:05 *after syncing*, that's a clean update; if the phone was offline since 1:00, the same timestamps hide a real conflict. Version vectors encode causality directly — they answer 'did edit B happen with knowledge of edit A?' — which is the actual question. The cost is a vector that grows with device count, but users have 3–5 devices, so vectors stay tiny; I'd prune entries for devices unseen for 90+ days."

**Resolution policy by file type** (steps, not code):

1. **Text/structured documents**: attempt a three-way merge using the common ancestor version (we keep recent version history per file). Clean merge → single merged result, vectors joined.
2. **Photos and binaries**: no merge is meaningful — keep both, renaming the loser as a conflict copy: *"Report (Dana's iPad, 2026-07-11).pages"*. The name tells the user what happened and where.
3. **Anything ambiguous**: keep both. The invariant across all policies is that no user byte is ever discarded without an explicit user decision.

**Deletes are edits too.** A delete is recorded as a tombstone (is_deleted flag) with its own version-vector bump, never a physical row removal. Otherwise a device offline during the delete would happily re-upload the file on reconnect and "resurrect" it — the classic sync bug. Delete-vs-edit conflicts follow the same comparison: if device A deleted while device B edited concurrently, that's a conflict, and the policy is to keep B's edit and surface the file as restored — deletion is the one operation where erring toward keeping data is always right. Tombstones are garbage-collected only after every registered device's cursor has passed them.

**What we give up**: version vectors detect conflicts but don't resolve them — we still need per-type merge logic and conflict-copy plumbing, and users occasionally see duplicate files. Operational transform or CRDTs would merge automatically, but only for structured/text content, and they'd force every client (including third-party CloudKit apps) to adopt complex merge semantics. For a general file store, detection + honest conflict copies is the right layer.

## 🔧 Deep Dive 2: Content-Addressed Chunk Storage

A 2GB video with one metadata edit must not cost 2GB of upload. Files are split into 4MB chunks, each identified by the SHA-256 of its content.

**Upload protocol**:

1. Client chunks the file locally and hashes each chunk
2. Client POSTs the manifest (ordered hash list) to the server
3. Server checks each hash against the global chunk_store and replies with only the hashes it doesn't have
4. Client uploads just those chunks, in parallel; each PUT is idempotent because the key *is* the content hash
5. Client commits the manifest; server increments reference counts and flips the file's metadata atomically

This one protocol buys four properties: **deduplication** (identical chunks across files and even across users stored once — enormous for photos synced to shared albums, common attachments, OS-generated files), **delta sync** (an edited document re-uploads only changed chunks), **resumability** (an interrupted upload resumes at step 3 — the server already tells you what's missing), and **parallelism** (chunks are independent).

**Why 4MB?** The chunk size is a real tuning decision, not a default:

- **Smaller chunks** (256KB–1MB): better dedup granularity and finer delta sync, but the manifest and chunk_store row count balloon — a 4GB video becomes 16,000 rows instead of 1,000, and per-chunk request overhead (TLS, headers, refcount write) starts to dominate transfer time
- **Larger chunks** (16–64MB): fewer rows and requests, but a one-byte edit re-uploads 64MB, resumability granularity worsens on cellular, and dedup hit rates fall because bigger chunks are less likely to repeat
- 4MB sits where per-request overhead is amortized (~1–2% of transfer time on broadband) while a typical document edit still touches only one or two chunks. I'd keep it a per-file-class constant, not a global one — photos could use larger chunks since they're immutable

**Garbage collection via reference counting**: each chunk row carries a refcount; committing a manifest increments, deleting a file decrements, and a background sweeper removes chunks at zero — after a grace period, because a decrement racing a concurrent upload of the same hash must not delete a chunk something just referenced. The sweeper re-verifies refcount at delete time inside a transaction.

**Quota enforcement** rides on the same tables: manifest commit sums the *newly referenced* chunk sizes against the user's remaining quota, rejecting with a clear error before any state changes. Because dedup means a user's "usage" is ambiguous (do shared chunks count fully for everyone?), the accounting rule is: each user is charged the full logical size of their files, ignoring dedup. Simpler to explain, immune to gaming, and dedup savings accrue to the operator — which is the correct incentive, since the operator paid for the storage.

**Fixed-size vs content-defined chunking — the honest trade-off**:

> "Fixed 4MB chunks have a real weakness: insert one byte at the front of a file and every chunk boundary shifts, so every hash changes and delta sync degrades to full upload. Content-defined chunking (Rabin fingerprinting) sets boundaries by content, so an insertion only disturbs neighboring chunks. I still start with fixed chunks, for two reasons. First, the dominant byte volume here is photos and video — append-only or immutable content where boundary-shift never happens and CDC buys nothing. Second, CDC's variable chunk sizes complicate quota accounting, range requests, and client implementations across four platforms. I'd add CDC later as a per-file-type policy for frequently edited documents, where it pays. What I give up meanwhile: poor delta efficiency on prepend-heavy edits — measurable, but rare in this workload."

**Encryption interaction**: chunks are encrypted before upload. Note the tension — encrypting with per-user keys destroys cross-user dedup, since identical plaintext yields different ciphertext. For standard-protection categories Apple's answer (and mine) is convergent-style encryption keyed by content for dedup-eligible data, and true per-user E2E keys for sensitive categories where we deliberately sacrifice dedup for privacy. That's a policy knob per data class, not a single global choice.

## 🔧 Deep Dive 3: The Idempotent Sync Protocol

Mobile clients retry constantly — a train tunnel mid-upload is the normal case, not the edge case. Every mutation in the sync API must be safe to replay.

**Layered idempotency**:

1. **Chunk uploads are naturally idempotent** — the key is the content hash; re-uploading is a no-op overwrite of identical bytes.
2. **Metadata mutations carry an idempotency key** derived client-side from the operation's content. Server flow: check Redis for a cached result under that key → if present, return it; otherwise acquire a short lock on the key (SET NX, 5-minute TTL), perform the operation, cache the result for 24h, release the lock. A concurrent duplicate that fails to get the lock waits for the result rather than re-executing.
3. **The database is the backstop**: unique constraints on (file_id, version) transitions mean that even if Redis is flushed, a replayed commit collides and returns the original outcome instead of double-applying.

> "Two layers because they fail differently — Redis is fast but ephemeral; the constraint is durable but catches the duplicate late. A client retry after a mid-flight timeout is indistinguishable from a first attempt at the network layer; idempotency keys make the distinction explicit at the application layer, which is the only place it can be made."

**Client retry discipline**: exponential backoff with jitter (1s base, doubling, ±20% jitter, capped attempts), retry only on 5xx/network errors — a 4xx means the request itself is wrong and retrying is abuse. Jitter matters at this scale: a regional outage recovering without jitter means a million devices retry in synchronized waves that re-kill the service.

**Circuit breakers on object storage**: sync metadata operations must not hang because MinIO/S3 is degraded. Storage calls run through per-operation breakers (reads trip and recover faster than writes; existence checks are cheapest and most tolerant). When the storage breaker is open, the sync service still serves metadata and accepts manifests — devices learn *what* changed and defer the byte transfer. That's graceful degradation shaped by the metadata/content split: the system stays conversational even when the heavy path is down.

**Failure ordering rule**: chunks are always durably stored *before* the manifest commit that references them, and the manifest commits *before* the change is announced on the push channel. Every observer therefore sees only fully-materialized states; a crash between steps leaves orphaned chunks (cleaned by the sweeper), never a file that references missing bytes.

**The change feed and sync tokens.** The pull side deserves precision, because it's the correctness backbone:

1. Every committed metadata change appends an entry to a per-user, monotonically ordered change feed
2. A device's sync token is an opaque cursor into that feed; `GET /sync/changes?cursor=` returns everything after it plus a new token
3. Entries are compacted: if a file changed 40 times since the device's cursor, the device receives only the latest state — intermediate versions are unobservable and shipping them wastes bandwidth
4. If a cursor is too old (feed truncated), the server returns a "reset" signal and the device falls back to a full-state comparison — expensive but always available, so feed retention is a cost/latency tuning knob rather than a correctness cliff

**Failure modes and responses**:

| Failure | Blast radius | Response |
|---------|--------------|----------|
| Object storage degraded | Content transfer only | Breaker opens; metadata sync continues; devices queue transfers |
| Redis idempotency cache lost | Retry dedup slower | DB unique constraints backstop; no double-applies |
| Push channel down | Latency only | Devices fall back to periodic pull; nothing is missed |
| Change feed truncated past a cursor | One stale device | Explicit reset → full-state reconcile for that device only |
| Metadata DB shard down | Users on that shard | Other shards unaffected; devices retry with backoff; reads from replica if available |

The theme: every degradation moves the system toward *slower*, never toward *wrong*. Sync can always be reconstructed from durable state plus idempotent replay.

## 🧩 CloudKit: Sync as a Platform

The same machinery generalizes to third-party app data, which is worth designing for because it constrains the core:

- **Records instead of files**: CloudKit exposes typed records in per-app containers, but underneath it's the same primitives — per-record version tracking, per-device cursors into a change feed, push invalidations, pull-based delivery
- **Zones as the consistency unit**: records group into zones; a zone is the atomic-commit and cursor boundary. This gives apps small-scale transactionality (save 5 records atomically in one zone) without the backend promising cross-zone transactions — the same "user-partitioned, no global coordination" property that makes the whole system shardable
- **Why this matters for the core design**: once thousands of third-party apps depend on the sync semantics, the conflict model and cursor protocol become a public contract. That's a strong argument for the simplest semantics that work — version-per-record with explicit conflict surfacing — rather than clever merge behavior we'd have to support forever

### Consistency Model, Stated Precisely

- **Per-device read-your-writes**: a device always sees its own committed changes in its next pull
- **Cross-device eventual consistency**: bounded in practice by push latency (< 5s target), unbounded in theory (offline devices), which is exactly why causality tracking exists
- **Per-file linearizable commit point**: the metadata row update is the single serialization point per file; two racing commits on one file are ordered by the database, and the loser's commit triggers conflict handling rather than a lost update
- **No cross-file transactions in file sync**: moving a folder of 100 files is 100 independent ops plus an ordering rule (parents before children). Simpler, shardable, and interruption leaves a visible-but-valid partial state that the next sync round completes

## 📷 The Photo Pipeline

Photos deserve their own treatment because they dominate byte volume and have a distinct access pattern: written once, never edited, browsed constantly through thumbnails.

**Ingest flow** when a photo is taken:

1. Device uploads the original through the same chunk protocol (originals dedup well — burst shots, re-imports, shared-album copies)
2. Photo service enqueues a derivative job; workers generate a 200px thumbnail and a 1024px preview, stored as independent objects
3. Metadata row (taken_at, location, EXIF) is written and the change feed notifies other devices
4. Other devices pull *only the thumbnail* by default — a 50,000-photo library syncs as a few hundred MB of thumbnails, not 250GB of originals

**Storage optimization** is a contract between device and cloud: the device keeps thumbnails always, previews for recent/viewed items, and full-res only on demand or when space allows. The backend supports this with three-tier derivatives and range-friendly chunk downloads. The eviction decision is entirely client-side — the server just guarantees every tier is always fetchable.

> "The key judgment is that derivatives are *disposable* and originals are *sacred*. Derivatives live outside the refcount system and can be regenerated from originals at any time, so I can change thumbnail sizes or codecs fleet-wide with a backfill job, and losing a derivative bucket is an inconvenience, not data loss. Originals go through the full chunk/refcount/durability machinery. Mixing the two — refcounting thumbnails, or treating originals as regenerable — either bloats the GC system or risks the only copy of someone's wedding photos."

**Shared albums** are the first cross-user feature: an album is a membership list plus references into each contributor's photo space. Adding a photo to a shared album doesn't copy chunks — it adds references and bumps refcounts, so a 500-photo shared album costs metadata, not storage. Removal semantics follow from refcounting: a contributor leaving decrements their photos' refs, and content persists only if another member pinned a copy.

## 🔐 Security and Auth

Authentication and authorization, briefly, since sync amplifies any auth mistake across a user's whole digital life:

- **Per-device tokens, not per-user sessions**: each device registers and gets its own credential. Revoking a stolen iPhone must not log out the Mac, and per-device tokens are also what make per-device sequence numbers in version vectors trustworthy — a device can only increment its own entry.
- **Two-factor on new device registration**: adding a device is the sensitive operation (it gains access to everything), so approval flows through an existing trusted device.
- **Chunk access is capability-based**: chunk GETs require a short-lived signed URL issued per manifest, so knowing a hash never grants access to content — important because hashes travel in metadata that support tooling can see.
- **Rate limiting tiered by cost**: manifest posts and change pulls are cheap and generous; chunk bandwidth is metered per account; device registration attempts are aggressively limited (that's the account-takeover surface).
- **Audit trail**: every sync mutation logs actor device, IP, and action — both for security forensics and because "which device deleted this folder" is a real support question.

## 📊 Observability

The signals I'd instrument first, chosen because each one maps to a distinct failure story:

| Signal | Why it matters |
|--------|----------------|
| Sync propagation latency p95 (save on A → notify B) | The headline SLO (< 5s); regressions here are what users call "sync is broken" |
| Sync success rate per device platform | A drop isolated to one OS build catches client regressions early |
| Conflict rate by file type | Baseline ~0.1%; a spike means a client is mishandling vectors, not that users got busier |
| Dedup hit ratio | > 30% expected; a fall suggests chunking or hashing broke silently |
| Chunk sweeper backlog + orphan age | Storage leak detector — refcount bugs show up here first |
| Quota reconciliation drift | Nightly job: sum of chunk sizes per user vs storage_used; drift pages a human |

Structured logs keyed by (userId, deviceId, syncToken) let me replay one device's entire sync conversation — with billions of events, per-device traceability is the only way to debug "my iPad won't sync."

Alerting philosophy: page on user-facing symptoms (propagation latency SLO, sync success rate), ticket on internal leading indicators (sweeper backlog, dedup ratio drift, feed truncation resets). The reconciliation jobs — quota drift, refcount audit — are the deepest safety net: they detect *correctness* bugs that no latency metric ever will, and any nonzero finding is treated as a sev-2 even if no user has noticed yet.

## 📈 Scalability: What Breaks First

1. **First: the file-metadata write path in PostgreSQL.** Billions of sync events funnel into metadata updates. Fix: shard by user_id — sync is perfectly user-partitioned; no query ever joins across users. Sharding here is almost mechanical, which is exactly why the schema was kept user-keyed from day one. The one cross-user table (chunk_store) is deliberately excluded from user sharding.

2. **Second: the device_sync_state / change-feed workload.** Every device polls or resumes its cursor; this is a huge, hot, simple-access-pattern dataset — the classic case for moving from relational storage to Cassandra, partition-keyed by (user_id, device_id), where writes scale linearly with nodes. The AP posture is fine because a device that reads a slightly stale cursor just re-fetches a few already-applied changes, and idempotency makes reapplication harmless.

3. **Third: chunk_store dedup lookups.** A global hash → refcount table serving every upload's "which chunks do you have?" query becomes a read hotspot. Fix: it's a pure key-value workload on a uniformly distributed key (a hash) — shard by hash prefix and front with a cache; near-perfect distribution comes free because SHA-256 outputs are uniform by construction.

4. **Fourth: derivative generation during photo bursts.** New Year's midnight produces a global spike of photo ingests all needing thumbnails. The queue absorbs it — derivatives are async and disposable, so the backlog stretches to minutes without any user-visible failure; originals were already durable at ingest.

5. **Object storage itself scales horizontally by design** — content addressing means no rename/move traffic, and immutable chunks make CDN caching of popular shared-album content trivial.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict detection | ✅ Version vectors | ❌ Timestamps (LWW) | Detects true concurrency; immune to clock drift |
| Conflict resolution | ✅ Merge + keep-both copies | ❌ OT/CRDT everywhere | Works for any file type; no silent data loss |
| Chunking | ✅ Fixed 4MB | ❌ Content-defined (CDC) | Simple, right for photo/video-dominated bytes; CDC later per-type |
| Content addressing | ✅ SHA-256, global dedup | ❌ Per-file opaque blobs | Dedup + delta + resumable + idempotent uploads from one design |
| Sync state store | ✅ Cassandra (prod ideal) | ❌ PostgreSQL for everything | Highest-write, user-partitioned, AP-tolerant workload |
| Change delivery | ✅ Push invalidations + pull payloads | ❌ Push full payloads | Missed pushes are harmless; pull cursor is the correctness path |
| Mutation safety | ✅ Idempotency keys, Redis + DB constraint | ❌ Best-effort dedup | Mobile retries are the normal case; two layers fail differently |
| Deletes | ✅ Tombstones with vector bump | ❌ Physical deletion | Offline devices would resurrect deleted files |
| Quota accounting | ✅ Full logical size per user | ❌ Dedup-aware sharing of cost | Explainable, ungameable; dedup savings go to operator |
| Derivatives | ✅ Disposable, outside refcount GC | ❌ Refcounted like originals | Regenerable assets shouldn't burden the durability machinery |

## 🚀 Closing: What I'd Build Next

With more time I'd go deeper on:

- **End-to-end encryption key hierarchy**: per-file keys wrapped by device keys, the recovery-contact escrow problem, and the explicit dedup cost of E2E categories
- **Content-defined chunking** as a per-file-type policy for frequently edited documents, measured against real edit traces before committing to the complexity
- **Selective sync and shared folders**: permission models once folders span accounts, and what "the folder changed" means when members have different visibility
- **Cross-region replication**: sync state is user-homed so region pinning is natural, but shared albums create the first genuinely cross-user, potentially cross-region edges in the data model — that's where the interesting consistency work begins

The through-line of the design: metadata and content on separate paths, causality tracked explicitly rather than inferred from clocks, and every mutation replayable — so the system degrades toward slow, never toward wrong.
