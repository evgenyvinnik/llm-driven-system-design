# Dropbox — Development with Claude

## Project Context

The interesting thing about a file sync service isn't storing bytes — object storage solves that. It's that the *same bytes* show up over and over: the same PDF attached in three folders, the same 500MB video re-uploaded after a one-line metadata edit, the same node_modules tree across every project. A naive design stores each copy, and storage cost grows linearly with upload volume regardless of how much unique content exists.

Content-addressed chunking is the fix. Split every file into chunks, hash each chunk with SHA-256, and make the hash the storage key. Now identical content is physically stored once no matter how many files reference it, and "which parts of this file do you already have?" becomes a set-membership query instead of a byte comparison. This one decision cascades into everything else in the system: it's why versions are cheap (a new version only stores the chunks that changed), why the `chunks` table needs reference counting (you can't delete a chunk just because one file that used it was deleted), and why the upload protocol is three round-trips instead of one.

The second problem is metadata. A file tree is a self-referencing hierarchy with move, rename, soft-delete, sharing, and per-user quota, all of which must stay consistent — you cannot have a file that exists in the tree but whose chunks were garbage-collected.

**Learning goals:** content-addressed storage and deduplication, chunk reference counting and its GC problem, snapshot-free versioning through shared chunk references, a self-referencing folder hierarchy in SQL with soft deletes, and multi-device sync notification through Redis pub/sub.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express + `ws` server** (`backend/src/index.ts`) | **3000** | Single process serving `/api/*` and the `/ws` sync channel. The WebSocket only pushes notifications, so it doesn't need its own tier |
| **PostgreSQL 16** | 5432 | The file tree is a self-referencing `files.parent_id` hierarchy with a partial unique index `(user_id, parent_id, name) WHERE deleted_at IS NULL` — enforcing "no duplicate names in a folder, unless deleted" needs a real relational engine |
| **MinIO** (S3-compatible) | 9000 / 9001 | Chunks are opaque blobs keyed by their SHA-256 hash in the `dropbox-chunks` bucket. Object storage, not the database, because a 4MB blob in a Postgres row is an anti-pattern and presigned URLs let clients eventually bypass the API entirely |
| **Valkey (Redis)** | 6379 | Three roles: session store (`setSession`/`getSession`), folder-listing cache, and pub/sub on `sync:<userId>` for cross-device notifications |

Storage is split by responsibility: `chunks` (hash → storage key + `reference_count`) is global and shared across all users; `file_chunks` (file → ordered chunk hashes) and `file_version_chunks` are the join tables that assemble bytes back into files. `backend/src/services/file/` is split into `upload.ts`, `download.ts`, `versioning.ts`, and `metadata.ts` behind an `index.ts` barrel; `sharingService.ts` handles both link shares and per-user folder shares. Frontend is React 19 + TanStack Router (file-based routes in `frontend/src/routes/`) + Zustand + Tailwind, with `react-dropzone` for drag-and-drop and `lucide-react` for icons.

## Key Design Decisions

### 1. Fixed 4MB chunks, not content-defined chunking

Every file is split at fixed 4MB boundaries (`CHUNK_SIZE` in `utils/chunking.ts`, env-overridable) and each chunk is SHA-256'd. The alternative — content-defined chunking via a rolling Rabin fingerprint, where boundaries are chosen at positions whose hash matches a pattern — is strictly better at deduplication and is what real Dropbox does. It's also considerably more code and requires tuning min/max/target chunk sizes.

The concrete failure mode of fixed chunks: insert a single byte at the start of a 100MB file and *every* boundary shifts by one, so all 25 chunks hash differently and the "delta" upload is 100MB. Content-defined chunking would resync boundaries after the insertion point and re-upload roughly one chunk. Fixed-size dedup therefore only wins on *identical* content — the same file uploaded twice, the same file shared between users, or an append-only file whose leading chunks are unchanged. For an interactive demo where the common case is genuinely duplicate files, that's the case that actually fires.

What we give up is real delta sync. This is the single biggest gap between this implementation and the product it models, and it's called out in the README rather than papered over.

### 2. Deduplication is negotiated *before* bytes move: hashes up, needed-list down

`POST /files/upload/init` takes the full ordered list of chunk hashes and returns `chunksNeeded` — only the hashes the server has never seen. The client then uploads just those, and `POST /files/upload/complete` assembles the file from the full hash list.

The obvious alternative is upload-then-dedup: send everything, hash server-side, discard duplicates. That saves storage but nothing else — a user re-uploading a 500MB file they already have still pushes 500MB over the wire and still waits. Worse, it puts the deduplication check *behind* the slowest part of the request, so the server can't tell the client "you're done" until the transfer completes. Negotiating up front turns a re-upload of known content into three small JSON round-trips.

The cost is a protocol that's harder to use and a trust boundary: the server accepts the client's claim that hash H corresponds to chunk data it isn't sending. `uploadFileChunk` re-hashes every chunk it *does* receive and rejects on mismatch, so a client can't poison the store with wrong content under a hash — but it *can* claim a file is composed of chunks belonging to another user, since `chunks` is a global namespace with no ownership check. That's a real confidentiality hole inherited from global dedup, and every content-addressed store has some version of it.

### 3. Versions store chunk *references*, not copies

`completeUpload` on an existing filename creates a `file_versions` row and copies the *old* `file_chunks` rows into `file_version_chunks`, then repoints `file_chunks` at the new content. No bytes are copied.

Storing full copies per version is the naive approach and it's catastrophic for the common case: editing one paragraph of a 50MB document ten times costs 500MB with full copies and ~50MB + 9×4MB here, because only the chunks containing the edit differ. The trade-off is that "delete this version" is no longer a simple `DELETE` — it has to decrement `reference_count` on every chunk that version pointed at, and only chunks that reach zero can be removed from MinIO. Versions, live files, and other users' files all share the same physical chunk, so no single owner can decide it's garbage.

### 4. Reference counting over mark-and-sweep for chunk lifetime

`chunks.reference_count` increments on every chunk upload (including a hit on an existing chunk, via `ON CONFLICT (hash) DO UPDATE SET reference_count = reference_count + 1`). The alternative is periodic mark-and-sweep: walk every `file_chunks` and `file_version_chunks` row, build the live set, delete everything else. That's exact and self-healing but it's O(all metadata) per sweep, and it races with in-flight uploads — a chunk uploaded but not yet linked to a file looks like garbage.

Reference counting is O(1) per operation and always knows the answer, but it is only correct if *every* path that adds or drops a reference remembers to adjust it. That's the honest weakness here: soft-deleting a file does not decrement, so counts drift upward over time. Drifting up is the safe direction — we leak storage rather than delete live data — but it means the counts are a lower bound on liveness, not a truth, and a mark-and-sweep reconciliation job is the missing piece.

### 5. Sync notifications go through Redis pub/sub, not direct WebSocket sends

When an upload completes, `publishSync(userId, event)` publishes to the Redis channel `sync:<userId>`; every backend process `psubscribe`s to `sync:*` and forwards to whichever of that user's WebSocket connections it happens to hold (`userConnections` map in `index.ts`).

Writing directly to the WebSocket set would be simpler and works perfectly with one process. It breaks the moment you run `dev:server1/2/3` (ports 3001–3003): the user's laptop is connected to server1, their phone to server2, and an upload handled by server1 has no way to reach the phone. The process holding the connection and the process handling the write are unrelated, so notification has to go through a shared bus. Redis pub/sub is the right weight here precisely *because* it's fire-and-forget — a dropped sync notification means a client's folder view is briefly stale, and the client re-fetches on the next navigation anyway. That would be an unacceptable guarantee for the data itself; it's fine for a hint that data changed.

## Current State

Runs end to end on backend 3000 + Vite 5173. Working: email/password auth with bcrypt hashes and Redis-backed session tokens, the full file tree (create folder, rename, move, soft delete) with breadcrumb navigation, chunked upload with hash-negotiated dedup, file download reassembled from chunks, version history with restore, share links carrying optional password / expiry / download-count limits, per-user folder shares with view/edit access levels and a "Shared with me" view, per-user quota enforcement against `users.quota_bytes`, live sync notifications over `/ws`, an admin dashboard (system stats, user list, quota editing, activity feed, storage breakdown, a maintenance cleanup action), Prometheus metrics, Pino structured logging, `express-rate-limit`, and Cockatiel circuit breakers wrapping the MinIO calls in `utils/storage.ts`.

Seeded logins: **`admin@dropbox.local` / `password123`** (admin role, 10GB quota) and **`demo@dropbox.local` / `password123`** (user role, 2GB quota). Both rows share one bcrypt hash; the inline comments in `backend/db-seed/seed.sql` claim `admin123` and `demo123` and are **wrong** — verified by `bcrypt.compare` against the stored hash, only `password123` matches. The README has it right.

**Worth knowing about the upload path:** the backend exposes both the three-step chunked protocol (`/files/upload/init` → `/upload/chunk` → `/upload/complete`) and a single-shot convenience endpoint (`POST /files/upload`) that buffers the whole file through multer and then runs the same chunking/dedup logic server-side. The browser UI uses the *single-shot* endpoint, because computing SHA-256 over 4MB slices in the browser before uploading is work the demo doesn't need. So deduplication really does happen and really does save storage — but the bandwidth savings the protocol is designed for are only realized by an API client that drives the three-step flow. A desktop sync client would use the chunked path; there isn't one.

Also simplified or absent: no desktop sync client or filesystem watcher, no delta sync, no conflict resolution (concurrent edits to the same file are last-write-wins, with the loser recoverable only through version history), no end-to-end encryption, no chunk garbage collector, and `storage.ts` can generate presigned upload/download URLs but nothing in the request path uses them — all chunk bytes still flow through the API process.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The old file was misleading in both directions — it listed "Add monitoring with Prometheus + Grafana", "Optimize database queries with proper indexing", and "Add caching layer for folder listings" under a Phase 3 marked *Not started*, while `shared/metrics.ts`, eight `CREATE INDEX` statements in `init.sql`, and `getCache`/`deleteCache` on the `folder:<userId>:<parentId>` key were all already implemented. It also claimed real-time sync was done without mentioning that it requires Redis pub/sub to work across instances.
- **Seed password comments are wrong (found 2026-07, not yet fixed):** `db-seed/seed.sql` says `password: admin123` and `password: demo123`, but both users carry the identical hash `$2b$10$BdLsE...`, which `bcrypt.compare` confirms is `password123`. Anyone trusting the SQL comment over the README cannot log in. The comments should be corrected; the hash itself is fine.
- **Upload split into modules:** `services/fileService.ts` was decomposed into `services/file/{upload,download,versioning,metadata}.ts` behind a barrel `index.ts` with a shared `types.ts` re-export, because the single file had grown past the point where the version-copy logic inside `completeUpload`'s transaction was reviewable.
- **Version chunk copy moved inside the transaction:** creating a `file_versions` row, copying `file_chunks` → `file_version_chunks`, deleting the old `file_chunks`, and repointing the file must be atomic. A failure partway through previously left a file whose chunk list had been deleted but whose new chunks weren't linked — an unreadable file. It now all runs inside `transaction()`.
- **Chunk integrity check on upload:** `uploadFileChunk` re-hashes received data and throws on mismatch rather than trusting the client-supplied hash, so a corrupted transfer can't silently take over a content address that other files reference.
- **MinIO calls wrapped in circuit breakers:** `utils/storage.ts` uses Cockatiel policies, so a MinIO outage fails fast with a clear error instead of every request hanging on the S3 client's default retry behavior.
- **Port:** unlike several projects in this repo, no `PORT=` pin was needed — `index.ts` defaults to 3000 and the Vite proxy targets 3000 for both `/api` and `/ws`, so they already agreed.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide Postgres + Redis + MinIO, so it failed on every PR without signalling a real defect.

## Open Questions

1. `reference_count` only ever goes up — soft deletes don't decrement it. Should the fix be decrementing on delete (fast, but wrong if a soft-deleted file is restored), or a periodic reconciliation job that recomputes counts from `file_chunks` ∪ `file_version_chunks` and treats the column as a cache?
2. Chunks live in one global namespace keyed only by hash. Any user who can guess or obtain a hash can claim a file composed of it. Is per-user dedup scoping (losing most of the savings) the right answer, or convergent encryption, or is this acceptable for content whose hash is already a secret?
3. The browser uses the single-shot upload endpoint, so a 2GB file is buffered entirely in the API process's memory by multer. What's the right forcing function to move the UI onto the chunked path — a file-size threshold, or just always chunking and accepting the client-side hashing cost?
4. Folder shares are per-folder rows in `folder_shares`, but access checks need to answer "is this file inside *any* folder shared with me?", which means walking `parent_id` upward on every access. At what tree depth does that walk justify materializing a path column or a closure table?

## Resources

- [Dropbox: Streaming file synchronization](https://dropbox.tech/infrastructure/streaming-file-synchronization) — the delta-sync design this project deliberately doesn't implement
- [Rabin fingerprint](https://en.wikipedia.org/wiki/Rabin_fingerprint) — the basis for content-defined chunking, decision 1's rejected alternative
- [rsync algorithm technical report](https://rsync.samba.org/tech_report/) — rolling checksums and why boundary alignment matters
- [MinIO documentation](https://min.io/docs/minio/linux/index.html)
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html) — how `UNIQUE(user_id, parent_id, name) WHERE deleted_at IS NULL` coexists with soft deletes
