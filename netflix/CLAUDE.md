# Netflix — Development with Claude

## Project Context

The interesting thing about Netflix is that the video bytes are the *easy* part — they're static files that a CDN serves. The hard parts are everything wrapped around them: deciding which of thousands of titles to show a specific profile in under a second, remembering exactly where every profile stopped in every title, and doing all of it under a per-profile maturity filter that must never leak a title a child shouldn't see.

The architecture here reflects that. The API never touches video bytes: `/api/stream/:id/play` resolves to a presigned MinIO URL and issues a **302 redirect**, so the streaming path leaves the Node process entirely after the redirect. What the API does own is the manifest (which qualities exist, where to resume), the personalization query fan-out, and the progress writes — which is the actual write-heavy workload, since a playing client posts progress on a timer for every profile watching anything.

The other thread running through this project is the account/profile split. Almost nothing is keyed by account; nearly everything — progress, history, My List, experiment allocation, maturity level — is keyed by `profile_id`. Getting that boundary right is what makes "the kids' profile can't see this" a schema property rather than a UI convention.

**Learning goals:** manifest-based quality selection and where real ABR would slot in, per-profile personalization assembled from many small queries plus a cache, maturity filtering enforced in SQL rather than in the client, and consistent-hash bucketing for A/B experiments.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 for multi-instance testing |
| **Retention job** (`backend/src/jobs/watch-history-retention.ts`) | In-process `setInterval` | Prunes `watch_history` / `viewing_progress` and supports per-profile GDPR-style deletion |
| **PostgreSQL 16** | 5432 (`netflix`/`netflix_secret`, db `netflix`) | `accounts`, `profiles`, `videos`, `seasons`, `episodes`, `video_files`, `viewing_progress`, `watch_history`, `my_list`, `experiments`, `experiment_allocations`, `sessions` |
| **Valkey 7** | 6379 | Sessions (`session_token` cookie → account + *selected profile*), homepage cache (5 min/profile), sliding-window rate limits |
| **MinIO** | 9000 / console 9001 | S3-compatible object storage; `minio-setup` sidecar creates the `videos` and `thumbnails` buckets and marks them publicly downloadable |

Streaming endpoints are in `backend/src/routes/streaming.ts`; the homepage row fan-out is `backend/src/routes/browse.ts`; experiment bucketing is `backend/src/routes/experiments.ts`. Quality ladder (240p→4K with bitrates) is declared once in `backend/src/config.ts` as `STREAMING_CONFIG`. Frontend is React 19 + Zustand + Tailwind with TanStack Router configured **programmatically in `frontend/src/App.tsx`** (`createRoute`/`createRouter`), not via file-based routing — the `routes/` directory holds page components, not route files. The player is decomposed under `frontend/src/components/VideoPlayer/` (ControlBar, ProgressBar, QualitySelector, VolumeControl, `useVideoPlayerControls.ts`).

## Key Design Decisions

### 1. A JSON manifest plus a 302 redirect, not real DASH/HLS segmentation

`GET /api/stream/:videoId/manifest` returns a small JSON document — duration, an array of qualities with bitrate/width/height, and `resumePosition` — and each quality's `url` points back at `/api/stream/:videoId/play?quality=…`, which resolves a presigned MinIO URL and redirects.

Real ABR needs the video pre-segmented into 2–10 second chunks at each rung of the ladder, plus an MPD or M3U8 the player parses, plus an encoder pipeline to produce all of it. That's an FFmpeg transcoding tier and a job queue before a single frame plays — genuinely the largest subsystem in a real Netflix, and entirely orthogonal to the personalization and progress problems this project is about.

What the JSON manifest preserves is the *shape*: the client fetches a description of available renditions before playing, and switching quality means switching URLs. What it gives up is the thing ABR exists for — the client cannot switch mid-stream, because there are no segment boundaries to switch at. `QualitySelector.tsx` is therefore a manual picker defaulting to 720p, and the "Auto" label it shows when nothing is selected is aspirational. Bandwidth estimation, buffer-based rung selection, and the EMA smoothing that makes ABR not oscillate are all absent; the hooks that would feed them (`POST /:videoId/buffer`, `POST /:videoId/error`) exist and record Prometheus QoE metrics, but nothing consumes them to make a decision.

### 2. Maturity filtering is a SQL predicate in every query, not a post-filter

Every personalization helper in `browse.ts` — `getTrending`, `getByGenre`, `getSimilarVideos`, `getNewReleases`, `getByType`, `getMyList`, `getContinueWatching`, and search — carries `AND maturity_level <= $n`, sourced from the *profile's* `maturity_level`.

The tempting alternative is one filter at the response boundary, or filtering in the client. Both fail the same way: the restricted titles have already been fetched, so they exist in a response payload, a Redis cache entry, or a Zustand store where any curious kid with devtools can read them. And a single choke point is only safe until someone adds a tenth row and forgets to route it through the filter — the failure is silent and the blast radius is a child seeing adult content.

Pushing it into each query means the restricted rows are never selected in the first place, and the homepage cache key (`homepage:{profileId}`) is inherently scoped to a profile whose maturity level was applied at build time, so a cached response can't leak across profiles. The cost is repetition — the predicate appears in nine places and a new query that forgets it is a real (if now less likely) bug. A view or row-level security policy would make it structural rather than conventional.

### 3. The homepage is 8+ sequential queries behind a 5-minute per-profile cache

`GET /api/browse/homepage` builds Continue Watching, My List, Trending, up to 3 genre rows derived from watch history, up to 2 "Because you watched" rows (each requiring a lookup of the source title *then* a genre-overlap query), New Releases, TV Shows, and Movies. On a cache miss that's a dozen-plus round trips assembled serially.

Precomputing rows offline — a batch job writing a materialized homepage per profile — is what a real system does, and it's the right answer at Netflix's profile count. It's wrong here for a specific reason: rows must react to actions the user just took. Finish an episode and Continue Watching should update; add a title and My List should show it. A precomputed row is stale exactly when the user is most attentive to it.

The 5-minute Redis TTL is the compromise, and it's a blunt one: any write (progress, My List add/remove) leaves the cached homepage stale for up to five minutes with no invalidation on those paths. It's acceptable only because the row contents are suggestions rather than facts. If this mattered, `POST /my-list/:videoId` deleting `homepage:{profileId}` is a two-line fix — the reason it isn't done is that the fan-out cost on the next request is exactly what the cache was protecting against.

### 4. Experiment allocation is a hash of `profileId:experimentId`, persisted on first use

Variant assignment hashes the profile-and-experiment pair to a 32-bit integer and buckets it. Hashing rather than random assignment is what makes allocation *consistent*: a user who reloads, switches devices, or hits a different API instance lands in the same variant, because the bucket is a pure function of two IDs and needs no coordination between servers. Including the experiment ID in the hash input is what keeps concurrent experiments independent — hash on `profileId` alone and every experiment would split the population along the identical seam, so the same users are always in every treatment and interaction effects become impossible to separate from main effects.

Allocations are also written to `experiment_allocations`, which is belt-and-braces: the hash already determines the answer, but persisting it means changing the bucketing function later doesn't retroactively reassign users mid-experiment and corrupt the results.

The function is named `murmurhash` but is actually `crypto.createHash('md5')` with the first 4 bytes read as a uint32. That works — MD5's avalanche is more than adequate for uniform bucketing, and this is not a security use — but it is meaningfully slower than a real MurmurHash3 and the name is misleading.

### 5. Progress is an upsert on `(profile_id, video_id, episode_id)`, with completion at 95%

Playback progress arrives as periodic `POST /:videoId/progress`, written via `INSERT … ON CONFLICT (profile_id, video_id, episode_id) DO UPDATE`. Appending every ping and reading the latest would preserve a full scrub history, but progress pings are frequent and per-playing-client, so the table would grow without bound to answer a question that only ever needs one row per profile-title pair.

The 95% completion threshold is what turns "watching" into "watched": it moves the item out of Continue Watching (which additionally filters to 5–95% so a title you barely started doesn't clutter the row) and inserts into `watch_history`, which is what genre-preference and "Because you watched" rows read. The threshold exists because nobody watches credits — requiring 100% would mean almost nothing ever counts as finished, and Continue Watching would fill up with titles the user considers done.

Progress writes are rate-limited to 60/minute per account, which is the guard against a misbehaving client turning the resume feature into a write flood.

## Current State

Runs end to end: account registration/login (bcrypt, Redis session under a `session_token` httpOnly cookie), multi-profile management with per-profile maturity levels, profile selection stored *in the session* rather than the URL, the personalized homepage described above, browse/detail/search with maturity filtering, a video player with manual quality selection, volume, seek, and fullscreen, resume-from-position, My List add/remove/check, and the A/B experiment API with consistent allocation. Cross-cutting: sliding-window rate limiting in Redis with tiered per-category limits (playback 30/min, progress 60/min), an Opossum circuit breaker around MinIO so storage failure degrades to a JSON fallback instead of a 500, Pino structured logging, Prometheus metrics including streaming starts/ends, buffer events and playback errors, RBAC middleware, health endpoints, and a retention job with per-profile data deletion.

Seeded from `backend/db-seed/seed.sql`: account **`demo@netflix.local`** / **`password123`** with profiles and catalog rows. (The SQL comment next to the hash says `-- password: demo123` and is wrong — the stored hash verifies against `password123`, which is what `scripts/screenshot-configs/netflix.json` uses.)

Simplified or omitted: no transcoding pipeline and no segmented DASH/HLS, therefore no true adaptive bitrate — the buckets are declared in `STREAMING_CONFIG` but nothing produces the corresponding renditions, and `/play` returns an explanatory JSON body rather than a video when the key is absent from MinIO. No CDN. Recommendations are genre-overlap and popularity ordering — no embeddings, no collaborative filtering. No experiment metrics pipeline or analysis dashboard, so experiments can allocate but not conclude. Viewing progress lives in PostgreSQL rather than Cassandra, which the architecture doc names as the production choice for that write pattern.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 1 was marked COMPLETED including "Quality selection support" under a stated learning goal of "Build adaptive bitrate streaming" — but there is no ABR: `QualitySelector.tsx` is a manual dropdown, there is no bandwidth estimator, and no segmented media exists to switch between. Phase 2 was "IN PROGRESS" with all six of its concrete items already ticked.
- **Experiment hash function is misnamed:** `murmurhash()` in `routes/experiments.ts` is MD5-based. The old doc advertised "Consistent allocation service (murmurhash)" as a completed feature, which is half true — allocation is consistent, the algorithm isn't MurmurHash.
- **Seed password comment is wrong:** `db-seed/seed.sql` annotates the bcrypt hash as `demo123`; it actually verifies against `password123`. The screenshot config was already correct, so this only ever misled humans reading the SQL.
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the Vite proxy target in `frontend/vite.config.ts`.
- **MinIO bucket bootstrap:** buckets are created by a `minio-setup` `mc` sidecar in `docker-compose.yml` rather than by application code, so a fresh `docker-compose up` has `videos` and `thumbnails` present before the API's first presign attempt.
- **Storage failures degrade instead of 500ing:** `/play` wraps the presign in `withStorageCircuitBreaker` and, on breaker-open or a missing object, returns a JSON explanation naming the expected key path — which is what makes the app demoable without uploading real video files.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The homepage cache has a TTL but no invalidation — adding to My List or finishing an episode won't be reflected for up to 5 minutes. Is targeted invalidation on those two writes correct, or does per-row caching (each row its own key with its own TTL) fit the access pattern better than one blob per profile?
2. `getContinueWatching` uses a correlated subquery inside a `LEFT JOIN … ON` clause to resolve an episode back to its parent video. Would a denormalized `video_id` on `viewing_progress` for episode rows be worth the write-side redundancy?
3. Buffer and error events are recorded as Prometheus counters and then dropped. To do real ABR the client needs them as *input*, not the operator as output — should QoE feed a client-side bandwidth estimate, or is the segmentation work a prerequisite that makes the question moot?
4. Experiment allocations are persisted *and* deterministically derivable. Which one is authoritative when they disagree — and should the allocation endpoint refuse to serve a variant for an experiment that has already ended?

## Resources

- [Netflix Tech Blog](https://netflixtechblog.com/)
- [DASH-IF specifications](https://dashif.org/docs/) — what a real manifest contains and why segmentation is a prerequisite for ABR
- [MDN: Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) — the browser API a real ABR player is built on
- [Netflix: it's all A/Bout testing](https://netflixtechblog.com/its-all-a-bout-testing-the-netflix-experimentation-platform-4e1ca458c15) — experiment allocation and layered experiments
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — the pattern MinIO implements here
