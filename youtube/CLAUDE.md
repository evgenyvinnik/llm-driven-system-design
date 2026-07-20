# YouTube — Development with Claude

## Project Context

A video platform is a system where the write path and the read path have almost nothing in common. Uploading is a long-running, failure-prone, multi-gigabyte transfer followed by minutes of CPU-bound processing. Watching is a latency-sensitive, cache-friendly, read-mostly stream. They share a database and nothing else, and most of the design work is keeping them from interfering.

The upload half is dominated by one fact: a single HTTP request is the wrong shape for a 4GB file. It has no resume, no progress, no partial durability — a connection drop at 95% throws away everything. So uploads have to be chunked, which means tracking per-chunk state server-side, which means an `upload_sessions` table and a multipart abstraction over object storage.

The watch half is dominated by a different fact: view counts are the highest-frequency write in the system and the least important one. Every play is an `UPDATE videos SET view_count = view_count + 1`, and that row is also being read by everyone loading the page. Treating that write with the same care as a comment insert is how you make the database the bottleneck for a feature nobody would notice being approximate.

**Learning goals:** chunked/resumable upload with multipart object storage, async transcoding through a durable queue with parallel workers, HLS adaptive streaming and manifest generation, write buffering for high-frequency low-value counters, and circuit-broken storage access.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Express, versioned under `/api/v1`; also hosts two background timers (view-count flush, queue-depth metrics) |
| **Transcode worker** (`workers/transcode-worker.ts`) | — | Consumes the durable RabbitMQ transcode queue. `dev:worker1` / `dev:worker2` run two with distinct `WORKER_ID`s |
| **PostgreSQL 16** | 5432 | `users`, `videos`, `video_resolutions`, `comments`, `subscriptions`, `video_reactions`, `comment_likes`, `watch_history`, `upload_sessions` |
| **Valkey (Redis)** | 6379 | Sessions, metadata cache, buffered view counts, transcode job status, trending cache |
| **MinIO** | 9000 / 9001 | S3-compatible storage split into raw-upload, processed-video, and thumbnail buckets |
| **RabbitMQ 3** | 5672 / 15672 | Durable transcode queue with `prefetch(1)` — the mechanism that keeps encoding off the request path |

Services are grouped by concern: `services/upload.ts` (session init, chunk upload, completion), `services/transcoding.ts` (job queueing and status), `services/streaming.ts` (manifest URLs, presigned resolution URLs, view recording, watch progress), `services/recommendations.ts`, and `services/metadata/` split per entity (`video`, `channel`, `comment`, `reaction`, `subscription`). Cross-cutting modules in `backend/src/shared/`: `resilientStorage.ts` (retry + circuit breaker around every object-storage call), `queue.ts`, `circuitBreaker.ts`, `rateLimiter.ts`, `retry.ts`, `health.ts`, `logger.ts`, `metrics.ts`. Schema applies via `npm run db:migrate` → `backend/migrations/run.ts`.

Frontend is React + TanStack Router + Zustand + Tailwind, with `VideoPlayer.tsx` handling quality selection and `UploadModal.tsx` driving chunked upload progress. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. Uploads are chunked with server-side session state, mapped onto S3 multipart

`initUpload()` validates the MIME type, creates an `upload_sessions` row and a MinIO multipart upload, and returns a chunk size and count. Each chunk uploads independently, tracked as a `{uploaded: number[], etags: string[]}` structure. `completeUpload()` assembles the parts and enqueues transcoding.

A single `POST` with the whole file fails in the ordinary case, not the exceptional one. On a home connection a multi-gigabyte upload runs for many minutes, and any interruption — sleep, tunnel, transient 5xx — discards all transferred bytes with no resume path. There's also no honest progress indicator: the browser knows how much it has *sent*, not how much the server durably holds. Chunking makes each part independently durable and retryable, so a failure costs one chunk instead of the whole file, and progress is a real server-side count rather than an estimate.

Mapping to S3 multipart rather than reassembling chunks ourselves matters because the object store already solves the hard parts — parts can arrive out of order, in parallel, and are only assembled on `completeMultipartUpload`. Writing that assembly by hand means holding partial files on local disk, which reintroduces the statefulness that makes the API server unscalable.

What we pay: `upload_sessions` rows accumulate for abandoned uploads, and MinIO holds orphaned parts until `abortMultipartUpload` runs. Nothing sweeps either on a schedule.

### 2. Transcoding is a durable queue job with `prefetch(1)`, never a request

`queueTranscodingJob()` publishes to a `durable: true` queue and caches job status in Redis under `transcode:{videoId}`; the worker consumes with `channel.prefetch(1)`.

Transcoding inline is impossible rather than merely slow — encoding a video into a resolution ladder takes minutes, and no HTTP client waits that long. But the more interesting choice is `prefetch(1)`. RabbitMQ's default pushes many messages to a consumer at once, which is right for cheap tasks and exactly wrong for expensive ones: a worker would grab a batch of jobs, sit on them while processing the first, and starve an idle second worker. With prefetch 1, a worker holds one job and the next goes to whoever is free — real load balancing across `dev:worker1` and `dev:worker2` instead of accidental hoarding.

`durable: true` plus per-message acking means a worker crash mid-transcode redelivers the job rather than silently losing the video. The cost is at-least-once delivery: a job can be processed twice if a worker dies after finishing but before acking, so transcoding output has to be overwrite-safe.

The other trade-off is deliberate and large: **transcoding is simulated.** The pipeline, queue semantics, status tracking, resolution rows, and manifest generation are all real; FFmpeg is not invoked. That keeps the project about async job architecture rather than about codec configuration, at the cost of the output files not actually being encoded at the resolutions they claim.

### 3. View counts are buffered in Redis and flushed to Postgres once a minute

`recordView()` increments a Redis counter. A `setInterval` in `index.ts` calls `flushViewCounts()` every 60 seconds and applies each accumulated delta with a single `UPDATE videos SET view_count = view_count + $1`.

Writing per view puts the platform's most frequent event directly onto its hottest row. For a popular video that's a stream of updates to one row, each taking a row lock — so concurrent viewers serialize against each other, and every one of those writes contends with the reads rendering the same row on the watch page. The result is lock contention on exactly the content that's most valuable.

Buffering collapses a minute of views into one increment per video. A video getting 6,000 views a minute goes from 6,000 row updates to one. And the accuracy loss is precisely the kind nobody can detect — a count that lags by under a minute reads as correct to every human who sees it.

What we give up is honest: a process crash loses up to 60 seconds of counts with no recovery, because the buffer is the only record. The flush loop is also per-instance, so multiple API servers each flush their own buffer — correct, since the updates are relative increments, but it means N update statements per video per minute instead of one.

### 4. Every object-storage call goes through retry *then* a circuit breaker, with no fallback

`resilientStorage.ts` wraps each operation with retry first, then an Opossum breaker (30s reset), and passes `null` as the fallback with the comment "storage operations must succeed."

The layering order is the design. Retry sits innermost so transient faults — a dropped connection, a brief 503 — are absorbed before the breaker ever sees them; a breaker wrapping an un-retried call would count normal blips as failures and open on healthy infrastructure. The breaker outside catches the case retry can't fix: storage is genuinely down, and continuing to retry just multiplies load against a failing dependency while holding request handlers open.

Deliberately having no fallback is the unusual part, and it's correct here. Most breakers in this repo degrade to something (trending instead of personalized, local broadcast instead of pub/sub). There is no degraded version of "store this video" — a fallback that pretended to succeed would acknowledge an upload whose bytes went nowhere, which is worse than an error the client can retry. Failing loudly is the feature.

### 5. Recommendations are assembled from labeled sources, not one ranked query

`getRecommendations()` builds a list from subscribed-channel videos (highest priority), category-similar videos derived from the user's last few watched items, and trending (~30% of the slot budget), tagging each result with its `source` and excluding already-watched videos. Logged-out users get a different mix — roughly half trending.

A single ranked SQL query can't express this, because the inputs aren't commensurable: "is from a channel I subscribe to" is a join, "is similar to what I just watched" is a category match against recent history, and "is trending" is a cached velocity ranking. Forcing them into one `ORDER BY` means inventing an arbitrary numeric bridge between a boolean, a category equality, and a view rate — and then making the database evaluate all three across the whole catalog to sort them.

Carrying the `source` label through matters more than it looks: it's the only way to answer "why am I seeing this", and it's what makes the mix tunable per surface (the logged-out mix differs precisely because the source weights differ). The cost is the standard retrieval ceiling — a great recommendation that no source retrieves can never be shown — and that the proportions are hand-set constants with no feedback loop.

## Current State

Runs end to end: API on 3001 with Redis-backed sessions, chunked upload to MinIO with progress and cancel, simulated transcoding through RabbitMQ with one or more workers, `video_resolutions` rows and HLS master/media manifest generation, presigned per-resolution streaming URLs, watch progress persistence and resume, buffered view counting, comments with likes, video reactions, subscriptions, source-labeled recommendations, cached trending, tiered rate limiting (separate buckets for auth and upload), Prometheus `/metrics` including transcode queue depth with a high-water warning, structured logging, and health checks.

Frontend covers home feed, watch page with quality selection, channel pages, subscriptions, trending, history, and a creator studio.

Seeded logins (all `password123`): `alice` (Alice Tech), `bob` (Bob Cooks), `charlie` (Charlie Gaming), and the rest of `backend/db-seed/seed.sql`. The screenshot config runs unauthenticated because the browse surfaces don't require login.

**Simulated or omitted:** FFmpeg is never invoked — the transcode worker performs the job lifecycle without encoding, so a "1080p" resolution row points at content that was never re-encoded. No CDN, no DRM, no live streaming, no thumbnail extraction at multiple timestamps, and no cleanup job for abandoned `upload_sessions` rows or orphaned MinIO multipart parts.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It marked Phase 3 "Scaling and Optimization" as **Not started** with focus areas "Add caching layer" and "Add monitoring" — while Redis caching was in use for metadata, trending, transcode status, and buffered view counts, and `shared/metrics.ts` exported a Prometheus endpoint that `index.ts` feeds a transcode-queue-depth gauge every 10 seconds. Phase 2 was "In progress" with every listed item complete. The old file also listed "What caching strategy for video metadata?" as an open question about code that already had one.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the Vite proxy target.
- **Queue consumer set to `prefetch(1)`:** without it, one worker buffers a batch of transcode jobs while a second worker sits idle — see decision 2.
- **Storage breaker given no fallback deliberately:** `withStorageResilience` passes `null` rather than a degraded path, so a storage outage surfaces as an error instead of a silent data-loss success.
- **View-count flush made additive:** the flusher applies `view_count = view_count + $1` deltas rather than writing absolute totals, so concurrent flushes from multiple API instances compose correctly instead of overwriting each other.
- **Schema applies via `npm run db:migrate`** (`backend/migrations/run.ts`) rather than a `docker-entrypoint-initdb.d` mount — run it before seeding on a fresh clone.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. Abandoned `upload_sessions` rows and orphaned MinIO multipart parts accumulate with nothing to sweep them. Should expiry be a scheduled reaper, or should MinIO's own lifecycle rules own it — and how does the Postgres session row learn that the parts were expired underneath it?
2. Buffered view counts are lost entirely on crash because Redis is the only record. Is that acceptable for view counts specifically, and does the answer change once view counts drive creator payouts?
3. Transcoding is at-least-once, so a job can run twice. The simulated pipeline is idempotent by accident (it overwrites); a real FFmpeg pipeline writing multiple resolution files might not be. What's the right idempotency key — video ID alone, or video ID plus resolution?
4. Recommendation source proportions (subscriptions first, ~30% trending, ~50% trending when logged out) are hand-set constants that have never been evaluated. Without watch-time feedback there's no signal to tune them against — is per-source click-through the minimum instrumentation worth adding?

## Resources

- [RFC 8216: HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216) — the manifest format generated by `services/streaming.ts`
- [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — the semantics MinIO implements and `services/upload.ts` builds on
- [RabbitMQ consumer prefetch](https://www.rabbitmq.com/docs/consumer-prefetch) — why `prefetch(1)` distributes long jobs correctly
- [FFmpeg documentation](https://ffmpeg.org/documentation.html) — what the simulated transcoder stands in for
- [MinIO documentation](https://min.io/docs/minio/linux/index.html) — bucket layout and presigned URL generation
