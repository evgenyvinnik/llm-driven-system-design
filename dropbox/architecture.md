# Dropbox: architecture

## System Overview

This learning project separates a navigable file namespace from immutable, content-addressed chunk objects. PostgreSQL stores users, folder relationships, file manifests, and historical versions; MinIO stores bytes; Valkey provides sessions and ephemeral notification fanout. The interesting problems are publishing a complete file despite retries, preserving concurrent edits, and retaining exactly the bytes that authorized readers may still need.

The production sections below describe a **proposal**, not Dropbox Inc.'s internal design and not guarantees of this checkout. The Database Schema and API Design sections explicitly document the actual implementation. Implementation Notes maps the proposal to the source and its known defects. Setup belongs in [README.md](./README.md).

## Requirements

### Production functional scope

- Browse a hierarchical namespace; create, rename, move, and delete entries by stable ID.
- Upload files up to an assumed 10 GiB, resume interrupted transfers, and download a consistent version with byte ranges.
- Keep retained versions and restore one without silently destroying a concurrent edit.
- Share folders with named users and files through revocable, optionally protected links.
- Propagate committed changes across devices, with reconciliation after disconnection.
- Enforce quota and retention rules without treating global content hashes as authorization.

Rich document collaboration, desktop filesystem watchers, full-content search, malware analysis pipelines, and end-to-end encryption are separate extensions. Binary files cannot generally be merged with a text CRDT.

### Production targets

| Concern | Proposed target / definition |
|---------|------------------------------|
| Availability | 99.9% monthly for authorized metadata and download admission within a region |
| Metadata latency | p95 under 300 ms for one bounded folder page, excluding client network |
| Finalization | p95 under 500 ms after all verified bytes are staged, at the assumed load |
| Sync visibility | p95 under two seconds from metadata commit to another connected client's refresh |
| Integrity | Publish only a validated ordered manifest whose bytes satisfy the storage durability policy |
| Conflict safety | A stale base version cannot silently replace the current version |
| Durability | Replicated object storage, metadata backups, integrity scans, and rehearsed restore; no unmeasured numerical durability claim |

Transfer duration depends on bandwidth and file size. A chunk acknowledgment target must not pretend that moving 4 MiB over a slow connection takes a fixed 100 ms. Availability also excludes access explicitly denied by permission or expired capability.

## Capacity Estimation

Assume one million daily active users, one uploaded version per active user per day, a 20 MiB average version, ten metadata reads per user per day, and a tenfold peak. These are sizing assumptions, not measurements or adoption forecasts.

| Quantity | Estimate |
|----------|----------|
| Finalizations | 1,000,000/day ≈ 11.6/s average, 116/s peak |
| Metadata reads | 10,000,000/day ≈ 116/s average, 1,160/s peak |
| Chunk transfers | At five 4 MiB chunks/version: 5,000,000/day ≈ 58/s average, 580/s peak |
| Incoming bytes before deduplication | About 19.1 TiB/day; roughly 2.26 GiB/s at the assumed peak |
| Thirty days of incoming versions | About 572 TiB before retention deletions, replication, and deduplication |
| Manifest metadata | At 1 KiB/version: about 0.95 GiB/day, plus indexes and chunk references |
| Live connections | Assume 100,000 sockets; partition across notification gateways |

Do not subtract a guessed deduplication percentage. Measure reuse by workload; compressed media, encrypted content, and shifted fixed-size boundaries may provide little reuse. Downloads and shared-link popularity require separate egress estimates.

Local development uses one API, one frontend, PostgreSQL, Valkey, and MinIO. Start with a few small files and accounts. The current browser path buffers whole files and has an 8 MiB default limit; it cannot exercise the proposed 10 GiB flow.

## High-Level Architecture

Proposed production responsibilities; these boxes need not begin as separate deployments:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Browser clients  │────▶│ API gateway      │────▶│ Metadata service │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                         │                         │
        ▼                         ▼                         ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Private objects  │     │ Upload service   │────▶│ SQL + outbox     │
│ Scoped URLs      │◀────│ Verify staging   │     │ Namespace owner  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                                            │
                                                            ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Other devices    │◀────│ Sync gateways    │◀────│ Change relay     │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

The browser transfers bytes using bounded requests to private object storage or an upload proxy. The upload service verifies durable staging receipts; the metadata service alone publishes the current file version. The SQL transaction also records a durable change. Notification delivery is an optimization over a replayable namespace change feed. A CDN may cache immutable bytes only behind an authorization-aware delivery boundary.

## Core Components / Request Flows

### Publish a version

1. Authenticate the actor and authorize the destination namespace and parent folder. Capture the target file ID, base version, operation ID, declared size, and manifest.
2. Reserve logical quota transactionally with a lease. Store the ordered manifest and one uniquely identified slot per expected chunk. Bounds cover count, index, length, digest format, and total bytes.
3. Issue upload capabilities scoped to that actor, session, slot, and expiry. Allow reuse only within an authorized deduplication scope; knowledge of a global hash is not proof of ownership.
4. Receive bytes, verify their digest and length, and durably record each slot receipt. Retrying an identical slot returns its receipt; conflicting bytes for that slot are rejected.
5. In one short SQL transaction, recheck authorization, the live destination, base version, slot completeness, reservation, and operation receipt. Publish an immutable version and advance the file pointer, consume quota, and insert an outbox/change record.
6. Return the same committed result for retries of the same actor/operation/payload. An outbox relay notifies devices independently of the HTTP response.

Object transfer precedes the transaction; it never holds a database lock for the duration of a network upload. Unpublished staged objects are acceptable temporary garbage. A published manifest that points to unverified or absent bytes is not acceptable. Garbage collection must coordinate with staging leases and finalization.

### Download and restore

Authorize the file or public capability, then pin one immutable version and its ordered manifest. Range requests map byte offsets to manifest slots. Stream bounded buffers with backpressure; verify stored integrity and fail clearly on missing bytes. A second request must identify the same version if the client needs to resume consistently.

Restore publishes a new version referencing a retained immutable manifest. It uses a base-version precondition and stable operation ID, just like upload finalization. It does not renumber history or quietly replace a newer edit. Readers already admitted to an older version need a defined retention/grace boundary.

### Namespace and sharing

Partition metadata by a stable namespace, which may represent a personal drive or a shared workspace. File identity does not change on rename. Parent, entry, permission, and quota decisions for one namespace stay within one authority. Cross-namespace moves become explicit copy-and-delete workflows.

All entry creation validates that the parent is live, is a folder, and belongs to the authorized namespace. Serialize structural moves within a namespace, or use an equivalent transaction protocol that prevents two concurrent moves from forming a cycle. Enforce name uniqueness at the root as well as below a folder.

### Synchronization

A committed namespace revision is the recovery coordinate. A reconnecting client requests changes after its cursor; if retention has removed that cursor, it reloads a bounded snapshot tied to a revision and continues from there. Duplicate or delayed notices cannot move the cursor backward. Authorize the snapshot, feed, and socket independently.

Snapshot pagination must use a stable revision or restart when invalidated. Connecting a socket and then fetching an arbitrary latest page is insufficient: a change can fall between those operations. The durable feed closes that gap. Redis Pub/Sub alone cannot: disconnected subscribers lose messages under its [documented delivery semantics](https://redis.io/docs/latest/develop/pubsub/).

## Database Schema

### Actual local schema

The following is the checked-in [init.sql](./backend/src/db/init.sql), including its present constraints and omissions. It is **not** the proposed production migration. There are ten tables; folders share the `files` table, and the hierarchy is an adjacency list.

```sql
-- Dropbox Cloud Storage Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    quota_bytes BIGINT DEFAULT 2147483648,  -- 2GB free tier
    used_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Files and Folders
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES files(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_folder BOOLEAN NOT NULL DEFAULT FALSE,
    size BIGINT DEFAULT 0,
    mime_type VARCHAR(255),
    content_hash VARCHAR(64),  -- SHA-256 hash of all chunk hashes
    version INTEGER DEFAULT 1,
    sync_status VARCHAR(20) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'syncing', 'pending', 'error')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- "No duplicate names in a folder, unless soft-deleted." A partial UNIQUE cannot
-- be an inline table constraint (that's a syntax error that crashes initdb) — it
-- has to be a partial UNIQUE INDEX.
CREATE UNIQUE INDEX idx_files_unique_name
    ON files(user_id, parent_id, name) WHERE deleted_at IS NULL;

-- Index for folder hierarchy queries
CREATE INDEX idx_files_user_parent ON files(user_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_user_id ON files(user_id) WHERE deleted_at IS NULL;

-- File chunks (references to blocks in object storage)
CREATE TABLE file_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,
    chunk_size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(file_id, chunk_index)
);

CREATE INDEX idx_file_chunks_file_id ON file_chunks(file_id);
CREATE INDEX idx_file_chunks_hash ON file_chunks(chunk_hash);

-- Global chunk store (for deduplication)
CREATE TABLE chunks (
    hash VARCHAR(64) PRIMARY KEY,
    size INTEGER NOT NULL,
    storage_key TEXT NOT NULL,  -- MinIO object key
    reference_count INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- File versions (history)
CREATE TABLE file_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    size BIGINT NOT NULL,
    content_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id),

    UNIQUE(file_id, version)
);

CREATE INDEX idx_file_versions_file_id ON file_versions(file_id);

-- File version chunks
CREATE TABLE file_version_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_hash VARCHAR(64) NOT NULL,
    chunk_size INTEGER NOT NULL,

    UNIQUE(version_id, chunk_index)
);

-- Shared links (public sharing)
CREATE TABLE shared_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    url_token VARCHAR(32) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    expires_at TIMESTAMP WITH TIME ZONE,
    download_count INTEGER DEFAULT 0,
    max_downloads INTEGER,
    access_level VARCHAR(20) DEFAULT 'view' CHECK (access_level IN ('view', 'download', 'edit')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_shared_links_token ON shared_links(url_token);
CREATE INDEX idx_shared_links_file_id ON shared_links(file_id);

-- Folder sharing (with specific users)
CREATE TABLE folder_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    folder_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    shared_with UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_level VARCHAR(20) NOT NULL CHECK (access_level IN ('view', 'edit', 'owner')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(folder_id, shared_with)
);

CREATE INDEX idx_folder_shares_folder_id ON folder_shares(folder_id);
CREATE INDEX idx_folder_shares_shared_with ON folder_shares(shared_with);

-- Sessions table for auth
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- Upload sessions (for resumable uploads)
CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id UUID REFERENCES files(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    parent_id UUID REFERENCES files(id),
    total_chunks INTEGER NOT NULL,
    uploaded_chunks INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'completed', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_upload_sessions_user_id ON upload_sessions(user_id);

-- Seed data is in db-seed/seed.sql
```

### Schema implications and proposed additions

- The live-name partial unique index handles non-null parents, but root rows have `parent_id = NULL` and can duplicate under races. PostgreSQL considers these nulls distinct unless the index uses `NULLS NOT DISTINCT`; a real root row is another design option. See [PostgreSQL 16 unique indexes](https://www.postgresql.org/docs/16/indexes-unique.html).
- A parent foreign key does not prove ownership, folder type, liveness, or absence of cycles. Those invariants need a transaction protocol and appropriate namespace constraints.
- Neither manifest table has a foreign key to `chunks`; an arbitrary hash can be referenced. `upload_sessions` stores a count, not the ordered manifest, slot receipts, or a finalization result.
- BIGINT columns are returned as strings by the default installed `pg` parser. TypeScript annotations do not convert them. Use an explicit integer representation and safe API serialization throughout quota and metrics code.
- Production additions include namespace IDs/revisions, immutable version manifests, upload slot receipts, quota reservations, durable operation receipts, permission revisions, outbox records, and a coordinated reclamation state. Their absence is material to the guarantees above.

## API Design

### Actual local endpoints

Paths are mounted exactly as listed; there is no `/api/v1` prefix. [File routes](./backend/src/routes/files.ts), [auth](./backend/src/routes/auth.ts), [sharing](./backend/src/routes/sharing.ts), and [admin](./backend/src/routes/admin.ts) define the contracts.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/auth/register`, `/login` under the same auth prefix | Register or authenticate; return user/token and set cookie |
| POST | `/api/auth/logout` | Delete Redis and SQL session, then clear cookie |
| GET / PATCH | `/api/auth/me` | Read or update profile/password |
| GET | `/api/files/folder`, `/api/files/folder/:folderId` | Owner root/folder listing with breadcrumbs |
| POST | `/api/files/folder` | Create folder with `name` and optional `parentId` |
| POST | `/api/files/upload` | Whole-file multipart field `file`, optional `parentId` |
| POST | `/api/files/upload/init` | Accept `fileName`, `fileSize`, `parentId`, `chunkHashes`; return `uploadSessionId`, needed hashes, total count |
| POST | `/api/files/upload/chunk` | Multipart `chunk`, `uploadSessionId`, `chunkIndex`, `chunkHash` |
| POST | `/api/files/upload/complete` | Accept `uploadSessionId` and ordered `chunkHashes` again |
| GET | `/api/files/file/:fileId` | Owner metadata |
| GET | `/api/files/file/:fileId/download` | Buffered owner download |
| GET | `/api/files/file/:fileId/chunks` | Owner manifest entries with one-hour presigned GET URLs |
| PATCH | `/api/files/file/:fileId/rename`, `/move` under the same file prefix | Rename or move |
| DELETE | `/api/files/file/:fileId` | Soft delete entry/subtree |
| GET | `/api/files/file/:fileId/versions` | Historical versions, excluding current |
| POST | `/api/files/file/:fileId/versions/:versionId/restore` | Restore history as another current version |
| POST / GET | `/api/share/link`, `/api/share/links` respectively | Create link / list owner's links |
| DELETE | `/api/share/link/:linkId` | Revoke link record |
| GET | `/api/share/:token`, `/api/share/:token/download` | Validate public link; metadata or buffered bytes; optional query password |
| POST | `/api/share/folder` | Create/update named-user folder grant |
| GET | `/api/share/shared-with-me` | Intended recipient list; shadowed by earlier `/:token` route |
| GET / DELETE | `/api/share/folder/:folderId`, `/api/share/folder/:folderId/:userId` respectively | List / remove grants as owner |
| GET | `/api/admin/stats`, `/users`, `/users/:userId`, `/activity`, `/storage/breakdown` under admin prefix | Admin reporting |
| PATCH / DELETE | `/api/admin/users/:userId/quota`, `/api/admin/users/:userId` respectively | Change quota / delete another user |
| POST | `/api/admin/maintenance/cleanup` | Manual nonpositive-refcount cleanup |
| GET | `/health`, `/health/live`, `/health/ready`, `/health/deep`, `/metrics` | Unauthenticated diagnostics, subject to global HTTP limiter |
| WS | `/ws?token=…` | Server-side token-authenticated notifications; no browser consumer |

For example, init returns **hashes**, not missing chunk indices. Repeated hashes may occur in several positions. Completion has no expected version, immutable init-manifest binding, or idempotency key in its wired contract. The production proposal adds those fields plus status/resume and cursor-based change endpoints; it must not be inferred from the current paths.

Errors are broad route-level responses, not a consistent typed protocol. Oversized multipart files reach the global 500 handler. Upload completion commonly returns an error after its commit; download storage errors become 404. Proposed clients require distinct invalid-input, permission, quota, conflict, pending, and retryable-unavailable outcomes.

## Key Design Decisions

### Verified staging before atomic publication

Choose chunk staging plus a short metadata transaction. It lets slow clients retry small transfers without holding locks, while one commit determines whether a file is visible. A single whole-file request is simpler, but restarting a 10 GiB transfer after a late failure wastes bandwidth and ties application memory to concurrent upload size. A transaction spanning SQL and object storage would require a coordination protocol that the S3 operations do not supply.

The cost is a staging ledger, expiring reservations, and orphan reclamation. An object PUT acknowledgment alone is insufficient: publication must validate the expected slot, size, digest, and durability state. An HTTP timeout does not mean publication failed; the durable operation receipt resolves that uncertainty.

### Explicit conflicts over silent replacement

Choose immutable versions and a base-version condition for replacement. If two devices edit version 7, the first publishes version 8; the second receives a conflict with its staged bytes preserved. The user can keep both or deliberately replace the latest revision. File history by itself is weaker: a silently replaced edit is easy to miss, even if recoverable later.

This creates conflict UI and abandoned-upload retention costs. Binary merge is not generally defined, and clocks do not establish intent. Use server revisions, not client timestamps, for concurrency. Name uniqueness and structural moves need their own constraints; a version check does not prevent folder cycles.

### Authorized reuse and delayed reclamation

Choose namespace-scoped deduplication and private objects. A global “do you have this hash?” endpoint leaks content membership and can become a way to attach another user's bytes. Namespace scope gives up some cross-user space savings in exchange for an intelligible authorization boundary. If cross-namespace reuse is later required, it needs a proof-of-possession and disclosure design.

Reclaim only chunks unreachable from current manifests, retained versions, and active staging leases. Mark candidates, wait through an explicitly coordinated grace period, recheck liveness while excluding new attachment, delete objects idempotently, then remove metadata. Reference counts can accelerate discovery only if maintained transactionally and reconciled; they cannot substitute for a correct liveness protocol.

## Consistency and Idempotency

The proposed commit serializes namespace authority, file base version, manifest publication, quota conversion, operation receipt, and outbox insertion. An operation ID is scoped to actor and payload; a retry with a different manifest is rejected. Each slot has a unique session/index receipt with a digest and verified size. The finalization transaction checks that every slot remains protected from reclamation.

Define quota before implementing it. Here the proposal charges logical bytes for every retained file version, irrespective of deduplication, and reserves prospective versions during upload. Restore creates a new retained version and consumes its logical size. Deletion releases bytes only when retention ends. Physical object usage is a separate metric. This is easier to explain than tying a user's billable capacity to other users' deduplication behavior.

Local `completeUpload` uses a real SQL transaction, but no receipt, status guard, or base-version condition. Retrying a completed session can create another version and charge again. Local restore adjusts usage only by the size difference; file delete subtracts current size, folder delete subtracts nothing. Those operations do not implement the proposed quota definition or a coherent alternative.

## Security / Auth

Production uses secure HTTP-only sessions, origin/CSRF protection for writes, bounded authentication attempts, and permission checks on every metadata/byte operation. A short-lived signed URL is a capability: revoking a link stops new grants, but an already issued URL may remain valid until expiry. Already downloaded bytes cannot be recalled. Strict immediate revocation requires an online authorization check at the byte-delivery boundary.

Public password submission should avoid query strings and logs. Consume a limited-download admission atomically, define whether it counts attempts or completed transfers, and bind it to a file/version capability. Permission changes must reach shared-namespace feeds and invalidate future admissions. “View” does not prevent copying bytes delivered to a browser.

Locally bcrypt cost 10 protects passwords. A random 64-hex-character token is stored in Redis and also in SQL. HTTP checks Redis then reads the user; SQL session rows are not a fallback. Cookie `token` is HTTP-only, SameSite Lax, secure only in production, and fixed at 24 hours. Redis/SQL expiry follows `SESSION_EXPIRY_HOURS`. The frontend also persists the returned token in localStorage, although its HTTP client uses cookies.

Registration and session writes are not one transaction. Logout/password changes/account deletion do not provide comprehensive socket/session revocation. The WebSocket server validates a query token at connection only, without origin checks, periodic reauthorization, or expiry closure. Global HTTP limiting is an in-process 1,000 requests per 15 minutes/IP, not a Redis-backed or auth-specific limit.

## Observability

Production signals should answer whether users can publish and retrieve the same bytes: verified-slot latency, commit latency, unknown outcomes, quota discrepancies, conflict rate, oldest undelivered change, stale client cursors, missing chunks, and reclamation failures. Bound labels to route templates and error categories; keep filenames, passwords, tokens, and untrusted query strings out of routine logs.

Local Pino and Prometheus instrumentation are wired, but measurements need interpretation. `storageUsedBytes.inc(session.file_size)` throws on the SQL BIGINT string after commit; upload notifications and response success are then skipped. Other gauges start at zero and drift. The deduplication-ratio gauge and sync-latency histogram are not populated. Circuit state callbacks supply numeric enums, but the local mapping expects strings and reports closed even when open.

Retry “exhausted” increments on individual failure callbacks, and “success after retry” is inferred from duration rather than attempt count. Admin storage savings use `size × reference_count`, whose reference count is not manifest liveness; integer multiplication can also overflow before aggregation. Latest modified files are an activity view, not an immutable audit log. Health checks cannot verify these semantics.

## Failure Handling

| Failure | Proposed behavior | Current implementation |
|---------|-------------------|------------------------|
| Lost completion response | Read stable operation receipt; retry same intent | Commit can precede metric/Redis error; retry can version and charge again |
| Missing or corrupt chunk | Fail publication or retrieval explicitly; repair from replica | Completion accepts missing hashes; no download integrity/total-size validation |
| Redis unavailable | Durable changes retained; explicit auth policy | HTTP auth depends on Redis; post-write notifications/cache deletion can fail after effects |
| Object store unavailable | Bounded retries, deadlines, no publication without receipts | Cockatiel wraps PUT/DELETE and GET acquisition; HEAD catches errors as absence; GET body drain is outside policy |
| Concurrent replacement | Base-version conflict with staged bytes preserved | No CAS; competing history inserts may fail on uniqueness |
| Client disconnect | Resume verified slots, reconcile from durable cursor | No browser resume queue or socket; Pub/Sub has no replay |
| Garbage collection failure | Keep retryable deletion record and exclude new attachment | Cleanup deletes chunk metadata first, catches object failures, and loses retry information |

Cockatiel's installed `maxAttempts: 3` permits three retries after the initial call. The outer storage breaker counts failed retry sequences and opens after five consecutive failures, with a 30-second half-open interval. No explicit request deadline or cancellation policy bounds a stuck operation. Shutdown starts HTTP/socket closure without fully awaiting drains, omits some Redis clients, and has no overall deadline.

## Scalability Considerations

The first local bottlenecks are whole-file buffering, unbounded parallel browser uploads, sequential chunk reads, full folder listings, and per-ancestor queries. Fix integrity, quota, and authorization before increasing traffic. Direct scoped transfers plus streaming downloads remove most bytes from API heap; a bounded client pool keeps memory proportional to in-flight chunks.

Scale metadata by namespace after measuring transaction contention and folder sizes. Keep mutations and immediate post-write reads on the namespace authority, or enforce a minimum-revision fence on replica reads. Hot shared folders may need their own shard and paginated listings. Hash partitioning inside one PostgreSQL server is not automatic horizontal write scaling.

Separate socket gateways from metadata workers when connection load warrants it. Coalesce notices by namespace revision, bound queues, and force slow clients to resynchronize. Scale byte storage and egress independently; use immutable version keys to make caching safe. Multi-region failover must fence writers and verify both metadata and referenced object availability before acknowledging new writes.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Publication | Verified staging + SQL commit | Whole-file request / cross-store transaction | Retry small transfers; publish complete manifests atomically |
| Conflicts | Base-version check + retained versions | Silent last arrival wins | Preserve user intent under concurrent edits |
| Deduplication | Authorized namespace scope | Global hash membership | Avoid turning content knowledge into access |
| Recovery | Durable cursor + notification hints | Pub/Sub alone | Reconcile after gaps and reconnects |
| Quota | Retained logical versions + reservations | Mutable approximate counter | Stable user semantics independent of physical reuse |
| Reclamation | Coordinated reachability + grace | Unchecked reference counts | Protect current, historical, and staged bytes |

## Implementation Notes

### Patterns actually wired

The actual [entry point](./backend/src/index.ts) hosts Express and `/ws` together. PostgreSQL contains metadata, MinIO holds `chunks/<first-two-hash-characters>/<full-hash>`, and Redis carries sessions and `sync:<userId>` notifications. There is no RabbitMQ, temporary bucket, background sync worker, or browser WebSocket client.

The publication pattern in [upload.ts](./backend/src/services/file/upload.ts) includes a real database transaction:

```typescript
const file = await transaction(async (client) => {
  // Current source writes history, file manifest, usage and session status here.
  // Missing validation and retry guards are described below.
});
// Current source updates metrics, publishes, and invalidates after COMMIT.
```

The snippet is an abbreviated sequence, not a complete implementation. The transaction protects its SQL writes together; it does not cover object upload, preceding validation, or following side effects. [database.ts](./backend/src/utils/database.ts) supplies BEGIN/COMMIT/ROLLBACK and a 20-connection pool. [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) supplies retries and a breaker around selected object operations. [logger.ts](./backend/src/shared/logger.ts), [metrics.ts](./backend/src/shared/metrics.ts), and [health.ts](./backend/src/routes/health.ts) provide diagnostics with the limitations above.

### Upload and accounting gaps

[File routes](./backend/src/routes/files.ts) buffer multipart requests with Multer's `CHUNK_SIZE × 2` limit. Browser [XHR upload](./frontend/src/services/api.ts) sends the entire file, so server-side deduplication does not reduce browser upload bandwidth. Progress measures bytes sent, not committed storage. No `MAX_FILE_SIZE` setting is consumed.

Initialization records only the total chunk count and tests global hash membership. Upload validates the supplied bytes against the supplied hash, but never binds `chunkIndex` to a stored manifest or enforces session expiry/status. Repeating a chunk increments counters again. If an object exists without its SQL row, the existing-object path updates zero rows and never repairs the row.

Completion checks only the array length. It can substitute new hashes, accept missing objects and negative/inaccurate declared sizes, attach arbitrary hashes, or overwrite a folder's metadata because the name lookup does not filter folder type. Missing chunk sizes default to 4 MiB. There is no owner-scoped proof for deduplicated chunks, commit-time quota enforcement, or lock/CAS on the base file.

The default `pg` BIGINT parser makes upload quota arithmetic concatenate and lexically compare strings. More decisively, completion commits and then `storageUsedBytes.inc` throws on the string size, before sync publication. Isolated execution of the actual module reproduced two failed responses with two committed versions and two usage charges. These are application defects, not a claim that PostgreSQL lost atomicity.

### Tree, version, and retention gaps

[Metadata operations](./backend/src/services/file/metadata.ts) precheck names and destinations outside mutation transactions. Create-folder and upload do not validate parent ownership/type/liveness. Breadcrumb traversal can expose ancestor names across malformed ownership boundaries; recursive delete follows all descendants without an owner filter. Concurrent structural moves can create cycles despite the single-request ancestor check.

Direct file delete subtracts current size; subtree delete does not subtract descendants. Concurrent deletes can double-subtract after separate initial reads. [Restore](./backend/src/services/file/versioning.ts) saves history and advances the version, but has no expected version, quota guard, cache invalidation, or notification. Historical manifests and current manifests do not maintain chunk reference counts on attachment/removal. Counts can both overstate and understate reachability.

[Admin cleanup](./backend/src/routes/admin.ts) only considers rows with nonpositive reference counts, deletes those rows first, then attempts object deletion. There is no schedule, grace period, reference recheck, or pending-upload coordination; objects lacking SQL rows are invisible to it. Account deletion does not reconcile physical storage or Redis sessions. No retention purge or trash restore API is implemented.

### Sharing, client state, and operational limits

[Sharing routes](./backend/src/routes/sharing.ts) register `/:token` before `/shared-with-me`; the latter is interpreted as a token. Normal file reads enforce owner ID regardless of folder grants. Permission middleware and `checkAccess` helpers are unused by those routes; one helper also omits the selected folder-type field. Stored public-link access levels are not enforced, and folder links can yield empty downloads rather than folder archives. Download limits are checked and incremented separately, allowing concurrent over-admission.

The native download URL endpoint really does return one-hour presigned GET URLs; the upload-presigning helper is not exposed. Compose makes the entire chunk bucket anonymously readable. Public query passwords are included in debug request-query logging. The frontend's copied link targets API JSON, and its sharing screen has no recipient navigation. These facts preclude treating the demo as a private shared drive.

[File store](./frontend/src/stores/fileStore.ts) keeps one unkeyed folder result and launches dropped files without a concurrency bound. Late responses can replace the active folder; upload completion can reload its old destination after navigation. State is not cleared across logout, requests are not cancelled, and upload tasks are not persisted or resumable. Rename can submit through both blur and Enter. Modals do not provide complete focus/keyboard behavior; list rows are not a keyboard-operable explorer.

[Version history](./frontend/src/components/VersionHistoryModal.tsx) and sharing/move modals do not fence responses when their target changes. Settings actions are placeholders. Admin has no quota-edit interface or immutable activity feed. [Seed SQL](./backend/db-seed/seed.sql) creates two users and fourteen admin entries, but no chunk bytes; the download service returns an empty buffer for those samples.

[Compose](./docker-compose.yml) runs PostgreSQL 16, Valkey 7, and MinIO with local volumes, using mutable `latest` tags for MinIO. It has no object replication or guaranteed AOF configuration for Valkey. SQL sessions are not used to recover Redis sessions. Folder-cache getters/setters and [idempotency middleware](./backend/src/shared/idempotency.ts) are unused; invalidating a key does not establish that any reads are cached.

### Simplified and omitted production work

The local application substitutes one PostgreSQL and one MinIO instance for a replicated namespace/object architecture. It omits verified resumable slots, durable finalization receipts, quota reservations, cursor replay, shared-namespace authorization, object reclamation coordination, range delivery, frontend virtualization, bounded transfer workers, CDN authorization, and multi-region recovery. These are the main production extensions described above, not completed features.

The documentation review used source inspection and isolated checks with mocked SQL/storage/Redis. It verified the BIGINT metric failure after commit, repeated completion, missing-chunk acceptance, repeated invalid-index uploads, empty seeded downloads, numeric circuit-state mapping, retry count, and seeded password hashes. It did not run the full application, load-test targets, or modify application code.
