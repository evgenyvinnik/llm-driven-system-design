# Loom (Async Video Messaging) — Architecture

## System Overview

Loom lets someone record their screen, camera and microphone in the browser, press Stop, and immediately paste a link that plays for anyone they send it to. The recording is large (a three-minute recording is about 50 MB) while everything else is tiny metadata, and the product promise is about time: **the link has to work about a second after Stop**, not after a 50 MB upload and a transcode. That forces the design's central idea — the browser uploads the recording *while it is still recording*, in parts, straight to object storage — and everything else (an explicit upload state machine, background processing that never blocks playback, revocable share links, idempotent view tracking) follows from it.

This document describes the production-scale design first. [Implementation Notes](#implementation-notes) describes what the local Express + PostgreSQL + Valkey + MinIO + React implementation actually runs.

**Learning goals**

- Streaming a recording to object storage during capture with S3 multipart upload and presigned part URLs, and making completion safe to retry.
- Modelling an upload as a state machine, and reconciling uploads that clients abandon.
- Share links as revocable capabilities: checking a password once, and keeping revocation effective after playback credentials were handed out.
- Background processing with leased jobs, fencing and idempotent outputs, without making the user wait for it.
- Counting views from heartbeats without double counting.

## Requirements

### Functional requirements

1. **Record** screen, camera or both, with microphone, pause and resume, for up to an hour.
2. **Upload while recording**, so the video is playable about a second after Stop; survive network drops without re-recording.
3. **Share** a link, optionally with a password and an expiry; revoke it at any time.
4. **Watch** from the link without an account; seek to time-anchored comments.
5. **Comment**, optionally anchored to a moment in the video, with one level of replies.
6. **Analytics** for the owner: views, unique viewers, average watch time, completion rate, views per day.
7. **Library**: list, search, organize in folders, delete.

Out of scope: editing and trimming, live streaming, team workspaces and SSO, native mobile recording, captions and transcripts.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Stop → shareable link | p95 < 2 s | The product promise |
| Part URL issuance | p99 < 50 ms | On the recording's critical path every ~20 s |
| Upload durability | An acknowledged part is never lost; a network drop never loses the recording | Recordings can't be recreated |
| Share open | p99 < 100 ms server-side; first frame p95 < 1.5 s | Viewers judge the product by the first second |
| Revocation | New opens blocked at once; in-progress playback within 10 min | Sharing with the wrong person must be undoable |
| Processing | Renditions within ~1× the recording's length; original playable meanwhile | Nobody waits for a transcode |
| Analytics freshness | < 1 minute | Creators check right after sending |
| Availability | Playback 99.99%, recording and upload 99.95% | Playback is what recipients see |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Recordings | 1M/day → ~12/s average, ~35/s at peak | Small metadata write rate |
| Average recording | 3 min at ~2.2 Mbps ≈ 50 MB | Bytes must never pass through the API |
| Concurrent recorders at peak | 35/s × 180 s ≈ 6,300 | Each streams parts directly to storage |
| Upload ingress at peak | 6,300 × 2.2 Mbps ≈ 14 Gbps | Object storage absorbs it; the API sees none |
| Part URL requests | One 5 MiB part per ~19 s per recorder → ~330/s | A handful of API instances |
| New storage | 50 TB/day of sources ≈ 18 PB/year; renditions add ~0.8× | Storage tiering and lazy renditions |
| Views | 50M/day → ~580/s average, ~2,000/s peak starts | View start is cheap; heartbeats dominate |
| Heartbeats | ~240K concurrent viewers ÷ 15 s ≈ 16K events/s | A log plus a column store, not row updates |
| Playback egress | 50M views × ~30 MB ≈ 1.5 PB/day ≈ 140 Gbps | CDN in front of storage |
| Metadata | ~1 KB per video → ~365 GB/year | One PostgreSQL primary for years |

Two numbers shape the design: about 14 Gbps of recordings arrive at peak, which is why the API only signs URLs, and about 16,000 view heartbeats per second, which is why analytics goes through Kafka into a column store.

### Local Development Scale

One API process (port 3001), one optional worker process, PostgreSQL, Valkey and MinIO from Docker Compose, and the Vite dev server. Recordings are a few megabytes, so a typical local recording is one or two parts. `dev:server1..3` run extra API instances against the same infrastructure. There is no load balancer, CDN, Kafka or ClickHouse. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
 ┌─────────────────────────┐                                          ┌──────────────────────────┐
 │ Creator's browser       │                                          │ Viewer's browser         │
 │ recorder + uploader     │                                          │ share page + player      │
 └──┬─────────────────┬────┘                                          └───────┬───────┬──────────┘
    │ (1) PUT part n  │ (1) start, part URLs,       (2) GET /share/{t}        │       │ (2) HLS
    │ presigned URL   │     complete              ┌───────────────────────────┘       │ segments
    │                 ▼                           ▼ (3) POST /views                   ▼
    │    ┌────────────────────────────────────────────────────┐            ┌─────────────────────┐
    │    │ Load balancer · TLS · rate limits · /api/*         │            │ CDN                 │
    │    └──────────────────────────┬─────────────────────────┘            │ signed cookie       │
    │                               │ JSON                                 └──────────┬──────────┘
    │                               ▼                                                 │
    │    ┌────────────────────────────────────────────────────┐                       │ miss:
    │    │ Video API (stateless)                              │                       │ origin
    │    │ uploads · shares · comments · views · stats        │                       │
    │    └──┬─────────────┬──────────────────┬────────────┬───┘                       │
    │       │             │                  │            │                           │
    │       │ complete    │ rows +           │ (3) events └────────────────┐          │
    │       │ upload      │ outbox           │                             │ stats    │
    │       │             ▼                  ▼                             ▼          │
    │       │   ┌────────────────────┐   ┌─────────────────────┐   ┌────────────────┐ │
    │       │   │ PostgreSQL         │   │ Kafka               │   │ ClickHouse     │ │
    │       │   │ videos, shares,    │   │ video-uploaded,     ├──▶│ view rollups   │ │
    │       │   │ jobs, outbox       │   │ view-events         │   └────────────────┘ │
    │       │   └─────────┬──────────┘   └────────┬────────────┘                      │
    │       │             ▲                       │ consume                           │
    │       │             │                       ▼                                   │
    │       │             │ mark ready   ┌─────────────────────┐                      │
    │       │             │              │ Transcode workers   │                      │
    │       │             └──────────────┤ FFmpeg, leased jobs │                      │
    │       │                            └────────┬────────────┘                      │
    │       │                                     │ read source, write HLS            │
    ▼       ▼                                     ▼                                   ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Object storage (S3) · source uploads, HLS renditions, posters                                 │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Record and upload (1).** When recording starts, the browser creates the video and opens a multipart upload through the Video API. Every ~5 MiB of recording becomes a part that the browser `PUT`s straight to object storage with a presigned URL. On Stop it sends the small last part and calls complete; the API verifies the parts in storage, marks the video `processing` (already playable), and an outbox row tells the transcode workers to build renditions.
2. **Watch a shared link (2).** The viewer's browser asks the API for the share; the API checks the share row (and the password, once), then hands back video details and short-lived CDN credentials. The player streams HLS segments from the CDN, which fetches from storage on a miss.
3. **Count views (3).** The player reports a view on first play and a heartbeat every 15 seconds of watching, all under one view ID. The API publishes them to Kafka; ClickHouse keeps one row per view session and per-day rollups that the owner's analytics tab reads.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routing, coarse rate limits | Requests | Never sees video bytes |
| Video API | Uploads, shares, comments, views, stats queries | Part URLs + share opens (~1K/s) | Stateless; signing URLs is local HMAC work |
| Object storage (S3) | Source uploads, HLS renditions, posters | Bytes (~14 Gbps in) | Multipart upload; lifecycle rules abort stale uploads |
| CDN | Playback | Egress (~140 Gbps) | Signed cookies scoped to one video's prefix |
| PostgreSQL | Videos, upload state, shares, comments, jobs, outbox | Metadata writes | Primary + read replicas; shard by owner later |
| Redis | Sessions, rate-limit counters | Active users | Losing it blocks sign-in, not share playback |
| Kafka | `video-uploaded` and `view-events` topics | Events | Replayable; partitioned by video |
| Transcode workers | Remux, poster, HLS ladder | Minutes of video recorded | The largest compute cost |
| ClickHouse | View sessions and daily rollups | Heartbeats (~16K/s) | Ingests from Kafka |

The API never touches a video byte. A proxied 50 MB upload would hold a request open for the length of the transfer and scale the API tier by bandwidth — about 14 Gbps at peak — instead of by request rate, which is a few hundred requests a second.

## Core Components / Request Flows

### Recording and upload (write path)

```
Recorder                               Video API                      PostgreSQL   S3
    │                                      │                               │        │
    │ 1 POST /videos {id}; /uploads/start  │                               │        │
    │─────────────────────────────────────▶│                               │        │
    │                                      │ 2 INSERT video (uploading)    │        │
    │                                      │──────────────────────────────▶│        │
    │                                      │ 3 CreateMultipartUpload                │
    │                                      │───────────────────────────────────────▶│
    ························· every ~20 s while recording ···························
    │ 4 POST part-url {n}                  │                               │        │
    │─────────────────────────────────────▶│                               │        │
    │ 5 PUT part n (presigned URL)                                                  │
    │──────────────────────────────────────────────────────────────────────────────▶│
    ······························ user presses Stop ································
    │ 6 PUT last part (< 5 MiB)                                                     │
    │──────────────────────────────────────────────────────────────────────────────▶│
    │ 7 POST /complete {partCount}         │                               │        │
    │─────────────────────────────────────▶│                               │        │
    │                                      │ 8 ListParts; CompleteMultipartUpload   │
    │                                      │───────────────────────────────────────▶│
    │                                      │ 9 processing + outbox (1 tx)  │        │
    │                                      │──────────────────────────────▶│        │
    │ 10 200: share link works now         │                               │        │
    │◀─────────────────────────────────────│                               │        │
    │                                      │                               │        │
```

- **Idempotent creation.** The recorder generates the video's UUID, so a create retried after a lost response returns the same row (`INSERT … ON CONFLICT (id) DO NOTHING`). Starting the upload is idempotent too: a conditional `UPDATE … WHERE upload_id IS NULL` picks one winner if two starts race, and the loser aborts the multipart upload it opened.
- **Parts.** The recorder buffers MediaRecorder's one-second chunks and cuts a part whenever 5 MiB (S3's minimum for every part except the last) has accumulated — about every 19 seconds at 2.2 Mbps. It uploads up to two parts at once and retries each with backoff, asking for a fresh URL on every attempt because an expired URL is a common cause of failure. Part numbers follow recording order, so storage concatenates the parts into exactly the bytes the recorder produced.
- **Completion is verified against storage.** Step 8 lists the parts that storage actually holds. The API refuses to complete when any of parts 1..`partCount` is missing or a non-final part is under 5 MiB, and it stitches with the ETags storage reports rather than any the client sends. It then stats the object, and only then flips the row from `uploading` to `processing` — in the same transaction as the outbox row that triggers processing. A repeated complete finds the video already `processing` and returns it.
- **Why Stop is fast.** By the time the user presses Stop, everything but the last partial part is already in storage, so steps 6–10 move at most 5 MiB and take about a second.

The upload is an explicit state machine on `videos.status`:

```
uploading ──complete, parts verified──▶ processing ──renditions written──▶ ready
    │                                        │
    └── no part requested for 30 min         └── retries exhausted: serve the
        ──▶ failed (multipart aborted)           original ──▶ ready
```

A sweeper fails uploads that nobody has fed for 30 minutes — measured from the last part URL issued, not from the start, so a long recording is never mistaken for an abandoned one — and aborts their multipart uploads so orphaned parts stop costing money. A bucket lifecycle rule (`AbortIncompleteMultipartUpload` after 7 days) is the backstop if the sweeper's abort fails.

### Opening a share link and watching (read path)

```
Viewer                          Video API                PostgreSQL    CDN                      S3
   │                                │                         │         │                        │
   │ 1 GET /share/{t}               │                         │         │                        │
   │───────────────────────────────▶│                         │         │                        │
   │                                │ 2 share row: live? pw?  │         │                        │
   │                                │────────────────────────▶│         │                        │
   │ 3 401 password required        │                         │         │                        │
   │◀───────────────────────────────│                         │         │                        │
   │ 4 POST /share/{t}/unlock {pw}  │                         │         │                        │
   │───────────────────────────────▶│                         │         │                        │
   │                                │ 5 bcrypt once; sign grant         │                        │
   │ 6 video, grant, CDN cookie     │                         │         │                        │
   │◀───────────────────────────────│                         │         │                        │
   │ 7 GET manifest, segments                                           │                        │
   │───────────────────────────────────────────────────────────────────▶│                        │
   │                                │                         │         │ 8 miss: GET rendition  │
   │                                │                         │         │───────────────────────▶│
   ································ every ~10 min while watching ·································
   │ 9 refresh (share re-checked)   │                         │         │                        │
   │───────────────────────────────▶│                         │         │                        │
   │                                │                         │         │                        │
```

- A share is a row with a 256-bit random token, an optional bcrypt password hash, an optional expiry and a download flag. Unknown and revoked tokens both answer `404`; an expired one answers `410`.
- The password travels in a `POST` body, never a query string, so it stays out of access logs, and it is checked **once**. Success issues a signed **grant**: an `HttpOnly` cookie naming the share and the video. Later requests (refreshing playback credentials, view heartbeats, reading comments) present the grant instead of the password.
- Every use of a grant re-reads the share row, so deleting the share or letting it expire cuts off new requests immediately even though the cookie lives on. What a grant can't recall is a playback credential already issued, so those are short: CDN signed cookies scoped to the video's prefix and valid for 10 minutes, refreshed by the player through the API (step 9). That 10 minutes is the revocation bound for someone mid-playback.

### Processing (asynchronous path)

```
 Relay                    Kafka           Transcoder                      PostgreSQL   S3
   │                        │                  │                               │        │
   │ 1 video-uploaded {id}  │                  │                               │        │
   │───────────────────────▶│                  │                               │        │
   │                        │ 2 deliver        │                               │        │
   │                        │─────────────────▶│                               │        │
   │                        │                  │ 3 claim job (lease)           │        │
   │                        │                  │──────────────────────────────▶│        │
   │                        │                  │ 4 GET source.webm                      │
   │                        │                  │───────────────────────────────────────▶│
   │                        │                  │ 5 remux, probe, poster, HLS ladder     │
   │                        │                  │ 6 PUT renditions (fixed keys)          │
   │                        │                  │───────────────────────────────────────▶│
   │                        │                  │ 7 ready, if lease still held  │        │
   │                        │                  │──────────────────────────────▶│        │
   │                        │ 8 commit offset  │                               │        │
   │                        │◀─────────────────│                               │        │
   │                        │                  │                               │        │
```

- The outbox relay publishes `video-uploaded` after the completing transaction commits, so a crash can't lose the event or announce an upload that rolled back.
- A worker claims the video's job row with a **lease** (`locked_until`), incrementing `attempts`. The pair (worker, attempt) is a **fencing token**: the final write succeeds only if the row still carries it, so a worker that stalled past its lease can't overwrite the work of the worker that took over.
- Outputs go to fixed keys next to the source (`…/playback.webm`, `…/hls/720p/…`, `…/poster.jpg`), so a retried job overwrites rather than duplicates.
- MediaRecorder writes WebM without a duration or a seek index, so browsers can't seek it until it has fully downloaded — which breaks jumping to time-anchored comments. The first step is a copy-only remux (seconds, no re-encoding) that adds both; the HLS ladder follows. The video is watchable from the original the whole time.
- After five failed attempts the job is dead-lettered and the video is marked `ready` anyway, served from the original with the failure recorded. A recording that can't be transcoded is still a recording.

### Counting views

```
Player                         Video API                       Kafka                    ClickHouse
   │                               │                             │                           │
   │ 1 POST /views {viewId, 0 s}   │                             │                           │
   │──────────────────────────────▶│                             │                           │
   │                               │ 2 access check              │                           │
   │                               │ 3 view event (key videoId)  │                           │
   │                               │────────────────────────────▶│                           │
   ························· every 15 s watched; beacon on pagehide ··························
   │ 4 POST /views {viewId, 45 s}  │                             │                           │
   │──────────────────────────────▶│                             │                           │
   │                               │ 5 view event, same viewId   │                           │
   │                               │────────────────────────────▶│                           │
   │                               │                             │ 6 max seconds per viewId  │
   │                               │                             │──────────────────────────▶│
   ································· owner opens analytics ···································
   │                               │ 7 daily rollups                                         │
   │                               │────────────────────────────────────────────────────────▶│
   │                               │                             │                           │
```

A view is a playback session, not a request. The player creates a view ID on first play and repeats it in every heartbeat — every 15 seconds of actual watching, at 90% (completion), and in a `sendBeacon` when the page is hidden. ClickHouse stores one row per view ID and keeps the maximum watch time (`ReplacingMergeTree` versioned by seconds watched), so retries and late heartbeats can neither add views nor shrink watch time. The owner's own plays are not counted.

## Database Schema

### Production schema

PostgreSQL holds everything that must be correct:

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE videos (
  id                 UUID PRIMARY KEY,                  -- generated by the recorder
  owner_id           UUID NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'uploading'
                     CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  source_key         TEXT,                              -- original upload
  playback_key       TEXT,                              -- remux or HLS manifest
  poster_key         TEXT,
  upload_id          TEXT,                              -- open multipart upload
  upload_activity_at TIMESTAMPTZ,                       -- sweeper's staleness clock
  duration_seconds   INTEGER,
  size_bytes         BIGINT,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX videos_owner_created ON videos (owner_id, created_at DESC, id);
CREATE INDEX videos_uploading ON videos (upload_activity_at) WHERE status = 'uploading';

CREATE TABLE shares (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id       UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  token_hash     BYTEA NOT NULL UNIQUE,                 -- SHA-256 of the token; a DB leak leaks no links
  password_hash  TEXT,
  expires_at     TIMESTAMPTZ,
  allow_download BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author_id         UUID NOT NULL REFERENCES users(id),
  parent_id         UUID REFERENCES comments(id) ON DELETE CASCADE,  -- one level of replies
  timestamp_seconds REAL,                               -- NULL = general comment
  body              TEXT NOT NULL CHECK (length(body) <= 5000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_video ON comments (video_id, created_at);

CREATE TABLE video_jobs (
  id           BIGSERIAL PRIMARY KEY,
  video_id     UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,               -- fencing token with locked_by
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_until TIMESTAMPTZ,
  last_error   TEXT,
  UNIQUE (video_id, kind)
);

CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,                            -- 'video-uploaded'
  key          TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_pending ON outbox (id) WHERE published_at IS NULL;
```

ClickHouse holds view sessions and rollups:

```sql
CREATE TABLE view_sessions (
  video_id        UUID,
  view_id         UUID,
  viewer_key      String,                 -- user id, or an anonymous per-browser id
  started_at      DateTime,
  watched_seconds UInt32,
  completed       UInt8
) ENGINE = ReplacingMergeTree(watched_seconds)   -- keeps the row with the most watch time
PARTITION BY toYYYYMM(started_at)
ORDER BY (video_id, view_id);

CREATE MATERIALIZED VIEW views_daily
ENGINE = AggregatingMergeTree ORDER BY (video_id, day)
AS SELECT video_id, toDate(started_at) AS day,
          uniqState(view_id) AS views, uniqState(viewer_key) AS viewers
FROM view_sessions GROUP BY video_id, day;
```

Redis keys: `sess:{id}` (session), `rl:{limiter}:{key}` (rate-limit counters).

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql), loaded by Docker Compose on a fresh volume or by `npm run db:migrate`, and safe to re-run on an existing database (guarded `ADD COLUMN IF NOT EXISTS` and constraint swaps).

| Production | Local | Difference |
|------------|-------|------------|
| `videos` | `videos` (`storage_path`, `source_path`, `thumbnail_path`, `upload_id`, `upload_activity_at`, `failure_reason`, `view_count`) | `storage_path` is what plays; a denormalized `view_count` |
| `shares.token_hash` | `shares.token` | Plaintext token, so seeded demo links stay readable |
| `video_jobs` + `outbox` + Kafka | `video_jobs` only | The job row commits with the status change, which gives the outbox's guarantee without a relay; workers poll it |
| `view_sessions` in ClickHouse | `view_events` in PostgreSQL | One row per view ID, upserted; aggregated at query time |
| `comments`, `users`, folders | `comments`, `users`, `folders`, `video_folders` | Same idea |

## API Design

### Production API

```
POST   /api/v1/videos                       {id, title} → 201 | 200 same video on retry
POST   /api/v1/videos/{id}/upload           open multipart upload → {uploadId, partSize}
POST   /api/v1/videos/{id}/upload/parts     {partNumber} → presigned PUT URL (15 min)
GET    /api/v1/videos/{id}/upload/parts     parts storage already holds (resume)
POST   /api/v1/videos/{id}/upload/complete  {partCount} → video (processing) | 409 missing parts
GET    /api/v1/videos/{id}                  owner or share grant → video + playback credentials
DELETE /api/v1/videos/{id}                  aborts an open upload, deletes objects
POST   /api/v1/videos/{id}/shares           {password?, expiresAt?, allowDownload?} → token
DELETE /api/v1/videos/{id}/shares/{shareId} revoke
GET    /api/v1/shares/{token}               200 | 401 password required | 404 | 410 expired
POST   /api/v1/shares/{token}/unlock        {password} → 200 + grant cookie | 401 | 429
GET    /api/v1/videos/{id}/comments         owner or grant
POST   /api/v1/videos/{id}/comments         {body, timestampSeconds?, parentId?}
POST   /api/v1/views                        {videoId, viewId, watchedSeconds, completed}
GET    /api/v1/videos/{id}/stats            ?from&to&tz → series + as_of
```

- Errors use `application/problem+json`; rate limits are advertised with `RateLimit` headers.
- Reads of another person's video answer `404`, never `403`, so IDs can't be probed.
- Share pages set `Referrer-Policy: no-referrer`, because the token is in the URL path.

### Local routes

The local API is mounted under `/api` (no version prefix); see [Implementation Notes](#implementation-notes).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Session auth |
| GET, POST | `/api/videos` | Library (`page`, `limit`, `search`, `folderId`); create with an optional client `id` |
| GET, PUT, DELETE | `/api/videos/:id` | Details (owner or grant), update, delete (aborts an open upload) |
| POST | `/api/upload/multipart/start`, `/multipart/part-url`, `/complete` | The upload protocol |
| GET | `/api/upload/multipart/:videoId/parts`, `/api/upload/download/:videoId` | Resume listing; presigned playback URL |
| GET, POST, DELETE | `/api/videos/:videoId/comments[/:commentId]` | Comments (owner or grant to read and write; author or owner to delete) |
| POST, GET, DELETE | `/api/share/:videoId/share`, `/api/share/:videoId/shares[/:shareId]` | Create, list, revoke shares |
| GET, POST | `/api/share/:token`, `/api/share/:token/unlock` | Open a share; check its password once |
| POST, GET | `/api/analytics/view`, `/api/analytics/:videoId/analytics` | View heartbeats; owner analytics |
| GET, POST, PUT, DELETE | `/api/folders[/:id[/videos[/:videoId]]]` | Folders |
| GET | `/api/health/live`, `/api/health/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. Upload during recording, in parts, straight to storage

The obvious design records into memory, then uploads the whole file after Stop. At 2.2 Mbps a three-minute recording is about 50 MB; on a 20 Mbps uplink that is 20 seconds of "Uploading…" before the link exists — and an hour-long recording is a gigabyte that fails as one unit if the network drops at 95%. Proxying through the API is worse: it adds a hop for every byte and makes the API scale with bandwidth (14 Gbps at peak). A resumable-upload protocol such as tus solves resumption but needs its own server tier and still reassembles bytes we would then copy into object storage.

S3 multipart upload already is a resumable protocol: parts are independent, retried individually, and stitched server-side. Uploading parts as the recording produces them means Stop leaves at most one 5 MiB part to send, which is what makes the link ready in about a second. The cost is client complexity — part cutting, ordering, retries, a session that must be resumable — and a 5 MiB floor on part size that sets the granularity of progress and of loss: if the tab dies, up to one part's worth of recording since the last upload is lost unless the client also journals chunks locally (IndexedDB).

### 2. Storage decides when an upload is complete

The client's view of what it uploaded is a hint. Completion lists the parts storage holds, checks they are contiguous and correctly sized, stitches them with storage's own ETags, and stats the result before the row changes state. That makes completion idempotent (a replay finds `processing` and returns), makes it impossible to mark a video playable when its bytes aren't there, and removes any dependence on the browser being able to read `ETag` response headers (a CORS detail that breaks many multipart uploaders). The cost is one extra `ListParts` call per completion, about 20 ms.

### 3. Share links are revocable capabilities; passwords are checked once

A signed URL (HMAC over video and expiry) needs no database lookup, but it can't be revoked without rotating the key for every link. A random token looked up per open supports revoke, expiry and passwords as row attributes. Re-checking a password on every request makes a protected video cost a bcrypt computation (~100 ms of CPU) per request — an easy denial of service. Caching "this token was unlocked" would grant access to anyone holding the URL. A per-viewer signed grant cookie avoids both: bcrypt runs once per viewer, and because the grant only names the share, every use re-checks the share row. Playback credentials are the one thing that can't be recalled after issue, so they are kept short (10 minutes).

### 4. Playable first, processed later

Blocking the link on a transcode would cost about a recording's length of waiting and break the product promise. The original upload is watchable as soon as completion verifies it; processing upgrades it in the background (seek index, poster, HLS ladder) and the player switches when renditions exist. The cost is a period where seeking is poor and there is no adaptive bitrate — acceptable because most recipients open the link minutes later, when processing has finished.

### 5. Views are sessions with heartbeats, stored in a column store

Appending a row per request double-counts retries and can't express watch time; incrementing a counter loses everything but the total. A view ID per playback session, repeated in heartbeats and kept at its maximum watch time, gives exact view counts, watch time and completion from one table. At ~16K heartbeats per second PostgreSQL row updates would generate constant churn on hot videos; Kafka plus ClickHouse turns them into appends that merge in the background.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Create video | One row per recording, even when retried | Client-generated UUID; `INSERT … ON CONFLICT (id) DO NOTHING` |
| Start upload | One multipart upload per video | `UPDATE … WHERE upload_id IS NULL`; the loser aborts its own upload |
| Upload a part | Retry-safe | Re-`PUT` of a part number replaces it; fresh URL per attempt |
| Complete | One transition, one processing job | Storage-listed parts; `UPDATE … WHERE status = 'uploading'`; job/outbox row in the same transaction |
| Process | At-least-once delivery, effectively-once result | Leases; (worker, attempt) fencing on the final write; fixed output keys |
| View heartbeat | One view per session; watch time only grows | View ID upsert keeping the maximum |
| Revoke share | New requests denied at once; playback within 10 minutes | Grants re-check the share row; short-lived playback credentials |

## Security / Auth

- **Sessions:** `HttpOnly`, `SameSite=Lax` cookies backed by Redis; bcrypt for account passwords.
- **One authorization rule:** every read of a video (details, playback, comments, view reporting) passes the same check — the caller owns it, or holds a grant for a live share of it. Anything else is `404`.
- **Share tokens:** 256 random bits; stored as a SHA-256 hash so a database leak doesn't leak working links; masked in logs.
- **Share passwords:** sent in the request body, bcrypt-verified once, and rate-limited per link and client (10 failures per 15 minutes) with the limiter failing *closed*, because each attempt costs ~100 ms of CPU.
- **Upload URLs:** scoped to one part of one upload, valid 15 minutes. A presigned `PUT` can't cap its body size, so completion enforces part sizes and per-user quotas cap total storage.
- **Browser hardening:** `Referrer-Policy: no-referrer` on share pages (the token is in the path), a strict Content-Security-Policy, and no third-party scripts on the share page.

## Observability

- **Upload health:** part URLs issued per second, completion outcomes (completed, replayed, incomplete, rejected), server-side finalize latency, uploads swept as abandoned, and client-reported Stop → link latency (the product SLO).
- **Processing:** queue depth and age of the oldest queued job, attempts and dead jobs, time from upload to renditions.
- **Playback and sharing:** share opens by outcome (200/401/404/410/429), CDN hit ratio and time to first frame.
- **Analytics pipeline:** Kafka consumer lag, which is exactly how stale the dashboard is.
- Structured logs carry a request ID; share tokens are masked, and cookies and passwords are never logged. Liveness and readiness are separate endpoints.

## Failure Handling

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Network drops while recording | Recording continues; "upload paused" badge | Parts queue in the browser; per-part retries with fresh URLs; IndexedDB journal for a crashed tab |
| Tab closed mid-recording | Video ends at the last uploaded part, or fails | Sweeper fails it after 30 idle minutes and aborts the multipart upload; lifecycle rule as backstop |
| Complete response lost | Nothing; the client retries | Completion is idempotent |
| Object storage unavailable | Can't start or finish uploads; cached playback continues | Breaker fails fast with `503`; the recorder keeps buffering and retries |
| Worker crashes | Processing finishes a little later | Lease expires, another worker takes the job; fencing blocks the stale worker's writes |
| A recording that FFmpeg can't process | No poster or HLS; still plays | Five attempts, then dead-letter and serve the original |
| Redis down | Sign-in fails; share links keep working | Share viewing needs only PostgreSQL and storage; API limiter fails open, password limiter fails closed |
| Kafka down | Analytics gap | API buffers briefly, then drops and counts; dashboard flags partial data |
| PostgreSQL primary down | No new uploads or shares; in-progress playback continues | Failover to a replica; `503` with `Retry-After` |

## Scalability Considerations

1. **Upload bandwidth** scales with object storage, not with us: the API handles ~330 part-URL requests per second at peak no matter how large the recordings get.
2. **Transcoding** is the largest compute cost: about 2,100 minutes of new video arrive per minute at peak. Producing the first rendition eagerly and higher rungs only for videos that are actually watched cuts most of it, because most recordings are watched a handful of times.
3. **Playback egress** (~140 Gbps) is a CDN problem; immutable segment keys make cache hits easy.
4. **Analytics** scales by Kafka partitions (keyed by video) and ClickHouse shards.
5. **Metadata** grows ~365 GB/year; one primary with read replicas lasts years, then shard by owner or workspace so a library stays on one shard.
6. **Storage cost** is managed with tiering: sources move to infrequent-access storage after 30 days, and renditions of videos nobody has watched in a year are deleted and rebuilt on demand.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Upload timing | Multipart parts during recording | Single upload after Stop | Link ready ~1 s after Stop; failures retry one part |
| Upload path | Presigned URLs, browser → storage | Proxy through the API | API scales by requests, not 14 Gbps of bytes |
| Upload completion | Storage-listed parts, verified | Trust the client's part list | Idempotent, can't mark missing bytes playable |
| Abandoned uploads | Activity-based sweeper + lifecycle rule | Timeout from creation | Long recordings aren't mistaken for abandoned ones |
| Share links | Random token + row lookup | Signed URLs | Revocable, password and expiry as row attributes |
| Share passwords | Checked once, signed grant | Check on every request | One bcrypt per viewer, revocation still immediate |
| Processing | Play original now, transcode in background | Block until transcoded | No waiting; renditions arrive within minutes |
| Job coordination | Leases + attempt fencing | Exclusive locks held for the job | Crashed workers' jobs recover; stale writes rejected |
| View counting | View ID heartbeats, max watch time | Row per request or a counter | Exact views, watch time and completion; retry-safe |
| Analytics store | Kafka → ClickHouse | PostgreSQL row updates | 16K heartbeats/s become appends |

## Implementation Notes

The local stack runs [the API](./backend/src/index.ts) (Express, port 3001), an optional [processing worker](./backend/src/worker/index.ts) (`npm run dev:worker`), PostgreSQL 16, Valkey 7 and MinIO from [Compose](./docker-compose.yml), and the React frontend on 5173. Shared backend modules live in `backend/src/services/`.

### Production patterns implemented

**Streaming multipart upload.** [`ChunkedUploader`](./frontend/src/services/chunkedUploader.ts) receives each MediaRecorder chunk, cuts 5 MiB parts in recording order, uploads up to two at a time with exponential backoff and a fresh presigned URL per attempt, and pauses in an `error` phase whose `retry()` resends only the failed parts. [`uploadService.ts`](./backend/src/services/uploadService.ts) implements start (idempotent, race-safe), part presigning (which also bumps `upload_activity_at`), and completion that trusts only what storage lists:

```typescript
// uploadService.ts: completeUpload
const parts = await listUploadedParts(video.storage_path, video.upload_id);
const problem = findPartProblems(parts, partCount ?? parts.length); // missing, extra, < 5 MiB
if (problem) throw new UploadError(409, problem.reason, { missingParts });
await completeMultipartUpload(key, uploadId, parts.map((p) => ({ part: p.part, etag: p.etag })));
// then: stat the object, and in one transaction
// UPDATE videos SET status = 'processing' … WHERE id = $1 AND status = 'uploading'; enqueue the job
```

**Upload sweeper.** `sweepStaleUploads()` claims stale `uploading` rows with one `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` and aborts their multipart uploads afterwards, outside any transaction. Every API process runs it every 5 minutes ([`index.ts`](./backend/src/index.ts)); `UPLOAD_STALE_MINUTES` defaults to 30.

**Processing worker.** [`jobQueue.ts`](./backend/src/services/jobQueue.ts) claims jobs with `FOR UPDATE SKIP LOCKED`, a lease, and `attempts` as the fencing token; failures back off (10 s, 20 s, 40 s… up to 10 minutes) and die after 5 attempts. [`videoProcessor.ts`](./backend/src/worker/videoProcessor.ts) runs FFmpeg: a copy-only remux that adds the duration and seek index MediaRecorder omits, an `ffprobe` duration, and a poster frame, written to fixed keys next to the source and committed only if the lease still matches. A job that dies leaves the video `ready` on its original upload.

**One access rule.** [`videoAccess.ts`](./backend/src/services/videoAccess.ts) resolves owner or viewer for every read path; [`shareGrants.ts`](./backend/src/services/shareGrants.ts) signs and verifies the grant cookie (HMAC-SHA256, at most 20 grants, never outliving the share's expiry); [`routes/shares.ts`](./backend/src/routes/shares.ts) exposes `GET /api/share/:token` and `POST /api/share/:token/unlock`.

**Idempotent view tracking.** [`recordView()`](./backend/src/services/analyticsService.ts) is one statement: an upsert keyed by the client's view ID that keeps the larger watch time and a sticky `completed`, and a `view_count` bump only when the row was inserted (`xmax = 0`). [`useViewTracker`](./frontend/src/hooks/useViewTracker.ts) sends the first play, a heartbeat per 15 s watched, completion at 90%, and a beacon on page hide.

**Rate limiting.** [`rateLimiter.ts`](./backend/src/services/rateLimiter.ts) stores counters in Redis (`loom:rl:*`) on a dedicated connection with the offline queue disabled ([`redis.ts`](./backend/src/services/redis.ts)), so during a Redis outage the API limiter fails open immediately instead of stalling each request for about two seconds. The auth and share-password limiters fail closed; only failed password attempts count.

**Operational patterns.** One Opossum breaker guards storage control-plane calls, ignoring "not found" answers ([`storageService.ts`](./backend/src/services/storageService.ts)); presigning is local HMAC because the client's region is fixed. Pino logs mask share tokens, drop query strings and redact cookies and passwords ([`logger.ts`](./backend/src/services/logger.ts)). Prometheus metrics cover HTTP routes, part URLs, completion outcomes, finalize latency, sweeps and view events ([`metrics.ts`](./backend/src/services/metrics.ts)). `/api/health/live` and `/api/health/ready` (PostgreSQL + Redis) are separate, and SIGTERM stops the sweeper, drains in-flight requests and closes clients.

### Simplified or substituted

| Production | Local | Consequence |
|------------|-------|-------------|
| S3 | MinIO | Same API |
| CDN signed cookies (10 min) | Presigned GET URLs (1 hour) | A revoked viewer mid-playback keeps the current URL for up to an hour |
| Outbox + Kafka + transcoder fleet | `video_jobs` table polled by `npm run dev:worker` | Same commit-together guarantee; no replay, no fan-out |
| HLS ladder | Copy-only WebM remux + poster | Seekable and fast, but no adaptive bitrate |
| Kafka + ClickHouse views | `view_events` upsert in PostgreSQL, aggregated on read | Fine locally; no rollups |
| Hashed share tokens | Plaintext `shares.token` | Seeded demo links stay readable |
| IndexedDB chunk journal | Chunks held in memory | A crashed tab loses the recording since the last uploaded part |
| Keyset pagination, full-text search | `OFFSET` and `ILIKE` | Fine for small libraries |

### Omitted

CDN, adaptive bitrate, the transcoding ladder, multi-region, captions and transcripts, team workspaces and SSO, notifications, content moderation, and IndexedDB crash recovery.

### Known limitations

- `allow_download` is advisory: the playback URL points at the same object, so a viewer can save it.
- Presigned part URLs can't cap size; part sizes are only checked at completion, and there is no per-user storage quota.
- Workers don't renew leases: a job running past `WORKER_LEASE_SECONDS` (600) can be claimed twice. Fencing keeps the result correct but wastes the first run.
- Without a running worker, new videos stay `processing` — playable, but without a poster or seek index.
- Safari can't record WebM; the recorder shows an error instead of falling back to MP4.
- The sweeper fails abandoned uploads; it doesn't salvage the parts already uploaded.
- `view_events` grows without rollups or retention.
- Local runtime verification used moto's S3 emulator in place of MinIO (same S3 API, including the 5 MiB part minimum); the browser recorder itself was verified by unit tests and builds, not in a browser.
