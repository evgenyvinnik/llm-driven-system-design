# File System — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Write path → Deep dives → Scale*

> "The coding version of this question is an in-memory file store that grows over four levels: files, then queries, then users with quotas, then backups or history. The design version asks what that same model becomes for tens of millions of users. File contents are a solved problem I'll hand to a block store. The hard part is the metadata: a path must be a file or a directory but never both, a user must never exceed their quota even with a hundred concurrent uploads, and a restore must never overwrite someone else's file. Every one of those is an invariant that has to hold under concurrency, so most of this answer is about where each invariant is enforced and what it costs."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Metadata only; quotas are hard; totals may lag |
| Architecture | ~6 min | Namespaces as the shard unit; one writer service; derived data downstream |
| Data model | ~5 min | Entries keyed by parent and name; a quota counter; versioned rows |
| API | ~4 min | Paths in the body or query; 409 versus 404 versus 422 |
| Write path | ~7 min | One successful and one failed trace |
| Deep dives | ~14 min | Placement under concurrency, exact quotas, snapshots and restore |
| Scale and wrap-up | ~4 min | What breaks first, with measured evidence |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Are file contents in scope? | Decides whether this is a blob-storage interview | No. A block service stores contents; I design the namespace and quotas |
| Is the quota hard or soft? | Exactness under concurrency versus eventual reconciliation | Hard: no commit may take a user over capacity |
| Can a path be both a file and a directory? | Object store versus file system semantics | No, and nothing can live below a file |
| Do directory sizes need to be exact? | Synchronous aggregates versus async | No. They may lag by up to a minute; quotas may not |
| What does restore do when a path is now someone else's? | Restore semantics | Skip it and report it; never overwrite another user's data |
| Do we need rename and move? | Path keys versus inode ids | Yes in production, which decides the key |
| How far back do backups go? | Copy-on-write retention | 30 days of point-in-time restore |

### Functional requirements

1. Create a file at a path with a size; read, resize and delete it. Directories are implicit and exist while something lives below them.
2. List a directory, total the bytes below it, and find the N largest files under a path prefix.
3. Users have a byte capacity; owned files count against it, system files against no one.
4. Merge one account into another, moving files and capacity.
5. Back up a user's files and restore later, skipping paths that became unavailable.
6. Files can expire after a time to live; any path's size can be read as of a past time.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Metadata write | p99 < 50 ms | Create, resize, delete |
| Stat | p99 < 10 ms | Served from cache |
| List | p99 < 100 ms per page of 1,000 | Name-cursor pagination |
| Directory totals | May lag 60 s | Listings show "about" |
| Quota | Exact and hard | Enforced in the write transaction |
| Durability | No committed write lost | Synchronous replica |
| Availability | 99.99% reads, 99.95% writes | |

**Out of scope:** file contents and sync (a block service), sharing permissions beyond namespace membership, full-text search, and rename conflicts across devices (the sync client's problem).

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Users | 50M registered, 10M daily active | |
| Entries | ≈ 115B rows | 2,000 files per user, plus ≈ 15% directories |
| Metadata storage | ≈ 70 TB with indexes | ≈ 300 bytes per row, doubled for indexes |
| Shards | ≈ 70 primaries at 1 TB each | Each with a synchronous replica |
| Writes | ≈ 4.6K/s average, ≈ 25K/s peak | 40 metadata writes per active user per day, 5× peak |
| Reads | ≈ 500K/s peak | ≈ 20 reads per write |
| Daily backups as row copies | ≈ 230K rows/s, sustained | 10M users × 2,000 rows a day |

> "Two numbers shape the design. If directory totals were updated synchronously, 25K writes a second times six ancestors is 150K row updates a second, concentrated on the few directories near each root. And daily backups as copies are 230K row copies a second forever. Both push work out of the write path: totals become derived data, and backups become copy-on-write."

### From the coding levels to the service

> "I like to say out loud which part of the coding answer survives. Each level of the four-level version maps to one production concern, and the data-model choice that made the levels easy is the same one that makes the service correct."

| Coding level | What it asked | What it becomes at scale |
|--------------|---------------|--------------------------|
| 1. Files | Add, read, resize, delete; file-or-directory rule | A unique key shared by files and directories, plus top-down locks |
| 2. Queries | List, directory size, N largest under a prefix | Indexes per namespace; totals and top-N from an aggregator |
| 3. Users and quotas | Capacity, merge accounts | A conditional counter; merge as a resumable job |
| 4. Backup | Snapshot and restore, skipping taken paths | Copy-on-write snapshots and a diff-based restore |
| 4. Time | TTL and size-at-time-T | Versioned rows and an expiry index |

The lesson from the coding version carries over directly: keep one record per file and change every derived structure in the same place. In the service, "the same place" is the write transaction for the quota counter, and the change log for everything that may lag.

---

## 🏗️ Architecture (~6 min)

```
┌──────────────┐       ┌────────────────────────┐
│ Clients      │──────▶│ API gateway            │  auth, rate limits, request ids
└──────┬───────┘       └───────────┬────────────┘
       │ contents                  │ metadata
       ▼                           ▼
┌──────────────┐       ┌────────────────────────┐       ┌───────────────────────┐
│ Block service│◀ ─ ─ ─│ Metadata service       │──────▶│ Metadata shards        │
│ + object     │commit │ stateless; placement,  │◀──────│ by namespace id        │
│ storage      │       │ quotas, merge, restore │       │ primary + sync replica │
└──────────────┘       └──────┬──────────┬──────┘       └───────────┬───────────┘
                              │          │                          │ change log
                     ┌────────▼───┐  ┌───▼────────────┐   ┌─────────▼───────────┐
                     │ Valkey     │  │ Job workers    │   │ Kafka               │
                     │ stat/list  │  │ merges,        │   └─────────┬───────────┘
                     │ cache      │  │ restores       │             ▼
                     └────────────┘  └────────────────┘   ┌─────────────────────┐
                                                          │ Aggregator: totals, │
                                                          │ largest-N indexes   │
                                                          └─────────────────────┘
```

**Namespaces are the shard unit.** Each user's home tree is a namespace, and each shared folder is its own namespace mounted into its members' trees. A namespace lives on one shard, so placement checks, the owner's quota charge and the file row all commit in one local transaction.

> "I shard by namespace rather than by user or by path hash because the invariants are per-tree. Hashing paths would scatter a directory's children across shards, and 'is anything below /a/b?' would become a scatter-gather on every create. Sharding by user breaks for shared folders, where several users write into one tree. A namespace is exactly the scope the invariants need."

**One writer service.** The metadata service is the only thing that writes entries. A write succeeds when its transaction commits on the shard primary and its synchronous replica.

**Derived data is downstream.** Directory totals and the largest-file indexes come from the aggregator, which consumes the change log. Quotas stay in the write path because they gate writes.

---

## 💾 Data Model (~5 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| entries | namespace_id, entry_id, parent_id, name, kind, size, owner_id, expires_at, valid_from_seq, valid_to_seq | Unique (namespace_id, parent_id, name) where current; (expires_at) where current | One row per version; the current version has no valid_to_seq |
| users | id, capacity, used, home_namespace_id | PK | `used` is a counter, checked against capacity on every write |
| reservations | id, user_id, bytes, expires_at | (user_id), (expires_at) | Bytes held for in-flight uploads; count toward `used` |
| namespaces | id, owner_id, shard, journal_seq | PK | The sequence increments with every change |
| snapshots | user_id, namespace_id, seq, taken_at | (user_id, taken_at) | A backup is a sequence number |
| idempotency_keys | key, request_hash, response, created_at | PK | Kept 24 h; written in the write's transaction |

**Why inode ids rather than full paths as the key.** Keying by full path makes "a path is a file or a directory" a primary-key property and makes prefix queries a range scan. That's what I'd do for the four-level coding version, and it's what the local build does. But it breaks on rename: moving a project folder rewrites every path below it, possibly millions of rows in one transaction. With `(parent_id, name)` keys, a move is one row update, and "nothing below a file" holds by construction because a parent must be a directory row. The cost is that path lookup becomes a walk from the root, which I serve from a cache of path to entry id that renames invalidate.

**Resolving a path.** A request for `/home/alice/notes/today.md` resolves in three steps:
1. Map the path's first segments to a namespace through the mount table (alice's home namespace), cached for minutes.
2. Walk the remaining segments by (parent_id, name), or hit the path cache, which maps a path to an entry id and is keyed by the namespace's journal sequence so a rename makes it miss.
3. Read or lock the entry. Writes always re-resolve inside the transaction, because the cache only speeds up reads.

**Why versioned rows.** Each change closes the current version (sets valid_to_seq) and opens a new one. A backup is then "remember seq N", a restore is a diff between N and now, and "what size was this at time T" is a lookup. It's the same structure as the coding question's time level, scaled up.

---

## 🔌 API Design (~4 min)

```
GET    /api/v1/fs/list?path=…&cursor=…       → entries page, directory totals ("about")
GET    /api/v1/fs/stat?path=…                → size, owner, version
GET    /api/v1/fs/largest?prefix=…&n=10      → [{ path, size }]
POST   /api/v1/fs/files                      → 201 + remaining quota       (Idempotency-Key)
PATCH  /api/v1/fs/files?path=…               → previous size               (If-Match: version)
DELETE /api/v1/fs/files?path=…               → freed bytes                 (Idempotency-Key)
POST   /api/v1/uploads                       → reservation for a pending upload
POST   /api/v1/users/:id/merge               → 202 job id
POST   /api/v1/users/:id/backup              → snapshot seq
POST   /api/v1/users/:id/restore             → 202 job id → { restored, skipped[] }
```

| Status | When |
|--------|------|
| 409 | Path exists, path is a directory, an ancestor is a file, over capacity, version mismatch |
| 404 | No such file, directory or user |
| 422 | Malformed path (empty, `.` or `..` segments, over 1,024 characters), self-merge |

> "Paths go in the query or body, never in the route, because they contain slashes. And quota refusal is a 409, not 507 Insufficient Storage. Clients and proxies retry 5xx automatically, and retrying a quota refusal unchanged can never succeed."

---

## 🔁 Write Path (~7 min)

### Successful trace: alice creates `/home/alice/notes/today.md`, 2 KB

1. The gateway authenticates alice and forwards to the metadata service with her idempotency key.
2. The service looks up the namespace for `/home/alice` and routes to its shard.
3. In one transaction:
   - Insert the idempotency key. A conflict means this is a retry, so return the stored response.
   - Charge the quota: add 2 KB to alice's `used` only if the result stays within capacity. The update returns her remaining bytes and locks her user row.
   - Resolve `notes` under alice's root and lock it, then insert `today.md` under it. The unique index on (parent, name) refuses a duplicate.
   - Bump the namespace journal sequence, which stamps the new version.
4. Commit on the primary and its synchronous replica, then answer 201 with the remaining quota.
5. The change log carries the event to the aggregator, which updates directory totals within seconds, and to the cache, which drops the cached listing for `notes`.

### Failed trace: dmitri's 2 MB upload, 1 MB left

1. The client asks for an upload reservation of 2 MB.
2. The conditional quota update finds `used + 2 MB > capacity` and returns no row. A second read confirms dmitri exists, so the error is over-capacity with both amounts.
3. Nothing in the namespace was touched. Rollback releases the user lock, and the client gets 409 before uploading a single block.
4. The refusal counter for over-capacity ticks up. Product watches it as an upgrade signal.

> "The reservation is the key move. An upload takes minutes, so I can't check quota at the end, when the bytes are already in the block store. Reserving at the start makes the quota exact at every moment. An abandoned upload holds capacity until its reservation expires, and a sweeper releases it."

### Failed trace: two clients race on the same name

1. Alice's laptop creates the file `/home/alice/report`, while her phone creates `/home/alice/report/draft.md`, at the same moment.
2. Both charge alice's quota. The laptop's transaction gets the user row first, and the phone's waits on it.
3. The laptop locks `/home/alice` and inserts `report` as a file, then commits.
4. The phone gets the user row, locks `/home/alice`, and tries to use `report` as a directory. It finds a current file entry with that name under `/home/alice`, so it fails with "an ancestor is a file" and rolls back its quota charge.
5. The phone's client shows the conflict. Nothing was half-written, and alice's `used` counts only the laptop's file.

> "Notice that the quota row serializes these two, which is why the race is so tidy. Two different users racing on a shared folder serialize one level down, on the parent directory's row, with the same outcome."

### Merge as a job

Merging bob's old account into his new one usually crosses shards and can move millions of entries:

1. The API creates a merge job and returns 202 with its id. Resubmitting returns the same job.
2. The source namespace goes read-only, so the copy has a fixed target.
3. Workers copy entries to the target shard in batches of 1,000, keyed by source entry id, writing a checkpoint after each batch. A crashed worker resumes from the checkpoint, and a re-copied batch is a no-op.
4. One small transaction on the target's shard adds the source's capacity and used bytes, and flips ownership. The source account is deleted with its snapshots, and a redirect is left for old links.

Locally, merge is one transaction: lock both users sorted by id, reassign the files, move the counters and delete the source.

### Expiry and the largest-file query

**Expiry.** A file added with a time to live expires at exactly its creation time plus the TTL. A sweeper walks the expiry index and closes those versions, releasing the owner's bytes, but reads don't wait for it: every current-state query also filters on the expiry time. A file is invisible the instant it expires even when the sweeper is behind, and its bytes come back to the quota within one sweep.

**Largest N under a prefix.** Inside one namespace I keep an index on (namespace, size descending, path) and walk it until N entries match the prefix. That's fast when the prefix is a large share of the namespace and slow when it's a narrow folder, so the aggregator also maintains a small top-N list per directory. A prefix that spans namespaces, such as an admin query over everything, scatters to each shard for its top N and merges the results. Prefix means string prefix, not directory: `/a/b` matches `/a/bc.txt`. Directory size, by contrast, is directory-aware, and mixing the two up is a classic bug.

---

## 🔐 Concurrency and Idempotency (~3 min)

**Retries after a lost response.** Every write carries an idempotency key, stored in the same transaction as the write with the request hash and the response. A retry with the same key and body replays the response; with a different body it's a 422. Without this, a retried create would come back 409 path-exists and the client couldn't tell its own success from someone else's file. That's exactly what happens in the local build, which skips idempotency keys.

**Lost updates.** Resizes carry the entry version (If-Match), so two clients resizing from the same version can't silently overwrite each other.

**Failure between steps.** Single-entry operations are one transaction, so there is no "between". Merges and restores touch many rows and run as jobs with checkpoints; each batch is idempotent by entry id, and the final ownership flip is one small transaction.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Keeping "file or directory, never both" true under concurrent writes

**The decision.** Files and directories share one uniqueness constraint, and every write locks its ancestors from the root down.

**Why it works.** Suppose one client creates `/a/b` as a file while another creates `/a/b/c`. Creating `/a/b/c` needs a directory at `/a/b`; creating the file `/a/b` needs that same name. Because both kinds of entry share the unique key, whoever inserts second blocks on the first's uncommitted row, then sees it and fails. No application-level check can race, because the database arbitrates. Locally, 15 rounds of three conflicting creates never let more than two succeed, and an invariant query after the test finds no file below a file.

**Why the alternative fails.** "Check that the parent isn't a file, then insert" in application code has a window between the check and the insert. Two writers both pass the check, and the tree ends up with `/a/b` as a file and `/a/b/c` below it. Closing that window needs either SERIALIZABLE isolation, which aborts and retries a large share of transactions on a hot tree, or a lock, which is what the shared key gives us for free.

**The lock order is the subtle part.** My first version locked directories first and the user's quota row last for ordinary writes, but merges and restores locked users first. A test that mixed them produced about ten deadlocks per run, each costing PostgreSQL's one-second detection timeout. The fix was one global order: user rows (sorted by id when there are two), then ancestor directories from the root down, then the entry. Because anyone holding a descendant also holds its ancestors, top-down locking can't form a cycle. The same test now shows zero deadlocks.

**What I'm giving up.** One user's writes now run one at a time, because they all start on that user's row: about 565 creates a second locally, the same as a single writer. Normal users never notice; a bulk importer would. For them I'd batch creates per transaction, or give the importer a quota lease, a pre-reserved block of bytes settled periodically, so it doesn't touch the user row on every file.

### Deep dive 2: Making quotas exact

**The decision.** A conditional counter: add the delta to `used` only where `used + delta ≤ capacity`, inside the write's transaction, with a CHECK constraint behind it. Uploads reserve first.

**Why it works.** The conditional update is a single atomic statement. Thirty concurrent 10-byte writes against a 100-byte quota produce exactly ten successes and twenty over-capacity refusals; locally the race test asserts exactly that, then checks that `used` equals the sum of owned file sizes. The CHECK constraint means even a bug in application code can't commit an over-quota state.

**Why the alternatives fail.** Computing usage as a sum over the user's files under a lock is exact but O(files) per write: a power user with a million files would pay a million-row scan per upload. An eventually consistent counter, updated by the aggregator, is cheap but lets a burst of uploads overshoot before the count catches up. With a hard quota, that overshoot is a correctness bug, not a lag.

**What I'm giving up.** The counter is a second copy of a fact, so it can drift if any code path forgets it. I keep every file change behind one function per backend that also adjusts the counter, and a nightly job recomputes it for a sample of users and alerts on drift. The concurrency tests run that recomputation after every race.

### Deep dive 3: Backups and restore with copy-on-write

**The decision.** Versioned rows. A backup records a journal sequence number; a restore computes, for each of the user's paths, the version live at that sequence, and applies the difference.

**Why it works.** A snapshot costs one row instead of copying 2,000. Restore and point-in-time reads use the same mechanism, and so does undo for a single file. It's the time track of the coding question: each path keeps versions with validity intervals, and "state at time T" is the version whose interval contains T.

**Why the alternative fails at scale.** Copying rows is what I'd do in the coding version, and the local build does it. At 10M daily backups of 2,000 rows each, it's 230K row copies a second, permanently, which is more than the system's entire user write load.

**Restore semantics.** The world changed since the backup. If a backed-up path now holds another user's file, an unowned file, a directory of someone else's files, or sits below someone else's file, I skip it and report it, rather than failing the whole restore or overwriting. Failing lets one conflict block an account's recovery. Overwriting destroys someone else's data. Locally, each restored file runs in its own savepoint, so a skipped path rolls back only its own partial work, and the response lists every skipped path.

**What I'm giving up.** Version rows accumulate, so I need garbage collection of versions older than the 30-day retention, and every current-state query must filter to current versions. Restores of very large accounts become jobs with checkpoints rather than one transaction.

---

## 🛡️ Failure Handling and Access (~2 min)

| Failure | Behavior |
|---------|----------|
| Deadlock or serialization failure | Roll back and rerun the whole transaction with jittered backoff |
| Merge moved a file mid-operation | Lock-then-verify sees the new owner and reruns |
| Shard primary fails | Promote the synchronous replica; no committed write lost |
| Cache unavailable | Fall through to the shard; cached keys include the namespace version, so stale entries are never served after recovery |
| Aggregator behind | Totals lag; quotas, which never read them, are unaffected; alert on lag over 60 s |
| Restore path unavailable | Skip and report |

**Access.** Authorization is per namespace: owners and members of a shared namespace can write there, charging the namespace owner's quota. The cache stores entries but every read re-checks namespace membership, so a removed member can't keep reading from cache.

### Observability

| Signal | Why |
|--------|-----|
| Write latency by route, refusals by code | Over-capacity refusals are a product signal; placement conflicts spike when a client misbehaves |
| Transaction retries by operation | Should be near zero; a jump means a lock-order regression |
| Aggregator lag | Directory totals are only as fresh as this |
| Reservation count and age | Abandoned uploads holding capacity |
| Drift check | Nightly recompute of `used` and totals for a sample; any mismatch pages |

### Security

- **Untrusted paths stop at the API.** Segments of 1-255 characters with no `/` or NUL, no `.` or `..`, and at most 1,024 characters in total.
- **Unicode normalization (NFC)** before any comparison, so two visually identical names can't coexist. Where clients' file systems are case-insensitive, names are also compared case-folded within a directory, which avoids a sync client that can't represent both `Report` and `report`.
- **Admin-only bulk operations.** Merges and restores of other users' accounts require an admin role and are audit-logged with the job id.
- **Rate limits per user** at the gateway, with a separate, higher bucket for sync clients doing bulk listing.

---

## 📈 What Breaks First and How It Scales (~4 min)

I measured this on the local PostgreSQL build, with 20 concurrent writers creating files:

| Scenario | Creates per second |
|----------|-------------------|
| Separate top-level directories | ≈ 2,000 |
| One shared top-level directory | ≈ 600-770 |
| Shared directory three levels up | ≈ 560-660 |
| Separate directories, one user | ≈ 565 |

> "A shared ancestor turns twenty writers into roughly one. Every transaction updates that directory's running total and holds its lock until commit. That's why the production design takes directory totals out of the write path: in a team namespace, the root would be the throughput of the whole team."

**In order:**

1. **Synchronous directory totals near the root.** Fix: aggregate asynchronously from the change log.
2. **One shard's write rate.** Split very large namespaces by subtree.
3. **A single heavy uploader**, serialized on its user row. Batch creates, or use a quota lease.
4. **Huge directories.** Name-cursor pagination, never offsets.
5. **Read volume.** Cache keyed by namespace version, plus replicas for listings.
6. **Version growth.** Garbage-collect past retention.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Shard key | Namespace | User, path hash | Invariants are per tree; shared folders need several writers |
| Entry key | (parent_id, name) + entry id | Full path | Rename and move are one-row updates |
| File-or-directory rule | Shared unique key + top-down locks | Check then insert | No race window; no SERIALIZABLE retries |
| Quota | Conditional counter + reservations | Sum under lock; async counter | O(1) and exact; uploads reserve first |
| Directory totals | Async from change log | Synchronous | A shared ancestor caps writes at one writer |
| Backups | Copy-on-write versions | Row copies | One sequence number versus 230K row copies a second |
| Restore conflicts | Skip and report | Fail; overwrite | Never destroys others' data; never blocks recovery |
| Quota error | 409 | 507 | 5xx invites automatic retries |

---

## 📝 Wrap-up (~1 min)

> "Every requirement here is an invariant over a tree: no path is both kinds, no file sits below a file, no user exceeds capacity, no restore touches another user's data, and every total agrees with its files. I enforced each one at the narrowest place that can't race: a unique key, a conditional counter, a lock order, a savepoint. Then I moved everything that only needs to be approximately right, directory totals and largest-file indexes, out of the write path, with a measurement showing why it had to go."

### If I had more time

- Rename and move, including what happens to a directory's cached paths and its totals in the aggregator.
- Cross-device conflicts: two offline edits to one file become a "conflicted copy" rather than a lost update.
- Trash with retention, which is just another use of the version history.
- Per-namespace quota for team folders, charged to a billing owner rather than each writer.

### How the local implementation compares

The repository builds the coding version (`backend/src/fs/file-store.ts`, all four levels) and a PostgreSQL service over the same model. The service keys rows by full path in one global namespace, updates directory totals synchronously, copies rows for backups and runs merge as one transaction. It does implement the shared primary key for files and directories, the conditional quota counter with a CHECK constraint, the user-then-top-down lock order with deadlock retries, and savepoint-per-file restores that report skipped paths. Its race tests check every invariant after each run, and the benchmark above comes from it. Idempotency keys, reservations, sharding and the aggregator are described but not built.
