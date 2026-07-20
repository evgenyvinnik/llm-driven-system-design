# Loom — Development with Claude

## Project Context

Loom's architectural pressure point is that the payload is enormous and the metadata is tiny. A five-minute screen recording is 50–150 MB; the database row describing it is a few hundred bytes. Any design where those two travel the same path is wrong — routing video bytes through an Express handler means a single upload occupies a Node process for the duration of the transfer, and ten concurrent uploads exhaust the server on a workload that is pure I/O with zero business logic.

So the whole system is organized around keeping bytes off the API. The browser captures with `MediaRecorder`, asks the API for a presigned URL, `PUT`s directly to object storage, and then tells the API it's done. The API's entire involvement in a 150 MB upload is two sub-100ms JSON requests. That's what makes the API tier stateless and trivially scalable, and it's why the interesting complexity moves to the *client*, which now has to orchestrate a four-step flow and recover if any step fails.

The second thing that makes this project interesting is that sharing is the product. A recording nobody can watch is worthless, so the share model — unguessable tokens, optional passwords, expiry, download permission — carries real security weight, and every share is a capability handed to someone who has no account.

**Learning goals:** browser media capture, the presigned-URL upload pattern and its client-side coordination cost, capability-token sharing with revocation, and aggregating view analytics from an append-only event table.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** (`npm run dev` → `PORT=3001 NODE_ENV=development tsx watch`) | Single Express process; `config/index.ts` also defaults `PORT` to 3001, so it's consistent either way |
| **PostgreSQL 16** | 5432 (`loom`/`loom123`, db `loom`) | 7 tables: `users`, `videos`, `comments`, `shares`, `view_events`, `folders`, `video_folders` |
| **Valkey 7** | 6379 | Session store via `connect-redis` (prefix `loom:session:`) and the backing store for `rate-limit-redis` |
| **MinIO** | 9000 / console 9001 (`minioadmin`/`minioadmin`) | S3-compatible storage, bucket `loom-videos`; the browser talks to it **directly**, not through the API |

`app.ts` is exported separately from `index.ts` so vitest can mount the app without binding a port. Storage is `backend/src/services/storageService.ts` (presign PUT/GET, 1-hour expiry); share tokens and validation are `services/shareService.ts`; view aggregation is `services/analyticsService.ts`. Frontend is React 19 + TanStack Router (file-based: `index`, `login`, `register`, `record`, `videos.$videoId`, `share.$token`) + Zustand + Tailwind, with the four-step upload orchestration living in `frontend/src/stores/videoStore.ts`.

## Key Design Decisions

### 1. Presigned PUT directly to MinIO — the API never sees a video byte

`POST /api/upload/presigned` verifies ownership, generates an object key of `{userId}/{videoId}/{uuid}.webm`, records it on the `videos` row, and returns a presigned URL. The browser `PUT`s the blob straight to MinIO. `POST /api/upload/complete` then flips `status` to `ready` and backfills `file_size_bytes` from a MinIO `statObject`.

Proxying through the API is the alternative, and it fails on resource occupancy rather than on correctness. A 150 MB upload on a slow connection holds an Express request open for minutes; Node handles the streaming fine, but every concurrent upload consumes a connection, a request context, and — if `multer` buffers rather than streams — potentially hundreds of megabytes of heap. You end up scaling the API tier for bandwidth, which is the most expensive possible reason to add a server. Presigning moves the transfer to storage that is *designed* for it, and the API scales on request rate, which is now tiny.

What we give up is atomicity. The four steps (create row → get URL → PUT → mark complete) are four independent operations with no transaction across them. A client that dies after step 3 leaves a `videos` row stuck in `status = 'processing'` forever with a real object behind it, and a client that dies after step 2 leaves an orphan row with no object. Nothing reconciles either case — no sweeper marks stale `processing` rows failed, and no job garbage-collects unreferenced MinIO objects. That's the honest cost of the pattern and the most obvious missing piece in this implementation.

### 2. Share tokens are 256-bit random capabilities, not signed URLs

`generateShareToken()` is `crypto.randomBytes(32).toString('hex')` — 256 bits, stored in `shares.token` with a unique index.

The alternative is a signed URL: encode the video ID and an expiry, sign with a server key, and validate the signature without any database lookup. It's stateless and fast, and it has one disqualifying property for this feature — **you cannot revoke it**. A signed URL is valid until it expires, no matter what; the only way to kill one early is to rotate the signing key, which invalidates *every* outstanding link at once. "I shared this with the wrong person, undo it" is a basic expectation of a sharing product, and it has to be a single-row delete.

Random tokens also make the security argument simple: 256 bits is unguessable by any margin that matters, so the token *is* the capability and no additional authorization is needed. UUIDv4 would have been fine too (122 bits), but `randomBytes` costs nothing extra.

The costs: every share access is a database lookup (fine — it's indexed and infrequent), and password-protected shares add a bcrypt verification to every view, not just the first. Since `validateShare` re-checks the password on each access rather than issuing a short-lived session after the first success, a viewer scrubbing through a protected video pays bcrypt repeatedly.

### 3. Time-anchored comments are one nullable float, not a separate type

`comments.timestamp_seconds FLOAT` is `NULL` for a general comment and set for one anchored to a moment in the video. `parent_id` gives single-level threading.

The modelling alternative is polymorphism — separate tables, or a discriminator column with a type enum. Both are the right call when the variants diverge in *structure*; here they don't. An anchored comment and a general comment have identical fields, identical permissions, identical rendering except for a timestamp badge, and are listed together in the same query. Splitting them would mean a `UNION` on every read and duplicated write paths to express one optional attribute.

What we give up is the ability to constrain the anchor — nothing checks that `timestamp_seconds` falls within `duration_seconds`, so a comment can be anchored past the end of its video. A `CHECK` constraint can't easily express that (it's a cross-table reference), so it would have to be application-level validation, which currently doesn't exist.

### 4. Views are append-only events, aggregated at read time

Each view writes a row to `view_events` with `watch_duration_seconds`, a `completed` flag, and either a `viewer_id` or an anonymous `session_id`. The analytics panel runs a single aggregate: `COUNT(*)` for total views, `COUNT(DISTINCT COALESCE(viewer_id::text, session_id))` for unique viewers, `AVG(watch_duration_seconds)`, and `COUNT(*) FILTER (WHERE completed) / COUNT(*)` for completion rate.

Incrementing counters on the `videos` row would make reads free, and it's what you'd do if views were the only metric. It fails as soon as you want a *second* question answered. Counters record the answer, not the data — you cannot derive "unique viewers" or "completion rate" or "views per day" from a total, so every new metric requires a schema change plus a backfill you can't actually perform because the underlying events were never stored. The event table answers questions that hadn't been asked when it was written, which is the entire argument for event storage.

The `COALESCE(viewer_id::text, session_id)` trick is what makes unique-viewer counting work across logged-in and anonymous viewers in one expression — anonymous viewers dedupe by session, authenticated ones by user ID, so the same person watching signed-in twice counts once.

What we give up is read cost that scales with view volume: a video with a million views aggregates a million rows on every analytics page load, with no rollup table and no cache. The `idx_view_events_video (video_id, created_at DESC)` index keeps it a range scan rather than a full scan, but the fix at scale is a periodic rollup into daily buckets — worth it precisely because the raw events are still there to roll up from.

### 5. WebM served as-is — no transcoding tier

`MediaRecorder` is configured with `video/webm;codecs=vp9,opus` and the resulting blob is stored and served unchanged. Playback is a native `<video>` element pointed at a presigned GET URL.

Transcoding to HLS/DASH is what a production Loom does, and it's not a small addition: an FFmpeg worker fleet, a job queue, a `status` state machine that actually *means* something, segment storage, and manifest generation. It buys adaptive bitrate and universal device playback. Skipping it is the single biggest simplification in this project, and it's a deliberate one — the `status` column (`processing`/`ready`/`failed`) exists as the seam where that pipeline would attach, but nothing currently sets `failed` and `processing` only lasts as long as the upload.

The cost is real and visible: playback requires a browser with VP9 WebM support (fine on Chrome/Firefox/Edge, historically a problem on Safari), and there is no quality adaptation — a viewer on a bad connection gets the full-bitrate file or nothing. `MediaRecorder.start(1000)` uses a one-second timeslice so chunks are emitted incrementally rather than accumulating a single giant buffer in memory during a long recording.

## Current State

Runs end to end: registration and login with bcrypt and Redis-backed sessions, browser recording of screen (`getDisplayMedia`) or camera (`getUserMedia`) with optional microphone audio, pause/resume, and an `ended` listener on the video track so stopping the share via the browser's own UI ends the recording cleanly; the four-step presigned upload with byte-level progress via `XMLHttpRequest.upload.onprogress` mapped onto a five-stage indicator (`UploadProgress.tsx`); a video library with grid, filters, and folder organization; playback with time-anchored and general comments plus single-level replies; share creation with optional password, expiry, and download permission, and a public `share.$token` route that enforces all three; and an analytics panel with stat cards plus a per-day `ViewsChart`. Cross-cutting: Pino structured logging via `pino-http`, Prometheus metrics, and Redis-backed rate limiting (a global `/api` limiter plus a stricter `uploadLimiter`).

Seeded from `backend/db-seed/seed.sql`: users **`alice`**, `bob`, `carol`, and `admin` (`admin@example.com`, role `admin`) — all with password **`password123`** — plus videos, comments, folders, view events, and two share links (`share_public` with no protection, `share_locked` password-protected with `password123`).

Simplified or omitted: no transcoding, so no HLS/DASH and no adaptive bitrate; no thumbnail extraction (the `thumbnail_path` column and its presign branch exist, but nothing generates an image); no multipart upload, so a recording large enough to fail a single `PUT` has no recovery path; no reconciliation of stuck `processing` rows or orphaned MinIO objects; no WebSocket notifications — comments and upload completion require a refetch; hard deletes with no trash.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 2 claimed "Circuit breaker (Opossum) wrapping MinIO operations" as built — but `backend/src/services/circuitBreaker.ts` exports `createCircuitBreaker` and **nothing imports it**. Every MinIO call in `storageService.ts` is unwrapped, so a MinIO outage surfaces as a raw 500 rather than a fast-failing breaker. The file is scaffolding that was never wired up, and the old doc presented it as a shipped feature.
- **Screenshot config backend port is wrong (outstanding):** `scripts/screenshot-configs/loom.json` sets `"backendPort": 3000`, but this backend binds **3001** — both from the `PORT=3001` prefix in the `dev` script and from `config/index.ts`'s default — and `frontend/vite.config.ts` proxies `/api` to 3001. The harness therefore waits on a port nothing listens to. Removing the `backendPort` override lets the harness derive 3001 from the `dev` script.
- **Backend port pinned in `dev`:** `PORT=3001 NODE_ENV=development tsx watch src/index.ts` matches the Vite proxy target. Note `dev:server2`/`dev:server3` are written as `PORT=3002 npm run dev`, which does **not** work as intended — the inner `dev` script re-exports `PORT=3001` and overrides the outer value, so all three scripts bind 3001.
- **`app.ts` split from `index.ts`:** the Express app is exported without calling `listen()`, so vitest can mount it with supertest and mock `services/db.js` / `services/storageService.js` without a live port or live Docker services.
- **Upload progress needed XHR, not fetch:** the Fetch API has no upload-progress event, so a byte-level progress bar is impossible with it. `videoStore.ts` uses `XMLHttpRequest` purely for `upload.onprogress`, mapped onto the 20–85% band of the five-stage indicator so the surrounding API calls have visible room at either end.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The four-step upload has no reconciliation. Should a sweeper mark `processing` rows older than N minutes as `failed` (and delete their objects), or should the object store be the source of truth with the row derived from a bucket listing?
2. Password-protected shares run bcrypt on *every* access rather than once. Should a successful password check mint a short-lived scoped cookie for that share token — and does that reintroduce the session state the presign design was avoiding?
3. `view_events` aggregates at read time with no rollup. At what view count does that stop being acceptable, and is a daily rollup table better than caching the aggregate with a short TTL?
4. Recordings over ~1 GB will fail a single presigned `PUT`. Multipart upload means N presigned URLs, client-side chunking, and a completion call listing the parts — is that worth building, or is a hard recording-length cap the honest answer for this project's scope?

## Resources

- [MDN: MediaStream Recording API](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API) — `MediaRecorder`, timeslices, and mime type selection
- [MDN: Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API) — `getDisplayMedia` and the track `ended` event
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — the pattern MinIO implements
- [MinIO JavaScript client](https://min.io/docs/minio/linux/developers/javascript/API.html) — `presignedPutObject` / `presignedGetObject`
- [MDN: XMLHttpRequest upload progress](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequestUpload) — why fetch can't do decision 5's progress bar
