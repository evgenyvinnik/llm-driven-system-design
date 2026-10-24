# File System — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · Requirements → Architecture → Data model → API → End-to-end flows → Deep dives → Scale*

> "This is the namespace of a cloud file store, end to end: a web app for browsing and editing files and for admin work on users, and the service behind it that keeps the tree correct. Contents go to a block store I'll treat as solved. What's left is a set of rules, and each needs one place that enforces it and one place that explains it. A path is a file or a directory, never both. Nobody exceeds their quota. A restore never touches someone else's file. Directory totals can be a minute old, but quotas can't. I'll design each rule's enforcement on the server and its explanation in the UI together, because a refusal the user can't understand is half a feature."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Hard quotas, lagging totals, restore semantics |
| Architecture | ~5 min | Namespaces as the shard unit; the web app as a thin, honest client |
| Data model and API | ~7 min | Entries by parent and name, a quota counter, versioned rows; a typed error contract |
| End-to-end flows | ~8 min | A create, an over-quota refusal, and a restore with skipped paths |
| Deep dives | ~14 min | Invariants under concurrency, restore across the stack, directory totals |
| Scale and wrap-up | ~6 min | What breaks first, with measurements |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| File contents in scope? | Blob storage versus namespace | No; a block service stores bytes |
| Hard or soft quota? | Exactness under concurrency | Hard: no commit exceeds capacity |
| File and directory with one name? | Object store versus file system | Never; nothing below a file either |
| Exact directory sizes? | Synchronous versus async aggregates | No, a minute of lag is fine. Quotas must be exact |
| Restore conflicts? | Overwrite, fail or skip | Skip and list the skipped paths |
| Biggest directory? | Pagination and virtualization | 100K entries |
| Who are the users? | Screens and permissions | End users with home folders; admins who manage quotas, merges and restores |

### Functional requirements

1. Browse directories by click, breadcrumb and URL; list children with sizes, file counts and owners.
2. Create, resize and delete files. Directories are implicit and appear and disappear with their files.
3. See a directory's total size and the largest files under it.
4. Users have capacities; owned files count against them.
5. Admins add users, merge accounts, back up and restore, and see what a restore skipped.
6. Files can expire, and any path's size can be read as of a past time.

**Out of scope:** file contents and desktop sync, sharing permissions beyond namespace membership, and search.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Metadata write | p99 < 50 ms server-side; a definite outcome in the UI in < 200 ms |
| Cached directory navigation | < 100 ms to content |
| Quota | Exact and hard |
| Directory totals | Up to 60 s stale, labeled as such |
| Big directories | 100K entries scroll at 60 fps |
| Durability | No committed write lost |

### Capacity sketch

| Quantity | Estimate | What it decides |
|----------|----------|-----------------|
| Entries | ≈ 115B rows (10M daily actives of 50M users, 2,000 files each, plus directories) | Sharding: ≈ 70 shards of ≈ 1 TB |
| Writes | ≈ 25K/s peak | Totals can't be updated synchronously (6 ancestors each) |
| Reads | ≈ 500K/s peak | A stat and listing cache |
| Daily backups as copies | ≈ 230K row copies/s | Copy-on-write versions instead |
| Typical listing | < 10 KB | One request |
| Largest listing | ≈ 10 MB (100K entries) | Cursor pages and a virtualized table |

Locally the demo has 5 users and 25 files in 4 top-level folders, and the measured ceiling is about 2,000 creates a second, which is plenty for the build and useful for the scaling discussion later.

---

## 🏗️ Architecture (~5 min)

```
┌──────────────────────────────┐
│ Web app (React SPA)          │  URL holds the directory; listing cache by path;
│ Files · Users (admin)        │  confirmed writes; virtualized tables
└──────────────┬───────────────┘
               │ HTTPS (JSON, typed errors, idempotency keys)
┌──────────────▼───────────────┐      ┌──────────────────────────┐
│ API gateway                  │      │ Block service + object    │
│ auth, rate limits            │      │ storage (contents)        │
└──────────────┬───────────────┘      └─────────────▲────────────┘
               │                                    │ commit after upload
┌──────────────▼───────────────┐      ┌─────────────┴────────────┐
│ Metadata service (stateless) │─────▶│ Metadata shards           │
│ placement rules, quotas,     │◀─────│ by namespace; primary +   │
│ merge and restore jobs       │      │ synchronous replica       │
└──────┬───────────────────────┘      └─────────────┬────────────┘
       │                                            │ change log
┌──────▼──────┐                          ┌──────────▼───────────┐
│ Valkey      │                          │ Aggregator: directory │
│ stat/list   │                          │ totals, largest-N     │
└─────────────┘                          └──────────────────────┘
```

**Server.** A namespace (a user's home tree, or a shared folder) lives on one shard, so a write's placement check, quota charge and entry insert are one local transaction. Directory totals and largest-file indexes are derived from the change log by an aggregator.

**Client.** Two routes: the file browser, with the directory in a `?path=` search parameter, and the admin users page. The client enforces nothing. It shows what the server decided, as precisely as the server can say it.

> "I keep the client thin on purpose. Every rule here depends on other users' concurrent actions: the name you want was just taken, the quota was just used by another upload. The client can't know those things, so any client-side enforcement would be a guess, and showing a guess as fact is worse than a 40 ms wait."

---

## 💾 Data Model (~4 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| entries | namespace_id, entry_id, parent_id, name, kind, size, owner_id, expires_at, valid_from_seq, valid_to_seq | Unique (namespace, parent, name) among current rows; one row per version |
| users | id, capacity, used | `used` is a counter, guarded by `used ≤ capacity` |
| reservations | user_id, bytes, expires_at | In-flight uploads count toward `used` |
| snapshots | user_id, seq, taken_at | A backup is a journal sequence number |
| idempotency_keys | key, request_hash, response | Written in the same transaction as the write |

**Parent and name, not full paths.** Full-path keys are what I'd use in the four-level coding version, and the local build uses them. They make the file-or-directory rule a primary-key property and prefix queries a range scan, but renaming a folder would rewrite every path below it. With (parent, name), a move is one row, and "nothing below a file" holds because a parent must be a directory.

**Versioned rows.** A change closes the current version and opens another. Backups, restores, point-in-time reads and trash all fall out of that one structure.

---

## 🔌 API Design (~3 min)

```
GET    /api/v1/fs/list?path=…&cursor=…    → { bytes, fileCount, entries[], nextCursor }
GET    /api/v1/fs/largest?prefix=…&n=8    → { files: [{ path, size }] }
POST   /api/v1/fs/files                   → 201 { remaining }             Idempotency-Key
PATCH  /api/v1/fs/files?path=…            → { previous }                  If-Match
DELETE /api/v1/fs/files?path=…            → { size }
GET    /api/v1/users                      → { users: [{ id, capacity, used, fileCount, backup }] }
POST   /api/v1/users/:id/merge            → { remaining }  (a job at scale)
POST   /api/v1/users/:id/restore          → { restored, skipped: [path] }
```

**The error contract is shared by both halves.** Errors look like `{ code, message }`. The server's message is already human-readable, with sizes formatted ("needs 2.0 MB more but has 1023 KB left"), so the UI shows it verbatim and branches on the code only to offer a recovery action.

| Status | Codes | UI recovery |
|--------|-------|-------------|
| 409 | Path exists, path is a directory, an ancestor is a file | Rename, open the existing item, or edit the path |
| 409 | Over capacity | Delete something, change owner, or ask an admin |
| 404 | File or directory gone | Refresh; move up to the nearest existing folder |
| 422 | Malformed path, self-merge | Inline field error |

> "Quota refusal is a 409, not 507 Insufficient Storage. Clients and proxies retry 5xx on their own, and a quota refusal retried unchanged never succeeds."

---

## 🔁 End-to-End Flows (~8 min)

### Successful trace: alice creates `/home/alice/notes/today.md`

1. **UI.** Alice is at `/?path=/home/alice`; the owner picker already says "alice" because it's her home folder. She enters `notes/today.md` and 2 KB, and the button shows a pending state. The client generates an idempotency key for this action.
2. **API.** The service routes to alice's namespace shard and opens a transaction. It records the idempotency key, then charges the quota: add 2 KB to alice's `used` only if it stays within capacity, which returns her remaining bytes and locks her user row.
3. **Namespace.** It locks `notes` under alice's root, from the top down, and inserts `today.md`. The unique key refuses a duplicate name.
4. **Commit** on the primary and its synchronous replica; 201 with the remaining quota.
5. **UI.** The client invalidates the cached listings of `/home/alice` and every ancestor, since their totals changed. It refetches what's on screen and reloads users so the quota bar moves. The toast reads "Created /home/alice/notes/today.md. alice has 39.7 MB left".
6. **Downstream.** The change log feeds the aggregator, which updates directory totals in seconds.

### Failed trace: dmitri's upload doesn't fit

1. **UI.** Dmitri picks a 2 MB file. The upload manager asks for a quota reservation before reading a byte.
2. **API.** The conditional quota update returns nothing; dmitri exists, so it's over capacity. Rollback; nothing in the namespace was touched.
3. **UI.** 409 with "dmitri needs 2.0 MB more but has 1023 KB left". The form keeps his selection and links to his largest files, since deleting one is the likeliest fix.

### Restore trace: alice's backup, with a conflict

1. **UI.** The admin clicks Restore on alice's row; the row asks "Replace alice's files with the backup?" and the admin confirms.
2. **API.** One job (one transaction locally) locks alice, then every folder it will touch, top-down. It deletes alice's current files, then re-creates each backed-up file in its own savepoint.
3. **Conflict.** `/shared/roadmap.md` was alice's when she backed up, but she deleted it and bob created his own. Re-creating it fails the uniqueness check, so only that savepoint rolls back.
4. **Response:** `{ restored: 7, skipped: ["/shared/roadmap.md"] }`.
5. **UI.** A banner reads "Restored 7 files for alice, skipped 1" and lists the path with the reason: someone else holds it now.

### Merge trace: folding carol's archive account into carol

1. **UI.** The admin picks source `carol-archive` ("deleted") and target `carol` ("keeps everything"). In production the form would also preview what moves (2 files, 2.0 MB used, 4 MB of capacity); the local form doesn't yet.
2. **API.** Locally, one transaction locks both users in id order, reassigns the files, adds capacity and usage to carol and deletes the source with its backup. At scale this crosses shards, so it becomes a job: the source goes read-only, entries are copied in idempotent batches with checkpoints, and a final small transaction flips ownership.
3. **UI.** "Merged carol-archive into carol. carol has 13.6 MB left", and the users table reloads. At scale the button returns a job id, and the row shows progress until the job finishes.

### Expiry: a file with a time to live

The file is stored with an expiry time. Every current-state read filters on it, so the file disappears from listings, totals and the owner's quota the instant it expires, even if the sweeper that closes its version is behind. The UI shows an "expires in 3 h" chip on such files and a toast if one vanishes while on screen. History keeps the expired version, so "view this folder as of yesterday" still shows it.

---

## 🖥️ Client Design in Brief (~3 min)

| Concern | Decision |
|---------|----------|
| Current directory | URL search parameter, so back, refresh and deep links work |
| Listings | Cache keyed by path; stale-while-revalidate; prefetch on hover |
| After a write | Invalidate the directory and all its ancestors; reload users |
| Creates, resizes | Confirmed, not optimistic; refusals depend on others' concurrent writes |
| Deletes | Inline confirm today; optimistic with Undo once trash exists |
| Big directories | Server cursor pages of 1,000; virtualized rows |
| Vanished folders | Deleting a folder's last file deletes the folder; move up to the nearest one that still exists |
| Admin actions | Inline two-step confirms that name the user; restore lists skipped paths |

> "The one piece of client state I care most about is the cache invalidation after a write. Totals live on every ancestor, so a write deep in a tree changes numbers all the way up. If I invalidated only the current folder, the breadcrumb one level up would show a stale size the moment the user clicked it."

```
 write lands in /home/alice/photos
        │
        ├─ invalidate /home/alice/photos, /home/alice, /home, /   (entries or totals changed)
        ├─ keep       /home/bob, /shared, …                       (unaffected)
        ├─ refetch    only what's on screen; the rest on next visit
        └─ reload     users store                                 (quota changed)
```

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: One invariant, enforced in one place, explained in another

**The decision.** The file-or-directory rule and the quota are enforced only in the database transaction: a uniqueness constraint shared by files and directories, a conditional quota counter, and one lock order. The UI enforces neither; it explains the server's decision.

```
 laptop: create file /home/alice/report      phone: create /home/alice/report/draft.md
   │                                            │
   ├─ charge alice's quota (locks alice) ──┐    ├─ charge alice's quota ── waits on alice
   ├─ lock /home/alice                     │    │
   ├─ insert "report" as a file            │    │
   ├─ COMMIT ──────────────────────────────┘    ├─ (alice released) charge succeeds
   ▼                                            ├─ lock /home/alice
  201 Created                                   ├─ "report" is a file, can't be a parent
                                                ├─ ROLLBACK (quota charge undone)
                                                ▼
                                               409 "report is a file"
```

**Why it works.** Take two devices of alice's racing: the laptop creates the file `/home/alice/report` while the phone creates `/home/alice/report/draft.md`. Both start by charging alice's quota, so they serialize on her user row. The laptop inserts `report` as a file and commits. The phone then finds a file where it needs a directory, rolls back, quota charge included, and gets "report is a file, so nothing can go inside it". With users locked first and directories locked top-down, two operations can't wait on each other in a cycle.

**Why the alternatives fail.** A client-side check ("is there a file called report?") is stale the moment it returns. A server-side check-then-insert in application code has the same race window between the check and the insert. Closing it needs SERIALIZABLE isolation, which aborts and retries heavily on a busy tree, or a lock, which the shared constraint gives for free. On quotas, summing a user's files under a lock is exact but costs O(files) per write, and an asynchronous counter lets a burst of uploads overshoot.

**Evidence from the build.** My first version locked directories before the user on ordinary writes but users first in merges and restores. A test mixing them hit about ten deadlocks per run, each costing PostgreSQL's one-second detection timeout. One global order (users, then directories top-down, then the file) took that to zero.

**What I'm giving up.** One user's writes run one at a time, about 565 creates a second locally, the same as a single writer. Bulk importers get batched creates or a quota lease.

### Deep dive 2: Restore, from versions on disk to a list on screen

**The decision.** On the server, copy-on-write versions: a backup is a journal sequence number, and a restore applies, for each of the user's paths, the version live at that sequence. In the UI, a restore is confirmed inline, and its result lists every skipped path.

**Why it works.** A backup costs one row rather than a copy of every entry, so daily backups for 10M users cost 10M rows a day instead of 230K row copies a second. The same versions answer "what size was this at 3 p.m." and power trash. Conflicts get a defined policy: skip any path that is now someone else's, or is blocked by someone else's file, and report it. In the UI, that list is the admin's to-do list.

**Why the alternatives fail.** Copying rows per backup works for the coding version and the local build, and becomes the system's largest write load at scale. On conflicts, overwriting destroys another user's data, and failing the whole restore lets one conflict block an account's recovery. A UI that shows only "restored 7 of 8" leaves the admin hunting for the missing one.

**What I'm giving up.** Old versions must be garbage-collected after retention, every current-state query filters to current rows, and very large restores become jobs with progress in the UI rather than a single request.

### Deep dive 3: Directory totals: exact and slow, or fresh enough and fast

**The decision.** Locally, directory totals update in the write transaction. In production, an aggregator maintains them from the change log, and the UI labels them "about" when they come from there.

**Why exact totals fail at scale. I measured it.** With 20 concurrent writers in separate top-level directories, the local PostgreSQL build does about 2,000 creates a second. Put the same writers under one shared `/home` and it drops to 600-770, close to a single writer, because every transaction updates `/home`'s running total and holds that row's lock until commit. In a team namespace, the root's row would be the whole team's write throughput.

**Why the async version works.** Totals feed listings and "what's using my space", where a minute of lag is invisible. Quotas, which must be exact, never read them; they use the per-user counter. The UI shows the age of a total when it's over a minute old, and invalidates its own cached ancestors after its own writes, so a user never sees their own write missing from a total they just caused to change.

**What I'm giving up.** A total can briefly disagree with the sum of the listed children, which is surprising if you add them up. The UI's "about" label exists for that.

---

## 🔐 Idempotency and Retries (~2 min)

- **Client.** Each user action gets an idempotency key when it's initiated, and a network retry reuses it. A second deliberate click is a new action.
- **Server.** The key, request hash and response are written in the same transaction as the change. A retry replays the stored response, while a reused key with a different body gets 422.
- **Without it,** which is how the local build works, a retried create returns "path exists" for the user's own file, a retried delete returns 404, and the UI can't tell success from conflict.
- **Resizes** carry the entry's version (If-Match), so two people resizing from the same version can't silently overwrite each other.

## 🛡️ Failures, Access and Observability (~3 min)

| Failure | Server | UI |
|---------|--------|----|
| Deadlock or serialization failure | Roll back and rerun the transaction with jittered backoff | Nothing visible beyond a few ms |
| A merge moved a file mid-operation | Lock-then-verify sees the new owner and reruns | Nothing visible |
| Shard primary fails | Promote the synchronous replica; no committed write lost | Retries reuse the idempotency key |
| Aggregator lag | Totals age; quotas unaffected | Shows the total's age past a minute |
| Folder vanished while viewed | Listing returns "not a directory" | Moves to the nearest existing folder with a toast |
| Network drop mid-write | Commit may or may not have happened | Retry with the same key; the server replays |

**Access.** Authorization is per namespace. Members of a shared folder can write there, charged to the folder owner's quota, and the server re-checks membership on every read, cache or not. The client keys its listing cache by user and clears it on sign-out. A 404 for a path drops every cached listing under that path, so a revoked member's tab stops showing the folder.

**Observability.** Track write latency by route, refusals by code (over-capacity is a product signal), transaction retries (near zero unless a lock-order regression ships), aggregator lag, and a nightly drift check that recomputes `used` and totals for a sample. On the client, measure navigation timing and error toasts by code.

---

## 🧩 The Coding Version Behind This (~2 min)

This question often follows a four-level coding exercise on the same model. The data-model lesson carries over directly:

| Coding level | Production counterpart |
|--------------|------------------------|
| Files and the placement rules | Shared uniqueness constraint and top-down locks |
| List, directory size, largest under a prefix | Indexes per namespace plus the aggregator |
| Users, quotas, merges | Conditional counter; merge as a resumable job |
| Backup and restore, or TTL and history | Versioned rows; an expiry index read by every query |

The common thread: keep one record per file, and change every derived structure in one place. In the coding version that's three private methods; in the service, it's the write transaction for anything exact and the change log for anything that may lag.

## 🧪 Testing Across the Stack (~1 min)

- **Conformance.** The four-level test suites run against both the in-memory answer and the SQL service, so the two can't drift apart on semantics.
- **Races.** Many writers on one path, file-versus-directory conflicts, one quota, and merges and restores mixed with updates. Each test then checks every invariant with SQL: totals equal their files, `used` equals owned bytes, and no file sits below a file.
- **API.** Every error code maps to its status, and a restore reports exactly the paths it skipped.
- **End to end.** Playwright drives navigation, an over-quota create showing the server's message, and a restore banner listing the skipped path, against seeded data, so the scenario is deterministic.

---

## 📈 What Breaks First (~3 min)

| Scenario (20 concurrent writers, local PostgreSQL) | Creates per second |
|-----------------------------------------------------|-------------------|
| Separate top-level directories | ≈ 2,000 |
| One shared top-level directory | ≈ 600-770 |
| Separate directories, all one user | ≈ 565 |

1. **Synchronous totals near the root.** Move them to the aggregator.
2. **One shard's write rate.** Split large namespaces by subtree.
3. **A single heavy uploader**, serialized on its user row. Batch, or use a quota lease.
4. **Client: huge directories and invalidation storms.** Virtualize, page by cursor, and coalesce change events per path.
5. **Read volume.** Cache keyed by namespace version; replicas for listings.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Rule enforcement | Database transaction only | Client checks too | Rules depend on concurrent writers the client can't see |
| Entry key | (parent, name) + id | Full path | Moves are one row |
| File-or-directory | Shared unique key + top-down locks | Check then insert | No race window |
| Quota | Conditional counter + upload reservations | Sum under lock; async counter | O(1) and exact |
| Directory totals | Async, labeled "about" | Synchronous | A shared ancestor caps writes at one writer |
| Backups | Versioned rows | Row copies | One sequence number per backup |
| Restore conflicts | Skip and list | Fail; overwrite | Recovery proceeds; nobody else's data lost |
| Client writes | Confirmed | Optimistic | Refusals are common and only the server can judge |
| Current directory | URL | Global store | Back, refresh and links work |

---

## 📝 Wrap-up (~1 min)

> "Each rule here has one enforcer and one explainer. The database enforces placement and quotas inside the write transaction, with a lock order that can't deadlock. The UI explains each refusal precisely enough that the next step is obvious. Restore is the clearest example: versions on the server make it cheap, a skip-and-report policy makes it safe, and a list of skipped paths makes it actionable. Directory totals are the one thing I deliberately let lag, and I measured why."

### If I had more time

- Rename and move, end to end: one row on the server, an optimistic move with a clear revert in the UI.
- A change feed over SSE for shared folders, with coalesced invalidation in the client.
- Trash and per-file version history in the UI, both from the existing version rows.
- Upload reservations with resumable block uploads and a tray that survives navigation.
- Team folders with their own quota, charged to a billing owner rather than each writer.
- A "what's using my space" view per user, built on the largest-files query and the aggregator's totals.

### How the local implementation compares

The repository builds both halves. It has the four-level coding answer (`backend/src/fs/file-store.ts`), a PostgreSQL service over the same model, and a React app with the two routes described here. The service keys rows by full path in one namespace, updates totals synchronously, copies rows for backups and runs merges in one transaction. It implements the shared constraint, the conditional quota counter with a CHECK constraint, the user-then-top-down lock order with deadlock retries, savepoint-per-file restores and the typed error contract. Its race tests check every invariant after each run, and its benchmark produced the table above. The client has URL-held directories, confirmed writes showing the server's messages, inline confirms, the skipped-path banner and nearest-folder recovery. It refetches on each visit rather than caching listings, and its demo directories are small enough not to need virtualization. Idempotency keys, upload reservations, sharding and the aggregator are designed here but not built.
