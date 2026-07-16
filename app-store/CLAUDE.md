# Design App Store (App Marketplace) — Development with Claude

## Project Context

An application marketplace: developers publish apps (with icons, screenshots, and metadata), users search and browse charts, download apps, and leave reviews — and the review corpus has to stay trustworthy. The hard problems are **search that ranks on quality, not just text match**, **review integrity** (catching velocity spam and coordinated review-bombing before fake reviews distort ratings), and **reliable async processing** (a review's integrity score and a download's counters are computed off the request path without ever losing an event). Commerce is intentionally schema-only — the interesting parts here are discovery, trust, and the developer publishing pipeline.

**Learning goals:** quality re-ranking on top of full-text search, multi-signal review-integrity scoring, the transactional-outbox pattern, and a developer app lifecycle with object storage.

## Architecture at a Glance (what actually runs)

Five backing services (`docker-compose.yml`):

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** (`postgres:16-alpine`) | `pg` | Source of truth: apps (denormalized rating aggregates + `download_count` + `status`), developers, categories, reviews (`integrity_score`, `status`), `review_votes`, `rankings` (precomputed charts), `download_events`, `user_apps`, `purchases`/`app_prices` (schema-only), and `event_outbox` | ACID for the app lifecycle and the outbox; denormalized aggregates for fast app-detail reads |
| **Elasticsearch 8.11** (`@elastic/elasticsearch`) | — | App search (`multi_match`, fuzzy, `name^3`/`developer^2` boost), suggestions, and `more_like_this` for similar apps | Relevance + typo tolerance + facets Postgres full-text can't match; re-ranked by quality after retrieval |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `ioredis` | Sessions, cache-aside (search results, app detail, charts), and consumer idempotency | Sub-ms reads on the hot discovery path; dedup keys for at-least-once workers |
| **RabbitMQ** (`rabbitmq:3-management-alpine`) | `amqplib` | Async workers fed by the outbox: `reviewWorker` (integrity scoring), `downloadWorker` (download aggregation) | Durable, acked processing so integrity/analytics run off the request path |
| **MinIO** (`minio/minio`) | `minio` + `multer` | App icons, screenshots, packages; presigned upload URLs | S3-compatible object storage so large binaries don't stream through the API |

Auth is session-based (`bcryptjs`, Redis), hardened with `helmet`. The backend has a real migration runner (`scripts/migrate.ts` → `npm run migrate`) plus `scripts/seed.ts`. Frontend is React 19 + TanStack Router + Zustand v5 + `clsx`/Tailwind.

## Key Design Decisions

### 1. Review integrity scored asynchronously, six weighted signals
A submitted review lands `status = pending`; `reviewWorker` computes an `integrity_score` from six weighted signals — review velocity (0.15), content quality (0.25, penalizing generic phrases / rewarding specifics + length), account age (0.1), verified download (0.2), coordination/review-bombing spike (0.2), originality (0.1) — and promotes it to `published` or `rejected`. **Trade-off given up:** reviews aren't visible the instant they're posted (worker lag), and heuristics have false positives (a genuine one-line rave scores low) — accepted because scoring synchronously would block the write path and ML-based detection is out of scope. Note the "verified purchase" signal actually checks `user_apps` (has the user *downloaded* the app), since there is no purchase flow.

### 2. Transactional outbox for reliable event publishing
State changes write an `event_outbox` row **in the same Postgres transaction** as the change; a relay publishes unpublished rows to RabbitMQ and marks them sent. This defeats the dual-write problem — you can't atomically commit to Postgres *and* publish to a broker, so a naive "insert then publish" loses events on a crash between the two. **Trade-off given up:** an extra table, a relay hop of latency, and at-least-once delivery — so every consumer must be idempotent (Redis dedup on event id). Worth it because a lost `review.created` means a review stuck `pending` forever.

### 3. Elasticsearch retrieval + application-side quality re-ranking
Search fetches ~2× the requested results from Elasticsearch (text relevance, fuzzy, `name^3` boost), then re-ranks blending text score (~60%) with quality signals — rating, review count, downloads (~40%) — before returning the page. **Trade-off given up:** the ES index can drift from Postgres between publishes (it's synced when an app is published, not via CDC), and re-ranking adds CPU per query — but pure text ranking surfaces keyword-stuffed junk above the app users actually want, which is the whole failure mode ASO spam exploits.

### 4. Precomputed daily rankings, not per-request chart scans
Top Free / Paid / Grossing charts live in a `rankings` table keyed by `(date, country, category, rank_type)`, computed offline. **Trade-off given up:** charts are up to a day stale, accepted because ranking every app by a composite score on each homepage load would scan the whole catalog per request — precomputation turns that into a single indexed read.

### 5. MinIO with presigned upload URLs for developer media
Developers upload icons/screenshots (via `multer` → MinIO) and can request a presigned PUT URL (`getUploadUrl`) so large packages upload directly to object storage instead of streaming through the API. **Trade-off given up:** the client handles a two-step upload (get URL, then PUT), in exchange for keeping big binaries off the request-handling servers. MinIO stands in for S3 + CDN locally.

## Current State

**Implemented end to end:** register/login + become-developer; catalog (hierarchical categories, apps, top charts, app detail with denormalized ratings); Elasticsearch search with quality re-ranking, suggestions, and similar-apps; download tracking (`/apps/:id/download` → `downloadWorker` → `user_apps` + `download_count`); reviews (create with async integrity scoring, helpful/not-helpful votes, developer responses); developer portal (create/update app, submit-for-review, publish, icon + screenshot upload to MinIO, presigned upload URL, per-app analytics and reviews); transactional outbox → RabbitMQ workers; Opossum circuit breaker, health checks, Prometheus metrics, Pino/pino-http logging; `npm run migrate` + `npm run seed`.

**Schema-only or omitted (documented in `architecture.md`):** commerce — `purchases` and `app_prices` tables exist but there is **no purchase/checkout API**, subscriptions, receipt validation, or developer payouts; admin moderation UI; editorial content; personalized / ML-based ranking; and Kafka-scale event streaming (RabbitMQ locally).

## Iteration & Repair Log

- **Seed password divergence (partially unresolved):** the screenshot/triage harness applies `backend/db-seed/seed.sql`, whose hashes are all the shared `password123` (its header comment still says `admin123`/`developer123`/`user123`, which is stale). The TypeScript seeder `scripts/seed.ts` still bcrypts distinct `admin123`/`developer123`/`user123`. This pass normalized the **README** credentials table to `password123` for all three logins to match the harness seed; the `seed.ts` divergence is source code (outside the .md scope) and is flagged for a code-side fix.
- **Migration path present:** unlike projects that rely solely on the docker `initdb.d` mount, this one has `scripts/migrate.ts` (`npm run migrate`) as the schema-apply path plus `npm run seed` — so a persisted/partial volume can be re-migrated idempotently (`CREATE TABLE IF NOT EXISTS`).
- **ESM / connection-fallback pass (repo-wide):** ESM under `tsx`; `pino-http` named import; Postgres/Redis/Elasticsearch/MinIO clients fall back to docker-compose defaults when env vars are unset.

## Open Questions

1. The ES index is refreshed when an app is published, so an edited-but-not-republished app can rank on stale text. Where is the right seam for change-data-capture (outbox → ES indexer) so edits reach search within seconds?
2. Integrity scoring is fully heuristic with fixed weights. What's the minimal feedback loop (e.g., helpful-vote signal, developer disputes) that could tune weights without a full ML pipeline — and how do we avoid gaming it?
3. `rankings` is precomputed daily but there's no scheduled job wired locally. Should chart generation be a cron worker consuming download/review events, and how fresh do charts really need to be?
4. The verified-purchase integrity signal reads `user_apps` (downloads) because commerce is unbuilt. When a real purchase flow lands, does the signal split into "owns" vs "downloaded free," and does that change the weight?

## Resources

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — the trust/moderation problem this models
- [Transactional Outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) — the reliable-publish design behind `event_outbox`
- [Elasticsearch relevance tuning](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-multi-match-query.html) — the `multi_match` + boost retrieval that re-ranking builds on
