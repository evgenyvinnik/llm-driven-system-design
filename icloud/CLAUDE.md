# iCloud Sync — Development with Claude

## Project Context

File sync looks like a storage problem and is actually a **causality** problem. When a laptop and a phone both hand the server a version of the same file, the server has to answer a question timestamps cannot: did one of these edits *know about* the other? A wall-clock comparison says the newer one wins, but the phone's clock may be skewed, and — more importantly — "later" and "informed by" are different things. Two edits made simultaneously on two offline devices are both "latest"; silently keeping one destroys the other's work with no trace.

So the sync engine here tracks causality explicitly with **version vectors**: each file carries a map of `deviceId → sequence`, and comparing two vectors yields four outcomes, not two. If every component of A is ≥ B's, A descends from B and can be fast-forwarded. If some components are higher on each side, neither knows about the other — that's a genuine concurrent edit, and the correct move is to surface it as a conflict rather than pick a winner. That's `compareVersions` / `mergeVersions` in `backend/src/services/sync.ts`, and it's the heart of the project.

The second theme is transfer cost. Re-uploading a 50MB file because someone changed one paragraph is intolerable on a phone's data plan, so files are split into 4MB **content-addressed chunks** keyed by SHA-256. A modified file re-uploads only the chunks whose hashes changed, and — because the address *is* the content hash — identical chunks across different files and different users are stored exactly once, with a reference count.

**Learning goals:** version vectors and conflict detection that distinguishes concurrent from causal, content-addressed chunking with cross-user deduplication, delta sync, and pushing change notifications to other devices over WebSocket.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`, port **3001**) | `npm run dev` (`PORT=3001 tsx watch`) | REST and `ws` share one HTTP server; `dev:server2/3` on 3002/3003 |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | Metadata and causality: `files` (with `version_vector` JSONB), `file_chunks`, `chunk_store`, `file_versions`, `sync_operations`, `devices`, `photos`, `albums`, `album_photos`, `album_shares`, `device_photos`, `sessions` |
| **MinIO** (9000, console 9001) | `docker-compose.yml` + `minio-init` | Three buckets created at startup: `icloud-chunks`, `icloud-photos`, `icloud-thumbnails`. S3-compatible, which is what the real thing is |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Sessions and cache (`shared/cache.ts`) |

`backend/src/services/chunks.ts` owns content-addressed storage: split at 4MB, SHA-256 each chunk, store at `chunks/<first-2-hex>/<full-hash>`, and either upload-and-insert or bump `reference_count` on a dedup hit. `services/sync.ts` owns the version-vector comparison and the create/update/delete apply paths. `services/websocket.ts` broadcasts changes to a user's other devices — `broadcastToUser(userId, msg, excludeDeviceId)` deliberately skips the originating device, since it already knows. MinIO calls go through opossum breakers in `shared/circuitBreaker.ts` (`StorageCircuitBreakers`); `sync.ts`'s push and conflict-resolution endpoints are wrapped in `withIdempotency`.

Photos take a separate path from files: `routes/photos.ts` uses **sharp** to generate a 200×200 cover-fit thumbnail and a 1024×1024 inside-fit preview at upload time, storing three derivatives per photo and serving them from distinct endpoints.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, with `DrivePage` (file browser with drag-and-drop upload) and `PhotosPage` (grid + viewer). `components/photos/PhotoGrid.tsx` uses `@tanstack/react-virtual` with **row-based** virtualization. The admin dashboard has Overview / Users / Operations / **Conflicts** tabs. Vite proxies `/api` and `/ws` → `localhost:3001`.

## Key Design Decisions

### 1. Version vectors, not last-write-wins timestamps
`compareVersions` returns `local-newer`, `server-newer`, `equal`, or `conflict` by checking whether each side has any component strictly greater than the other's.

Last-write-wins fails in two distinct ways here, and only one is about clocks. The clock problem is real — a phone with 30 seconds of skew silently overwrites a laptop edit made after it — but the deeper problem is that LWW *cannot represent* the situation where two devices edited independently. It has no vocabulary for "these are siblings"; it must pick one, and the other's changes vanish with no record that they existed. For a file sync product that's the single worst possible bug: silent data loss that the user discovers weeks later. Version vectors make the concurrent case a *first-class outcome*, so the system can create a conflict copy and let a human decide.

The costs are concrete. The vector grows with the number of devices that have ever touched a file and is never pruned, so a user cycling through devices accumulates dead entries forever. And a conflict must be surfaced — the honest interface is "we kept both," which every user finds annoying, versus LWW's cheerful and wrong "we handled it."

### 2. Content-addressed 4MB chunks with a reference-counted global store
Chunks are keyed by the SHA-256 of their bytes and stored once in `chunk_store` with a `reference_count`; `file_chunks` maps `(file_id, chunk_index)` to a hash.

The alternative — one blob per file version — means editing one paragraph of a 50MB document re-uploads 50MB, which on a metered connection is the difference between a product people use and one they turn off. Chunking makes the transfer proportional to the *change*, and `checkChunks` lets a client ask which hashes the server is missing before sending a byte. Dedup falls out for free: the same attachment shared among ten users occupies storage once.

What we give up is not small. **Fixed-size 4MB boundaries are fragile under insertion** — prepend a single byte to a file and every subsequent chunk boundary shifts, so all hashes change and the "delta" is the whole file. Content-defined chunking (rolling-hash boundaries) fixes exactly this, at the cost of variable chunk sizes and more complex logic; the fixed split is the simplification we took. Reference counting is also the classic source of storage leaks: a decrement missed on a failed delete leaves an orphan forever, which is why `POST /api/v1/admin/cleanup-chunks` exists as a manual sweeper.

### 3. Broadcast to the user's *other* devices, excluding the originator
`broadcastToUser` and `broadcastToFileSubscribers` both take `excludeDeviceId` and skip that socket.

Without the exclusion, the device that just uploaded receives a notification about its own change and — depending on how naively the client handles it — refetches state it already has, or worse, applies the change again and bumps its own vector, generating another broadcast. That's a feedback loop, and its symptom is a device that appears to be syncing constantly while idle. Excluding the originator makes each change produce exactly N−1 notifications.

The trade-off is that a user with two windows open on the *same* device won't be notified in the second one, since exclusion is per-device rather than per-connection.

### 4. Photo derivatives are generated at upload, not on demand
Upload runs sharp twice — 200×200 thumbnail, 1024×1024 preview — and stores both alongside the original before responding.

On-demand generation with a cache is more storage-efficient and correct-by-default. It's wrong for the access pattern: a photo grid requests hundreds of thumbnails at once on first scroll, so a cold cache means hundreds of concurrent full-resolution decodes. Sharp is fast but not free, and the CPU spike lands precisely when the user is waiting for the grid to paint. Doing it once at upload moves the cost to a moment the user already expects to take time.

What we give up: three objects stored per photo forever, including for photos never viewed again, and derivative dimensions frozen at upload time — changing the thumbnail size later requires reprocessing the library. The upload request is also slower and CPU-bound in the API process, where a real system would hand this to a worker.

### 5. The photo grid virtualizes by row, not by item
`PhotoGrid.tsx` uses `useVirtualizer` over *rows* of the grid (fixed `ITEM_HEIGHT`, `overscan: 2`) rather than individual photos.

Per-item virtualization doesn't map onto a CSS grid: the virtualizer wants absolute positioning of each measured item, and grid layout wants to place them itself, so you end up reimplementing wrapping and column math by hand. Treating a row as the unit keeps the grid layout intact within a row while still only mounting the rows near the viewport. Fixed row height is what makes it cheap — no measurement pass, exact scroll offsets — and it's legitimate here because thumbnails are a uniform 200×200 by construction (decision 4). It would be wrong for a feed of variable-height posts, which is why the Instagram project in this repo uses `measureElement` instead.

## Current State

Runs end to end. `docker-compose up -d` starts Postgres (schema auto-loaded from `backend/src/db/init.sql`), Valkey, and MinIO, with `minio-init` creating all three buckets; `npm run dev` starts the API and WebSocket server on 3001. Working: registration/login with bcrypt and Redis sessions, device registration and management with sync history, file browser with folders, drag-and-drop upload, chunked content-addressed storage with SHA-256 dedup and reference counting, download by reassembling chunks, rename/move/delete, version history, delta chunk checking, the full sync protocol (`GET /sync/state`, `GET /sync/changes`, `POST /sync/push`, `POST /sync/resolve-conflict`) with version-vector conflict detection and idempotent push, WebSocket change notification to sibling devices, photo upload with sharp-generated thumbnail/preview/full derivatives, favorites, albums, and an admin dashboard with a dedicated conflicts view plus chunk cleanup and purge-deleted operations. Operational surface: opossum breakers around MinIO, prom-client metrics (chunk operation duration, dedup hits, bytes uploaded), Pino logging, rate limiting, and health checks.

Seeded logins: `admin@icloud.local` (admin) and `user@icloud.local`, both with the bcrypt hash for `password123` — note the comments in `backend/db-seed/seed.sql` still say `admin123` / `user123` from before the hashes were standardized; **the working password is `password123`**.

Simplified or omitted: chunking is fixed-size, so insertions defeat the delta (decision 2). Chunk garbage collection is manual via the admin endpoint, not automatic. There's no client-side offline queue or IndexedDB cache — "offline-first" is the server-side protocol only. No selective sync, no public share links (the `album_shares` table exists but isn't exposed), no compression before upload, and no end-to-end encryption.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old file's **"Phase 2: Conflict Resolution [IN PROGRESS]"** heading sat directly above four checked boxes (version vectors, conflict detection, automatic merge, conflict copies) — the heading and its own contents contradicted each other, and all four were in fact implemented in `services/sync.ts`. Its Implementation Notes also showed the code as JavaScript when the backend is TypeScript throughout.
- **Backend `dev` pinned to `PORT=3001`:** the Vite proxy targets 3001 for both `/api` and `/ws`; without the pin the server fell through to its default and the frontend proxied to a dead port, which surfaced as login failures rather than as a connection error.
- **MinIO wrapped in circuit breakers (`StorageCircuitBreakers`):** a slow or down MinIO previously meant every chunk upload in a multi-chunk file waited on its own timeout, so one 100MB upload could tie up the process for minutes. Storage calls now fail fast when the breaker is open, and `StorageHealth` reports state to the health endpoint.
- **Idempotency on the sync endpoints:** `POST /sync/push` and `POST /sync/resolve-conflict` are wrapped in `withIdempotency`. A retried push was previously re-applying changes and re-incrementing version vectors, which manufactured *phantom conflicts* — the retry looked like a concurrent edit from the same device.
- **Broadcast excludes the originating device**, breaking the self-notification loop described in decision 3.
- **Seed password hashes standardized** to the repo-wide `password123` bcrypt hash; the descriptive comments in `seed.sql` were left stale and still name the old per-user passwords.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Postgres/Redis/MinIO services these tests need). Verification is local: `npm run type-check`, then `npm run triage icloud`.

## Open Questions

1. Version vectors never shrink — every device that ever touched a file leaves a permanent entry. Is there a safe pruning rule (drop components for devices deleted more than N days ago), or does pruning inherently risk resurrecting a conflict that was already resolved?
2. Fixed 4MB boundaries mean a one-byte insertion invalidates every downstream chunk. Is content-defined chunking worth the variable-size complexity for the file types people actually sync, or is the common case really append-and-overwrite where fixed boundaries hold up fine?
3. Chunk GC is a manual admin action, so a failed delete leaks storage silently until someone notices. Should reference counts be authoritative (fast, but any missed decrement leaks forever) or should a periodic mark-and-sweep over `file_chunks` be the truth (self-healing, but a full scan of the chunk store)?
4. The conflict UI currently surfaces conflicts in the admin dashboard rather than to the user who caused them. What's the right end-user affordance — a conflict copy sitting next to the original in the file list, which is how Dropbox does it and which users find confusing, or a blocking prompt, which is worse on mobile?

## Resources

- [Vector clocks](https://en.wikipedia.org/wiki/Vector_clock) — the causality model behind `compareVersions`
- [Dropbox: rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) — why sync engines are hard for reasons that aren't storage
- [restic: content-defined chunking](https://restic.readthedocs.io/en/latest/100_references.html#backups-and-deduplication) — the alternative to fixed-size chunks in decision 2
- [sharp](https://sharp.pixelplumbing.com/) — the derivative pipeline in `routes/photos.ts`
- [TanStack Virtual](https://tanstack.com/virtual/latest) — row-based virtualization in `PhotoGrid.tsx`
