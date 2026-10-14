# Loom — Development with Claude

## Project Context

Loom's architectural pressure point is that the payload is enormous and the metadata is tiny. A five-minute screen recording is 50–150 MB; the database row describing it is a few hundred bytes. Any design where those two travel the same path is wrong — routing video bytes through an Express handler means a single upload occupies a Node process for the duration of the transfer, and ten concurrent uploads exhaust the server on a workload that is pure I/O with zero business logic.

So the whole system is organized around keeping bytes off the API — and, since the product promise is "the link works the moment you press Stop", around uploading *during* the recording. The browser cuts MediaRecorder's one-second chunks into 5 MiB S3 multipart parts and `PUT`s each one straight to object storage with a presigned URL while the user is still talking; on Stop only the tail is left. The API's involvement is a few dozen small JSON calls (start, part URLs, complete). That keeps the API stateless and moves the interesting complexity to the *client* (a parts queue with retries) and to *completion* (the server decides, from what storage lists, whether the upload is really done).

The second thing that makes this project interesting is that sharing is the product. A recording nobody can watch is worthless, so the share model — unguessable tokens, optional passwords, expiry, download permission — carries real security weight, and every share is a capability handed to someone who has no account.

**Learning goals:** browser media capture, streaming multipart upload with presigned part URLs and storage-verified completion, an upload state machine with a sweeper for abandoned uploads, leased background jobs with fencing, capability-token sharing with one-time password checks and revocation, and idempotent view heartbeats.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** (`npm run dev` → `PORT=3001 NODE_ENV=development tsx watch`) | Single Express process; `config/index.ts` also defaults `PORT` to 3001, so it's consistent either way |
| **PostgreSQL 16** | 5432 (`loom`/`loom123`, db `loom`) | 8 tables: `users`, `videos`, `comments`, `shares`, `view_events`, `folders`, `video_folders`, `video_jobs` |
| **Processing worker** (`backend/src/worker/index.ts`) | no port (`npm run dev:worker`) | Claims `video_jobs` rows with `FOR UPDATE SKIP LOCKED`; FFmpeg remux, `ffprobe` duration, poster frame. Optional: without it videos stay `processing` (playable, no poster) |
| **Valkey 7** | 6379 | Session store via `connect-redis` (prefix `loom:session:`) and `rate-limit-redis` counters (`loom:rl:*`) on a second, fail-fast connection |
| **MinIO** | 9000 / console 9001 (`minioadmin`/`minioadmin`) | S3-compatible storage, bucket `loom-videos`; the browser talks to it **directly**, not through the API |

`app.ts` is exported separately from `index.ts` so vitest can mount the app without binding a port. The upload protocol is `services/uploadService.ts` (state machine, verified completion, sweeper) on top of `services/storageService.ts` (multipart helpers, presigning with a fixed region); access is `services/videoAccess.ts` + `services/shareGrants.ts`; jobs are `services/jobQueue.ts` + `worker/`. Frontend is React 19 + TanStack Router (file-based: `index`, `login`, `register`, `record`, `videos.$videoId`, `share.$token`) + Zustand + Tailwind; the streaming upload is `frontend/src/services/chunkedUploader.ts`, driven from `stores/videoStore.ts`, and view heartbeats are `hooks/useViewTracker.ts`.

## Key Design Decisions

### 1. Multipart parts uploaded during the recording — the API never sees a video byte

`ChunkedUploader` buffers MediaRecorder chunks into 5 MiB parts and `PUT`s each one straight to MinIO with a presigned part URL while recording continues; `POST /api/upload/complete` lists the parts MinIO holds, refuses (`409`, `missingParts`) unless parts 1..`partCount` are all there and every non-final part is at least 5 MiB, stitches with MinIO's ETags, stats the object, and only then flips `uploading` → `processing` and enqueues the processing job in the same transaction.

Proxying through the API fails on resource occupancy (every upload holds a request and its bandwidth for minutes), and a single `PUT` after Stop fails on time (upload time grows with recording length, and one network drop loses the whole file). Multipart is already a resumable protocol; uploading parts as they are produced is what makes the link work about a second after Stop.

What we give up is simplicity on the client — a parts queue, retries with fresh URLs, an `error` phase with `retry()` — and a 5 MiB loss granularity: a crashed tab loses what was recorded since the last uploaded part, because chunks are held in memory (an IndexedDB journal would fix that). The atomicity gap the old single-`PUT` flow had (rows stuck in `processing` forever) is closed by the state machine plus the sweeper in `index.ts`.

### 2. Share tokens are 256-bit random capabilities, not signed URLs

`generateShareToken()` is `crypto.randomBytes(32).toString('hex')` — 256 bits, stored in `shares.token` with a unique index.

The alternative is a signed URL: encode the video ID and an expiry, sign with a server key, and validate the signature without any database lookup. It's stateless and fast, and it has one disqualifying property for this feature — **you cannot revoke it**. A signed URL is valid until it expires, no matter what; the only way to kill one early is to rotate the signing key, which invalidates *every* outstanding link at once. "I shared this with the wrong person, undo it" is a basic expectation of a sharing product, and it has to be a single-row delete.

Random tokens also make the security argument simple: 256 bits is unguessable by any margin that matters, so the token *is* the capability and no additional authorization is needed. UUIDv4 would have been fine too (122 bits), but `randomBytes` costs nothing extra.

The costs: every share access is a database lookup (fine — it's indexed and infrequent). The password is checked once: `POST /api/share/:token/unlock` takes it in the JSON body (never the query string, which pino-http would log), runs bcrypt, and sets a signed `loom_share_grants` cookie. Later requests present the grant, and `videoAccess.ts` re-reads the share row each time, so revocation still bites on the next request while bcrypt runs once per viewer. The grant is a signed cookie rather than session state on purpose: anonymous viewers never create a Redis session, so share links keep working during a Redis outage.

### 3. Time-anchored comments are one nullable float, not a separate type

`comments.timestamp_seconds FLOAT` is `NULL` for a general comment and set for one anchored to a moment in the video. `parent_id` gives single-level threading.

The modelling alternative is polymorphism — separate tables, or a discriminator column with a type enum. Both are the right call when the variants diverge in *structure*; here they don't. An anchored comment and a general comment have identical fields, identical permissions, identical rendering except for a timestamp badge, and are listed together in the same query. Splitting them would mean a `UNION` on every read and duplicated write paths to express one optional attribute.

What we give up is a database-level constraint on the anchor: a `CHECK` can't compare against `videos.duration_seconds` across tables, so `routes/comments.ts` validates it (and that replies attach only to top-level comments) in application code.

### 4. Views are one row per playback session, aggregated at read time

Each playback session is one row in `view_events`, keyed by a `viewId` the player generates: the first report inserts it (and bumps `videos.view_count` in the same statement), heartbeats upsert it keeping the larger watch time and a sticky `completed`. Rows carry either a `viewer_id` or an anonymous `session_id` (a stable per-browser key). The analytics panel runs a single aggregate: `COUNT(*)` for total views, `COUNT(DISTINCT COALESCE(viewer_id::text, session_id))` for unique viewers, `AVG(watch_duration_seconds)`, and `COUNT(*) FILTER (WHERE completed) / COUNT(*)` for completion rate.

Incrementing counters on the `videos` row would make reads free, and it's what you'd do if views were the only metric. It fails as soon as you want a *second* question answered. Counters record the answer, not the data — you cannot derive "unique viewers" or "completion rate" or "views per day" from a total, so every new metric requires a schema change plus a backfill you can't actually perform because the underlying events were never stored. The event table answers questions that hadn't been asked when it was written, which is the entire argument for event storage.

The `COALESCE(viewer_id::text, session_id)` trick is what makes unique-viewer counting work across logged-in and anonymous viewers in one expression — anonymous viewers dedupe by session, authenticated ones by user ID, so the same person watching signed-in twice counts once.

What we give up is read cost that scales with view volume: a video with a million views aggregates a million rows on every analytics page load, with no rollup table and no cache. The `idx_view_events_video (video_id, created_at DESC)` index keeps it a range scan rather than a full scan, but the fix at scale is a periodic rollup into daily buckets — worth it precisely because the raw events are still there to roll up from.

### 5. Play the original WebM at once; a worker remuxes it afterwards

Completion makes a video `processing`, which is already playable from the uploaded WebM. The worker then does the part of "transcoding" that matters for MediaRecorder output: a copy-only FFmpeg remux that adds the duration and seek index MediaRecorder omits (without it the browser can't seek, which breaks jumping to time-anchored comments), an `ffprobe` duration, and a poster frame, written to fixed keys next to the source and committed only if the job's lease is still held.

An HLS/DASH ladder is what production Loom does, and it buys adaptive bitrate; it stays out of scope locally because it's minutes of CPU per recording. The cost is visible: playback still needs WebM support, and there is no quality adaptation.

## Current State

Runs end to end: registration and login with bcrypt and Redis-backed sessions; browser recording of screen (`getDisplayMedia`) or camera (`getUserMedia`) with optional microphone audio, pause/resume, and an `ended` listener so stopping via the browser's own UI ends the recording cleanly; a streaming multipart upload during recording (live "Uploaded X of Y MB" while recording, "Uploaded" about a second after Stop, Save/Discard afterwards); server-verified completion and an upload sweeper; an optional processing worker (remux, duration, poster); a video library with grid, filters and folders; playback with time-anchored comments whose badges seek the player; share links with optional password, expiry and download flag, a public `share.$token` route that shows comments and unlocks via `POST`; one access rule (owner or live share grant) on every read path; idempotent view heartbeats; and an analytics panel. Cross-cutting: Pino logging with token masking and cookie/password redaction, Prometheus metrics (HTTP, uploads, sweeps, views), Redis-backed rate limiting (API fails open, auth and share-password fail closed), an Opossum breaker on storage control-plane calls, liveness/readiness endpoints, and graceful shutdown.

Seeding is `npm run db:seed` (`backend/src/db/seed.ts`), which applies the SQL fixture `backend/db-seed/base.sql` **and then populates MinIO**. Users **`alice`**, `bob`, `carol`, and `admin` (`admin@example.com`, role `admin`) — all with password **`password123`** — plus videos in every status (ready, uploading, failed), comments, folders, view events, and share links (`demo-checkout-walkthrough-2f8a91` with no protection, `demo-dashboard-review-7c3e44` password-protected with `password123`, `demo-eng-onboarding-b19d05` expiring in 90 days). The seeded `uploading` row is swept to `failed` once it has been idle for `UPLOAD_STALE_MINUTES` (30) — expected, not a bug.

The object-storage half of the seed is not optional decoration. `videos.thumbnail_path` and `storage_path` are MinIO **object keys**, and the API presigns them before the client ever sees a URL; a row pointing at a key with no object behind it yields a presigned URL that 404s. The seeder therefore fetches real stills and a short CC0 clip and PUTs them at exactly the keys `base.sql` references.

Tests: `npm test` in `backend/` (49 vitest tests: upload service, access rule, share grants, job queue and processor, HTTP-level access/unlock/rate-limit/view tests) and in `frontend/` (8 tests for `ChunkedUploader`).

Simplified or omitted: no HLS/DASH or adaptive bitrate; no IndexedDB journal, so a crashed tab loses the recording since the last uploaded part; no CDN (presigned GET URLs live an hour, which is the revocation bound for someone mid-playback); share tokens stored in plaintext; no WebSocket notifications; hard deletes with no trash; view events are aggregated on read with no rollups.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 2 claimed "Circuit breaker (Opossum) wrapping MinIO operations" as built — but `backend/src/services/circuitBreaker.ts` exports `createCircuitBreaker` and **nothing imports it**. Every MinIO call in `storageService.ts` is unwrapped, so a MinIO outage surfaces as a raw 500 rather than a fast-failing breaker. The file is scaffolding that was never wired up, and the old doc presented it as a shipped feature.
- **Screenshot config backend port (fixed):** the config used to set `"backendPort": 3000` while this backend binds **3001** (from the `PORT=3001` prefix in `dev`, from `config/index.ts`'s default, and matching the Vite proxy), so the harness waited on a dead port. The override is gone; the harness derives 3001 from the `dev` script.
- **2026-07-29 — the library and player were visually empty, and the cause was storage, not the UI.** Three separate faults, all downstream of the same misunderstanding that a MinIO object key is not a URL:
  1. `VideoCard` never read `thumbnailPath` at all — it rendered a generic play glyph for every ready video regardless. The column, the type field, and the upload route's thumbnail branch all existed; only the card was missing.
  2. Even once the card read it, `thumbnail_path` is an object key, so the client can't use it directly. The API now presigns it per row (`withThumbnailUrls` in `routes/videos.ts`) and returns `thumbnailUrl`. Presigning is local HMAC work with no round trip, so doing it while building the list response is cheaper than N client requests.
  3. No objects existed in the bucket at all. Seeding moved from a bare `seed.sql` to `db:seed`, which uploads stills and a sample clip. **Note the harness rule this had to work around:** `scripts/screenshots.mjs` only runs a project's TypeScript seeder when `seed.sql` has no user rows, so the SQL fixture was renamed to `base.sql` and the TS seeder now applies it.
- **`<video>` needs real bytes, not just a poster.** Adding `poster={thumbnailUrl}` to `VideoPlayer` was not enough on its own: WebKit drops the poster frame once the media resource errors, so a 404 on `storage_path` still rendered black. Seeding a real (small, CC0) webm behind every `ready` row is what actually makes the player show anything — and it makes scrubbing and time-anchored comments genuinely exercisable locally.
- **Backend port pinned in `dev`:** `PORT=3001 NODE_ENV=development tsx watch src/index.ts` matches the Vite proxy target. (`dev:server2`/`dev:server3` used to be written as `PORT=3002 npm run dev`, which bound 3001 because the inner `dev` script re-exported `PORT=3001`; fixed 2026-10-10 — they now call `tsx` directly.)
- **`app.ts` split from `index.ts`:** the Express app is exported without calling `listen()`, so vitest can mount it with supertest and mock `services/db.js` / `services/storageService.js` without a live port or live Docker services.
- **Upload progress needed XHR, not fetch:** the Fetch API has no upload-progress event, so a byte-level progress bar is impossible with it. `videoStore.ts` uses `XMLHttpRequest` purely for `upload.onprogress`, mapped onto the 20–85% band of the five-stage indicator so the surrounding API calls have visible room at either end.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).
- **2026-10-10 — upload during recording, an access rule, and a processing worker.** The review found the share model leaking and the core Loom idea missing:
  1. **IDOR / revocation bypass (fixed).** `GET /api/videos/:id`, `GET /api/upload/download/:videoId` and `GET /api/videos/:id/comments` had no auth at all, analytics had auth but no ownership check, and any signed-in user could comment anywhere. Because the share response includes `video.id`, anyone who had ever opened a link could mint fresh playback URLs forever — password, expiry and revocation were decorative. All read paths now go through `services/videoAccess.ts` (owner, or a signed share grant whose share row is still live); others get `404`.
  2. **Share password in the URL (fixed).** It was sent as `?password=` and pino-http logged full URLs and request headers (session cookies). The password moved to `POST /api/share/:token/unlock`, is bcrypt-checked once and remembered in a signed grant cookie; logs mask share tokens, drop query strings and redact cookies and passwords.
  3. **Completion trusted the client (fixed).** `/complete` marked a video `ready` even when `statObject` failed, and `/presigned` could repoint a `ready` video. Replaced by the multipart protocol (start / part-url / complete) with storage-listed parts, conditional state transitions, client-generated video IDs for retry-safe creation, an activity-based sweeper (`UPLOAD_STALE_MINUTES`), and abort-on-delete. The frontend's `ChunkedUploader` streams 5 MiB parts while recording.
  4. **Processing worker (new).** `video_jobs` + `worker/` (SKIP LOCKED claims, leases, attempts as a fencing token, backoff, dead-letter that falls back to serving the original). Verified with real FFmpeg: a live-mode WebM with duration `N/A` came out of the remux with `12.028` s and a JPEG poster.
  5. **Views (fixed).** `recordViewEvent` did INSERT then UPDATE outside a transaction and counted every request; it's now one upsert keyed by the client's `viewId`, and the player actually reports watch time (it never did) via `useViewTracker`, with a beacon on page hide.
  6. **Rate limiting was in-memory** despite `rate-limit-redis` being a dependency (and the docs saying otherwise). Now Redis-backed on a dedicated connection with the offline queue off — the first runtime test showed every API request stalling ~2.3 s during a Redis outage on the shared client; with the dedicated one it's ~5 ms. Also fixed: deleting a comment with replies or a folder with subfolders hit a non-cascading FK (`500`); the four custom metrics were registered but never observed.
  - Verified against PostgreSQL 16, a private Redis and **moto** (S3 emulator, standing in for MinIO, which wasn't available): 67 scripted curl checks — schema loaded twice plus an upgrade from the original schema, IDOR denials, grant/revoke, unlock + 429, two-part upload whose stitched object matched the recording's md5, `409` for a missing part and for a 1 MiB non-final part, worker output, sweeper aborting the multipart upload, view idempotency, cascades, log redaction, metrics, graceful shutdown.
  - Docs rewritten to the diagram standard: architecture.md and the three answers now share one layered overview (clients → load balancer/CDN → Video API → data, async on the right, object storage as the floor) and seqdiag-generated flows.

## Open Questions

1. `view_events` still aggregates at read time with no rollup. At what view count does that stop being acceptable, and is a daily rollup table better than caching the aggregate with a short TTL?
2. Chunks live in memory until uploaded. Is an IndexedDB journal (resume after a crashed tab) worth its complexity for this project, or is "lose at most one part" an acceptable local limitation?
3. The worker doesn't renew its lease, so a job longer than `WORKER_LEASE_SECONDS` can run twice (fencing keeps the result correct). Add a heartbeat, or size the lease from the file's duration?
4. Should the sweeper salvage abandoned uploads (complete the contiguous parts it has) instead of failing them? WebM plays fine when truncated, which is what real Loom does after a crash.

(Resolved 2026-10-10: reconciliation of stuck uploads — sweeper; bcrypt on every protected access — signed grant; multipart for large recordings — built.)

## Resources

- [MDN: MediaStream Recording API](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API) — `MediaRecorder`, timeslices, and mime type selection
- [MDN: Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API) — `getDisplayMedia` and the track `ended` event
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — the pattern MinIO implements
- [MinIO JavaScript client](https://min.io/docs/minio/linux/developers/javascript/API.html) — `presignedUrl`, multipart helpers, `presignedGetObject`
- [Amazon S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — part numbering, the 5 MiB minimum, and lifecycle rules for incomplete uploads
- [MDN: XMLHttpRequest upload progress](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequestUpload) — why fetch can't do decision 5's progress bar
