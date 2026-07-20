# TikTok — Development with Claude

## Project Context

The interesting thing about TikTok is that it has almost no social graph to lean on. Instagram and Twitter can build a feed out of "people you follow"; TikTok's default surface — the For You Page — has to be good for a user who follows nobody, on their first session, with zero history. That inverts the usual problem: instead of ranking a known candidate set, the hard part is *producing* a candidate set at all, then ranking it well enough that the user keeps scrolling.

The second hard part is that the engagement signal is not a click. A click is binary and instant; watch time is continuous and only known after the fact. The whole feedback loop here is built around recording how long someone actually watched and what fraction of the video they completed — which means the signal arrives when the user scrolls *away*, not when the video appears. That timing shapes both the client (the player has to measure and report on unmount) and the ranking (engagement counters are the aggregate of those reports).

Third, this is a video feed, so the client is as much of a systems problem as the server. A hundred `<video>` elements mounted at once is a hundred media decoders and a hundred network buffers; the browser will not survive it.

**Learning goals:** two-phase recommendation (candidate generation → ranking), cold-start handling for both new users and new videos, exploration-vs-exploitation in a ranked feed, vector similarity search inside Postgres, and virtualized full-screen media rendering.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Single Express process; `dev:server1/2/3` also exist to run 3001–3003 for multi-instance testing |
| **PostgreSQL** (`pgvector/pgvector:pg16`) | 5432 | Not plain Postgres — the image is chosen for the `vector` extension, since embeddings live in the same tables as the rows they describe |
| **Valkey (Redis)** | 6379 | Session store (`connect-redis`, prefix `tiktok:session:`) and the backing store for `rate-limit-redis` counters |
| **MinIO** | 9000 / 9001 | S3-compatible video + thumbnail storage; `minio-init` creates the `videos` and `thumbnails` buckets and makes them public |

Backend routes live in `backend/src/routes/` (`auth`, `users`, `videos`, `comments`, `feed`), with the recommendation logic concentrated in `routes/feed.ts` and the vector work in `services/embeddings.ts`. Cross-cutting modules are in `backend/src/shared/`: `logger.ts` (Pino + request IDs), `metrics.ts` (prom-client, including `fypLatencyHistogram` and a `recommendationLatencyHistogram` labeled by phase), `rateLimiter.ts`, `circuitBreaker.ts` (Opossum), `retry.ts`, `retention.ts`. Schema is `backend/src/db/init.sql` — `users`, `videos`, `follows`, `likes`, `comments`, `watch_history`, `user_embeddings`.

Frontend is React 19 + TanStack Router (file-based, `frontend/src/routes/`) + Zustand (`stores/feedStore.ts`, `stores/authStore.ts`) + Tailwind, with `@tanstack/react-virtual` driving the feed. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. Candidate generation and ranking are separate phases, not one SQL `ORDER BY`

`getPersonalizedFeedInternal()` pulls roughly `limit × 5` candidates from four independent sources — 30% followed creators, 20% hashtag-preference matches, 20% embedding neighbors, 30% trending — deduplicates them into a map, and only then scores them in application code. The alternative, one query with a big `ORDER BY (like_count * 2 + view_count * 0.1 + ...)`, is what `getTrendingFeed()` actually does for anonymous users, and it's instructive to see why it can't be the personalized path: those signals are heterogeneous. Cosine distance in pgvector, a JSONB hashtag-preference lookup, and a join against `follows` cannot be expressed as one comparable expression, and even if they could, the database would have to score every active video to sort them. Splitting the phases means the expensive scoring function only ever sees ~50 rows for a 10-video page. What we give up is global optimality — a genuinely perfect match that no source happened to retrieve is invisible to ranking, permanently. That's the standard recall/latency trade in two-stage recommenders, and the fix is more retrieval sources, not a better ranker.

### 2. Embeddings live in Postgres via pgvector, not in a dedicated vector database

`videos.embedding` and `users.interest_embedding` are `vector(384)` columns with IVFFlat indexes (`lists = 100`, cosine ops). The reason to keep them in Postgres is that every embedding query here is *also* a relational query: we need the creator join, the `status = 'active'` filter, and the "not in my watch history" exclusion in the same statement. With a separate vector store you retrieve k nearest neighbors, then discover that half of them are deleted, already watched, or from a blocked creator — so you over-fetch, round-trip back to Postgres to filter, and re-fetch when you come up short. Colocating makes it one query with a `WHERE` clause. The cost is that IVFFlat is approximate and its recall depends on `lists`/`probes` tuning, and that vector search now competes for the same connection pool as ordinary reads — at real scale this is exactly where you'd split it out.

### 3. The personalized feed sits behind a circuit breaker that falls back to trending

`recommendationBreaker` wraps `getPersonalizedFeedInternal` with a 5s timeout, 50% error threshold, 15s reset, and a volume threshold of 20. When it opens, `handleFYP` catches `Breaker is open` and serves `getTrendingFeed()` instead. This matters because the FYP is the entire product — there is no meaningful "sorry, feed unavailable" state. Without the breaker, a slow pgvector index scan doesn't fail, it *hangs*: requests pile up holding connections, the pool exhausts, and unrelated endpoints (login, comments) start timing out because they can't get a connection either. One slow subsystem takes down the app. Falling back to trending degrades quality — every user sees the same globally-popular videos, so it is visibly worse for anyone with a strong profile — but the feed still scrolls. The embedding source has its own narrower guard: `generateCandidates` wraps it in try/catch and logs "Embedding recommendations failed, skipping", because losing one of four sources should not lose the page.

### 4. The feed is virtualized with `overscan: 1`, not the usual 3

Most virtualized lists in this repo use `overscan: 3`. The feed here deliberately uses 1, because the items aren't DOM nodes — each one mounts a `<video>` element. Rendering ahead means allocating a media decoder and a network buffer per lookahead item, and on mobile hardware the decoder count is a hard, small limit; exceed it and playback fails outright rather than degrading. One item above and below is enough to make the snap-scroll transition seamless without holding more than three decoders. The trade-off is that a fast flick can outrun the render and briefly show an unpainted panel. `VideoPlayer` compensates by pausing and resetting `currentTime = 0` whenever `isActive` goes false, so a video that scrolls out of view stops consuming bandwidth immediately rather than continuing to buffer off-screen.

### 5. Views are recorded on scroll-away with a completion rate, not on impression

`VideoPlayer` starts a timer when it becomes active and, when it becomes inactive, computes `watchDurationMs` and `completionRate = currentTime / duration` before calling `POST /api/videos/:id/view`. Counting a view on impression would make the metric meaningless in a feed that auto-plays — every video the user scrolled past at speed would count identically to one they watched three times. Since ranking is downstream of these counters, an impression-based view count would train the feed to favor whatever appears early in the candidate list, a self-reinforcing loop with no relationship to whether anyone enjoyed the video. The cost is that the signal is lost if the tab closes on the last video watched, and that ranking currently uses only the aggregate counters — the per-row `completion_rate` in `watch_history` is stored but not yet fed back into scoring.

## Current State

Runs end to end: API on 3001, session auth in Redis, video upload through Multer to MinIO (with presigned upload/download helpers in `storage.ts`), the four-source FYP with ranking and 20% exploration, following/trending/hashtag feeds, in-feed search across descriptions, usernames and hashtags, likes, threaded comments with replies, follow/unfollow, per-video `GET /:id/similar` over pgvector, view recording with watch duration, per-route rate limiting (upload 3/hr, register 10/hr, login 5 per 15min, feed 100/min, search 30/min), Prometheus metrics on `/metrics`, `/health` with per-dependency latency and breaker states, plus `/health/live` and `/health/ready`. Frontend covers the virtualized feed, discover, upload, profile, inbox, and settings.

Seeded logins (all `password123`): `alice_dance`, `bob_comedy`, `charlie_cook`, `diana_fitness`, `eddie_music`, and `admin` (role `admin`).

**Embeddings are simulated.** `services/embeddings.ts` generates random 384-dimensional vectors rather than calling a model — the vector *plumbing* (storage, IVFFlat indexes, cosine queries, user-vector aggregation from watch history) is real and exercised, but the vectors carry no semantic meaning, so "similar videos" results are arbitrary. In production this would be sentence-transformers over description + hashtags and CLIP over frames, run as a background job. Also simplified: no transcoding to HLS/DASH ladders (uploads are served as-is), no CDN, and `shared/retention.ts` defines storage tiers and archival policy that nothing schedules yet.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md. Its "Phase 1" left `- [ ] CDN setup` unchecked next to `- [x] Basic transcoding` — but there is no transcoding in this codebase at all; uploads go straight to MinIO. It also marked Phase 2 "In Progress" while every item under it was checked, and buried the actual candidate-source split in three places with three different percentage sets (40/30/30, then 30/20/20/30). The code says 30/20/20/30; that's what this file records.
- **Routes mounted after async session setup (fixed):** `app.use('/api/...')`, the 404 handler, and the error handler were being registered at module load, which placed them *before* the session middleware that `setupSession()` adds asynchronously. `req.session` was therefore undefined in every route handler, and login died with `Cannot set properties of undefined (setting 'userId')`. All of it moved into `mountRoutesAndHandlers()`, called from `start()` after `await setupSession()` — see the comment block above that function.
- **Backend port pinned:** the `dev` script is `PORT=3001 tsx watch src/index.ts` so it matches the Vite proxy target in `frontend/vite.config.ts`. Without the pin, `index.ts` falls back to `process.env.PORT || 3000` and the frontend proxies into nothing.
- **Postgres image is `pgvector/pgvector:pg16`:** plain `postgres:16` cannot load `init.sql`, which runs `CREATE EXTENSION vector` and creates IVFFlat indexes — schema load fails at container init and the database comes up empty.
- **Embedding source made non-fatal in candidate generation:** a throw from `getEmbeddingBasedRecommendations` used to abort the whole FYP request; it is now caught and logged, dropping that one source.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. `completion_rate` is written to `watch_history` on every view but never read by `rankVideos`. Is watch-through rate a better ranking signal than raw like counts — and if we use it, how do we stop it from systematically favoring short videos, which trivially reach 100%?
2. Exploration is currently `Math.random() < 0.2 → score += Math.random() * 5`, applied per candidate at ranking time. That perturbs an already-retrieved set; it doesn't retrieve anything new. Should exploration move up into candidate generation, where it could actually surface a video no source would have returned?
3. IVFFlat with `lists = 100` is tuned for a seeded corpus of dozens of videos, where an exact scan would be faster anyway. At what corpus size does the approximation start paying for itself, and does HNSW become the better index before that point?
4. `generateCandidates` excludes already-watched videos with `NOT IN (SELECT video_id FROM watch_history WHERE user_id = $1)`. That subquery grows without bound per user. Is a Redis-backed bloom filter of seen video IDs the right shape, accepting false-positive suppression of a video the user never actually saw?

## Resources

- [How TikTok recommends videos](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you) — the official description of the multi-signal ranking model
- [pgvector](https://github.com/pgvector/pgvector) — IVFFlat vs HNSW index trade-offs and `lists`/`probes` tuning
- [Deep Neural Networks for YouTube Recommendations](https://research.google/pubs/pub45530/) — the canonical two-stage candidate-generation/ranking paper
- [TanStack Virtual](https://tanstack.com/virtual/latest) — the virtualizer behind the feed
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — the breaker wrapping the recommender
