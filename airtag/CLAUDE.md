# Design AirTag (Find My) — Development with Claude

## Project Context

A privacy-preserving item tracker modeled on Apple's Find My network: an owner registers devices (AirTag, iPhone, …), a crowd-sourced network submits **end-to-end-encrypted** location reports the server can never read, and only the owner — holding the device's master secret — can derive the rotating identifiers and decrypt positions. The hard problem is being *useful* (owner can always locate the tag) while being *zero-knowledge* (the server, and anyone who steals its database, learns nothing about where any device or person is). A second first-class concern is **anti-stalking**: detecting an unknown tracker that follows a victim.

**Learning goals:** deterministic time-rotating key derivation, zero-knowledge server design, crowd-sourced high-write ingestion, and heuristic anti-stalking detection.

## Architecture at a Glance (what actually runs)

Three backing services (`docker-compose.yml` — Postgres, Valkey, RabbitMQ):

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** (`postgres:16-alpine`) | `pg` | `location_reports` (encrypted JSONB blobs keyed by `identifier_hash`), `registered_devices` (master_secret), `decrypted_locations` (owner cache), `tracker_sightings`, `lost_mode`, `notifications`, `users` | Plain Postgres — no PostGIS; geo is `DECIMAL(lat,lng)` and distance is app-side Haversine. B-tree index on `(identifier_hash, created_at)` is the whole read path |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `ioredis` | Session store (`connect-redis` + `express-session`), cache-aside, and distributed rate-limit counters (`rate-limit-redis`) | Session revocation + rate-limit state shared across the `dev:server1..3` instances |
| **RabbitMQ** (`rabbitmq:3-management-alpine`) | `amqplib` | Async ingestion of location reports (`location-worker`) and notification delivery (`notification-worker`) | Absorbs the crowd-sourced report firehose off the request path; at-least-once with idempotency |

There is **no PostGIS, no object storage, and no circuit breaker** — the architecture doc explains the last one deliberately (there is no independently-failing external service to wrap; reports write straight to Postgres). Frontend is React 19 + Zustand v5 + **Leaflet/react-leaflet** for the map, routed by a single `App.tsx` tab switch (no TanStack Router).

## Key Design Decisions

### 1. Deterministic 15-minute key rotation (owner derives, server correlates nothing)
`KeyManager` (in `utils/crypto.ts`) derives a per-period key with `HMAC-SHA256(master_secret, "airtag_key_" + period)` where `period = floor(now / 15min)`, then an identifier and its SHA-256 hash. The tag broadcasts a rotating identifier; the server stores only `identifier_hash`. To locate a tag over a time window the owner regenerates the hash for *every* period in that window and queries by hash. **Trade-off given up:** a wide window fans out — 24h is 96 hashes, 7 days ~672 — so "show me last week" is a multi-hash `IN`/loop lookup rather than one indexed row. Chosen because it makes cross-report correlation impossible for anyone but the owner.

### 2. Zero-knowledge server: encrypted blobs, never plaintext
Finder devices encrypt `{lat, lon, accuracy, ts}` with AES-256-GCM under a key derived from the device secret (a simplified stand-in for Apple's ECIES/P-224), and the server persists the opaque `encrypted_payload` JSONB. Decryption happens only in the owner's authenticated session, caching results into `decrypted_locations` for fast map reads. **Trade-off given up:** the server can do *nothing* with location data — no server-side geofencing, no "devices near here", no analytics — and there is no master-secret recovery, so a lost secret means a permanently unlocatable tag. That is the price (and the point) of zero-knowledge.

### 3. No PostGIS — Haversine in application code
Distances (anti-stalking "is this tracker following me?") use the Haversine formula over `DECIMAL` lat/lng columns rather than a spatial type/index. **Trade-off given up:** fine for point-to-point checks over one user's small sighting set, but there is no spatial index, so a "find all sightings within radius X" query would be a full scan — acceptable because the actual query is always scoped to one `(user_id, identifier_hash)`.

### 4. Anti-stalking as heuristics, not ML
`antiStalkingService` flags a tracker when a user accumulates 3+ sightings of the same `identifier_hash` spanning >1 hour and >500m of travel, with a 1-hour per-tracker alert cooldown, then writes an `unknown_tracker` notification. **Trade-off given up:** pure thresholds produce false positives (a friend's tag riding along) and false negatives (a slow follower), where Apple layers in separation-from-owner signals and BLE proximity — out of reach without hardware here.

### 5. Redis-backed sessions + Redis rate limiting (not JWT, not in-memory limits)
Sessions live in Redis via `connect-redis` so any of the three backend instances can serve a request and logout is instant; `express-rate-limit` + `rate-limit-redis` share throttle counters across instances so the report-ingestion endpoint can't be flooded per-node. **Trade-off given up:** Redis becomes a hard dependency for both auth and abuse-protection; a Redis outage degrades login and rate limiting, not just cache.

## Current State

**Implemented end to end:** register/login with Redis sessions and bcrypt; device registration generating a master secret; time-rotating identifier derivation (`KeyManager`); encrypted report submission ingested asynchronously by `location-worker`; owner-side decryption with a `decrypted_locations` cache; Leaflet map with location-history trail (simulated by clicking the map); lost mode with contact info + `device_found` notifications; anti-stalking sighting recording, heuristic detection, and unknown-tracker alerts; admin dashboard (system stats, all users/devices, lost devices); Redis rate limiting; Prometheus metrics, Pino/pino-http structured logging, and health checks.

**Simulated or omitted (documented in `architecture.md` Implementation Notes):** real BLE beaconing and NFC (no hardware — locations are map clicks); production ECIES over P-224 with an HSM (uses AES-256-GCM symmetric + a demo ephemeral key); UWB precision finding; sound playback; real push notifications; master-secret recovery; and Kafka/Cassandra-scale ingestion (RabbitMQ + Postgres locally).

## Iteration & Repair Log

- **ESM / dependency modernization (repo-wide):** backend runs as ESM under `tsx`; the repo-wide passes fixed `connect-redis` and `pino-http` to named imports and added DB/Redis connection-string fallbacks to the docker-compose defaults (`findmy`/`findmy_secret`, `redis://localhost:6379`). Frontend was moved to React 19, which required `react-leaflet` v5 (v4 peer-deps on React 18) — that is why the map stack is pinned to `leaflet@1.9` + `react-leaflet@5`.
- **Seed password normalization (unresolved for this project):** the repo-wide effort normalized seeded logins to `password123`, but `backend/db-seed/seed.sql` still seeds `admin@findmy.local` with a comment reading `password: admin123` and its original hash. It is a source `.sql` file (outside the .md-only scope of this pass) and no `.md` exposes the credential, so nothing was changed here — flagged so the seed hash/comment can be reconciled to `password123` in a code pass.
- **Deliberate non-implementations recorded:** the architecture doc's Deep-Pattern section explicitly notes *why* there is no circuit breaker here (no independently-failing external dependency to wrap) rather than leaving it as an unexplained gap — kept as a decision, not a TODO.

## Open Questions

1. Owner queries derive one hash per 15-minute period; at "last 30 days" that is ~2,880 hashes per device. When does this need a server-assisted range index or a coarser rotation for cold history, without weakening unlinkability?
2. Report ingestion writes every encrypted blob to Postgres. At what report rate does this need partitioning by `reporter_region` / time (the doc's Kafka + Cassandra path), and how is idempotency preserved across that boundary?
3. Anti-stalking thresholds (3 sightings / 500m / 1h) are static. Should they adapt to context (transit vs. walking) to cut false positives, and can that be done without the server learning the user's movements?
4. The master secret sits in `registered_devices` in plaintext (flagged in-schema as "would be encrypted in production"). What is the minimal local upgrade — envelope encryption with a KMS-style key — that keeps the zero-knowledge property honest?

## Resources

- [Apple Platform Security: Find My](https://support.apple.com/guide/security/find-my-seca1a1b1c1d/web) — the rotating-key, zero-knowledge design this models
- [Security Analysis of Apple's Find My Network (USENIX '21)](https://www.usenix.org/conference/usenixsecurity21/presentation/heinrich) — where the simplified crypto here diverges from production
- [ECIES](https://en.wikipedia.org/wiki/Integrated_Encryption_Scheme) — the asymmetric scheme AES-256-GCM stands in for locally
