# iCloud Sync Architecture

## System Overview

This independent learning project explores file synchronization and a private photo
library. It is not a description of Apple's implementation. The core questions are
causality, preservation of concurrent edits, metadata-to-object consistency, and
recovery when a device misses notifications.

This document has two explicit layers. Requirements, capacity, the first diagram, and
design decisions describe a **proposed production system**. The SQL and API inventory
record the **checked-in implementation**. The final Implementation Notes trace actual
request paths and their limitations. Proposed guarantees are not local test results.

## Requirements

### Proposed production behavior

- Browse, upload, download, rename, move, and delete files across authenticated devices.
- Preserve concurrent file versions and let users resolve conflicts deliberately.
- Resume interrupted transfers and reconcile changes after an offline interval.
- Browse thumbnails and previews without downloading every original photo.
- Distinguish locally queued work, cloud-committed revisions, and bytes downloaded by a
  particular device. These are different acknowledgements.

Proposed service targets are 99.9% monthly metadata availability, p95 metadata reads
under 200 ms within the home region, and p95 online-device notification under two
seconds after commit. Large-transfer latency depends on bytes and bandwidth. Correctness
requires no silently overwritten accepted revision and no committed manifest referencing
unverified bytes. These are design targets, not measured repository properties.

Native clients could observe permitted filesystem changes. A browser handles files the
user selects and explicit offline copies; background execution and arbitrary filesystem
watching are outside its promise. Shared albums, collaborative document editing, and
CloudKit-style application databases are separate scopes.

## Capacity Estimation

Assume one million active accounts, three registered devices per account, 20 GiB of
logical retained content per account, and ten file mutations per active account per day.
That gives about 19 PiB logical storage and 116 average metadata mutations/second.
A 10× peak is roughly 1,160/second. At an assumed 1 MiB of newly uploaded bytes per
mutation, ingress is about 9.5 TiB/day before replication and derivatives.

These are workload assumptions. Compression, deduplication, retained versions, photo
mix, and erasure coding change physical cost; no savings percentage is established here.
A 4 MiB fixed chunk implies roughly 5,120 manifest entries for a 20 GiB file, so manifests
and resumable transfer state must be bounded and paged independently of directory reads.

### Local Development Scale

The local app buffers a complete upload: 100 MiB maximum for Drive and 50 MiB for
Photos. Photo decoding and derivative buffers add to memory use; file download assembly
also buffers the complete result. The PostgreSQL pool allows 20 connections per API
process. These implementation limits do not establish safe concurrent capacity.

## High-Level Architecture

Proposed production design; each box is a responsibility, not necessarily a separately
deployed service on day one.

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

Device A first stages and verifies blobs through the transfer service. Its sync command
then names an immutable manifest and a base revision. Admission checks ownership and
causality and commits the new head or conflict sibling, a command receipt, a change
record, and an outbox entry together. The outbox drives photo jobs and push hints.
Other devices pull the durable change feed and fetch any missing authorized chunks.

The numbered paths distinguish commands/receipts (1), replay (2), byte transfer (3),
metadata admission (4), durable event publication (5), notification hints (6), and
derivative processing/readiness (7). PostgreSQL contains the atomic commit boundary;
object storage and worker execution remain outside that transaction. Device B reaches
the same admission/read services through the gateway, including after reconnect.

The metadata service validates a staged manifest before publication. Upload sessions
pin staged objects so cleanup cannot race a commit. Push carries a reason to reconcile;
it is not the source of truth. A lost hint changes freshness, not eventual recoverability.

## Core Components / Request Flows

### Proposed file publication

1. Authenticate the account and a stable installation identity; authorize the file ID.
2. Create a bounded upload session and reserve logical quota for the proposed revision.
3. Upload absent chunks, verify their lengths and digests, and record staged ownership.
4. In one metadata transaction, lock the relevant file and namespace records, compare
   the submitted base with current heads, and either fast-forward or preserve a sibling.
5. Publish an immutable manifest, receipt, change entry, and outbox entry atomically.
6. Return the durable revision and receipt. Retry with the same command identity returns
   that result; another payload using that identity is rejected.
7. Release staging reservations after publication or expiry under the same reclamation
   protocol that protects retained versions and active transfers.

For an initial implementation, a per-account feed counter locked until transaction commit
provides a simple commit-ordered cursor. A plain database sequence allocated before
commit does not: a later number can become visible while an earlier transaction is still
uncommitted. High-volume accounts may need a partitioned log and a more involved cursor.

### Proposed photo path

Publish the original first, then enqueue derivative generation through the outbox. A
worker claims a versioned job, decodes within resource limits, normalizes orientation,
and writes immutable thumbnail and preview objects. It publishes derivative readiness
only after the objects exist. Retries target the same original revision and transform
version. A photo can be present while its preview is still processing.

User-selected metadata such as favorites and album membership is separate from binary
photo content. An explicit desired favorite value is safe to retry; a toggle is not.
Private media delivery must authorize cache hits as well as origin misses.

## Database Schema

### Actual local schema

The following is the exact schema in [init.sql](./backend/src/db/init.sql), including
its current defaults, indexes, and omissions. It is not a production migration proposal.
Fresh Docker volumes execute it automatically; rerunning it against existing tables fails.
Its final seed-file comment is stale: the actual fixture is `backend/db-seed/base.sql`,
applied by `backend/src/db/seed-photos.ts`.

```sql
-- iCloud Sync Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  storage_quota BIGINT DEFAULT 5368709120, -- 5GB default
  storage_used BIGINT DEFAULT 0,
  role VARCHAR(20) DEFAULT 'user', -- 'user' or 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices table
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- 'iphone', 'ipad', 'mac', 'web'
  last_sync_at TIMESTAMP,
  sync_cursor JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Files table
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES files(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  path VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(200),
  size BIGINT DEFAULT 0,
  content_hash VARCHAR(64),
  version_vector JSONB DEFAULT '{}', -- { deviceId: sequenceNumber }
  is_folder BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  last_modified_by UUID REFERENCES devices(id),
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_user_path ON files(user_id, path);
CREATE INDEX idx_files_parent ON files(parent_id);
CREATE INDEX idx_files_user_deleted ON files(user_id, is_deleted);

-- File chunks for chunked storage
CREATE TABLE file_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_hash VARCHAR(64) NOT NULL,
  chunk_size INTEGER NOT NULL,
  storage_key VARCHAR(200) NOT NULL, -- MinIO object key
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, chunk_index)
);

CREATE INDEX idx_chunks_file ON file_chunks(file_id);
CREATE INDEX idx_chunks_hash ON file_chunks(chunk_hash);

-- Global chunk deduplication table
CREATE TABLE chunk_store (
  chunk_hash VARCHAR(64) PRIMARY KEY,
  storage_key VARCHAR(200) NOT NULL,
  chunk_size INTEGER NOT NULL,
  reference_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- File versions for conflict resolution
CREATE TABLE file_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  version_vector JSONB NOT NULL,
  created_by UUID REFERENCES devices(id),
  is_conflict BOOLEAN DEFAULT FALSE,
  conflict_resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_id, version_number)
);

CREATE INDEX idx_versions_file ON file_versions(file_id);

-- Sync operations log
CREATE TABLE sync_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  operation_type VARCHAR(20) NOT NULL, -- 'create', 'update', 'delete', 'conflict'
  operation_data JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_sync_ops_user_device ON sync_operations(user_id, device_id);
CREATE INDEX idx_sync_ops_status ON sync_operations(status);

-- Photos table
CREATE TABLE photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  original_hash VARCHAR(64) NOT NULL,
  thumbnail_key VARCHAR(200),
  preview_key VARCHAR(200),
  full_res_key VARCHAR(200),
  width INTEGER,
  height INTEGER,
  taken_at TIMESTAMP,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  camera_make VARCHAR(100),
  camera_model VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  is_favorite BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  modified_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_user_date ON photos(user_id, taken_at DESC);
CREATE INDEX idx_photos_favorite ON photos(user_id, is_favorite) WHERE is_favorite = TRUE;

-- Photo albums
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  cover_photo_id UUID REFERENCES photos(id) ON DELETE SET NULL,
  is_shared BOOLEAN DEFAULT FALSE,
  share_token VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_albums_user ON albums(user_id);
CREATE UNIQUE INDEX idx_albums_share_token ON albums(share_token) WHERE share_token IS NOT NULL;

-- Album photos junction table
CREATE TABLE album_photos (
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (album_id, photo_id)
);

-- Album sharing
CREATE TABLE album_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  shared_with_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  can_contribute BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(album_id, shared_with_user_id)
);

-- Device photo sync state (for optimized storage)
CREATE TABLE device_photos (
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  has_full_res BOOLEAN DEFAULT FALSE,
  last_viewed TIMESTAMP,
  downloaded_at TIMESTAMP,
  PRIMARY KEY (device_id, photo_id)
);

-- Sessions table for authentication
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Seed data is in db-seed/seed.sql
```

The schema contains 13 tables. `files` owns the current mutable head; `file_chunks` is a
current manifest, not a manifest per immutable revision. `file_versions` retains hashes
and vectors, but no reference to old chunk lists. `sync_operations` is an activity table,
not a commit-ordered change feed. `album_shares` and sharing columns exist without a
corresponding sharing workflow.

The `(user_id, path)` index is nonunique. There is no chunk-hash foreign key from
`file_chunks` to `chunk_store`, no unique per-user photo digest, no quota constraint,
and no check that album members belong to the album owner. Device references from files
and versions can prevent deleting a device even though sessions use `ON DELETE SET NULL`.
Timestamps are without time zone; the API additionally serializes them through JavaScript
millisecond dates. These facts matter for cursor and retention reasoning.

### Proposed production additions

| Entity | Required purpose |
|--------|------------------|
| File revision and revision chunks | Immutable manifest, size, digest, causal ancestry, retained sibling bytes |
| Namespace entry | Stable file ID, parent ID, normalized name, live sibling-name uniqueness |
| Upload session | Account binding, verified chunks, expiry, reserved quota, staging references |
| Command receipt | Account, command ID, payload digest, durable outcome and resulting revision |
| Account changes and outbox | Commit-ordered cursor, tombstone events, durable publication |
| Device epoch and acknowledgements | Retired actors, replay progress, explicit rebootstrap boundary |
| Blob lifecycle | Staged/live/deleting states and a protocol shared by writers and collectors |

## API Design

### Implemented HTTP surface

All paths below are relative to `/api/v1`. Protected routes use session authentication;
admin routes also check the cached user's role. These are inventories, not guarantees
that every operation has correct concurrency semantics.

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Account/session lifecycle |
| GET | `/auth/me` | SQL session lookup and current user |
| GET | `/files?path=...` | Immediate directory entries; optional deleted entries |
| GET | `/files/:fileId` | File metadata |
| POST | `/files/folder` | Create a folder from name and parent path |
| POST | `/files/upload` | Multipart field `file`, optional `parentPath`; entire upload |
| GET | `/files/:fileId/download` | Assemble current chunks into a response buffer |
| PATCH / DELETE | `/files/:fileId` | Rename/move or soft-delete |
| GET | `/files/:fileId/versions` | Version metadata; no historical-byte restore |
| GET | `/sync/state`, `/sync/changes`, `/sync/conflicts` | Device state, timestamp scan, conflict metadata |
| POST | `/sync/push` | Apply metadata changes individually |
| POST | `/sync/resolve-conflict` | Experimental metadata-only resolution |
| POST | `/sync/delta` | Compare supplied hashes with the current manifest |
| GET | `/sync/chunk/:chunkHash` | Chunk download after an owner/manifest join |
| GET / POST | `/photos`, `/photos/upload` | Offset photo list; multipart field `photo` |
| GET | `/photos/:photoId/thumbnail` | Stream the thumbnail |
| GET | `/photos/:photoId/preview`, `/photos/:photoId/full` | Stream a preview or original |
| POST / DELETE | `/photos/:photoId/favorite`, `/photos/:photoId` | Toggle favorite; soft-delete photo |
| GET / POST | `/photos/albums` | List or create albums |
| POST | `/photos/albums/:albumId/photos` | Add members to an owned album |
| GET / POST | `/devices` | List or register devices |
| GET / PATCH / DELETE | `/devices/:deviceId` | Device detail, name/type update, delete |
| GET | `/devices/:deviceId/sync-history` | Activity records |
| GET | `/admin/stats`, `/admin/users`, `/admin/users/:userId` | Diagnostic counts and account views |
| PATCH | `/admin/users/:userId` | Role/quota updates |
| GET | `/admin/sync-operations`, `/admin/conflicts` | Administrative lists |
| POST | `/admin/cleanup-chunks`, `/admin/purge-deleted` | Manual experimental reclamation |

For example, a Drive upload sends multipart `file` and `parentPath`, then receives
file metadata including ID, path, size, hash, and vector. There is no upload-init,
chunk-upload, or upload-finalize endpoint. A sync push returns applied IDs, conflicts,
and per-item errors in a successful HTTP response; callers must inspect those fields.

The proposed production API adds upload sessions, immutable revision reads, payload-bound
command receipts, a durable changes cursor, and version-conditioned resolution. These
contracts belong in a new protocol version rather than being inferred from the routes above.

## Key Design Decisions

### Preserve causality and content together

A vector can distinguish equal, earlier, later, and concurrent histories; wall clocks
cannot prove that one edit observed another. I would compare a submitted base under a
transactional admission boundary and retain both immutable manifests for concurrent
edits. Joining vector components is metadata reconciliation, not document merging.

The cost is retained bytes, conflict UI, and actor lifecycle management. A single-server
revision token can suffice for simpler online editing; vectors earn their complexity
when independently edited offline histories must be distinguished. Retiring a device
requires an epoch/rebootstrap protocol, not silently deleting its vector component.

### Chunking and private deduplication

Fixed-size chunks are simple and bound memory per transfer unit, but inserting bytes
near the beginning shifts subsequent boundaries and can destroy reuse. Content-defined
chunking helps that workload at CPU and implementation cost. Start with fixed chunks,
measure reuse on representative files, and avoid implying that compressed photos gain
large cross-image savings.

Prefer account-scoped deduplication for the initial private-cloud design. Global content
hashes introduce cross-account existence signals and complicate encryption and deletion.
Randomized per-account encryption limits cross-account reuse; convergent encryption
changes the threat model and is not claimed as an Apple implementation detail.

### Durable replay plus lightweight push

A durable feed recovers changes after a device disconnects. WebSocket or SSE hints reduce
latency while allowing coalescing during bursts. Polling alone is simpler and may be
sufficient for less interactive clients. A persistent channel adds connection, heartbeat,
and reauthorization costs but never eliminates the need for replay.

## Consistency and Idempotency

The proposed transaction commits one accepted metadata outcome and its receipt together.
That supports repeatable admission, not exactly-once network delivery. Scope receipts by
account, operation, and stable command ID; compare payload digests and retain receipts
for the supported retry lifetime. Expired identities require explicit reconciliation.

Deletes are versioned tombstones. Retain them until active consumers acknowledge the
relevant feed position, with a bounded offline lease. Expired devices rebootstrap from a
consistent snapshot before submitting old work. A snapshot and its cursor must describe
the same boundary; otherwise the client can miss a change between listing and replay.

A collector cannot safely select `reference_count = 0` and delete objects later while
writers can add references. It must claim candidates under the same lifecycle protocol
used by publishers, account for staging and retained revisions, and revalidate ownership
before deletion. Reconciliation repairs counters from authoritative manifests.

## Security / Auth

Proposed production controls include object-level authorization on every manifest/media
request, bounded session caching with expiry and revocation, account-bound upload sessions,
strict vector/payload limits, and ownership checks on album membership. A digest identifies
bytes; knowing it is not permission to download them.

The local implementation uses bcrypt passwords, SQL sessions, HTTP-only SameSite=Lax
cookies, secure cookies in production mode, and a Redis session cache. Cache hits reuse
roles and session state for up to five minutes without a fresh SQL expiry check. Logout
and role changes do not revoke established sockets. Device display names are reused as
identity during login; different installations with the same browser/OS name can share
an actor ID.

Photo thumbnails and previews currently send `Cache-Control: public` despite serving
private account content. A shared cache can reuse a response without invoking origin
authorization. A proposed private delivery policy needs account-safe cache keys and edge
authorization, or private/no-store responses. See [MDN's cache privacy explanation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching).

## Observability

Pino request logs and correlation IDs, prom-client HTTP/process and domain metrics, and
health routes are implemented. No Prometheus or Grafana deployment is included. Domain
counters do not cover all paths: new chunks affect uploaded-byte totals, while photo
transfers and full-file download totals are not comprehensively measured. The WebSocket
connection gauge does not decrement on each peer disconnect.

The proposed operational view measures commit latency, oldest pending command, feed lag,
conflict rate, derivative delay, missing-object errors, and reference reconciliation
mismatches. Separate notification lag from time until a specific device has all bytes.
Avoid file IDs and user IDs as unbounded metric labels; logs require deliberate redaction.

## Failure Handling

Production clients persist intent before showing durable offline acceptance, retry with
jitter and stable command IDs, and query receipts after ambiguous responses. They keep
uncommitted bytes until the authoritative outcome is known. Workers retry immutable jobs;
poisoned images get a terminal processing error rather than blocking a whole queue.

Locally, Opossum wraps chunk object operations, but not photo operations or stream
consumption after `getObject` returns. A timeout does not cancel the underlying write.
Health instantiates a separate breaker set from the one used by ChunkService, so reported
breaker health is not the active chunk path's state. `/health/ready` checks SQL and Redis;
full health lists buckets without verifying required names or object writes.

Startup begins listening before dependency checks complete. Shutdown closes SQL/Redis
before draining HTTP and does not explicitly close WebSocket peers or their heartbeat
interval. This is not a proven graceful-drain implementation.

## Scalability Considerations

The first local bottlenecks are whole-file buffering, synchronous Sharp work, unbounded
folder/conflict lists, and per-event list reloads. Multiple API processes share SQL and
objects but have separate socket maps and rate-limit stores.

A production path first streams bytes and limits image concurrency, then moves derivatives
to workers. Partition metadata by account to keep ownership and most transactions local.
Use shared event delivery for gateways and a durable per-account feed for clients. Add
replicas for stale-tolerant browsing while keeping revision admission authoritative.
A very active account eventually outgrows a single serialized feed counter; splitting
that ordering domain is an explicit protocol change.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Concurrent edits | Retained causal siblings | Wall-clock overwrite | Preserve independent accepted work |
| Publication | Atomic metadata admission | Independent writes | Head, receipt, and feed agree |
| Transfers | Verified staged chunks | Whole-file retry | Bound retry cost for large files |
| Deduplication | Account scope initially | Global hash reuse | Simpler privacy and ownership |
| Delivery | Durable pull plus push hints | Push-only state | Recover after missed notifications |
| Photo display | Derivatives on demand | Download every original | Bound bandwidth and decoded memory |

## Implementation Notes

### What actually runs

```
┌──────────────────────────┐            ┌──────────────────────────┐            ┌──────────────────────────┐
│ React browser            │HTTP / WS   │ Express + ws process     │queries     │ PostgreSQL 16            │
│ In-memory Zustand        │───────────▶│ Routes and sync helpers  │───────────▶│ Mutable file metadata    │
└──────────────────────────┘            └──────────────────────────┘            └──────────────────────────┘
                                                      │          │
                                                      │          │
                                                      │          │    objects
                                                      │ cache    └────────────────────────────┐
                                                      │                                       │
                                                      │                                       │
                                                      ▼                                       ▼
                                        ┌──────────────────────────┐            ┌──────────────────────────┐
                                        │ Valkey                   │            │ MinIO                    │
                                        │ Session cache / receipts │            │ Chunks and photo objects │
                                        └──────────────────────────┘            └──────────────────────────┘
```

This is one Express process with route modules, not deployed microservices. The actual
startup ports, credentials, seeding, and native/Docker alternatives are in the
[README](./README.md). No CDN, broker, object replication, sharding, native sync client,
service worker, or persistent browser journal is configured.

### Implemented patterns and their boundaries

| Pattern and source | Actual wiring and limitation |
|--------------------|------------------------------|
| [Auth middleware](./backend/src/middleware/auth.ts) | SQL sessions cached in Redis; stale role/expiry and Redis failure affect authorization |
| [Idempotency](./backend/src/shared/idempotency.ts) | Optional only on sync push/resolve; raw global key, no payload/account scope, async receipt write |
| [Circuit breakers](./backend/src/shared/circuitBreaker.ts) | Chunk put/get/delete calls; photos bypass them, stream errors occur after breaker completion |
| [Cache helpers](./backend/src/shared/cache.ts) | Instantiated on app.locals; metadata/quota/sync caches are not invoked by routes |
| [Logger](./backend/src/shared/logger.ts) | Request timing and correlation; not a durable business audit trail |
| [Metrics](./backend/src/shared/metrics.ts) | Prometheus endpoint and partial domain instrumentation |
| [Health](./backend/src/shared/health.ts) | Dependency probes with readiness and breaker-reporting gaps |
| [Server limiter](./backend/src/index.ts) | Process-memory IP limit, 1,000 requests per 15 minutes; includes health/metrics |

For example, [chunk assembly](./backend/src/services/chunks.ts) verifies each fetched
chunk before concatenation:

```typescript
const actualHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
if (actualHash !== chunk.chunk_hash) {
  throw new Error(`Chunk integrity check failed for ${chunk.chunk_hash}`);
}
```

That check detects corrupted fetched bytes. It does not establish manifest completeness:
assembly receives the rows returned by a join and does not validate final length/hash or
missing indexes. A missing manifest can produce an empty download, including seeded files.

### Actual Drive and sync behavior

[File upload](./backend/src/routes/files.ts) buffers the entire multipart file, changes
metadata, removes the old manifest on overwrite, stores chunks, and increments storage
usage in separate operations. Old references are not decremented on overwrite and quota
is not enforced. Failures can expose partially published files. Rename changes `name`
without `path`; folder moves do not update descendant vectors/timestamps, and normal
routes do not consistently maintain `parent_id`.

[SyncService](./backend/src/services/sync.ts) compares valid vectors but reads and writes
without a transaction or compare-and-swap. Concurrent requests can overwrite each other;
`MAX(version_number) + 1` is also racy. A create-by-path fallback authorizes a matched
owned row but updates the caller-supplied file ID, which is a distinct authorization bug.
Delete accepts a causally older vector unless it is concurrent. Resolution keeps metadata
without copying a chunk manifest, and `use-local` does not install local content.

[Sync routes](./backend/src/routes/sync.ts) scan mutable `modified_at` timestamps with a
1,000-row limit, exclude the current device, and have no durable cursor/reset protocol.
Timestamp ties, precision loss, and delayed commits can break replay. Push can list a
change as applied even when the service returns `applied: false`; its `file_create` event
name also differs from the browser's expected `file_created` family.

Optional Redis receipt locks expire after five minutes, are released without comparing
an ownership token, and save responses asynchronously. The frontend sends no idempotency
header. These helpers do not make file upload or sync admission exactly once.

### Actual photos, browser state, and cleanup

[Photo upload](./backend/src/routes/photos.ts) directly writes an original plus two JPEG
derivatives using UUID object keys, then inserts SQL metadata. It does not use the Drive
chunk pipeline. EXIF fields remain empty for real uploads; fixture camera/date/location
values are synthetic. Full-resolution delivery records `has_full_res` before streaming,
which does not prove local persistence, and always advertises JPEG even for other inputs.
Album additions validate the album owner but not each photo's owner; the returned album
cover URL has no implemented route.

The browser uses three in-memory Zustand stores and eager programmatic routes. Drive
lists are not virtualized. The photo grid virtualizes four-column, 200-pixel rows with two
rows of overscan; it uses lazy thumbnails and a preview viewer. There is no measured
frame-rate claim. Grid focus semantics, modal focus trapping, responsive row sizing,
request cancellation, stable viewer identity, and account-scoped reset are unfinished.
Pagination is offset-based; filter changes and push-triggered reloads can race requests.

[WebSocket auth](./backend/src/services/websocket.ts) requires a Redis-cached session;
login itself only writes SQL, so an initial socket can fail before a protected HTTP
request warms that cache. Cookie session restoration never reconnects the browser socket.
Subscriptions accumulate without cleanup, and reconnection does not pull missed changes.

[Administrative purge](./backend/src/routes/admin.ts) and chunk cleanup use independent
queries and object deletes. New references can race deletion; retries can distort counts;
repeated identical chunks in one file are not correctly decremented by the joined update
([PostgreSQL updates a target row only once](https://www.postgresql.org/docs/16/sql-update.html#SQL-UPDATE-NOTES)).
There is no offline acknowledgement gate before tombstone removal or photo-object purge.
These paths demonstrate maintenance concerns without providing a safe reclamation protocol.
