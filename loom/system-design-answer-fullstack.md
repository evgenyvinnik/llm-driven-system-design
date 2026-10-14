# 🎥 Loom (Async Video Messaging) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one recording from the Record button to the owner's analytics, and get the contracts between browser and server right — because in Loom every hard problem sits on that seam. Three contracts carry most of the weight: a **part contract** that lets the browser upload while it records and lets the server decide when the upload is really complete; a **share grant** that checks a password once but still honours revocation; and a **view session** that makes heartbeats safe to retry."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and the targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the recorder to ClickHouse, plus the core flows |
| Data model & API contract | 6 min | Server tables, client state, and the fields both sides rely on |
| Deep dive 1: the link works at Stop | 9 min | The multipart part contract, end to end |
| Deep dive 2: sharing you can take back | 7 min | Tokens, grants, short-lived playback cookies, and what the UI says |
| Deep dive 3: views you can trust | 5 min | View sessions from the player to the column store |
| Failures, scale, wrap-up | 4 min | What each failure looks like to the creator and the viewer |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Creators record screen, camera or both in the browser, with pause and resume; the recording uploads while they record, and the link works about a second after Stop. They share links with an optional password and expiry, revoke them, and see views, unique viewers, watch time and completion. Viewers watch without an account, unlock protected links, and read and post time-anchored comments. Out of scope: editing, live streaming, team workspaces, transcripts, mobile recording.

| Side | Requirement | Target |
|------|-------------|--------|
| Both | Stop → working link | p95 < 2 s |
| Backend | Part URL issuance | p99 < 50 ms |
| Backend | Upload durability | An acknowledged part is never lost |
| Backend | Revocation | New opens blocked at once; active playback within 10 min |
| Backend | Analytics freshness | < 1 minute |
| Frontend | Share page | First frame p95 < 1.5 s; share-page JS < 100 KB gzipped |
| Frontend | Recorder | Memory stable for an hour; INP < 200 ms while encoding |
| Frontend | Network drops | Recording continues; upload resumes without re-recording |

**Scale.** One million recordings a day — about 35 new recordings a second at peak — average three minutes and 50 MB. At peak about 6,300 people are recording at once, which is ~14 Gbps of upload that must go straight to object storage, and ~330 part-URL requests a second to the API. Fifty million views a day produce ~16,000 heartbeats a second and ~140 Gbps of playback egress through the CDN.

"The upload numbers tell me the API must only sign URLs, and the product promise tells me the upload has to happen during the recording. Those two facts shape the client as much as the server."

---

## 🏗️ End-to-End Architecture (9 min)

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

1. **Record and upload (1).** The recorder creates the video with a client-generated ID and opens a multipart upload through the API. While recording, every 5 MiB becomes a part `PUT` straight to object storage with a presigned URL. On Stop it sends the last part and calls complete; the API verifies the parts in storage and the video becomes playable.
2. **Watch (2).** The share page opens the link through the API, which checks the share row and the password (once), and returns video details plus short-lived CDN credentials. The player streams from the CDN.
3. **Count (3).** The player sends a view on first play and heartbeats under one view ID; they flow through Kafka into ClickHouse, which the owner's analytics tab reads.

| Layer | Choice | Why |
|-------|--------|-----|
| Recorder | MediaRecorder + a `ChunkedUploader` class outside React | Streams parts during capture; testable without a browser |
| App and share page | React SPA, TanStack Query for server data; share page shell edge-rendered | Authenticated app needs no SSR; link unfurls need Open Graph tags |
| Video API | Stateless service | Signs URLs, owns the upload state machine and access rule |
| Object storage + CDN | S3 multipart upload; CDN with signed cookies | Bytes never touch the API |
| PostgreSQL | Videos, upload state, shares, comments, jobs, outbox | Transactions for state changes plus their side effects |
| Transcode workers | Leased jobs; FFmpeg | Upgrade the video without blocking the link |
| Kafka → ClickHouse | View sessions and rollups | 16K heartbeats a second as appends |

### Flow: recording to a working link

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

"Two halves of one contract are visible here. The browser promises to number parts in recording order, make every non-final part at least 5 MiB, and send `partCount` when it's done. The server promises not to believe it: step 8 lists what storage actually has before anything becomes playable."

### Flow: opening a protected link

```
Viewer             Share page                      Video API                     Player
   │                    │                              │                            │
   │ 1 open /share/{t}  │                              │                            │
   │───────────────────▶│                              │                            │
   │                    │ 2 GET /api/share/{t}         │                            │
   │                    │─────────────────────────────▶│                            │
   │                    │ 3 401 requiresPassword       │                            │
   │                    │◀─────────────────────────────│                            │
   │ 4 submit password  │                              │                            │
   │───────────────────▶│                              │                            │
   │                    │ 5 POST /unlock (pw in body)  │                            │
   │                    │─────────────────────────────▶│                            │
   │                    │ 6 video, URL; grant cookie   │                            │
   │                    │◀─────────────────────────────│                            │
   │                    │ 7 src, poster; comments load                              │
   │                    │──────────────────────────────────────────────────────────▶│
   │                    │                              │ 8 POST /views, first play  │
   │                    │                              │◀───────────────────────────│
   ····························· comment badge clicked ······························
   │                    │ 9 seek(t)                                                 │
   │                    │──────────────────────────────────────────────────────────▶│
   │                    │                              │                            │
```

"The share page branches on status codes, not message strings: `401` with `requiresPassword` shows the form, and a correct password comes back as an `HttpOnly` grant cookie, so the page never handles a credential it could leak."

### Flow: counting the view

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

"The view ID is born in the browser and the server treats it as an idempotency key, so heartbeats, retries and the final beacon all describe one view."

---

## 💾 Data Model & API Contract (6 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `videos` | `id` (client UUID), `owner_id`, `status`, `upload_id`, `upload_activity_at`, `source_key`, `playback_key`, `poster_key`, `duration_seconds` | `status`: uploading → processing → ready, or failed |
| PostgreSQL | `shares` | `token_hash`, `video_id`, `password_hash`, `expires_at`, `allow_download` | Revoke = delete the row |
| PostgreSQL | `comments` | `video_id`, `author_id`, `parent_id`, `timestamp_seconds` (nullable) | One level of replies |
| PostgreSQL | `video_jobs`, `outbox` | Lease, attempts, topic, payload | Written with the status change |
| ClickHouse | `view_sessions` | `video_id`, `view_id`, `viewer_key`, `watched_seconds`, `completed` | Keeps max watch time per view |

### Client side

| State | Holds | Owner |
|-------|-------|-------|
| `['video', id]`, `['comments', id]`, `['share', token]` | Server data | TanStack Query; polled while a video is uploading or processing |
| Upload snapshot | Phase, bytes recorded and uploaded, parts done, error | Zustand, fed by the uploader |
| Parts list | Numbered blobs with states | `ChunkedUploader` (IndexedDB journal in production) |
| `viewerKey` | Stable anonymous viewer ID | `localStorage` |
| Search, folder | Library filters | URL |

### The contract

```
POST /api/v1/videos                       {id, title} → Video (same id → same video)
POST /api/v1/videos/{id}/upload           → {uploadId, partSize}
POST /api/v1/videos/{id}/upload/parts     {partNumber} → presigned PUT URL (15 min)
POST /api/v1/videos/{id}/upload/complete  {partCount} → Video | 409 {missingParts}
GET  /api/v1/shares/{token}               → SharedVideo | 401 requiresPassword | 404 | 410
POST /api/v1/shares/{token}/unlock        {password} → SharedVideo + grant cookie | 401 | 429
POST /api/v1/views                        {videoId, viewId, viewerKey, watchedSeconds, completed}
GET  /api/v1/videos/{id}/stats            ?from&to&tz → series + as_of
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| Client-generated video `id` | Creating twice returns the same video | Retry a create whose response was lost |
| `partNumber` + 5 MiB minimum | Re-`PUT` of a part replaces it; parts stitch in number order | Retry any part, in any order, with a fresh URL |
| `partCount` on complete | Completes only when storage holds parts 1..N; else `409` with `missingParts` | Re-send exactly what's missing |
| `status` | `processing` is already playable | Show the player immediately, label it "processing" |
| Grant cookie | Valid only while the share row is live | Skip the password on refresh, without seeing the credential |
| `401` / `404` / `410` / `429` | Distinct meanings for password, revoked, expired, throttled | Show a precise message for each |
| `viewId` | Upserted; watch time only grows; owner's views ignored | Send heartbeats and a beacon without double counting |

---

## 🔧 Deep Dive 1: The Link Works at Stop (9 min)

"The scenario: someone records for ten minutes — about 165 MB — presses Stop, and expects to paste the link into Slack right away. If the upload starts at Stop, they wait over a minute. Each layer has a job."

**Browser.** MediaRecorder emits a chunk every second. The uploader buffers chunks until it has 5 MiB, cuts part *n*, and uploads it with `XMLHttpRequest` (the only API with upload progress) while recording continues, two parts at a time. Each attempt asks for a fresh presigned URL and backs off exponentially. Part numbers follow recording order. On Stop, `finish()` uploads the last, smaller part and calls complete with `partCount`. The video's ID was generated in the browser at Start, so every call is safe to retry.

**API.** Starting is idempotent: a conditional `UPDATE … WHERE upload_id IS NULL` makes one multipart upload per video even if two start calls race. Each part URL request also bumps `upload_activity_at`. Completion lists the parts storage holds, refuses with `409` and the missing numbers if any of 1..N is absent or a non-final part is under 5 MiB, stitches with storage's own ETags, stats the object, and only then flips `uploading` → `processing` together with the outbox row that schedules processing. A second complete returns the same video.

**Storage and background.** Object storage stitches parts without copying them through us. A sweeper fails uploads with no activity for 30 minutes and aborts their multipart uploads; a lifecycle rule is the backstop. Processing — a quick remux that adds the seek index MediaRecorder omits, then a poster and an HLS ladder — runs after the link already works.

**UI mapping.** While recording, a badge shows "Uploaded 41 MB of 43 MB". After Stop, the preview shows "Uploaded — ready to share" within about a second. If parts failed, it shows "Upload paused" with a Retry button that re-sends only the failed parts.

| Approach | Verdict |
|----------|---------|
| ✅ Multipart parts during recording, verified by storage at completion | Link ~1 s after Stop; failures cost one part; completion idempotent |
| ❌ One upload after Stop | Waiting grows with recording length; one failure loses the file |
| ❌ Stream through our API (WebSocket or proxy) | We carry ~14 Gbps of bytes and invent our own resume protocol |
| ❌ Trust the client's part list and ETags | A lost part becomes a truncated video marked playable; needs CORS-exposed headers |

"What I give up: the client is now a small distributed system — a parts queue, retries, a resumable session — and a crashed tab loses up to one part of recording unless parts are journaled to IndexedDB. I accept that because it's the only design where the waiting time doesn't grow with the length of the recording."

---

## 🔧 Deep Dive 2: Sharing You Can Take Back (7 min)

"A share link is a capability handed to people without accounts. The owner needs three things: an optional password, an expiry, and an undo button that actually works."

**Server.** The token is 256 random bits, stored hashed. A correct password — sent in a `POST` body, never the URL — is bcrypt-checked once, and the response sets a signed `HttpOnly` grant cookie naming the share and the video. Every later request re-reads the share row, so deleting it ends access on the next request. Password attempts are limited to 10 failures per link per 15 minutes, counted in Redis, failing closed.

**Playback.** The CDN can't consult our database per segment, so playback uses signed cookies scoped to the video's prefix, valid 10 minutes. The player refreshes them through the API — which re-checks the share — before they expire. That 10 minutes is the honest revocation bound for someone already watching.

**UI.** The owner's revoke button says "Link disabled. Anyone watching right now loses access within 10 minutes" — the same number the backend promises. The share page maps outcomes precisely: `401` shows the password form with focus in the field, `404` says "doesn't exist or was revoked", `410` says "expired", and `429` says "too many attempts, try again in a few minutes". Because the token sits in the URL path, the page sets `Referrer-Policy: no-referrer` and loads no third-party scripts.

| Approach | Verdict |
|----------|---------|
| ✅ Token row + signed grant + 10-minute CDN cookies | Revocable; bcrypt once per viewer; bounded tail |
| ❌ Signed URLs only | Can't revoke one link without breaking all of them |
| ❌ Re-check the password every request | ~100 ms of CPU per request; a protected video becomes a DoS target |
| ❌ Cache "unlocked" by token | The token is the URL, so anyone with the link skips the password |

"I'm trading instant revocation for 'immediate for new requests, within 10 minutes for active viewers', and the UI says exactly that."

---

## 🔧 Deep Dive 3: Views You Can Trust (5 min)

"Creators open analytics minutes after sending a link, so the numbers have to be fresh and exact enough to act on."

**Player.** On first play the view tracker creates a `viewId`. It counts watch time only from small forward steps of the playhead — a seek isn't watching — sends a heartbeat every 15 seconds watched and one at 90% (completion), and a final `sendBeacon` on `pagehide`, which survives the tab closing. A stable `viewerKey` in `localStorage` lets anonymous viewers count once in unique viewers. The owner's own plays are never sent.

**Server.** The API checks access with the same rule as every read — owner or live share grant — so nobody can inflate a video they can't watch, and publishes each report to Kafka keyed by video. ClickHouse keeps one row per `viewId` with the maximum watch time (`ReplacingMergeTree`), so retries and late heartbeats can neither add a view nor shrink watch time. A daily rollup feeds the dashboard, which shows an `as_of` time from consumer lag.

| Approach | Verdict |
|----------|---------|
| ✅ `viewId` sessions with heartbeats and a beacon | Exact views, real watch time, completion; retry-safe |
| ❌ Count a view per page load | Retries and refreshes inflate counts; no watch time |
| ❌ Increment counters in PostgreSQL | Hot-row contention at 16K heartbeats a second; answers one question only |

---

## 📈 Failures & Scale (2 min)

| Failure | What the creator sees | What the viewer sees | Mitigation |
|---------|----------------------|----------------------|------------|
| Wi-Fi drops while recording | "Upload paused"; recording continues | — | Parts queue; retries with fresh URLs |
| Tab closed mid-recording | Video fails, or ends at the last part | — | Sweeper + lifecycle rule; IndexedDB journal to resume |
| Object storage down | Can't start or finish uploads | Cached segments still play | Breaker fails fast; recorder keeps buffering |
| Transcoder backlog | Video says "processing" a while longer | Plays the original | Original is playable; autoscale on queue age |
| Redis down | Can't sign in | Share links still work | Sharing needs only PostgreSQL and storage |
| Kafka down | Analytics shows "partial data" | Nothing | Buffer, then drop and count |

**What breaks first as we grow:** transcode capacity at peak (eager first rendition only, lazy higher rungs), then the analytics pipeline (partitions and shards), then PostgreSQL storage in a few years (shard by owner).

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Upload | Parts during recording, direct to storage | Upload after Stop; proxy | Link ready ~1 s after Stop |
| Completion | Storage lists parts; client sends only `partCount` | Client sends parts and ETags | Can't mark missing bytes playable; no CORS header dependency |
| IDs | Client-generated video and view IDs | Server-assigned IDs | Every create and heartbeat is retry-safe |
| Sharing | Token row + signed grant + short CDN cookies | Signed URLs | Revocable; bcrypt once |
| Processing | Play original now, improve later | Wait for transcode | No waiting |
| Analytics | View sessions → Kafka → ClickHouse | Counters in PostgreSQL | Exact, fresh, and cheap at 16K/s |
| Server state in UI | TanStack Query | Copies in Zustand | No hand-written cache invalidation |

"With more time: an IndexedDB journal so a crashed tab resumes its upload, transcoding the first parts while recording is still going, and transcripts that make the library searchable and give viewers captions."
