# Netflix — Architecture

## System Overview

Netflix streams movies and series to TVs, phones and browsers. The video bytes are the easy part: they are static files, encoded ahead of time and served from cache appliances inside internet providers' networks. The hard parts are wrapped around them: **starting playback correctly and fast** (is this profile allowed to watch this title, at what quality, on how many screens, with which DRM keys), **remembering exactly where every profile stopped** while millions of players report their position every few seconds, and **building a different homepage for every profile** in well under a second without ever showing a child a title above their maturity level.

This document describes the production-scale design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + MinIO + React implementation actually does.

**Learning goals**

- Separating the control plane (APIs that decide what may play) from the data plane (a CDN that serves bytes).
- Playback authorization: maturity, plan limits, concurrent-stream leases, signed URLs checked at the edge, DRM licenses.
- High-rate idempotent writes: resume positions with last-writer-wins by position timestamp.
- Per-profile personalization: precomputed rows, a live Continue Watching merge, and cache invalidation that survives races.
- Adaptive bitrate streaming and why it needs segmented media.

## Requirements

### Functional requirements

1. **Browse**: a personalized homepage of rows per profile, title details, and search.
2. **Play**: start a movie or episode, adapt quality to the network, and resume where the profile left off on any device.
3. **Remember**: Continue Watching, My List, and viewing history per profile.
4. **Profiles**: up to five per account, each with a maturity level; kids profiles see only kids titles.
5. **Plans**: the plan caps resolution (720p, 1080p, 4K) and concurrent screens (1, 2, 4).
6. **Experiment**: A/B tests on layout, artwork and ranking with stable assignment.

Out of scope: billing, offline downloads, live events, and studio tooling beyond a sketch of the encoding pipeline.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Playback start | p95 < 2 s from pressing Play to the first frame |
| Rebuffering | < 0.5% of viewing time spent stalled |
| Streaming availability | 99.99%; streams already playing survive control-plane outages |
| Homepage | p99 < 300 ms server-side |
| Resume accuracy | Within one heartbeat (≤ 30 s) of where the profile stopped; never moves backwards |
| Entitlement | A restricted profile never receives a restricted title, manifest, URL or license |
| Screen limits | Enforced within about a minute; brief overages are tolerated |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Members | ~300M accounts, ~750M profiles | Everything personal is keyed by profile, not account |
| Peak concurrent streams | ~15M | Control plane sized for starts and heartbeats, not bytes |
| Peak bandwidth | 15M × ~5 Mbps ≈ 75 Tbps | Only an ISP-embedded CDN can carry this economically |
| Playback starts | 15M streams ÷ ~1 h average session ≈ 4K/s; ~40K/s at a premiere | Entitlement + manifest + license must stay < 200 ms |
| Progress heartbeats | 15M ÷ 30 s ≈ 500K writes/s | Blind writes to a wide-column store; no read-before-write |
| Homepage loads | ~100K/s at peak | Rows precomputed; the request only merges and filters |
| Viewing state | 750M profiles × ~300 rows × ~100 B ≈ 22 TB (×3 replicas) | Cassandra, partitioned by profile |
| Encoded catalog | ~18K titles × ~1,200 files (resolution × bitrate × codec × audio) | Petabytes at origin; popular titles copied to every appliance |
| Stream leases | 15M × ~100 B ≈ 1.5 GB | Fits in one Redis cluster |

Two numbers drive the design: 500K position writes per second, which rules out read-modify-write on a relational primary, and 75 Tbps, which rules out serving video from anything we operate centrally.

### Local Development Scale

One Express process (optionally three on ports 3001–3003), PostgreSQL, Valkey, MinIO and the Vite dev server, with one demo account, three profiles and about fifteen titles. A 5-second CC0 clip stands in for every rendition. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
 ┌────────────────────────────┐                                 ┌────────────────────────────────┐
 │ Netflix app                │  GET segments (signed URLs)     │ Open Connect CDN               │
 │ TV, phone, web             ├────────────────────────────────▶│ appliances inside ISPs         │
 │ ABR player · DRM           │                                 │ video segments on disk         │
 └────────────┬───────────────┘                                 └────────────────────────────────┘
              │ (1) GET /homepage   (2) POST /playback                            ▲
              │ (3) POST /progress every 10 s                                     │ fill nightly
              ▼                                                                   │
 ┌────────────────────────────────────────────────────────────┐   ┌───────────────┴───────────────┐
 │ API gateway · session check · routing · rate limits        │   │ Encoding pipeline + S3 origin │
 └────────────┬────────────────────────────────────────────┬──┘   │ transcode · package · encrypt │
              │ (1)                                (2) (3) │      └───────────────────────────────┘
              │                                            │
              ▼                                            ▼
 ┌─────────────────────────┐     ┌────────────────────────────────────────────────────┐
 │ Homepage API            │     │ Playback API                                       │
 │ rows · search           │     │ entitlement · manifest · stream slots              │
 │ A/B layout              │     │ DRM licenses · progress writes                     │
 └──────┬───────────────┬──┘     └──────┬───────────────────┬─────────────────────┬───┘
        │ GET rows      │ in-progress   │ (3) LWW write     │ slot lease          │ (3) event
        │               │               │                   │                     │
        ▼               ▼               ▼                   ▼                     ▼
 ┌─────────────────┐  ┌────────────────────────────┐  ┌───────────────┐  ┌─────────────────┐
 │ EVCache         │  │ Cassandra                  │  │ Redis         │  │ Kafka           │
 │ rows · catalog  │  │ progress · viewing history │  │ stream slots  │  │ playback-events │
 └───┬─────────────┘  └────────────────────────────┘  └───────────────┘  └────────┬────────┘
     │ miss      ▲                           ▲                                    │ consume
     ▼           │ ranked rows, hourly       │ append views                       │
 ┌────────────┐  │                           │                                    ▼
 │ PostgreSQL │ ┌───────────────────────────────────────────────────────────────────────────┐
 │ accounts   │ │ Recommendation + history pipeline · Flink stream jobs, Spark batch        │
 │ catalog    │ │ completions → viewing history · features → ranked rows per profile        │
 └────────────┘ └───────────────────────────────────────────────────────────────────────────┘
```

1. **Browse (1).** The app asks the Homepage API for the selected profile's homepage. It reads that profile's precomputed, ranked rows from EVCache, merges in Continue Watching from Cassandra, drops anything above the profile's maturity level, and returns title ids and artwork. The recommendation pipeline rebuilds the rows hourly from viewing history.
2. **Play (2).** The app asks the Playback API to start a session. It checks maturity, plan and region, claims a stream slot in Redis, reads the resume position, and returns a manifest whose segment URLs carry a signed token. The player then fetches segments directly from an Open Connect appliance, which checks the token without calling us.
3. **Heartbeat (3).** Every 10–30 seconds the player reports its position. The Playback API writes it to Cassandra with the client's timestamp (last writer wins), renews the stream slot, and publishes a playback event to Kafka; stream jobs turn those events into viewing history and recommendation features.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Netflix app | UI, ABR player, DRM module | Devices | Picks a quality per segment; sends heartbeats |
| Open Connect CDN | Serves video segments | Bytes (Tbps) | Appliances inside ISPs, filled nightly; token check at the edge |
| API gateway | Session check, routing, rate limits | Requests | Stateless; per-region |
| Homepage API | Rows, search, experiment layout | Homepage loads (~100K/s) | Reads precomputed rows; never ranks on the request path |
| Playback API | Entitlement, manifests, slots, licenses, progress | Starts (~4K/s) + heartbeats (~500K/s) | Stateless; the only service that can say "yes, play" |
| EVCache | Ranked rows, catalog and profile metadata | Profiles | Memcached-based; losing it means slower pages and fallback rows |
| Cassandra | Resume positions, viewing history | Profiles × titles | Partition key = profile; multi-region replication |
| Redis | Concurrent-stream leases | Active streams | Needs atomic scripts, which a plain memcached cache lacks |
| Kafka | Playback events | Heartbeats | Partitioned by profile so one profile's events stay ordered |
| Recommendation + history pipeline | Viewing history, features, ranked rows | Events | Flink for streaming state, Spark for hourly batch ranking |
| PostgreSQL | Accounts, profiles, plans, catalog | Accounts | Source of truth behind EVCache; low write rate |
| Encoding pipeline + S3 origin | Transcode, package, encrypt, store | Catalog size | Offline; fills appliances during off-peak hours |

## Core Components / Request Flows

### Starting playback

```
 App                             Playback API                Redis    Cassandra   Open Connect
  │                                    │                       │          │             │
  │ 1 POST /playback {title, episode}  │                       │          │             │
  │───────────────────────────────────▶│                       │          │             │
  │                                    │ 2 maturity, plan, region         │             │
  │                                    │ 3 acquire slot (Lua)  │          │             │
  │                                    │──────────────────────▶│          │             │
  │                                    │ 4 read resume point              │             │
  │                                    │─────────────────────────────────▶│             │
  │ 5 manifest, signed URLs            │                       │          │             │
  │◀───────────────────────────────────│                       │          │             │
  │ 6 POST /license (DRM)              │                       │          │             │
  │───────────────────────────────────▶│                       │          │             │
  │ 7 device-bound keys                │                       │          │             │
  │◀───────────────────────────────────│                       │          │             │
  │ 8 GET segment?token=…                                                               │
  │────────────────────────────────────────────────────────────────────────────────────▶│
  │ 9 segment (token checked)                                                           │
  │◀────────────────────────────────────────────────────────────────────────────────────│
  │                                    │                       │          │             │
```

- **Step 2 — entitlement.** The title's maturity rating must not exceed the profile's, the title must be licensed in the member's country, and the requested episode must belong to the requested series (otherwise a harmless series id in the path could smuggle a restricted show's episode id in the body). Refusals are `403` with a reason code; the UI shows "not available on this profile".
- **Step 3 — stream slot.** One Lua script drops expired leases from `streams:{account}`, renews this session if it is already a member, and admits a new session only while the account is under its plan's limit. Otherwise the answer is `409 stream_limit` and the UI names the limit.
- **Step 5 — manifest.** The ladder is capped by plan, and every segment URL is signed with an HMAC over (session, title, rendition, expiry). Steering picks two or three appliances close to the member's ISP, so the player can fail over without calling us.
- **Steps 6–7 — DRM.** Segments are encrypted. The license server returns keys only after repeating the entitlement check and binds them to the device's DRM module; licenses expire within hours and are renewed during playback. This is the hard enforcement point: a leaked URL yields only ciphertext.

### Progress heartbeats

```
 App                      Playback API         Redis    Cassandra    Kafka      Flink job
  │                             │                │          │          │            │
  │ 1 POST /progress {pos, ts}  │                │          │          │            │
  │────────────────────────────▶│                │          │          │            │
  │                             │ 2 renew lease  │          │          │            │
  │                             │───────────────▶│          │          │            │
  │                             │ 3 USING TIMESTAMP ts      │          │            │
  │                             │──────────────────────────▶│          │            │
  │                             │ 4 playback-event                     │            │
  │                             │─────────────────────────────────────▶│            │
  │ 5 200 {lease: active}       │                │          │          │            │
  │◀────────────────────────────│                │          │          │            │
  ································· asynchronously ··································
  │                             │                │          │          │ 6 consume  │
  │                             │                │          │          │───────────▶│
  │                             │                │          │       7 crossed 95%?  │
  │                             │                │          │ 8 append view         │
  │                             │                │          │◀──────────────────────│
  │                             │                │          │          │            │
```

The heartbeat is the system's highest-rate write, so it is a blind write. Cassandra already resolves concurrent writes per cell by timestamp; writing with `USING TIMESTAMP` set to the moment the client observed the position makes "last writer wins by position time" the storage engine's own rule. A retried heartbeat carries the same timestamp and changes nothing; a heartbeat delayed behind a newer one loses; two devices watching the same profile converge on whichever position is newer. The server clamps timestamps more than a minute in the future, or one device with a fast clock would win forever.

Completion is derived, not written: a Flink job keyed by profile sees the position cross 95% and appends one history row whose key includes the session id, so a replayed event rewrites the same row. Keeping that read-modify-write out of the 500K/s path is the point.

### Building the homepage

```
 App                       Homepage API                      EVCache    Cassandra
  │                              │                              │           │
  │ 1 GET /homepage (profile P)  │                              │           │
  │─────────────────────────────▶│                              │           │
  │                              │ 2 GET rows:P                 │           │
  │                              │─────────────────────────────▶│           │
  │                              │ 3 ranked rows (precomputed)  │           │
  │                              │◀─────────────────────────────│           │
  │                              │ 4 in-progress titles for P               │
  │                              │─────────────────────────────────────────▶│
  │                              │ 5 merge, filter, A/B layout  │           │
  │ 6 rows: title ids + artwork  │                              │           │
  │◀─────────────────────────────│                              │           │
  ························· cache miss or timeout ···························
  │                              │ 7 popular-in-region rows     │           │
  │                              │                              │           │
```

Ranking runs offline: Spark jobs score every title for every profile hourly and write the result as rows (`rows:{profile}`) to EVCache. The request path only merges the live part — Continue Watching, which must reflect the episode finished five minutes ago — applies the maturity filter as a predicate on every row source, and lays rows out according to the profile's experiment cell. If EVCache misses or times out, the API returns popular-in-region rows rather than an error; a generic homepage is better than a spinner.

### Encoding and delivery (offline)

Studios deliver a high-bitrate master. The encoding pipeline splits it into shots, encodes each shot at several resolutions and bitrates (per-title, even per-shot, ladders: an animated film looks perfect at a bitrate an action film can't use), and produces about 1,200 files per title across codecs (H.264, HEVC, VP9, AV1) and audio tracks. Packaging cuts the streams into 2–6 second segments aligned across renditions, writes DASH and HLS manifests, and encrypts segments for Widevine, FairPlay and PlayReady. Files land in S3; each night, appliances fetch what their ISP's members are predicted to watch tomorrow, so over 95% of bytes are served from inside the member's own network.

### Adaptive bitrate in the player

Because renditions are segment-aligned, the player can change quality at every segment boundary:

1. Estimate throughput from recent segment downloads, smoothed with an exponentially weighted moving average.
2. Pick the highest rendition whose bitrate fits under the estimate with a safety margin, and never above the plan cap in the manifest.
3. When the buffer is low (< 10 s), drop quality aggressively; a stall costs more than a blurry minute.
4. When the buffer is healthy (> 30 s), step up one rung at a time and only after sustained headroom, so quality doesn't oscillate.
5. On repeated segment failures, switch to the next appliance in the manifest.

## Database Schema

### Production schema

Accounts, profiles and the catalog change slowly and need constraints, so they live in PostgreSQL (fronted by EVCache):

```sql
CREATE TABLE accounts (
  id          UUID PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL CHECK (plan IN ('basic', 'standard', 'premium')),
  country     CHAR(2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id              UUID PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  maturity_level  SMALLINT NOT NULL CHECK (maturity_level BETWEEN 1 AND 4),
  is_kids         BOOLEAN NOT NULL DEFAULT false,
  pin_hash        TEXT                       -- optional profile lock
);

CREATE TABLE titles (
  id              UUID PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('movie', 'series')),
  name            TEXT NOT NULL,
  maturity_level  SMALLINT NOT NULL,
  genres          TEXT[] NOT NULL DEFAULT '{}',
  duration_s      INTEGER                    -- movies
);

CREATE TABLE episodes (
  id          UUID PRIMARY KEY,
  title_id    UUID NOT NULL REFERENCES titles(id),
  season      SMALLINT NOT NULL,
  number      SMALLINT NOT NULL,
  duration_s  INTEGER NOT NULL,
  UNIQUE (title_id, season, number)
);

CREATE TABLE title_availability (
  title_id   UUID REFERENCES titles(id),
  country    CHAR(2),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ,
  PRIMARY KEY (title_id, country)
);
```

Viewing state is written at 500K/s and always read by profile, so it lives in Cassandra:

```sql
-- CQL. Writes use USING TIMESTAMP <client position time>: per-cell last writer wins.
CREATE TABLE viewing_progress (
  profile_id  uuid,
  title_id    uuid,        -- the movie, or the series an episode belongs to
  content_id  uuid,        -- what was played: the movie or the episode
  position_s  int,
  duration_s  int,
  PRIMARY KEY ((profile_id), title_id, content_id)
);

-- One row per completed view; the key is derived from the event, so a replay rewrites the same row.
CREATE TABLE viewing_history (
  profile_id  uuid,
  watched_at  timestamp,   -- time of the heartbeat that crossed 95%
  content_id  uuid,
  title_id    uuid,
  session_id  uuid,
  PRIMARY KEY ((profile_id), watched_at, content_id)
) WITH CLUSTERING ORDER BY (watched_at DESC, content_id ASC);
```

Redis and EVCache keys: `streams:{account_id}` (sorted set: member = playback session, score = lease expiry), `rows:{profile_id}:v{n}` (ranked rows; the version is bumped by writes that change a row). Kafka topic `playback-events` is partitioned by `profile_id`.

### Local schema

The local schema lives in [`backend/src/db/init.sql`](./backend/src/db/init.sql); it is re-runnable and is loaded by Docker Compose into fresh volumes.

| Production | Local | Difference |
|------------|-------|------------|
| `accounts.plan` | `accounts.subscription_tier` (`basic`, `standard`, `premium`) | Same role; drives the quality cap and screen limit |
| `profiles` | `profiles` | No profile PIN |
| `titles`, `episodes` | `videos`, `seasons`, `episodes`, `video_files` | Seasons are a table; `video_files` lists renditions (empty in the seed, so the default ladder is used) |
| `title_availability` | — | No regional licensing |
| `viewing_progress` (Cassandra) | `viewing_progress` in PostgreSQL: one row per `(profile_id, content_id)`, where `content_id` is a generated column `COALESCE(episode_id, video_id)`; `client_updated_at` is the LWW clock | Last writer wins is a locked compare in a transaction instead of cell timestamps |
| `viewing_history` | `watch_history` | Written in the same transaction as the progress row that completes |
| `streams:{account}` | same key in Valkey | Same Lua script |
| `rows:{profile}:v{n}` | `cache:homepage:{profile}:v{n}` + `homepage-version:{profile}` in Valkey | The homepage is built on request, then cached for 5 minutes |
| Experiments | `experiments`, `experiment_allocations` | Allocation is persisted on first use |

## API Design

### Production API

```
POST   /api/v1/playback                 {title_id, episode_id?} → 201 manifest + session | 403 | 409
POST   /api/v1/playback/{sid}/license   DRM challenge → license bound to this device
POST   /api/v1/playback/{sid}/progress  {position_s, duration_s, ts} → 200 {applied, lease}
DELETE /api/v1/playback/{sid}           end the session and free its slot → 204
GET    /api/v1/homepage                 rows for the selected profile
GET    /api/v1/titles/{id}              details | 403 above the profile's maturity
GET    /api/v1/search?q=&cursor=        titles visible to the profile (keyset pagination)
PUT    /api/v1/my-list/{title_id}       idempotent add; DELETE removes
GET    https://{oca}/…/{segment}?t=…    segment bytes; token checked at the edge
```

- `POST /playback` accepts an `Idempotency-Key`, so a retried start returns the same session instead of taking a second screen.
- Errors use `application/problem+json` with a machine-readable `code` (`maturity_restricted`, `stream_limit`, `not_available_in_region`).
- Heartbeats return `applied: false` for retries and late arrivals; clients treat that as success.

### Local routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Session cookie auth (bcrypt) |
| GET, POST, PUT, DELETE | `/api/profiles`, `/api/profiles/:id`; POST `/api/profiles/:id/select` | Profiles; the selected profile is stored in the session |
| GET | `/api/videos`, `/api/videos/:id`, `/:id/similar`, `/trending`, `/genres` | Catalog with maturity filtering (`403` on a restricted title's details) |
| GET | `/api/browse/homepage`, `/continue-watching`, `/my-list`, `/search` | Personalized rows (cached 5 min per profile, versioned) |
| POST, DELETE | `/api/browse/my-list/:videoId` | My List; both bump the homepage version |
| POST | `/api/stream/:videoId/sessions` | Start playback → `201` manifest, `403 maturity_restricted`, `404`, `409 stream_limit` |
| GET | `/api/stream/:videoId/play?quality&episodeId&sid&exp&sig` | Verify the signed URL, then `302` to a presigned MinIO URL |
| POST, GET | `/api/stream/:videoId/progress` | LWW progress write (and slot heartbeat); read progress |
| DELETE | `/api/stream/sessions/:sessionId` | End the session, free the slot → `204` |
| POST | `/api/stream/:videoId/buffer`, `/error` | QoE events → Prometheus counters |
| GET, POST, PUT | `/api/experiments…` | Experiments; create, update and list need the `experiment_admin` or `admin` role |
| GET | `/health`, `/health/live`, `/health/ready`, `/health/details`, `/metrics` | Operations |

## Key Design Decisions

### 1. Our own CDN inside ISPs, not a commercial CDN

At 75 Tbps, per-gigabyte CDN pricing is the largest line item in the business, and long-haul peering links become the bottleneck at 9 p.m. Open Connect appliances sit inside the member's ISP, so most bytes never cross a peering link, and because viewing is predictable (a power law plus known release dates), appliances can be filled at 4 a.m. instead of on demand. The estimated saving is the large majority of delivery cost, and quality improves because the path is shorter. The cost is operating hardware in thousands of ISP sites and building a fill and steering system — justified only because streaming quality *is* the product. A company with a thousandth of the traffic should buy a CDN.

### 2. Authorization at session start, verified at the edge by token, enforced by DRM

The edge can't call the Playback API for every 4-second segment — that would put our control plane on the data path of 15M streams. So the Playback API decides once, at session start, and encodes the decision in an HMAC token on each URL: session, title, rendition and expiry. Any appliance verifies it locally. Changing the rendition or title in the URL breaks the signature, so a basic-plan member cannot edit `720p` into `2160p`. What tokens cannot do is revoke: a URL stays valid until it expires. That's why the real enforcement is the DRM license, which is short-lived, device-bound and re-checked on renewal. Without DRM the bytes would be free for anyone holding a URL for its lifetime.

### 3. Resume positions: last writer wins by position time, with blind writes

A per-row read-modify-write at 500K/s would need a relational primary per few thousand profiles and would still serialize two devices writing the same row. Ordering by *arrival* is wrong too: a heartbeat delayed by a flaky phone network would drag the resume point back. Ordering by the time the position was observed is right, and Cassandra already implements it per cell. The costs are clock skew (bounded by clamping future timestamps) and losing the full scrub history, which only an analytics pipeline wants — and it reads Kafka.

### 4. Concurrent streams as leases renewed by heartbeats

A counter that increments on start and decrements on stop leaks: phones die, tabs close and laptops sleep, so stop events never arrive and members get locked out of their own plan. A lease with a 90-second expiry, renewed by the heartbeat the player already sends, frees the slot of any device that goes quiet. When Redis is unavailable the check fails open: a few members briefly exceeding their screen count costs less than refusing playback to everyone.

### 5. Precomputed rows, live Continue Watching

Ranking thousands of titles for a profile takes 100 ms to 1 s of model inference; at 100K homepages per second that is a fleet nobody wants. Hourly precomputation makes the request a cache read, at the cost of freshness: a title finished a minute ago can still be recommended for up to an hour. Continue Watching is the exception, because it is a fact rather than a suggestion — it is read live from Cassandra on every request.

### 6. Maturity as a predicate in every query

Filtering at the response boundary, or in the client, means the restricted titles were already fetched — into a payload, a cache entry or a client store a curious kid can open in devtools. Putting `maturity_level <= profile.maturity_level` into every row source, the title-details endpoint, the playback session and the license server means restricted rows are never selected. The cost is repetition: a new row type that forgets the predicate is a real bug, so it belongs in a shared query layer and in tests.

## Consistency and Idempotency

- **Progress** is last-writer-wins by position timestamp: retries and late arrivals are no-ops, so clients retry freely. Two devices converge on the newer position.
- **Viewing history** is keyed by `(profile, watched_at, content)` from the completing event, so a replayed Kafka event rewrites the same row; one view per transition to "completed".
- **Playback sessions** are not naturally idempotent — each start takes a screen — so `POST /playback` takes an `Idempotency-Key`. Without it, a retried start holds an extra slot until its 90-second lease lapses.
- **My List** uses `PUT`/`DELETE` on the title id; both are idempotent.
- **Homepage cache** is versioned: a write bumps `homepage-version:{profile}` instead of deleting the entry, so a homepage that was being built from pre-write data is stored under an old key nobody reads.
- **Experiment allocation** is a pure function of `hash(profile_id : experiment_id)`, persisted on first use so a later change to the bucketing can't reassign members mid-experiment.
- **Consistency choices:** stream slots, history and recommendations are eventually consistent; entitlement reads the profile's current maturity level on every session start.

## Security / Auth

- **Sessions**: an opaque token in an `HttpOnly`, `SameSite=Lax` cookie, stored in Redis with a 7-day TTL; the selected profile is part of the session, not the URL, so every request is evaluated against one profile.
- **Entitlement** on every path that can reveal content: rows, details, search, playback session, progress, license.
- **Signed URLs** for segments (HMAC, bound to session, title, rendition and expiry); the origin bucket is private.
- **DRM**: Widevine, FairPlay and PlayReady licenses bound to the device, short-lived and renewed; forensic watermarking traces leaks to an account.
- **Roles**: members are viewers; experiment, content and admin roles gate internal endpoints.
- **Rate limits** per account and per IP in Redis: playback starts 30/min, progress 60/min, login 5 per 5 minutes.
- **Profile locks**: an optional PIN keeps a kids profile from switching to an adult one; without it, maturity is a convenience filter rather than a security boundary.

## Observability

- **Quality of experience** (the product's real SLOs): time to first frame, rebuffer ratio, average bitrate, playback failures by device, ISP and appliance.
- **Control plane**: `playback_sessions_total{outcome}` (started, maturity_restricted, stream_limit, not_found), `progress_writes_total{outcome}` (applied, stale — a rising stale rate means clients retry too much or clocks are off), `stream_url_rejections_total{reason}`, slot checks that failed open, homepage cache hit ratio and fallback-row rate, Kafka consumer lag (history and Continue Watching freshness).
- **Logs and traces**: structured JSON logs with session, profile and title ids; distributed traces across the gateway and services.
- **Health**: liveness never touches dependencies; readiness checks PostgreSQL, Redis and object storage.

## Failure Handling

| Failure | What members see | Mitigation |
|---------|------------------|------------|
| Appliance down | A brief quality dip | The manifest lists two or three appliances; the player fails over per segment |
| Playback API down | New plays fail; streams already playing continue | They hold a manifest and a license; heartbeats are retried with backoff |
| Redis (slots) down | Nothing | Slot checks fail open; overage is logged and counted |
| Cassandra slow | Resume may be one heartbeat stale | Heartbeat writes time out fast and are dropped; the next one supersedes them |
| EVCache miss or timeout | A less personal homepage | Popular-in-region fallback rows |
| Recommendation pipeline late | Rows an hour or two old | Serve the previous version; alert on staleness |
| Region failure | Reconnect to another region | Stateless services, multi-region Cassandra; traffic shifted at the gateway |

Retries use exponential backoff with jitter, and services call each other through circuit breakers so a slow dependency fails fast instead of exhausting connection pools. Failure injection (terminating instances, failing a region in rehearsal) proves these paths before a real outage does.

## Scalability Considerations

**What breaks first:**

1. **Heartbeat writes** — at 500K/s, anything with a read before the write. Cassandra blind writes scale by adding nodes; Kafka partitions by profile.
2. **Premiere spikes** — a new season starts and playback starts jump tenfold. Playback API instances scale out; licenses and manifests are precomputed per title where possible; slot checks are one Redis round trip.
3. **Homepage fan-out** — solved by precomputation; the request path is a cache read plus one Cassandra partition read.
4. **Appliance fill** — a surprise hit isn't on the appliances yet; misses fall back to regional appliances, then origin, and the fill model is retrained.

| Data | Partition / shard key | Why |
|------|-----------------------|-----|
| Viewing progress and history | `profile_id` | Every read is "this profile's titles" |
| Stream leases | `account_id` | The limit is per account |
| Playback events | `profile_id` | Per-profile order for completion detection |
| Ranked rows | `profile_id` | One key per homepage |
| Catalog | Not sharded; replicated | ~18K titles fit in memory everywhere |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Video delivery | Own CDN inside ISPs | Commercial CDN | Cost and quality at 75 Tbps |
| Segment authorization | Signed URLs + DRM licenses | Origin check per request | Keeps the control plane off the data path |
| Resume position | LWW by position timestamp, blind writes | Read-modify-write; order by arrival | 500K/s; late heartbeats can't move it back |
| Completions | Derived from events | Detected in the write path | Keeps the hot write path blind |
| Screen limits | Redis leases renewed by heartbeats | Start/stop counters | Dead devices free their slot |
| Slot check outage | Fail open | Fail closed | Overage is cheaper than refusing playback |
| Homepage | Precomputed rows + live Continue Watching | Rank per request | 100K/s; facts stay fresh |
| Cache invalidation | Versioned keys | Delete on write | A racing rebuild can't restore stale rows |
| Maturity | Predicate in every query | Filter at the response | Restricted rows never leave the database |
| Viewing store | Cassandra | PostgreSQL | Write rate, partition-by-profile access |

## Implementation Notes

The local project runs all three journeys — browse, play, heartbeat — on a single-node stack: one Express process, PostgreSQL 16, Valkey 7 and MinIO from [`docker-compose.yml`](./docker-compose.yml), and a React 19 + TanStack Router + Zustand app. This section maps the production design to the code as of 2026-10-10.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Gateway + Homepage API + Playback API | One Express app with route modules | [index.ts](./backend/src/index.ts), [routes/](./backend/src/routes/) |
| Entitlement, plan caps, screen leases | Implemented as designed (no regional licensing) | [playback.ts](./backend/src/services/playback.ts), [streaming.ts](./backend/src/routes/streaming.ts) |
| Signed segment URLs checked by appliances | HMAC-signed `/play` URLs verified by the API, then a `302` to a presigned MinIO URL | [playback.ts](./backend/src/services/playback.ts) |
| Segmented DASH/HLS + ABR | A JSON manifest of whole-file renditions; manual quality picker | [streaming.ts](./backend/src/routes/streaming.ts), [QualitySelector.tsx](./frontend/src/components/VideoPlayer/QualitySelector.tsx) |
| Cassandra LWW blind writes | PostgreSQL transaction: insert-if-absent, `SELECT … FOR UPDATE`, compare timestamps | [progress.ts](./backend/src/services/progress.ts) |
| Completions derived by a stream job | `watch_history` written in the same transaction as the completing write | [progress.ts](./backend/src/services/progress.ts) |
| Precomputed rows in EVCache | 8+ queries per homepage on a miss, cached 5 minutes under a versioned key | [browse.ts](./backend/src/routes/browse.ts), [redis.ts](./backend/src/services/redis.ts) |
| ML ranking | Genre overlap and popularity | [browse.ts](./backend/src/routes/browse.ts) |
| DRM licenses | None — media is unencrypted | — |
| Kafka + Flink + Spark | None | — |

### Playback sessions, signed URLs and stream slots

`POST /api/stream/:videoId/sessions` loads the profile with its account's plan (`loadViewer`), resolves the title (`resolvePlayable` — an episode must belong to the title in the path), and checks maturity (`evaluateEntitlement`). It then claims a slot with the Lua script described above (90-second lease, limits 1/2/4 for basic/standard/premium), caps the ladder (720p/1080p/4K), and signs one URL per rendition:

```typescript
// backend/src/services/playback.ts
const canonical = [sessionId, videoId, episodeId ?? '', quality, expiresAt].join('|');
const sig = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
```

`GET /play` needs no cookie and touches neither PostgreSQL nor Redis: it recomputes the HMAC, compares in constant time, checks expiry, derives the object key only from signed fields, and redirects to a presigned MinIO URL that never outlives the token. The MinIO `videos` bucket is private, so the presigned URL is the only way to the bytes. Progress reports carrying `playbackSessionId` renew the slot; `DELETE /api/stream/sessions/:sessionId` frees it. The player starts a session on mount, sends heartbeats every 10 s while playing, pauses with a notice if the lease was lost, and on exit sends a final position and the `DELETE` as `keepalive` requests ([playerStore.ts](./frontend/src/stores/playerStore.ts), [VideoPlayer.tsx](./frontend/src/components/VideoPlayer.tsx)).

### Resume position writes

`recordProgress()` runs in one transaction: `INSERT … ON CONFLICT (profile_id, content_id) DO NOTHING`; if the row existed, `SELECT … FOR UPDATE` and apply the write only when `clientTimestamp` is newer than `client_updated_at`. A not-completed → completed transition inserts `watch_history` in the same transaction, so repeated pings during the credits record one view, and a rewatch records a second. The route validates bodies with zod, clamps timestamps more than 60 s ahead, and returns `200 {applied: false}` for retries and late arrivals. Episode rows carry their series in `video_id`, so Continue Watching shows one card per title (the latest in-progress episode) and series completions feed the genre and "Because you watched" rows.

### Homepage and personalization

The homepage is built on a cache miss from Continue Watching, My List, Trending, up to three genre rows from watch history, up to two "Because you watched" rows, New Releases, TV Shows and Movies — every query filtered by the profile's `maturity_level`. The cache key is read before any query: `homepage:{profile}:v{n}`. My List adds and removes, a progress write that adds or removes a Continue Watching item, and a profile update (a lowered maturity level) bump `n`. Redis errors degrade to building from PostgreSQL. Search is `ILIKE` over title and description plus an exact genre match.

### Auth, profiles and experiments

bcrypt passwords and a Redis session holding the account and selected profile; every account, including the demo account, must present its real password. Profiles are limited to five per account and the selected profile is checked against the account. Experiment allocation hashes `profileId:experimentId` (MD5, read as a 32-bit integer — the function is not MurmurHash) and persists it; creating, listing and changing experiments requires the `experiment_admin` or `admin` role through `requirePermission` ([rbac.ts](./backend/src/middleware/rbac.ts)).

### Operations

Redis sorted-set sliding-window rate limits ([rate-limit.ts](./backend/src/middleware/rate-limit.ts)) are mounted on playback (30/min), progress (60/min) and login/register (5 per 5 minutes per IP); the browse and profile tiers are defined but not mounted. Opossum wraps the MinIO presign ([circuit-breaker.ts](./backend/src/services/circuit-breaker.ts)). [metrics.ts](./backend/src/services/metrics.ts) exports HTTP latency, QoE counters from `/buffer` and `/error`, and the playback, progress and URL-rejection counters above. Pino writes structured logs. A retention job deletes completed progress older than 90 days and archives watch history older than two years ([watch-history-retention.ts](./backend/src/jobs/watch-history-retention.ts)).

### Verification (2026-10-10)

- `npm test` in `backend/` runs 22 offline vitest tests: token signing and tampering, plan caps, entitlement, the slot script's arguments and fail-open path, episode-to-title resolution, and the LWW rules (late reports, same-timestamp retries, one history row per completion, rewatches) against an in-memory fake transaction. Backend `tsc` and lint are clean; the frontend's `tsc`, lint (0 errors) and `npm run build` pass.
- Against real PostgreSQL 16 and Redis, with MinIO absent: `init.sql` loads twice on a fresh database and upgrades a database built from the previous schema; wrong demo password → `401`; premium session → `201` with a 240p–4K ladder; a signed URL → `302` to a presigned URL, the same URL edited to `4k` → `403`, no token → `401`; progress applied, then an older timestamp and a same-timestamp retry both `applied: false`, position unchanged; three pings past 95% → one history row; My List add visible on the next homepage; a kids profile gets `403` for a mature title's session and details; a standard account gets two sessions, a third `409 stream_limit`, and a new session after `DELETE`.

### Simplified, omitted, and known limitations

- **No real streaming pipeline**: no transcoding, segments, DASH/HLS, ABR or DRM. Every rendition is the same small WebM clip, so the quality picker switches URLs but not pictures; the player keeps its position across a switch.
- **`/play` stands in for the edge**: it redirects whether or not the object exists (presigning never contacts MinIO); the JSON fallback appears only if presigning itself fails. Tokens last four hours and cannot be revoked; there is no DRM behind them.
- **Slots are cooperative**: the server stops renewing a lost lease and the player pauses, but a modified client could keep fetching its signed URLs until they expire. Slots fail open while Redis is down. Session starts are not idempotent locally (no `Idempotency-Key`), and `streaming_active_sessions` is a per-process gauge that drifts when leases expire without a `DELETE`.
- **One database, synchronous history**: progress, history and the catalog share PostgreSQL; the homepage is built with sequential queries; recommendations are genre overlap; search is `ILIKE`.
- **Frontend**: server data is copied into Zustand stores by hand (no TanStack Query); browse rows are not virtualized.
- **Auth gaps**: no profile PINs, so any session holder can raise a profile's maturity level; registration checks the email before inserting and creates the account and its first profile outside a transaction; the global `attachRole` middleware runs before authentication and never sets a role (roles are resolved by `requirePermission` per route); allocations are still served for experiments that are no longer active.
- **Omitted**: CDN, multi-region, Kafka, ML pipelines, artwork personalization, billing, admin UI, chaos testing. The five Playwright smoke tests in [`tests/`](./tests/) check page rendering only.
