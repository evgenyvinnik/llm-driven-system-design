# 🎥 Loom (Async Video Messaging) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Loom looks like a video upload site, but the product promise is about time: you press Stop and the link works a second later. Two things make that hard. First, a 50 MB recording has to already be in storage when recording ends, so the upload has to happen *during* the recording, in parts, straight to object storage — the API should never touch a video byte. Second, a share link is a capability handed to people without accounts, so revoking it has to actually cut access, even after we've handed out playback credentials."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the two numbers that drive the design |
| High-level architecture | 10 min | One overview and the three core flows |
| Data model & API | 7 min | What lives where, and the upload protocol |
| Deep dive 1: upload while recording | 8 min | Multipart parts, verified completion, abandoned uploads |
| Deep dive 2: revocable share links | 7 min | Tokens, one-time password checks, short-lived playback credentials |
| Deep dive 3: processing without waiting | 5 min | Leases, fencing, playing the original first |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin the scope down first, because 'Loom' covers recording, editing, transcripts and team workspaces, and I want to spend the time on the parts that are architecturally interesting."

### Functional requirements

1. **Record** screen, camera or both, with microphone and pause/resume, in the browser, for up to an hour.
2. **Upload while recording**, so the video is playable about a second after Stop, without losing the recording when the network drops.
3. **Share** a link, optionally with a password and an expiry, and revoke it at any time.
4. **Watch** from the link without an account, and jump to time-anchored comments.
5. **Comment**, optionally anchored to a moment, with one level of replies.
6. **Analytics** for the owner: views, unique viewers, average watch time, completion rate.

Out of scope: editing and trimming, live streaming, team workspaces and SSO, native mobile apps, transcripts.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Stop → shareable link | p95 < 2 s | The product promise |
| Part URL issuance | p99 < 50 ms | On the recording's path every ~20 s |
| Upload durability | An acknowledged part is never lost | A recording can't be recreated |
| Share open | p99 < 100 ms server-side; first frame p95 < 1.5 s | Recipients judge us by the first second |
| Revocation | New opens blocked at once; in-progress playback within 10 min | "I sent it to the wrong person" must be fixable |
| Analytics freshness | < 1 minute | Creators check right after sending |
| Availability | Playback 99.99%, recording 99.95% | Playback is what recipients see |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Recordings | 1M/day → ~12/s average, ~35/s peak | Tiny metadata write rate |
| Recording size | 3 min at ~2.2 Mbps ≈ 50 MB | Bytes must bypass the API |
| Concurrent recorders | 35/s × 180 s ≈ 6,300 at peak | Each streams to storage |
| Upload ingress | 6,300 × 2.2 Mbps ≈ 14 Gbps | Object storage takes it; the API sees none |
| Part URL requests | One 5 MiB part per ~19 s per recorder → ~330/s | A few stateless API instances |
| Storage | 50 TB/day ≈ 18 PB/year of sources | Tiering; lazy renditions |
| Views | 50M/day → ~2,000 view starts/s at peak | Cheap |
| Heartbeats | ~240K concurrent viewers ÷ 15 s ≈ 16K/s | A log and a column store |
| Playback egress | ~1.5 PB/day ≈ 140 Gbps | CDN |

"Two numbers drive everything: 14 Gbps of recordings arriving at peak, which is why the API only signs URLs, and 16,000 heartbeats a second, which is why analytics is a log plus a column store and not row updates."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the system, then walk the three journeys: recording and uploading, watching through a share link, and counting the view."

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

1. **Record and upload (1).** When recording starts, the browser creates the video and opens a multipart upload through the Video API. Every ~5 MiB of recording becomes a part that the browser `PUT`s straight to storage with a presigned URL. On Stop it sends the small last part and calls complete; the API verifies the parts, marks the video playable, and an outbox row triggers processing.
2. **Watch (2).** The viewer opens the link; the API checks the share row (and the password, once) and hands back short-lived CDN credentials. The player streams from the CDN, which fills from storage on a miss.
3. **Count (3).** The player sends a view on first play and a heartbeat every 15 seconds of watching, all under one view ID. The API publishes them to Kafka, and ClickHouse keeps one row per view session plus daily rollups for the owner's dashboard.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routing, coarse rate limits | Requests | Never sees video bytes |
| Video API | Upload protocol, shares, comments, views, stats | ~1K requests/s | Stateless; presigning is local HMAC |
| Object storage | Sources, renditions, posters | ~14 Gbps in | Multipart upload; lifecycle rules |
| CDN | Playback | ~140 Gbps out | Signed cookies per video prefix |
| PostgreSQL | Videos, upload state, shares, comments, jobs, outbox | Metadata | Primary + replicas |
| Redis | Sessions, rate-limit counters | Active users | Not needed to watch a share link |
| Kafka | `video-uploaded`, `view-events` | Events | Partitioned by video |
| Transcode workers | Remux, poster, HLS ladder | Minutes recorded | Largest compute bill |
| ClickHouse | View sessions, rollups | ~16K events/s | Ingests from Kafka |

"Why keep bytes off the API entirely? A proxied 50 MB upload holds a request open for the whole transfer, so the API tier would scale with bandwidth — 14 Gbps at peak — instead of with requests. Presigned URLs move the transfer to the one system designed for it, and the API's whole involvement in a recording becomes a few dozen small JSON calls."

### Flow 1: recording and uploading

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

"The recorder generates the video's UUID itself, so if the create call times out and is retried, the second insert hits the primary key and returns the same row instead of creating a duplicate. Steps 4 and 5 repeat every ~19 seconds while the user talks. When they press Stop, at most one partial part is left — that's why steps 6 to 10 take about a second. Step 8 is the important one: I list the parts storage actually has, not the ones the client claims, before I stitch them."

### Flow 2: opening a share link

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

"The password is checked once, in a `POST` body so it never lands in an access log. After that the browser holds a signed grant cookie, and every later request — refreshing the playback cookie, sending heartbeats, reading comments — re-reads the share row. Revoking the share is one `DELETE`, and it bites on the next request. The CDN cookie is the one credential I can't recall, so it lives 10 minutes; that's my revocation bound for someone mid-playback."

### Flow 3: processing

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

"The video was playable from step 0 — the original upload. This pipeline only makes it better: a copy-only remux that adds the seek index MediaRecorder leaves out, a poster frame, then the HLS ladder. Step 3 is a lease, not a lock, and step 7 only succeeds if the lease is still ours."

---

## 💾 Data Model (4 min)

"PostgreSQL holds anything that must be correct, object storage holds bytes, and ClickHouse holds events."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `videos` | `id` (client UUID, PK), `owner_id`, `status`, `source_key`, `playback_key`, `poster_key`, `upload_id`, `upload_activity_at`, `duration_seconds`, `size_bytes`, `failure_reason` | `(owner_id, created_at DESC)` for the library; partial index on `upload_activity_at` where `status = 'uploading'` for the sweeper |
| PostgreSQL | `shares` | `id`, `video_id`, `token_hash` (unique), `password_hash`, `expires_at`, `allow_download` | Token stored as SHA-256, so a database leak leaks no working links |
| PostgreSQL | `comments` | `id`, `video_id`, `author_id`, `parent_id`, `timestamp_seconds` (nullable), `body` | `(video_id, created_at)`; replies cascade with their parent |
| PostgreSQL | `video_jobs` | `video_id` + `kind` (unique), `status`, `attempts`, `locked_by`, `locked_until`, `run_after`, `last_error` | Partial index on runnable jobs |
| PostgreSQL | `outbox` | `id`, `topic`, `key`, `payload`, `published_at` | Written in the completing transaction |
| Object storage | `{owner}/{video}/source.webm`, `…/hls/…`, `…/poster.jpg` | — | Fixed keys, so retried jobs overwrite |
| ClickHouse | `view_sessions` | `video_id`, `view_id`, `viewer_key`, `watched_seconds`, `completed` | `ReplacingMergeTree` keeping max `watched_seconds`; daily rollup view |
| Redis | `sess:{id}`, `rl:{limiter}:{key}` | — | Sessions and rate-limit counters |

"A time-anchored comment is just a nullable `timestamp_seconds`. Splitting general and anchored comments into two tables would mean a union on every read to express one optional field. The application checks that the anchor falls inside the video's duration, since a check constraint can't look across tables."

"Why PostgreSQL rather than DynamoDB for metadata? At about 365 GB a year it fits one primary for years, and the operations I care about — 'flip uploading to processing and enqueue a job, atomically' and 'claim one job without blocking other workers' — are a transaction and `FOR UPDATE SKIP LOCKED`. When it outgrows one node I'd shard by owner, which keeps a library on one shard."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/videos                       {id, title} → 201, or 200 with the same video on retry
POST   /api/v1/videos/{id}/upload           open multipart upload → {uploadId, partSize}
POST   /api/v1/videos/{id}/upload/parts     {partNumber} → presigned PUT URL (15 min)
GET    /api/v1/videos/{id}/upload/parts     parts storage already holds (resume)
POST   /api/v1/videos/{id}/upload/complete  {partCount} → video (processing) | 409 missing parts
GET    /api/v1/videos/{id}                  owner or share grant → video + playback credentials
POST   /api/v1/videos/{id}/shares           {password?, expiresAt?, allowDownload?} → token
DELETE /api/v1/videos/{id}/shares/{shareId} revoke
GET    /api/v1/shares/{token}               200 | 401 password required | 404 | 410 expired
POST   /api/v1/shares/{token}/unlock        {password} → 200 + grant cookie | 401 | 429
POST   /api/v1/views                        {videoId, viewId, watchedSeconds, completed}
GET    /api/v1/videos/{id}/stats            ?from&to&tz → series + as_of
```

A few decisions worth saying out loud:

- **Every upload call is idempotent.** Create uses the client's UUID, starting returns the already-open upload, re-uploading a part number replaces it, and completing twice returns the video the first call produced.
- **`404`, not `403`,** for videos the caller can't see. Every read path — details, playback, comments, views — goes through one rule: you own it, or you hold a grant for a live share of it.
- **`410 Gone` for expired links,** so the share page can say "this link expired" instead of "not found".
- **Rate limits** in Redis with `RateLimit` headers: a general per-client budget, and 10 failed password attempts per link per 15 minutes.

---

## 🔧 Deep Dive 1: Uploading While Recording (8 min)

"The requirement is a working link one or two seconds after Stop, for recordings up to an hour long, on laptop Wi-Fi. Where the bytes go, and when, decides whether that's possible."

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Proxy through the API | Browser streams to an API endpoint, which writes to storage | The API scales with bandwidth (14 Gbps at peak), and a deploy kills in-flight uploads |
| ❌ One presigned PUT after Stop | Record into memory, upload the whole file | 50 MB on a 20 Mbps uplink is 20 seconds of "Uploading…"; an hour (~1 GB) fails as one unit at 95% |
| ⚠️ tus resumable protocol | A tus server accepts chunks and reassembles them | Solves resumption, but adds a server tier that holds bytes we then copy into storage |
| ✅ S3 multipart, parts uploaded during recording | Every ~5 MiB of recording becomes a part, presigned and `PUT` directly | More client logic; a 5 MiB floor on part size |

**Why it works.** Multipart upload already is a resumable protocol: parts are independent, each one is retried on its own, and storage stitches them server-side. MediaRecorder hands the page a chunk every second; the recorder buffers chunks until it has 5 MiB — S3's minimum for every part except the last — and uploads that part while recording continues, two at a time. At 2.2 Mbps that's a part every 19 seconds. When the user presses Stop, only the tail is left, so the link is live about a second later regardless of how long the recording was.

**Completion trusts storage, not the client.** The complete call carries only `partCount`. I list the parts storage holds; if any of 1..N is missing, or a non-final part is under 5 MiB, I answer `409` with the missing part numbers and the client re-sends them. Otherwise I stitch with storage's own ETags — so the browser never has to read `ETag` response headers, a CORS detail that breaks a lot of multipart uploaders — stat the result, and flip the row from `uploading` to `processing` in the same transaction as the outbox row. The conditional update (`WHERE status = 'uploading'`) means two concurrent completes produce one transition and one job.

**Abandoned uploads.** If the tab is closed mid-recording, nobody will ever call complete, and the open multipart upload keeps billing for its parts. A sweeper finds videos that have been `uploading` with no part URL requested for 30 minutes — measured from the last activity, not creation, so an hour-long recording isn't mistaken for a dead one — marks them `failed` and aborts the multipart upload. The claim is a single `UPDATE` over rows selected `FOR UPDATE SKIP LOCKED`, so every API instance can run it without double work, and the storage calls happen after the claim, outside any transaction. A bucket lifecycle rule that aborts incomplete uploads after seven days is the backstop.

**What I give up.** Client complexity — part cutting, ordering, retries, a resumable session — and some loss granularity: if the tab crashes, everything since the last uploaded part is lost unless the client also journals chunks to IndexedDB, which I'd add for long recordings. I also lose the ability to cap upload size per URL, because a presigned `PUT` can't bound its body; completion checks sizes and per-user quotas bound the total.

---

## 🔧 Deep Dive 2: Share Links That Can Be Revoked (7 min)

"A share link is a capability: whoever has it can watch. The questions are how to make one, how to protect it with a password without making every request expensive, and how to take it back."

| Approach | Revocable | Cost per request | Verdict |
|----------|-----------|------------------|---------|
| ❌ Signed URL (HMAC of video + expiry) | Only by rotating the key for every link | None | Can't undo one mistaken share |
| ❌ Token, password re-checked every request | Yes | bcrypt, ~100 ms CPU | A protected video becomes a denial-of-service target |
| ❌ Cache "this token is unlocked" | Yes | None | The cache key is the URL, so anyone with the link skips the password |
| ✅ Token row + signed per-viewer grant + short playback cookies | Yes, next request | One indexed lookup | Password checked once per viewer |

**Why it works.** The token is 256 random bits, looked up by its hash. Expiry, password and download permission are columns on that row, so revoking is deleting it. When a viewer enters the right password, I issue a grant: an `HttpOnly` cookie, signed with HMAC, that names the share and the video. Every later request presents the grant, and I re-read the share row — an indexed lookup that costs far less than bcrypt — so revocation and expiry take effect on the very next request, while bcrypt runs once per viewer instead of once per request.

**Why the alternatives fail.** A signed URL can't be revoked individually: it's valid until it expires, and rotating the signing key kills every link we've ever issued. Re-checking the password every request turns each protected video into a CPU sink — twenty requests a second is two cores doing nothing but bcrypt. Caching the unlock by token is the subtle failure: the token *is* the link, so the cache would wave through anyone who has the URL, which is exactly who the password was meant to stop.

**The credential I can't take back.** The bytes come from the CDN, which can't call my database per segment, so playback uses CDN signed cookies scoped to that video's prefix. Once issued, they're valid until they expire. I make them short — 10 minutes — and the player refreshes them through the API, which re-checks the share. So revocation is immediate for new requests and takes at most 10 minutes for someone already watching. That number goes into the product copy.

**Abuse.** Password attempts are rate-limited per link and per client — 10 failures per 15 minutes, counted in Redis so the limit holds across instances. That limiter fails *closed*: if Redis is down, password attempts are refused rather than let an attacker run bcrypt guesses unmetered. The general API limiter fails *open*, because blocking everyone during a Redis blip would be worse than briefly not limiting.

---

## 🔧 Deep Dive 3: Processing Without Making Anyone Wait (5 min)

"Transcoding a three-minute recording into an HLS ladder takes about as long as the recording. If the link waited for it, Stop-to-link would be minutes. So the rule is: playable first, better later."

1. **The original is playable immediately.** Completion verifies the upload and the status becomes `processing`, which the player treats as watchable. Processing only upgrades the video.
2. **The first job is a remux.** MediaRecorder writes WebM without a duration or a seek index, so a browser can't seek until it has downloaded everything — which breaks clicking a comment at 4:20. A copy-only remux fixes that in seconds without re-encoding, and the same pass probes the real duration and grabs a poster.
3. **Jobs are leased, and leases are fenced.** A worker claims a job with `FOR UPDATE SKIP LOCKED`, sets `locked_until`, and increments `attempts`. If it dies, the lease expires and another worker takes the job. Its final write only succeeds if the row still carries its (worker, attempt) pair, so a worker that stalled past its lease can't overwrite the new owner's results.
4. **Outputs are idempotent.** Renditions go to fixed keys next to the source, so a retry overwrites rather than duplicates.
5. **Failure has a floor.** After five attempts with exponential backoff the job is dead-lettered and the video becomes `ready` on its original file, with the failure recorded. A recording FFmpeg can't process is still a recording.

| Option | Verdict |
|--------|---------|
| ✅ Play the original, process in the background | Link works at Stop; quality improves within minutes |
| ❌ Block the link until transcoded | Minutes of waiting on every recording |
| ❌ Exclusive lock held for the whole job | A crashed worker strands the job until someone intervenes |

"What I give up is a window where seeking is weak and there's no adaptive bitrate. Most recipients open the link minutes later, when processing is done, so they never see it. And since transcoding is the biggest compute bill — about 2,100 minutes of new video per minute at peak — I'd produce only the first rendition eagerly and build the higher rungs for videos that actually get watched."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** transcode capacity at peak (lazy renditions and autoscaling on queue age), the analytics pipeline (Kafka partitions and ClickHouse shards; the dashboard reports its lag), then PostgreSQL storage in a few years (shard by owner).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Network drops while recording | "Upload paused", recording continues | Parts queue; per-part retries with fresh URLs |
| Tab closed mid-recording | The video fails or ends at the last part | Sweeper after 30 idle minutes; lifecycle rule |
| Complete response lost | Nothing | Completion is idempotent |
| Object storage down | Can't start or finish uploads | Breaker fails fast with `503`; the recorder keeps buffering |
| Worker crash | Processing finishes later | Lease expiry + fencing |
| Redis down | Sign-in fails; share links keep working | Watching a link needs only PostgreSQL and storage |
| Kafka down | Analytics gap | Buffer briefly, then drop and count; dashboard flags it |

**What I'd watch:** Stop-to-link latency reported by clients (the SLO), part URL rate, completion outcomes (a rise in `incomplete` means clients are losing parts), uploads swept per hour, the age of the oldest queued job, dead jobs, share opens by status code, and Kafka consumer lag.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Upload | Multipart parts during recording, direct to storage | One upload after Stop, or a proxy | Link ready ~1 s after Stop; API scales by requests |
| Completion | Parts listed from storage, verified | Trust the client's list | Idempotent; never marks missing bytes playable |
| Abandoned uploads | Activity-based sweeper + lifecycle rule | Timeout from creation | Long recordings aren't killed |
| Share access | Token row + signed grant | Signed URLs | Revocable; bcrypt once per viewer |
| Playback credentials | 10-minute CDN cookies | Long-lived URLs | Bounds revocation for active viewers |
| Processing | Play original, transcode later | Block on transcode | No waiting |
| Jobs | Leases + fencing | Locks held for the job | Crash recovery without stale writes |
| Views | View ID heartbeats in ClickHouse | Row per request in PostgreSQL | Exact and retry-safe at 16K/s |

"With more time I'd add an IndexedDB journal so a crashed tab can resume its upload, start transcoding the first parts while the user is still recording, and generate transcripts — which would also make the library searchable."
