# Netflix — Development with Claude

## Project Context

The interesting thing about Netflix is that the video bytes are the *easy* part — they're static files that a CDN serves. The hard parts are everything wrapped around them: deciding which of thousands of titles to show a specific profile in under a second, remembering exactly where every profile stopped in every title, and doing all of it under a per-profile maturity filter that must never leak a title a child shouldn't see.

The architecture here reflects that. The API never touches video bytes: `POST /api/stream/:id/sessions` decides once whether this profile may play this title (maturity, episode-belongs-to-title, plan quality cap, concurrent-screen lease) and returns a manifest of **HMAC-signed** `/play` URLs; `/play` verifies the token without a database lookup — the check a CDN edge would do — and issues a **302** to a presigned MinIO URL, so the streaming path leaves the Node process after the redirect. What the API does own is that decision, the personalization query fan-out, and the progress writes — the actual write-heavy workload, since a playing client posts its position every 10 seconds, and those posts double as the screen-lease heartbeat.

The other thread running through this project is the account/profile split. Almost nothing is keyed by account; nearly everything — progress, history, My List, experiment allocation, maturity level — is keyed by `profile_id`. Getting that boundary right is what makes "the kids' profile can't see this" a schema property rather than a UI convention.

**Learning goals:** playback authorization (entitlement, signed URLs, concurrent-stream leases), resume-position writes that are idempotent and last-writer-wins by position timestamp, manifest-based quality selection and where real ABR would slot in, per-profile personalization behind a versioned cache, maturity filtering enforced in SQL rather than in the client, and consistent-hash bucketing for A/B experiments.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 for multi-instance testing |
| **Retention job** (`backend/src/jobs/watch-history-retention.ts`) | In-process `setInterval` | Prunes `watch_history` / `viewing_progress` and supports per-profile GDPR-style deletion |
| **PostgreSQL 16** | 5432 (`netflix`/`netflix_secret`, db `netflix`) | `accounts`, `profiles`, `videos`, `seasons`, `episodes`, `video_files`, `viewing_progress`, `watch_history`, `my_list`, `experiments`, `experiment_allocations`, `sessions` |
| **Valkey 7** | 6379 | Sessions (`session_token` cookie → account + *selected profile*), homepage cache (5 min/profile under a versioned key), screen leases (`streams:{accountId}` sorted set), sliding-window rate limits |
| **MinIO** | 9000 / console 9001 | S3-compatible object storage; `minio-setup` sidecar creates the `videos` bucket (private — reachable only through presigned URLs) and the publicly readable `thumbnails` bucket |

Playback rules live in `backend/src/services/playback.ts` (entitlement, plan caps, URL signing, the lease Lua script) and `backend/src/services/progress.ts` (last-writer-wins writes); streaming endpoints are in `backend/src/routes/streaming.ts`; the homepage row fan-out is `backend/src/routes/browse.ts`; experiment bucketing is `backend/src/routes/experiments.ts`. Quality ladder (240p→4K with bitrates) is declared once in `backend/src/config.ts` as `STREAMING_CONFIG`. Frontend is React 19 + Zustand + Tailwind with TanStack Router configured **programmatically in `frontend/src/App.tsx`** (`createRoute`/`createRouter`), not via file-based routing — the `routes/` directory holds page components, not route files. The player is decomposed under `frontend/src/components/VideoPlayer/` (ControlBar, ProgressBar, QualitySelector, VolumeControl, `useVideoPlayerControls.ts`).

## Key Design Decisions

### 1. A JSON manifest plus a 302 redirect, not real DASH/HLS segmentation

`POST /api/stream/:videoId/sessions` returns a small JSON document — session id, duration, the qualities the plan allows with bitrate/width/height, and `resumePosition` — and each quality's `url` points back at `/api/stream/:videoId/play?quality=…&sid=…&exp=…&sig=…`, which verifies the signature, resolves a presigned MinIO URL and redirects.

Real ABR needs the video pre-segmented into 2–10 second chunks at each rung of the ladder, plus an MPD or M3U8 the player parses, plus an encoder pipeline to produce all of it. That's an FFmpeg transcoding tier and a job queue before a single frame plays — genuinely the largest subsystem in a real Netflix, and entirely orthogonal to the personalization and progress problems this project is about.

What the JSON manifest preserves is the *shape*: the client fetches a description of available renditions before playing, and switching quality means switching URLs. What it gives up is the thing ABR exists for — the client cannot switch mid-stream, because there are no segment boundaries to switch at. `QualitySelector.tsx` is therefore a manual picker defaulting to 720p, and the "Auto" label it shows when nothing is selected is aspirational. Bandwidth estimation, buffer-based rung selection, and the EMA smoothing that makes ABR not oscillate are all absent; the hooks that would feed them (`POST /:videoId/buffer`, `POST /:videoId/error`) exist and record Prometheus QoE metrics, but nothing consumes them to make a decision.

### 2. Maturity filtering is a SQL predicate in every query, not a post-filter

Every personalization helper in `browse.ts` — `getTrending`, `getByGenre`, `getSimilarVideos`, `getNewReleases`, `getByType`, `getMyList`, `getContinueWatching`, and search — carries `AND maturity_level <= $n`, sourced from the *profile's* `maturity_level`. Since 2026-10-10 the same rule also guards `GET /api/videos/:id`, playback sessions and progress writes, which previously let a kids profile open or play a restricted title by id.

The tempting alternative is one filter at the response boundary, or filtering in the client. Both fail the same way: the restricted titles have already been fetched, so they exist in a response payload, a Redis cache entry, or a Zustand store where any curious kid with devtools can read them. And a single choke point is only safe until someone adds a tenth row and forgets to route it through the filter — the failure is silent and the blast radius is a child seeing adult content.

Pushing it into each query means the restricted rows are never selected in the first place, and the homepage cache key (`homepage:{profileId}`) is inherently scoped to a profile whose maturity level was applied at build time, so a cached response can't leak across profiles. The cost is repetition — the predicate appears in nine places and a new query that forgets it is a real (if now less likely) bug. A view or row-level security policy would make it structural rather than conventional.

### 3. The homepage is 8+ sequential queries behind a 5-minute per-profile cache

`GET /api/browse/homepage` builds Continue Watching, My List, Trending, up to 3 genre rows derived from watch history, up to 2 "Because you watched" rows (each requiring a lookup of the source title *then* a genre-overlap query), New Releases, TV Shows, and Movies. On a cache miss that's a dozen-plus round trips assembled serially.

Precomputing rows offline — a batch job writing a materialized homepage per profile — is what a real system does, and it's the right answer at Netflix's profile count. It's wrong here for a specific reason: rows must react to actions the user just took. Finish an episode and Continue Watching should update; add a title and My List should show it. A precomputed row is stale exactly when the user is most attentive to it.

The 5-minute Redis TTL is the compromise. Writes that change a row — My List add/remove, a title entering or leaving Continue Watching, a profile update (a lowered maturity level) — bump `homepage-version:{profileId}`, and the cache key is `homepage:{profileId}:v{n}`, read *before* the queries run. A plain `DEL` would lose a race: a build that started before the write stores its stale rows after the delete. Ordinary position updates don't invalidate, so Continue Watching percentages can lag by up to five minutes — the fan-out cost on every heartbeat is exactly what the cache protects against.

### 4. Experiment allocation is a hash of `profileId:experimentId`, persisted on first use

Variant assignment hashes the profile-and-experiment pair to a 32-bit integer and buckets it. Hashing rather than random assignment is what makes allocation *consistent*: a user who reloads, switches devices, or hits a different API instance lands in the same variant, because the bucket is a pure function of two IDs and needs no coordination between servers. Including the experiment ID in the hash input is what keeps concurrent experiments independent — hash on `profileId` alone and every experiment would split the population along the identical seam, so the same users are always in every treatment and interaction effects become impossible to separate from main effects.

Allocations are also written to `experiment_allocations`, which is belt-and-braces: the hash already determines the answer, but persisting it means changing the bucketing function later doesn't retroactively reassign users mid-experiment and corrupt the results.

The function is named `murmurhash` but is actually `crypto.createHash('md5')` with the first 4 bytes read as a uint32. That works — MD5's avalanche is more than adequate for uniform bucketing, and this is not a security use — but it is meaningfully slower than a real MurmurHash3 and the name is misleading.

### 5. Progress is one row per `(profile_id, content_id)`, last writer wins by position timestamp, completion at 95%

Playback progress arrives as periodic `POST /:videoId/progress` carrying `clientTimestamp` (when the position was observed). `recordProgress()` inserts the row if absent, otherwise locks it and applies the write only if the timestamp is newer than `client_updated_at` — so retries and late arrivals are no-ops and a flaky network can't move the resume point backwards. `content_id` is a generated column (`COALESCE(episode_id, video_id)`) and episode rows carry their series in `video_id`. Appending every ping and reading the latest would preserve a full scrub history, but the table would grow without bound to answer a question that only ever needs one row per profile and title.

The 95% completion threshold is what turns "watching" into "watched": it moves the item out of Continue Watching (which additionally filters to 5–95% so a title you barely started doesn't clutter the row) and — only on the not-completed → completed transition, in the same transaction — inserts into `watch_history`, which is what genre-preference and "Because you watched" rows read. The threshold exists because nobody watches credits — requiring 100% would mean almost nothing ever counts as finished, and Continue Watching would fill up with titles the user considers done.

Progress writes are rate-limited to 60/minute per account, which is the guard against a misbehaving client turning the resume feature into a write flood.

## Current State

Runs end to end: account registration/login (bcrypt, Redis session under a `session_token` httpOnly cookie, no password bypass), multi-profile management with per-profile maturity levels, profile selection stored *in the session* rather than the URL, the personalized homepage described above (versioned cache), browse/detail/search with maturity filtering, and playback through sessions: entitlement checks, plan-capped quality ladders (basic 720p/1 screen, standard 1080p/2, premium 4K/4), HMAC-signed stream URLs, and screen leases renewed by progress heartbeats. The player starts a session on mount, reports progress every 10 s and on pause, flushes a final position and releases its screen with `keepalive` requests on exit, keeps its position across quality switches, and pauses with a notice if its lease was taken. My List add/remove/check and the A/B experiment API (create/list/status gated to `experiment_admin`/`admin`) round it out. Cross-cutting: sliding-window rate limiting in Redis (playback 30/min, progress 60/min, auth 5 per 5 min), an Opossum circuit breaker around the MinIO presign, Pino structured logging, Prometheus metrics (including `playback_sessions_total`, `progress_writes_total`, `stream_url_rejections_total`), health endpoints, and a retention job with per-profile data deletion.

**Tests:** `cd backend && npm test` runs 22 offline vitest tests (`services/playback.test.ts`, `services/progress.test.ts`).

Seeded by `npm run db:seed` from `backend/db-seed/base.sql`: account **`demo@netflix.local`** / **`password123`** (premium) with profiles John, Jane and Kids (maturity 1) and about fifteen titles.

Simplified or omitted: no transcoding pipeline and no segmented DASH/HLS, therefore no true adaptive bitrate — the ladder is declared in `STREAMING_CONFIG` but every rendition is the same clip; no DRM, so signed URLs are the only control and are not revocable; no CDN. Recommendations are genre-overlap and popularity ordering. No experiment metrics pipeline, so experiments can allocate but not conclude. Viewing progress lives in PostgreSQL rather than Cassandra; the LWW rule is a locked compare in a transaction rather than Cassandra write timestamps.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its Phase 1 was marked COMPLETED including "Quality selection support" under a stated learning goal of "Build adaptive bitrate streaming" — but there is no ABR: `QualitySelector.tsx` is a manual dropdown, there is no bandwidth estimator, and no segmented media exists to switch between. Phase 2 was "IN PROGRESS" with all six of its concrete items already ticked.
- **Experiment hash function is misnamed:** `murmurhash()` in `routes/experiments.ts` is MD5-based. The old doc advertised "Consistent allocation service (murmurhash)" as a completed feature, which is half true — allocation is consistent, the algorithm isn't MurmurHash.
- **Seed password comment is wrong:** `db-seed/seed.sql` annotates the bcrypt hash as `demo123`; it actually verifies against `password123`. The screenshot config was already correct, so this only ever misled humans reading the SQL.
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the Vite proxy target in `frontend/vite.config.ts`.
- **MinIO bucket bootstrap:** buckets are created by a `minio-setup` `mc` sidecar in `docker-compose.yml` rather than by application code, so a fresh `docker-compose up` has `videos` and `thumbnails` present before the API's first presign attempt.
- **Storage failures degrade instead of 500ing:** `/play` wraps the presign in `withStorageCircuitBreaker` and, on breaker-open or a missing object, returns a JSON explanation naming the expected key path — which is what makes the app demoable without uploading real video files.
- **2026-07-29 — the app looked unrealistic for three unrelated reasons.**
  1. **Every browse screenshot was the profile gate.** Profile selection is stored *in the session*, not the URL, so `/browse`, `/my-list` and `/search` all redirect to `/profiles` until one is picked. Nothing was broken — the capture flow simply never selected a profile. The screenshot config now clicks a profile tile (`data-testid="profile-tile"`) before the browse screens.
  2. **`VideoCard` is a fixed-width `flex-shrink-0` card built for the horizontal carousel**, and Search / My List drop it into a CSS grid. A fixed-width shrink-proof item overflows its grid column, so the cards clipped each other and the grid's `gap-4` vanished. Added a `layout` prop: `row` keeps the carousel width, `grid` fills the cell and shows the title under the poster (in a row the titles would compete with the row heading, so they stay hover-only there).
  3. **No media existed in MinIO**, so `/play` fell through to its JSON explanation and the player was a black rectangle. Seeding moved from a bare `seed.sql` to `npm run db:seed` (`src/scripts/seed.ts`), which applies `db-seed/base.sql` and then uploads a small CC0 clip at `videos/{contentId}/{quality}/video.mp4` for every movie and episode, at every rung of the ladder so the quality selector actually switches to something. **Note the harness rule this works around:** `scripts/screenshots.mjs` only runs a project's TS seeder when `seed.sql` has no account rows, so the SQL fixture was renamed to `base.sql`.
  - The `.mp4` key holds WebM bytes; browsers dispatch on the `Content-Type` header rather than the extension, so the object is stored as `video/webm` and plays.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).
- **2026-10-10 — playback was unauthorized and resume never saved.**
  - *Every progress write failed.* The upsert used `ON CONFLICT (profile_id, video_id, episode_id)`, which matched no index (the unique indexes were two partial ones), so PostgreSQL rejected each write and `POST /progress` returned 500. On top of that, the player's 10-second save effect depended on `currentTime`, so it was torn down on every `timeupdate` and never fired, and the unmount save read the store after `WatchPage`'s `reset()` could already have cleared it (React runs a parent's effect cleanup before its children's). Resume worked only for seeded rows. Now: a generated `content_id` with one unique index, last-writer-wins by `clientTimestamp` (`services/progress.ts`; clamped 60 s into the future), `watch_history` written once per transition to completed in the same transaction (it was re-inserted on every ping past 95% — the `ON CONFLICT DO NOTHING` there had no constraint to hit), episode rows carry their series so Continue Watching shows one card per title and series completions feed genre rows. Player: interval only while playing, save on pause, `keepalive` flush on `pagehide` and from `reset()`, position kept across quality switches.
  - *Playback had no entitlement.* `/manifest` and `/play` never checked maturity, `/play` didn't require a profile and presigned any `videos/{episodeId}/{quality}` key from query parameters, `GET /videos/:id` returned restricted titles to kids profiles, and the `videos` bucket was publicly downloadable anyway. Now `POST /sessions` checks maturity and episode ownership, caps the ladder by plan, claims a screen lease (Lua on a sorted set, 90 s, fails open), and signs each URL; `/play` verifies the HMAC and derives the key only from signed fields; the bucket is private. `GET /manifest` is gone, and so is the player's Big Buck Bunny fallback, which streamed a third-party video when the manifest failed.
  - *Smaller holes.* The demo account accepted any password (`isDemo ||` in the login check; `tests/smoke.spec.ts` relied on it with `demo123` — now `password123`). Any member could create or complete experiments; RBAC's `requirePermission` now guards them. My List writes, Continue Watching transitions and profile updates bump a homepage version (open question 1).
  - *Schema and tooling.* `init.sql` is re-runnable (it failed on `CREATE TABLE accounts` the second time) and upgrades existing volumes in place; `base.sql` backfills series ids for episode rows. vitest added (pinned `~4.0.18`, like bitly). Frontend `lint` used the removed `--ext` flag and `npm run build` failed in `tsc -b` for lack of `@types/node`; both fixed.
  - *Docs:* architecture.md rewritten around the production design (1,072 → about 500 lines) with an implementation map; the three interview answers rewritten with new overview and sequence diagrams.
  - *Verified* against PostgreSQL 16 and Redis (MinIO absent): schema loaded twice, 19 of 20 scripted curl checks passed and the 20th was a wrong expectation (presigning doesn't contact MinIO, so `/play` returns `302` even without the object; the earlier note that a missing object yields the JSON fallback was wrong).

## Open Questions

1. Buffer and error events are recorded as Prometheus counters and then dropped. To do real ABR the client needs them as *input*, not the operator as output — should QoE feed a client-side bandwidth estimate, or is the segmentation work a prerequisite that makes the question moot?
2. Experiment allocations are persisted *and* deterministically derivable, and `GET /:id/allocation` still serves a persisted variant for a paused or completed experiment. Which one is authoritative when they disagree, and should ended experiments return no variant?
3. Signed URLs live four hours and can't be revoked, and the screen limit is enforced only at session start and on heartbeats. Without DRM, is a shorter token TTL plus a manifest refresh in the player worth the complexity, or is the honest answer "this needs license renewal"?
4. LWW trusts client clocks (clamped to 60 s ahead). Should the server instead record its own receive time plus a per-session sequence number, trading cross-device ordering for immunity to bad clocks?
5. A retried `POST /sessions` takes a second screen until its 90-second lease lapses. Is an `Idempotency-Key` on session start worth it at this scale?

## Resources

- [Netflix Tech Blog](https://netflixtechblog.com/)
- [DASH-IF specifications](https://dashif.org/docs/) — what a real manifest contains and why segmentation is a prerequisite for ABR
- [MDN: Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) — the browser API a real ABR player is built on
- [Netflix: it's all A/Bout testing](https://netflixtechblog.com/its-all-a-bout-testing-the-netflix-experimentation-platform-4e1ca458c15) — experiment allocation and layered experiments
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — the pattern MinIO implements here
