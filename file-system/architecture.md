# File System - Architecture

## System Overview

This project has two layers that share one data model.

The first is a **practice problem**: an in-memory file store built in four levels that each extend the last (files, then queries, then users with quotas, then either backup and restore or time-to-live with history). That is the format of a timed online coding assessment, where you can't read the next level until the current one passes, so the skill under test is picking a data model that survives requirements you haven't seen. [levels.md](./levels.md) is the spec, written for this repository.

The second is the **service** that model becomes at scale: the metadata layer of a cloud file store. It covers the namespace of paths and directories, per-user quotas, account merges, backups, restores and point-in-time reads. File *contents* are out of scope here; the [dropbox](../dropbox/) project covers chunked blob upload and sync. What remains is everything that has to be exactly right about the tree itself: a path is a file or a directory but never both, a user never exceeds their capacity, a restore never overwrites someone else's file, and every derived number (directory totals, used bytes) agrees with the files.

**Learning goals:**

- Choose a data model by the last level, not the first: one record per file, every derived structure changed in one place
- Enforce structural invariants (file-or-directory, no file below a file) with a primary key and a lock order instead of application checks that race
- Make quotas exact under concurrency: a conditional counter update, reserve before writing, and a CHECK constraint behind it
- Decide which aggregates must be synchronous (quota) and which can lag (directory totals), with measured evidence
- Compare full-copy backups with copy-on-write snapshots, and see that the time track's version history *is* the copy-on-write design
- Define restore and merge semantics precisely when the world changed since the backup

The sections before **Implementation Notes** describe the production design. Implementation Notes maps it onto the local Docker + Node.js + React build, including what was simplified and left out.

## Requirements

### Functional Requirements

1. **Files**: create a file at a path with a size; read, resize and delete it. Directories are implicit: they exist while a file lives below them
2. **Placement rules**: a path is a file or a directory, never both; nothing can be stored below a file
3. **Queries**: list a directory's direct children, total the bytes below a directory, and find the N largest files under a path prefix
4. **Users and quotas**: each user has a byte capacity; owned files count against it; unowned (system) files count against no one
5. **Merges**: fold one account into another, moving every file and all capacity
6. **Backup and restore**: snapshot a user's files; restore later, skipping paths that someone else now holds
7. **History and expiry**: files can expire after a time to live; the size of a path can be read as of any past time
8. **Admin**: users with usage and backups, merge and restore controls

### Non-Functional Requirements

| Requirement | Target (production) |
|-------------|---------------------|
| Metadata writes (create, resize, delete) | p99 < 50 ms |
| Stat a file | p99 < 10 ms (cached) |
| List a directory | p99 < 100 ms per page of 1,000 entries |
| Directory totals and largest-N | p99 < 200 ms; may lag writes by up to 60 s |
| Quota | Exact and hard: no commit may take a user over capacity |
| Durability | A committed metadata write is never lost (synchronous replica) |
| Availability | 99.99% reads, 99.95% writes |
| Restore | Atomic per user; never touches another user's files |

**Out of scope:** file contents and sync (see [dropbox](../dropbox/)), sharing permissions beyond ownership (see [Workspace Permissions](../ROADMAP.md#7-workspace-permissions)), and full-text search.

## Capacity Estimation

### Production Scale

| Input | Value |
|-------|-------|
| Registered users | 50M, of which 10M active daily |
| Files per user | 2,000 average, with a long tail past 1M |
| Namespace rows | 50M × 2,000 = 100B files, plus ≈ 15% directories ≈ 115B rows |
| Metadata writes | 10M active users × 40 per day = 400M/day ≈ 4.6K/s average, ≈ 25K/s at a 5× peak |
| Metadata reads | ≈ 20 per write: ≈ 100K/s average, ≈ 500K/s peak |
| Average depth | 6 directories above a file |

**Derived load:**

- **Storage**: ≈ 300 bytes per row with indexes doubling it ≈ 70 TB. At ≈ 1 TB per shard that is ≈ 70 primary shards, each with a synchronous replica
- **Synchronous directory totals would be the bottleneck**: 25K writes/s × 6 ancestors = 150K row updates/s, all funnelled through the few directories near each root. The local benchmark below shows one shared ancestor caps throughput at a single writer's rate. Directory totals must be asynchronous at this scale
- **Quota updates**: one counter update per write, 25K/s spread over 10M users. Only a single heavy uploader contends with itself
- **Daily backups as full copies**: 10M users × 2,000 rows = 20B row copies/day ≈ 230K rows/s, sustained. As copy-on-write snapshots: 10M sequence numbers per day. That ratio decides the backup design
- **Cache**: the hot working set (recently listed directories, recently stat'ed files) is a few percent of rows, ≈ 2-3 TB across a Valkey cluster

### Local Development Scale

| Component | Sizing |
|-----------|--------|
| Seed data | 5 users (4-64 MiB), 25 files, 4 top-level directories, 2 backups |
| PostgreSQL | One instance; the namespace, quotas and backups in 4 tables |
| API | One instance on :3000 (`dev:server1..3` for 3001-3003), memory or PostgreSQL store |
| Measured write throughput | ≈ 2,000 creates/s with 20 writers in separate trees; ≈ 600-770/s under one shared directory |

## High-Level Architecture

```
┌──────────────────┐        ┌───────────────────────────┐
│ Clients          │ HTTPS  │ API gateway               │  auth, rate limits,
│ web, desktop sync│───────▶│                           │  request ids
└────────┬─────────┘        └─────────────┬─────────────┘
         │ file contents                  │ metadata
         ▼                                ▼
┌──────────────────┐        ┌───────────────────────────┐       ┌──────────────────────────┐
│ Block service    │        │ Metadata service          │──────▶│ Metadata shards           │
│ + object storage │◀ ─ ─ ─ │ (stateless)               │◀──────│ PostgreSQL, by namespace  │
│ (dropbox project)│ commit │ placement, quotas, merge, │       │ primary + sync replica    │
└──────────────────┘        │ backup, restore           │       │ entries, users, journal   │
                            └──────┬─────────────┬──────┘       └─────────────┬────────────┘
                                   │             │                            │ change data
                       ┌───────────▼───┐   ┌─────▼──────────────┐   ┌─────────▼────────────┐
                       │ Valkey        │   │ Job workers         │   │ Kafka: namespace      │
                       │ stat / list   │   │ merges and restores │   │ change log            │
                       │ cache         │   │ in resumable batches│   └─────────┬────────────┘
                       └───────────────┘   └────────────────────┘             │
                                                                   ┌──────────▼───────────┐
                                                                   │ Aggregator            │
                                                                   │ directory totals,     │
                                                                   │ largest-N indexes     │
                                                                   └──────────────────────┘
```

**Namespaces are the unit of sharding.** Each user's home tree is a namespace, and so is each shared folder, which is mounted into members' trees. One namespace lives on one shard, so placement checks, quota charges for that namespace's owner and directory updates are single-shard transactions. Moving between namespaces is a copy, not a rename.

**The metadata service is the only writer.** It enforces the placement rules and quotas inside one database transaction per operation, which is also the moment a write counts as successful: the commit on the shard primary with its synchronous replica.

**Derived data is downstream.** Directory totals and largest-file indexes are built by an aggregator from the change log, so a write touches one file row and one quota row, not six ancestors. Quotas stay synchronous because they gate writes.

## Core Components

### 1. The practice library (four levels, one model)

`backend/src/fs/file-store.ts` is the worked answer. It keeps:

| Structure | Holds | Why it exists |
|-----------|-------|---------------|
| `files` | path → `{ size, owner, expiresAt }` | The source of truth; each live file once |
| `dirFiles` | directory → files below it | "Is this a directory?" in O(1); placement checks in O(depth) |
| `users` | id → `{ capacity, used }` | Quota checks without summing files |
| `backups` | id → `[{ path, size }]` | Backup track |
| `history` | path → versions `{ size, from, to }` | Time track: `getSizeAt` |

Every mutation goes through three private methods, `link`, `unlink` and `resize`, which update all of them together. That is the property hidden tests probe: a delete that forgets to free quota, an expiry that leaves a directory behind, a merge that moves files but not bytes. Methods that can fail check every precondition before calling any of the three, so a failure changes nothing.

The levels deliberately change earlier methods: `updateFile` gains a quota failure at level 3, and every method must ignore expired files at level 4. A design with one mutation path absorbs those changes in one place.

### 2. Namespace and placement rules

The rules are: a path is a file or a directory, never both, and nothing lives below a file. Directories are implicit, like prefixes in an object store, but unlike an object store they are *exclusive* with files.

Locally, files and directories are rows of one table keyed by path (`fs_nodes`). Creating `/a/b/c` upserts directory rows `/a` and `/a/b`, refusing if either is a file, and then inserts the file row, refusing if the path exists. Because both kinds share the primary key, two racing writers can't make `/a/b` both a file and a directory: the loser blocks on the winner's uncommitted row and then sees it. The race tests in `pg-backend.test.ts` check this with 15 rounds of three conflicting creates.

In production the key is `(namespace_id, parent_id, name)` with an inode-style `entry_id` (see [Key Design Decisions](#2-path-keyed-rows-locally-inode-rows-in-production)). "No file below a file" then holds by construction, because a child's parent must be a directory row.

### 3. Quotas: reserve, then write

A write by a user starts with a conditional update of that user's counter:

```sql
UPDATE fs_users SET used = used + $delta
 WHERE id = $owner AND used + $delta <= capacity
 RETURNING capacity - used AS remaining
```

No row returned means over capacity (or no such user), and the operation stops before touching the namespace. The counter lives in the same transaction as the file change, and `CHECK (used <= capacity)` makes an over-capacity commit impossible even if application code is wrong.

In production, an upload takes minutes but the quota check must happen before it starts. The metadata service creates a **reservation** (user, bytes, expiry) that counts toward `used` immediately. Committing the file converts the reservation into usage in one transaction; an abandoned upload's reservation expires and is released by a sweeper. Quotas stay exact at every moment, with abandoned uploads holding capacity for at most the reservation TTL.

### 4. Directory totals

`dirSize` and the totals in listings come from directory rows that carry `size` and `file_count`. Locally they are updated synchronously, in the same transaction as the file, which keeps them exact and makes them a write hot spot: every write under `/home` updates the `/home` row and holds its lock until commit. The root has no row at all, so it can't become the one row every write touches; its totals are summed from its children on read.

In production, totals are maintained by the aggregator from the change log and may lag by up to a minute. Listings show "about" totals; quota numbers, which gate writes, never come from them.

### 5. Queries

| Query | Local plan | Production plan |
|-------|-----------|-----------------|
| `listDir` | `(parent, name)` index, already sorted by name in byte order | Same index per namespace, paginated by name cursor |
| `dirSize` | Directory row (exact) | Aggregator's directory row (lagging) |
| `largest(prefix, n)` | `(size DESC, path)` partial index, walk and filter by prefix, stop at n | Per-namespace index for prefixes inside one namespace; scatter-gather top-n across shards otherwise |

`largest` matches a plain string prefix (`/a/b` matches `/a/bc.txt`); `dirSize` is directory-aware. The spec makes that distinction on purpose, since confusing the two is a common hidden-test failure.

### 6. Merging users

A merge moves every file of the source to the target, adds the source's capacity to the target's and deletes the source and its backup. Locally it is one transaction that locks both user rows (sorted by id), updates file ownership in bulk and moves the counters.

In production, two accounts usually live on different shards, and one account can own millions of files, so a merge is a **job**: copy the source namespace's rows to the target shard in batches with a checkpoint, mark the source read-only during the copy, then flip ownership and capacity in one small transaction and leave a redirect. Each batch is idempotent (keyed by source entry id), so a crashed worker resumes from its checkpoint.

### 7. Backups, restore and history

**Local backup track.** A backup copies the user's `(path, size)` rows into `fs_backup_files` in a single `INSERT … SELECT`, which is one consistent snapshot. Restore runs as one transaction:

1. Lock the user, then every existing directory the restore will touch, in path order.
2. Delete the user's current files.
3. Re-create each backed-up file inside its own savepoint. A path that is now unavailable (another user's file, an unowned file, a directory of others' files, or below someone else's file) rolls back only that savepoint and is reported as skipped.

Skipping, rather than failing or overwriting, is the defined policy: a restore must never destroy data that isn't the user's.

**Time track, and why it is the production design.** The time track keeps every version of every path with a validity interval. That is copy-on-write snapshotting: a snapshot is just a point in time, and "restore to T" means "for each of my paths, take the version live at T". In production every entry row carries `valid_from_seq` and `valid_to_seq` from the namespace's journal sequence, so a backup costs one stored sequence number instead of a row copy per file. Old versions are garbage-collected after the retention window.

**Expiry.** Files with a TTL expire at `createdAt + ttl` exactly. The worked answer purges on `setTime`; production keeps a `(expires_at)` index swept by a background job, and every read also filters `expires_at > now()`, so a file is invisible the moment it expires even if the sweeper is behind.

### 8. Duplicate files (the onsite variant)

`backend/src/fs/dedup.ts` finds identical files in a large tree without reading any file whole into memory. It narrows candidates in stages: by size (from directory metadata, no reads), by a hash of the first 4 KB, then by a streamed SHA-256 of the whole file. A file with a unique size is never opened, and a file no bigger than 4 KB is hashed once. A test checks those costs (`dedup.test.ts`). In a cloud store the same idea runs at upload time: content-addressed blocks make duplicate detection a hash lookup.

## Database Schema

The local schema (`backend/src/db/init.sql`):

```sql
CREATE TABLE IF NOT EXISTS fs_users (
  id         TEXT PRIMARY KEY,
  capacity   BIGINT NOT NULL CHECK (capacity >= 0),
  used       BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_users_used_within_capacity CHECK (used <= capacity)
);

-- Files and directories share the primary key: a path is one or the other.
-- COLLATE "C" gives byte order (the spec's sort) and B-tree prefix scans.
CREATE TABLE IF NOT EXISTS fs_nodes (
  path       TEXT COLLATE "C" PRIMARY KEY,
  parent     TEXT COLLATE "C" NOT NULL,
  name       TEXT COLLATE "C" NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  size       BIGINT NOT NULL CHECK (size >= 0),        -- file size, or total below a directory
  file_count BIGINT NOT NULL DEFAULT 1 CHECK (file_count >= 0),
  owner_id   TEXT REFERENCES fs_users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_nodes_dirs_unowned CHECK (kind = 'file' OR owner_id IS NULL)
);
CREATE INDEX IF NOT EXISTS fs_nodes_parent_idx  ON fs_nodes (parent, name);
CREATE INDEX IF NOT EXISTS fs_nodes_owner_idx   ON fs_nodes (owner_id) WHERE kind = 'file';
CREATE INDEX IF NOT EXISTS fs_nodes_largest_idx ON fs_nodes (size DESC, path) WHERE kind = 'file';

CREATE TABLE IF NOT EXISTS fs_backups (
  user_id    TEXT PRIMARY KEY REFERENCES fs_users (id) ON DELETE CASCADE,
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes      BIGINT NOT NULL DEFAULT 0,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fs_backup_files (
  user_id TEXT NOT NULL REFERENCES fs_backups (user_id) ON DELETE CASCADE,
  path    TEXT COLLATE "C" NOT NULL,
  size    BIGINT NOT NULL,
  PRIMARY KEY (user_id, path)
);
```

The production entry table replaces path keys with inode ids and adds versioning:

```sql
CREATE TABLE entries (
  namespace_id   BIGINT NOT NULL,
  entry_id       BIGINT NOT NULL,
  parent_id      BIGINT NOT NULL,          -- the namespace root's id for top-level entries
  name           TEXT COLLATE "C" NOT NULL,
  kind           TEXT NOT NULL,            -- 'file' | 'dir'
  size           BIGINT NOT NULL,
  owner_id       BIGINT,
  content_hash   BYTEA,                    -- block list hash in the blob store
  expires_at     TIMESTAMPTZ,
  valid_from_seq BIGINT NOT NULL,          -- journal sequence that created this version
  valid_to_seq   BIGINT,                   -- NULL while current
  PRIMARY KEY (namespace_id, entry_id, valid_from_seq)
);
-- One current entry per name in a directory.
CREATE UNIQUE INDEX entries_current_name ON entries (namespace_id, parent_id, name) WHERE valid_to_seq IS NULL;
CREATE INDEX entries_expiry ON entries (expires_at) WHERE expires_at IS NOT NULL AND valid_to_seq IS NULL;
```

## API Design

Paths travel in the query string or body, never as a route segment, because they contain slashes.

```
GET    /api/v1/fs/list?path=/home/alice        → { path, bytes, fileCount, entries: [{ name, kind, size, owner, fileCount }] }
GET    /api/v1/fs/largest?prefix=/home/&n=10   → { prefix, files: [{ path, size }] }
POST   /api/v1/fs/files                        → 201 { path, size, owner, remaining }   body { path, size, owner? }
PATCH  /api/v1/fs/files?path=/home/a/x         → { path, size, previous }               body { size }
DELETE /api/v1/fs/files?path=/home/a/x         → { path, size }

GET    /api/v1/users                           → { users: [{ id, capacity, used, fileCount, backup }] }
POST   /api/v1/users                           → 201 { id, capacity }                   body { id, capacity }
POST   /api/v1/users/:id/merge                 → { targetId, sourceId, remaining }      body { sourceId }
POST   /api/v1/users/:id/backup                → { id, fileCount }
POST   /api/v1/users/:id/restore               → { id, restored, skipped: [path] }

POST   /api/v1/admin/reset                     → reloads the demo data
GET    /api/v1/info | /health | /ready | /metrics
```

**Errors** are `{ error: { code, message } }`:

| Status | Codes | Meaning |
|--------|-------|---------|
| 409 | `PATH_EXISTS`, `PATH_IS_DIRECTORY`, `PARENT_IS_FILE`, `OVER_CAPACITY`, `USER_EXISTS` | Valid request that conflicts with the tree or the quota. Retrying unchanged won't help |
| 404 | `FILE_NOT_FOUND`, `NOT_A_DIRECTORY`, `USER_NOT_FOUND` | |
| 422 | `VALIDATION_FAILED`, `SAME_USER` | Malformed path or size, or a self-merge |

Quota refusal is a 409 rather than 507 (Insufficient Storage): clients and proxies retry 5xx, and a quota refusal must not be retried.

## Key Design Decisions

### 1. One mutation path in the practice answer

The worked answer could have kept per-user file lists, per-directory child sets and a size-ordered index, each updated where it's needed. Each one is a second copy of a fact. In a timed assessment the cost of that isn't speed, it's correctness under requirements you haven't read: level 4's expiry has to remove a file from *every* structure, at a time no method call names. Routing every change through `link`, `unlink` and `resize` means expiry is one more caller of `unlink`. The price is O(files) scans in `listDir`, `dirSize`, `largest` and `mergeUsers`, which no level's tests punish and which take one sentence to justify.

### 2. Path-keyed rows locally, inode rows in production

Keying rows by full path makes the placement rules a primary-key property, makes prefix queries a range scan, and makes the SQL readable. It breaks on rename: moving a directory rewrites every path below it, which for a project folder can be millions of rows in one transaction. No level asks for rename, so the local build keeps paths. Production uses `(namespace_id, parent_id, name)` with stable `entry_id`s: rename and move are one-row updates, "no file below a file" holds because a parent must be a directory row, and path lookup becomes a walk from the root, served from a cache of path → entry id that a rename invalidates. The cost is that "everything under this prefix" is no longer a range scan; it needs the aggregator's indexes or a recursive walk.

### 3. One lock order: user rows, then namespace rows top-down

The first PostgreSQL version locked namespace rows first and the user last on the hot path, while merge and restore locked users first. The concurrency test that mixes merges, restores and updates then hit ten deadlocks per run, each costing PostgreSQL's one-second detection timeout before a retry. Now every write locks the owning user first (merges lock both users sorted by id), then existing ancestor directories in path order, then the file. Because a directory is locked before anything below it, and everyone acquires ancestors top-down, namespace locks can't form a cycle. After the change the same test shows no deadlocks; its only retries are the intended ones, where an update read a file's owner just before a merge moved it and starts over. The cost is that one user's writes run one at a time, about 565/s locally, which matters only for bulk importers (see Scalability).

### 4. Quota as a conditional counter, not a sum

`SELECT sum(size) … WHERE owner_id = $1` under a lock would be exact but O(files) per write. A counter updated with `used + $delta <= capacity` is O(1), and the row lock it takes is what serializes one user's concurrent writes. The CHECK constraint is the backstop. The counter is a derived fact, so the concurrency tests assert `used = sum(size of owned files)` after every race.

### 5. Synchronous directory totals locally, asynchronous in production

Synchronous totals are exact and simple, and the benchmark shows what they cost: 20 writers in separate top-level trees do about 2,000 creates/s, but under one shared `/home` they do 600-770/s, close to a single writer, because every transaction holds the `/home` row lock until commit. At production write rates that row would be the whole system's throughput. The aggregator gives that up for totals that lag by seconds, which listings tolerate and quotas never read.

### 6. Copy-on-write snapshots instead of copied rows

The local backup copies rows: simple, and fine for a few hundred files. At 2,000 files × 10M daily backups it is 230K row copies per second forever. Versioned rows make a snapshot a stored sequence number and a restore a diff against it. They also serve point-in-time reads and undo with no extra machinery, and the time track's `history` is that model in miniature. The cost is garbage collection of old versions and every current-state query filtering `valid_to_seq IS NULL`.

### 7. A restore skips what it can't take back

When a backed-up path is now held by someone else, a restore could fail, overwrite, or skip. Failing makes one conflict block a whole account's recovery. Overwriting destroys another user's data. Skipping, and reporting each skipped path, restores everything that is safely the user's and leaves the decision about the rest to a person. Savepoints make each skip roll back only its own partial work.

## Consistency and Idempotency

**Source of truth.** The committed rows in `fs_nodes` and `fs_users`, on the shard primary with its synchronous replica. A write is successful when that transaction commits. Directory totals locally, and everything the aggregator builds in production, are derived.

**Retries after a lost response.**

| Operation | Local behavior on retry | Production |
|-----------|-------------------------|------------|
| Create | `409 PATH_EXISTS`; the client can't tell its own success from someone else's file | `Idempotency-Key` header; the key, request hash and response are stored in the same transaction as the write and replayed for 24 h |
| Resize | Succeeds again; `previous` now equals the new size | Conditional on the entry's version (`If-Match`), so a retry of a stale resize fails loudly |
| Delete | `404 FILE_NOT_FOUND` | Treated as success when the idempotency key matches |
| Merge | `404` for the deleted source | Job id from the client; a resubmitted merge returns the existing job |
| Restore | Runs again from the same backup, with the same result | Same, plus a job id for large restores |

Idempotency keys are the main thing the local build leaves out (see Implementation Notes).

**Failure between steps.** Every local operation is a single transaction, so there is no "between steps": a crash rolls everything back, including a half-done restore. Production merges and restores span many transactions and are jobs with checkpoints; each batch is idempotent, and the final ownership flip is one small transaction.

**Ordering.** Per path, operations are serialized by the file's row lock; per user, by the user's row lock. Nothing needs a global order. The time track's "state at the end of time t" semantics match what a journal sequence gives in production.

### Successful trace: alice creates `/home/alice/notes/today.md` (2 KB)

1. `POST /api/v1/fs/files` reaches the API; zod validates the path (no empty, `.` or `..` segments) and size.
2. `BEGIN`. `UPDATE fs_users SET used = used + 2048 WHERE id = 'alice' AND used + 2048 <= capacity` returns 39.7 MB remaining and locks alice's row.
3. Upsert directory rows `/home`, `/home/alice`, `/home/alice/notes` top-down, adding 2048 bytes and one file to each; all three are directories, so all three rows come back.
4. `INSERT … ON CONFLICT (path) DO NOTHING` inserts the file row.
5. `COMMIT`. The API answers `201 { remaining }`; the client refreshes the listing and the largest-files panel.

### Failed trace: dmitri's upload doesn't fit

1. `POST` with 2 MiB for dmitri, who has 1023 KB left.
2. `BEGIN`. The conditional quota update returns no row. A second read finds dmitri exists, so the error is `OVER_CAPACITY` with both amounts.
3. Nothing in the namespace was touched; `ROLLBACK` releases the user lock. The API answers `409`, and `fs_writes_refused_total{code="OVER_CAPACITY"}` increments.

## Security / Auth

- **Locally there is no login.** Users are quota principals in the spec, not accounts, and authentication isn't what this project practices; the UI lets you act as any user. This is the one deliberate departure from the repository's session-auth default (see [CLAUDE.md](./CLAUDE.md)).
- **Production**: session or OAuth at the gateway, and authorization per namespace: a member of a shared namespace may write there, charging the namespace owner's quota. The cache stores entries keyed by namespace and version, and every read re-checks namespace membership, so a revoked member can't keep reading from cache.
- **Input validation** is where untrusted paths stop: absolute, segments of 1-255 characters with no `/` or NUL, no `.` or `..`, at most 1,024 characters. Production also normalizes Unicode (NFC) so two visually identical names can't coexist, and compares names case-insensitively where clients' file systems do.
- **Rate limits** per user at the gateway; bulk operations (merge, restore) are admin-only and run as jobs.

## Observability

Metrics on `/metrics` (`backend/src/shared/metrics.ts`):

| Metric | Why |
|--------|-----|
| `http_request_duration_seconds{method,route,status}` | Latency by route pattern |
| `fs_writes_refused_total{code}` | Placement conflicts vs quota refusals. A rising `OVER_CAPACITY` rate is a product signal, not an outage |
| `fs_transaction_retries_total{operation}` | Deadlock and lock-then-verify retries. It should stay near zero; a jump means a lock-order regression |
| `fs_restore_skipped_paths_total` | How often restores can't take a path back |

Structured logs come from pino, one line per request, with health and metrics probes excluded. `/health` is liveness; `/ready` checks the database.

In production, add replica lag, aggregator lag (the newest change-log offset minus the aggregator's), reservation counts, and a nightly consistency job that recomputes `used` and directory totals for a sample of users and alerts on drift. The local concurrency tests run exactly that check.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| PostgreSQL detects a deadlock (40P01) or serialization failure (40001) | `withTransaction` rolls back and reruns the whole transaction with jittered backoff, up to 4 attempts |
| A merge moved a file between reading its owner and locking it | Lock-then-verify sees a different owner and reruns the transaction (as 40001) |
| Database unavailable at startup | The API exits with instructions (`docker-compose up -d`, migrate, seed, or `npm run dev:memory`) |
| Database unavailable at runtime | `/ready` fails, requests return 500, nothing is half-written |
| A restore path became unavailable | That path's savepoint rolls back; the restore continues and reports it as skipped |
| Crash mid-restore | The transaction rolls back; the user's files are as they were |

Production adds: shard primary failover to its synchronous replica (no committed write lost), circuit breakers on the cache (fall through to the shard), and resumable checkpoints for merge and restore jobs.

## Scalability Considerations

**What breaks first, with evidence.** `npm run bench` runs 20 concurrent writers against PostgreSQL:

| Scenario | Creates/s |
|----------|-----------|
| Separate top-level directories | ≈ 2,000 |
| One shared top-level directory (`/home/u7/…`) | ≈ 600-770 |
| Shared directory three levels up | ≈ 560-660 |
| Separate directories, one user | ≈ 565 |

A shared ancestor reduces 20 writers to roughly one writer's throughput, because each transaction holds that directory's row lock until it commits. So the first thing to break is **synchronous directory totals near the root**. The fix is the production design: maintain totals asynchronously from the change log.

**Then, in order:**

1. **One shard's write rate.** Shard by namespace; a large team namespace can be split by subtree, with each subtree its own namespace.
2. **A single heavy uploader**, serialized on the user row by design. Desktop sync clients batch creates into one transaction per batch, and a bulk importer takes a quota lease (a block of pre-reserved bytes held in the service, settled periodically).
3. **Listing huge directories.** Name-cursor pagination; never `OFFSET`.
4. **Read load.** Valkey cache of stat and list results keyed by namespace version, plus read replicas for listings that tolerate replica lag.
5. **Version growth** from copy-on-write. Garbage-collect versions older than the backup retention, and compact frequently-updated entries.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Practice data model | One file map, three mutation methods | Several indexes updated ad hoc | Later levels change one place; hidden tests probe drift |
| Row key | Path (local), inode id (production) | Path everywhere | Paths fit the spec; renames need inodes |
| File-or-directory rule | Shared primary key | Application check | Holds under concurrent writers without SERIALIZABLE |
| Lock order | User, then ancestors top-down, then file | Per-operation order | No deadlocks; costs one user's writes running one at a time |
| Quota | Conditional counter + CHECK | Sum under lock | O(1) and exact; constraint as backstop |
| Directory totals | Synchronous (local), asynchronous (production) | Synchronous everywhere | Shared ancestors cap throughput at one writer |
| Backups | Row copy (local), copy-on-write versions (production) | Row copy everywhere | 230K row copies/s at scale versus one sequence number |
| Restore conflicts | Skip and report | Fail or overwrite | Never destroys another user's data; never blocks recovery |
| Quota refusal status | 409 | 507 | 5xx invites retries |
| Auth | None locally | Session auth | Users are quota principals here; auth isn't the subject |

## Implementation Notes

### Local architecture

```
┌──────────────────┐     ┌─────────────────────────────┐     ┌──────────────────────┐
│ Vite dev server  │────▶│ API :3000                   │────▶│ PostgreSQL :5432      │
│ :5173 (/api      │     │ Express + FsBackend         │     │ fs_users, fs_nodes,   │
│  proxied)        │     │ PgBackend or MemoryBackend  │     │ fs_backups(+_files)   │
└──────────────────┘     └──────────────┬──────────────┘     └──────────────────────┘
                                        │ MemoryBackend wraps
                              ┌─────────▼──────────────┐      ┌──────────────────────┐
                              │ FileStore (worked      │      │ Practice runner       │
                              │ answer, src/fs/)       │      │ practice-attempt/:    │
                              │ level tests in         │◀─────│ your FileStore + the  │
                              │ src/fs/tests/          │ copy │ unlocked level tests  │
                              └────────────────────────┘      └──────────────────────┘
```

`npm run dev` uses PostgreSQL; `npm run dev:memory` runs the same API over the in-memory worked answer with no Docker at all. `dev:server1..3` start extra PostgreSQL-backed instances on 3001-3003, which share all state through the database.

### Production-grade patterns actually implemented

**One conformance suite, two implementations** (`backend/src/fs/subject.ts`): the level tests run against the worked answer by default and against PostgreSQL with `npm run test:pg`, through a spec adapter (`store/pg-spec-store.ts`). The SQL version passes the same 63 level tests as the in-memory one (levels 1-3 and backup; the time track is memory-only).

**Placement rules in the primary key** (`backend/src/store/pg-backend.ts`): ancestors are upserted as directories with a guard, so a short row count means an ancestor is a file:

```sql
INSERT INTO fs_nodes (path, parent, name, kind, size, file_count)
SELECT d.path, d.parent, d.name, 'dir', $4, 1 FROM unnest($1::text[], $2::text[], $3::text[]) AS d (path, parent, name)
ON CONFLICT (path) DO UPDATE SET size = fs_nodes.size + EXCLUDED.size, file_count = fs_nodes.file_count + 1
  WHERE fs_nodes.kind = 'dir'
```

**Reserve-first quotas** and the **lock order** described in Key Design Decisions 3 and 4, with **lock-then-verify** for operations that must read a file's owner before locking it (`lockOwnerOf`).

**Deadlock-safe transactions** (`backend/src/shared/db.ts`): `withTransaction` retries 40P01 and 40001 with jittered backoff and counts retries in `fs_transaction_retries_total`.

**Concurrency tests with invariant checks** (`backend/src/store/pg-backend.test.ts`): many writers racing on one path, on file-versus-directory conflicts, on one quota, and on hot directories, plus merges, restores and updates on the same users at once. After each test, SQL checks that every directory's totals equal its files, no directory is empty, every `used` equals its files, no file sits below a file, and every parent exists.

**Savepoint-per-file restore** with skipped paths reported to the client.

**Prometheus metrics, pino logs, health and readiness checks**, and graceful shutdown in `api/index.ts`.

**Practice runner** (`backend/src/practice/cli.ts`): reveals `levels.md` one level at a time, copies that level's tests into a git-ignored attempt folder, keeps split times, and unlocks the next level only when the current one passes.

### Simplified or substituted

- **One global namespace keyed by path** instead of sharded namespaces with inode ids; shared folders are just directories (`/shared`)
- **Synchronous directory totals** instead of an aggregator fed by a change log
- **Backups copy rows** instead of copy-on-write versions; the time track (TTL and point-in-time reads) exists only in the in-memory worked answer
- **Merge is one transaction**, not a resumable cross-shard job
- **No authentication**; the UI acts as any user
- **File sizes only**, no contents or blob storage

### Omitted

- Idempotency keys on writes (the retry behavior without them is in Consistency and Idempotency)
- Rename and move
- Upload reservations with TTLs, and quota leases for bulk importers
- The stat/list cache, read replicas, sharding and the change log
- Version garbage collection, CDN, multi-region, Kubernetes

### Verified locally

PostgreSQL 16 in Docker. `npm test`: 107 tests (the level suites against the worked answer, dedup correctness and cost, API routes over the memory backend). `npm run test:pg`: the same level suites against PostgreSQL plus 5 concurrency tests, repeated several times with no deadlocks. `npm run bench` for the throughput table above. The practice runner was exercised end to end (a stub fails, levels unlock only on pass, the worked answer passes every level and the dedup bonus). In the browser: navigation, a refused over-quota create, a create below a file, resize and delete, and alice's restore reporting `/shared/roadmap.md` as skipped. Playwright smoke tests (6) and screenshots run through the repository harness.
