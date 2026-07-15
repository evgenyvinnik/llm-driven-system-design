# Pinterest — Image Pinning Platform — Development with Claude

## Project Context

An image-pinning platform: users upload pins, organize them into boards by *saving* (not liking), discover visual content in a masonry feed, follow people, and comment. The two hard problems are visual: a **masonry grid** that lays out variable-height images without layout jank, and an **async image pipeline** that extracts the metadata (dimensions, aspect ratio, dominant color, thumbnail) the grid needs *before* the full image downloads.

**Learning goals:** variable-height virtualization, an idempotent queue-driven image-processing pipeline, a save-based (board) engagement model instead of like-based, and perceived-performance tricks (dominant-color placeholders, precomputed aspect ratios).

## Architecture at a Glance (what actually runs)

Four infrastructure services in `docker-compose.yml`, each earning its place:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Users, pins, boards, `pin_saves`, follows, comments | Relational core; many-to-many board↔pin, and the aspect_ratio/dominant_color the grid reads |
| **Valkey/Redis** (`ioredis`) | Sessions (`connect-redis`), feed cache (60s TTL), rate-limit counters | Revocable session state + a short cache that absorbs the read-heavy discover feed |
| **RabbitMQ** (`amqplib`) | Image-processing job queue | Decouples the 2–10s Sharp pipeline from the upload request; redelivery gives free retries |
| **MinIO** (`minio`) | Original images + generated thumbnails (S3-compatible) | Object storage; bucket `pinterest-images` is auto-created public by `minio-init` |

Backend: Express app (`app.ts`) with routes `auth`, `pins`, `boards`, `feed`, `users`, `search`; a standalone `workers/image-worker.ts` (Sharp); services for `pinService`, `feedService`, `imageService`, `storage`, `queue`, plus `circuitBreaker` (Opossum), `metrics` (prom-client), `logger` (pino). Frontend: React 19 + TanStack Router + Zustand + `@tanstack/react-virtual`.

## Key Design Decisions

### 1. Precomputed `aspect_ratio` (height/width), not width/height
Masonry needs each pin's rendered height *before* the image loads, or the grid reflows as images arrive. The pipeline stores `aspect_ratio = height / width` so the client computes `columnWidth * aspect_ratio` = pixel height with no division at render time. Trade-off: the value must be produced during processing and trusted by the client — a wrong ratio means a visible gap — but that's cheaper than measuring images on the client.

### 2. Async image pipeline over synchronous processing
Upload writes the original to MinIO, enqueues a RabbitMQ job, and returns `status: 'processing'` immediately. A worker extracts dimensions via `sharp.metadata()`, dominant color via `sharp.stats()`, generates a 300px WebP thumbnail, uploads it, and flips the pin to `published`. Doing this inline would block the request 2–10s and pin a worker thread per upload. Trade-off: pins briefly exist unpublished, so the UI must handle a processing state — acceptable for the decoupling and independent worker scaling.

### 3. Idempotent worker steps → safe redelivery
The worker acks only on success; a crash mid-job leaves the message unacked and RabbitMQ redelivers. Every step is idempotent: the thumbnail overwrites the same MinIO key, and the DB `UPDATE` sets absolute values (not increments) guarded on current status. So a redelivered message can't double-count or corrupt. Exhausted retries set `status='failed'` and route to a DLQ. Trade-off given up: exactly-once delivery (impossible over a network) in exchange for at-least-once + idempotency, which is the achievable correctness.

### 4. Save-based engagement (boards), not likes
There is no `likes` table. Users save pins into boards (`pin_saves` with a board reference), a pin can live in many boards, and `save_count` — not `like_count` — signals popularity. This is the model choice that makes Pinterest *Pinterest* rather than Instagram: engagement is curation, so the schema is a many-to-many collection, not a per-post counter.

### 5. Pull-model feed with a short cache
The feed is a `UNION` of pins from followed users plus popular pins, computed on read and cached in Valkey for 60s — not fanout-on-write. Trade-off: higher read latency and a query per cold request, but vastly simpler than maintaining per-user feed lists, and the 60s cache absorbs the repeated-scroll pattern. Fanout-on-write would only pay off at a follower scale this project doesn't target.

### 6. Dominant-color placeholders + WebP thumbnails
`dominant_color` (7 bytes, `#RRGGBB`) is extracted server-side and available the instant pin data loads, so the grid paints a colored tile instead of grey while the image streams in. Thumbnails are WebP@80% (25–35% smaller than JPEG) — and since every grid cell loads a thumbnail, that compression is the dominant bandwidth cost. Client-side color extraction was rejected: it needs the full image first, defeating the placeholder's purpose.

## Current State

Implemented end to end: session auth (register/login/logout/me), pin CRUD with multipart upload (multer), the RabbitMQ + Sharp image worker (dimensions, aspect ratio, dominant color, 300px WebP thumbnail), board CRUD, save/unsave to boards, follow/unfollow, pin comments, personalized + discover feed with cache, search across pins/users/boards (PostgreSQL ILIKE), Opossum circuit breakers on MinIO/RabbitMQ, Redis-backed rate limiting, Prometheus metrics, and pino logging. Frontend: masonry grid (`useMasonryLayout` + react-virtual), PinCard with dominant-color placeholder, pin detail with comments, profile (Created/Saved tabs), board view, create-pin upload, and search.

Intentionally omitted / simulated: CDN in front of object storage, Elasticsearch (search is PostgreSQL ILIKE), visual-similarity search, ML feed ranking, and multi-region. Seed data uses `picsum.photos` URLs with preset dimensions to simulate already-processed pins rather than running the pipeline on real files.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md restructure):** Replaced the "Development Phases" checklist (Phase 1–4, all `[x]`) with an accurate Current State, and added the Architecture-at-a-Glance table and this repair log. Kept the (correct) masonry, pipeline, and engagement-model reasoning.
- **Seed images:** chose `picsum.photos/id/{N}/800/{h}` URLs so seed pins have known dimensions/aspect ratios without storing real files or running Sharp — lets the masonry grid render realistically from a fresh seed.
- **Repo-wide fixes that touched this project:** ESM hardening (`connect-redis` v8 named import, `pino-http` named import); DB/Redis/RabbitMQ connection-string fallbacks to the docker-compose creds (`pinterest:pinterest123`); schema-apply via `db/migrate.ts` + `npm run db:migrate` (also mounted at `docker-entrypoint-initdb.d`); seed users normalized to `password123` (alice/bob).
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. Feed is pull-model with a 60s cache — at what follower/pin volume does a hot discover query force a move to a materialized or fanout feed?
2. Masonry relies on a trusted `aspect_ratio`; how should the client recover gracefully if the stored ratio is wrong or the image later changes dimensions?
3. Search is PostgreSQL ILIKE — when does that need Elasticsearch, and is visual-similarity search worth an embedding index?
4. Thumbnails are a single 300px WebP; should the pipeline emit a responsive set (multiple widths) for retina/large screens, and where does that cost stop being worth it?

## Resources

- [Pinterest Engineering: building the grid](https://medium.com/pinterest-engineering)
- [sharp image processing](https://sharp.pixelplumbing.com/)
- [@tanstack/react-virtual](https://tanstack.com/virtual/latest)
