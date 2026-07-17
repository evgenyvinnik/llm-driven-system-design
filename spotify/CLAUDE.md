# Spotify (music streaming) — Development with Claude

## Project Context

A music streaming platform: a catalog of artists/albums/tracks, playlists and a personal library, audio playback, personalized recommendations, and royalty-relevant stream counting. The interesting engineering tension is **serving audio bytes cheaply and securely** (you don't want to proxy every track through your app servers) while **counting streams accurately for analytics/royalties** without slowing down the play/pause hot path.

**Learning goals:** presigned-URL audio delivery (the local stand-in for a CDN), a Kafka event pipeline that decouples playback from downstream analytics, session-based playback state, and a SQL-based recommendation baseline that stands in for a real ML pipeline.

## Architecture at a Glance (what actually runs)

Four datastores/brokers from `docker-compose.yml`:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL 16** (`pg`) | Catalog, users, playlists, library, listening history, playback events, audit log | ACID relational data with lots of joins (albums→tracks→artists, playlist_tracks) |
| **Valkey/Redis** (`redis` + `connect-redis`) | Sessions, playback state (24h TTL), rate-limit counters, idempotency keys, cache, taste-profile sorted sets | Sub-ms hot-path reads; TTL for ephemeral state |
| **MinIO** (`minio`) | Audio files + cover art | S3-compatible object store; the client streams audio directly via **presigned GET URLs** (1h expiry), not through Express |
| **Kafka** (`kafkajs`, + Zookeeper) | `playback-events` topic keyed by `userId` | Decouples the playback endpoint from analytics so a play returns in single-digit ms |

Backend: Express with services `auth`, `catalog`, `library`, `playlists`, `playback`, `recommendations`, `admin`, plus an **analytics worker** (`workers/analytics-worker.ts`) that consumes Kafka and updates stream counts, listening stats, and taste profiles. Shared modules: `kafka`, `idempotency`, `rateLimit`, `metrics` (prom-client, 13 metrics), `logger` (pino), `audit`. Frontend: React 19 + TanStack Router + Zustand (a player store managing queue/shuffle/repeat) + Tailwind, HTML5 `<audio>`. Schema via `npm run db:migrate` (`src/models/migrate.ts`); seed via `npm run seed` (`src/seed.ts`, TypeScript). Demo login: `demo@spotify.local` / `password123`.

## Key Design Decisions

### 1. Presigned MinIO URLs for audio, not proxying bytes through Express
`GET /api/playback/stream/:trackId` returns a time-limited (1h) presigned MinIO URL; the browser's `<audio>` element then fetches the bytes directly from MinIO. Trade-off: the app server never touches audio bytes (it would otherwise need bandwidth for every concurrent stream), and access control is enforced by the short-lived signature rather than a session check on every byte range. The cost is that a leaked URL grants access until it expires — acceptable given the 1h window. This is the local mirror of the production "CDN + signed URL" design in `architecture.md`.

### 2. Kafka event pipeline for playback analytics (not synchronous counting)
Play/pause/skip/`stream_counted` events are produced to the `playback-events` topic keyed by `userId` (per-user ordering); the analytics worker consumes them asynchronously and updates `stream_count`, daily listening stats, and Redis taste-profile sorted sets. Trade-off: stream counts lag real time by seconds, but the playback endpoint responds in ~ms and stays decoupled from every downstream consumer. If the worker is down, events sit durably in Kafka and are processed on recovery — nothing is lost. A stream only counts after 30s / 50% played, matching industry practice.

### 3. Idempotent stream counting via Redis `SET NX EX`
A playback session derives an idempotency key from `userId + trackId + session start`, checked atomically with `SET NX EX` (24h TTL), so a network retry storm can't double-count a stream toward royalties. Trade-off: an extra Redis round-trip per event, cheap insurance against inflated counts.

### 4. Redis-backed sessions (not JWT)
Session auth with httpOnly cookies allows instant revocation on logout, ban, or premium up/down-grade by deleting the Redis key — valuable when subscription state changes gate features immediately. Trade-off: a Redis lookup per request, but Redis is already on the hot path for playback state and rate limits, so it adds no new dependency.

### 5. SQL "same-artist + popular" recommendations as the ML stand-in
Recommendations come from the user's recent listening history and liked tracks: find unlistened tracks by artists they already play, then fill with popular tracks. Trade-off: no collaborative filtering or embeddings, so discovery is shallow — but it's deterministic, needs no training pipeline, and demonstrates the shape of a "For You" / Discover Weekly / artist-radio API. The production design (vector similarity, taste embeddings) is described in `architecture.md`.

## Current State

**Implemented end to end:** catalog browse/search (Postgres `ILIKE`), playlists CRUD + add/remove tracks, library (liked songs, saved albums, followed artists), playback with presigned streaming URLs and a full queue/shuffle/repeat player store, playback event production to Kafka + the analytics worker consuming it, recommendations (for-you, discover-weekly, popular, similar, artist-radio), session auth, admin API over the audit log, plus idempotency, rate limiting, Prometheus metrics, structured logging, health checks, and graceful shutdown (Kafka/Redis/PG disconnect).

**Intentionally omitted / simplified:** a real CDN (MinIO presigned URLs stand in); Elasticsearch (Postgres `ILIKE` search); Cassandra for listening history (single Postgres table); ML recommendation pipeline / vector embeddings; DRM and audio encryption; offline downloads and license handling; Spotify Connect real-time multi-device push (playback state is saved/restored via Redis but not pushed); ad insertion and a royalty payment system.

## Iteration & Repair Log

- **2026-07 (README drift correction):** the README's tech stack and "This starts…" infra list omitted **Kafka** even though `docker-compose.yml` runs Kafka + Zookeeper and the analytics worker is a Kafka consumer; the project-structure block listed `.js` files (`db.js`, `index.js`, `seed.js`) though the backend is TypeScript. Added Kafka + the analytics worker to the stack, added `npm run db:migrate` / `npm run dev:worker` to setup, corrected file extensions, and bumped Node 18→20.
- **Seed password already normalized:** `src/seed.ts` hashes `password123` for `demo@spotify.local` — consistent with the repo-wide login password; no change needed.
- **Docs verified against code, not assumed:** confirmed presigned-URL streaming (`storage.ts` `presignedGetObject`), the `playback-events` topic name and `userId` keying (`shared/kafka.ts`), and the 30s/50% stream-count rule (`playbackService.ts`).

## Open Questions

1. Stream counting is idempotent per session, but the "30s or 50%" trigger is client-reported — how is a client that lies about playback progress (to inflate royalties) detected server-side?
2. Presigned URLs are user-scoped for analytics but shareable within the 1h window; is that acceptable, or does audio need per-segment tokenization (HLS) even locally?
3. Recommendations are same-artist + popular; what's the smallest real signal (co-listen matrix, simple ALS) that would meaningfully improve discovery without a full ML pipeline?
4. Playback state is persisted to Redis but not pushed to other devices — what transport (WebSocket) would Spotify-Connect-style handoff need, and does that change the session model?

## Resources

- [Personalized Recommendations at Spotify](https://engineering.atspotify.com/2022/06/personalized-recommendations-at-spotify/)
- [Kafka — design & delivery semantics](https://kafka.apache.org/documentation/#design)
- [MinIO presigned URLs](https://min.io/docs/minio/linux/developers/javascript/API.html#presignedGetObject)
