# Loom - System Design Answer (Backend Focus)

## 1. Clarifying Questions (2 minutes)

> "Before I dive in, let me confirm scope. We're building a Loom-like platform where users record video in the browser, upload it, and share via link. I'll focus on the backend: upload pipeline, storage, sharing, analytics, and comments. Should I cover transcoding or adaptive streaming, or just raw video delivery?"

Assuming raw video delivery for this exercise, with notes on where transcoding fits.

> "A few more constraints I want to clarify. Are we supporting team workspaces with shared libraries, or is this individual-only? And should I design for mobile recording or browser-only?"

Assuming individual use with browser-only recording. Teams and mobile would be follow-up features.

## 2. Functional Requirements

- Users record video in the browser and upload it
- Videos are stored in object storage with metadata in a relational database
- Users can share videos via generated links with optional password, expiry, and download permissions
- Viewers can leave time-anchored comments on specific moments in a video
- Video owners see analytics: view count, unique viewers, watch duration, completion rate
- Videos can be organized into hierarchical folders
- Public share pages work without authentication

## 3. Non-Functional Requirements

- Upload latency: presigned URL generation under 100ms at p99
- Share link resolution: token validation under 50ms at p99
- Availability: 99.95% for playback and sharing paths
- Storage: support recordings up to 2GB
- Analytics freshness: view counts updated within 5 seconds
- Handle 10K concurrent viewers on a popular video
- Graceful degradation: if analytics service is down, video playback and sharing still work

## 4. Capacity Estimation

> "Let me size the system to understand where bottlenecks will emerge."

- 500K daily active users, 100K daily recordings
- Average recording: 3 minutes at ~2Mbps, approximately 50MB file size
- Daily new storage: 100K recordings x 50MB = 5TB/day, 150TB/month
- With 30-day retention default: steady-state storage around 150TB
- Peak upload throughput: 200 concurrent uploads during work hours (9AM-5PM accounts for 70% of recordings)
- View events: 10M daily views, ~115 views/second average, ~500/second peak
- Share link lookups: 5M daily, ~60/second average
- Comment writes: 500K daily, ~6/second (low-frequency compared to views)
- Database size: metadata is small -- 100K videos x 1KB = 100MB/day

> "Storage dominates infrastructure costs. Compute is modest because the API server handles only metadata -- kilobytes, not gigabytes. This is the core architectural decision."

## 5. High-Level Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│   Browser    │────▶│   CDN/Edge   │────▶│   API Gateway    │
│  (Recording) │     │  (Video      │     │  (Auth, Rate     │
└──────┬───────┘     │   Delivery)  │     │   Limiting)      │
       │             └──────────────┘     └────────┬─────────┘
       │                                           │
       │  Presigned PUT URL                ┌───────┴────────┐
       │                                   │                │
       ▼                           ┌───────┴──────┐ ┌───────┴──────┐
┌──────────────┐                   │  Video API   │ │  Analytics   │
│  S3 / Object │◀── direct upload──│  Service     │ │  Service     │
│  Storage     │                   └──────┬───────┘ └───────┬──────┘
└──────────────┘                          │                 │
                                   ┌──────┴───────┐ ┌───────┴──────┐
                                   │  PostgreSQL  │ │  ClickHouse  │
                                   │  (metadata)  │ │  (events)    │
                                   └──────────────┘ └──────────────┘
                                          │
                                   ┌──────┴───────┐
                                   │    Redis     │
                                   │  (sessions,  │
                                   │   cache)     │
                                   └──────────────┘
```

> "The key insight is that video bytes never touch the API server. The browser uploads directly to object storage via presigned URLs. The API server only handles metadata operations -- kilobytes, not gigabytes. This separation is what makes the system horizontally scalable without expensive bandwidth-heavy instances."

## 6. Data Model

> "I'll describe the six core tables and their relationships. I'm choosing PostgreSQL for metadata because we need ACID transactions for video-folder associations and foreign key integrity for cascade deletes."

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username (unique), email (unique), password_hash, display_name, avatar_url, role | email, username | Session-based auth, bcrypt passwords |
| videos | id (UUID PK), user_id (FK), title, description, duration_seconds, status, storage_path, thumbnail_path, file_size_bytes, view_count | (user_id, created_at DESC), status | Status enum: processing, ready, failed. view_count is denormalized |
| comments | id (UUID PK), video_id (FK CASCADE), user_id (FK), content, timestamp_seconds (nullable float), parent_id (self-FK) | (video_id, created_at), parent_id | Null timestamp = general comment, non-null = time-anchored |
| shares | id (UUID PK), video_id (FK CASCADE), token (unique, 64 chars), password_hash (nullable), expires_at (nullable), allow_download | token, video_id | 256-bit crypto-random tokens |
| view_events | id (UUID PK), video_id (FK CASCADE), viewer_id (FK nullable), session_id, watch_duration_seconds, completed, ip_address, user_agent | (video_id, created_at DESC), viewer_id | Insert-only append log for analytics |
| folders | id (UUID PK), user_id (FK), name, parent_id (self-FK) | user_id, parent_id | Hierarchical organization with adjacency list |

Plus a junction table `video_folders (video_id, folder_id)` for many-to-many assignment.

> "The `timestamp_seconds` nullable float on comments is a deliberate choice over a polymorphic comment model. Null means general, non-null means time-anchored. One table, one query, one API endpoint. The float type preserves sub-second precision for future features like frame-accurate annotations."

> "The view_count on videos is intentionally denormalized from view_events. The video library needs view counts for sorting and display -- running COUNT(*) on view_events for every video in a grid would be prohibitively slow. We increment view_count atomically on each view event insertion."

## 7. API Design

> "The API separates video metadata operations from upload/download operations to keep concerns clean. Upload endpoints handle the presigned URL dance. Share endpoints use tokens instead of video IDs for security isolation."

```
POST /api/auth/register          Create account
POST /api/auth/login             Session login
POST /api/auth/logout            Destroy session
GET  /api/auth/me                Current user info

GET    /api/videos               List user's videos (paginated, filterable by folder/search)
GET    /api/videos/:id           Get video with author info
POST   /api/videos               Create video metadata (returns video ID for upload)
PUT    /api/videos/:id           Update title/description
DELETE /api/videos/:id           Delete video + cascade storage objects

POST /api/upload/presigned       Generate presigned PUT URL for MinIO/S3
POST /api/upload/complete        Mark video ready after upload completes
GET  /api/upload/download/:id    Generate presigned GET URL for playback

GET  /api/videos/:id/comments    List all comments for a video (chronological)
POST /api/videos/:id/comments    Create comment (with optional timestamp_seconds and parentId)
DELETE /api/videos/:id/comments/:commentId  Delete own comment

POST   /api/share/:videoId/share           Create share link with options
GET    /api/share/:token                   Validate share and return video + presigned URL
GET    /api/share/:videoId/shares          List all shares for a video (owner only)
DELETE /api/share/:videoId/shares/:shareId Revoke share link

POST /api/analytics/view                  Record view event
GET  /api/analytics/:videoId/analytics    Get aggregated stats (owner only)

GET    /api/folders              List user's folders
POST   /api/folders              Create folder (with optional parentId)
PUT    /api/folders/:id          Rename folder
DELETE /api/folders/:id          Delete folder
POST   /api/folders/:id/videos   Add video to folder
DELETE /api/folders/:id/videos/:videoId  Remove video from folder
```

> "Notice that the share validation endpoint (GET /api/share/:token) is unauthenticated. This is intentional -- anyone with the token can access the video, subject to password and expiration checks. This is the same model as Google Docs share links."

## 8. Deep Dives

### Deep Dive 1: Video Upload and Processing Pipeline

> "This is the most architecturally interesting part -- how to handle gigabyte-sized uploads without overwhelming the API tier."

**The problem:** A naive approach proxies video bytes through the API server. At 200 concurrent uploads averaging 50MB each, that is 10GB of in-flight data consuming API server memory. Node.js with Express buffers request bodies by default, so each upload would consume 50-500MB of heap memory per request. The server becomes a memory bottleneck, and horizontal scaling means provisioning bandwidth-heavy instances that are expensive and underutilized for the 99% of requests that are metadata-only.

**The solution: Presigned URL pattern.**

The upload flow has four steps:

1. Client calls POST `/api/videos` to create metadata (title, description). Returns a video ID with status "processing." The video exists in the database but has no file associated yet
2. Client calls POST `/api/upload/presigned` with the video ID. The server verifies ownership, generates a time-limited (1-hour) presigned PUT URL using the S3/MinIO SDK, and stores the object path (`userId/videoId/uuid.webm`) on the video record
3. Client uploads the Blob directly to object storage via XMLHttpRequest (not fetch -- XHR supports upload progress events). The API server is completely uninvolved in this step. The presigned URL contains a cryptographic signature that authorizes the PUT operation
4. Client calls POST `/api/upload/complete`. The server queries MinIO for the file size via `statObject`, updates the video status to "ready" and stores `file_size_bytes`

**Object key structure:** `{userId}/{videoId}/{uuid}.webm`. The userId prefix groups a user's files together for efficient listing and bulk operations (account deletion, data export). The uuid suffix prevents collisions if the upload is retried.

**Why not multipart upload through the API?** Three reasons. First, memory: Express buffers request bodies, so a 500MB upload consumes 500MB of Node.js heap per request -- you would need 10GB of heap to handle 20 concurrent large uploads. Second, bandwidth: API server egress costs are 3-5x higher than S3 ingress in most cloud providers. Third, availability: if the API server restarts mid-upload, the entire upload is lost. With presigned URLs, S3 handles the upload independently -- an API restart doesn't affect in-progress uploads.

**Why not chunked/resumable upload (tus protocol)?** For recordings under 500MB, a single PUT with retry is sufficient. The browser can retry the entire upload on failure -- at 50MB on a 20Mbps connection, a full retry takes 20 seconds. For recordings over 1GB, we would add S3 multipart upload -- the presigned URL pattern extends naturally to presigned multipart, where each 10MB part gets its own presigned URL. The client uploads parts in parallel and calls CompleteMultipartUpload when done.

**Failure handling:** If the upload fails at any step, the video stays in "processing" status. The client can request a new presigned URL and retry. A background cleanup job (cron, not implemented locally) would garbage-collect videos stuck in "processing" for over 24 hours, deleting both the metadata row and any partial uploads from object storage. This prevents orphaned storage consumption.

**Status transitions:**
```
processing ──▶ ready    (upload/complete succeeds)
processing ──▶ failed   (transcoding fails, or cleanup marks it)
ready      ──▶ deleted  (user deletes, cascade removes storage)
```

**The trade-off:** Client complexity increases significantly. The frontend must handle XHR progress tracking, retry logic on network failure, presigned URL expiration handling, and the multi-step upload ceremony (4 API calls instead of 1). We accept this complexity because it keeps the API tier stateless, horizontally scalable, and free from large binary data processing. An API server that only handles JSON metadata can run on the smallest instance type.

### Deep Dive 2: Analytics Aggregation at Scale

> "View tracking looks simple but has hidden challenges around counting accuracy, storage growth, and query performance."

**The problem:** At 10M daily views, the `view_events` table grows by 300M rows per month. Aggregation queries (unique viewers, average watch time, completion rate) become increasingly slow as the table grows -- a full-table scan over 1B rows takes minutes, not milliseconds. Additionally, naive view counting is vulnerable to inflation from bots, refreshes, and embedded iframes auto-playing.

**The local solution:** PostgreSQL handles analytics at local scale. The `view_events` table stores raw events, and aggregation uses standard SQL:

- Total views: `COUNT(*)`
- Unique viewers: `COUNT(DISTINCT COALESCE(viewer_id::text, session_id))`
- Average watch time: `AVG(watch_duration_seconds)`
- Completion rate: `COUNT(*) FILTER (WHERE completed) * 100.0 / COUNT(*)`
- Daily breakdown: `GROUP BY DATE(created_at)`

The composite index on `(video_id, created_at DESC)` makes per-video time-range queries efficient. For a video with 10K views, the aggregation takes < 50ms.

**The production evolution -- three stages:**

Stage 1 (now, < 100M events): Direct PostgreSQL aggregation. Works well with proper indexes. Query time: 50-200ms per video.

Stage 2 (100M-1B events): Pre-computed materialized views refreshed every 5 minutes. Create a `video_analytics_daily` materialized view that aggregates by (video_id, date). Analytics queries hit this view instead of scanning raw events. The trade-off is up to 5 minutes of data staleness.

Stage 3 (> 1B events): Move view events to ClickHouse, a columnar OLAP database optimized for aggregation over append-only data. Raw events flow through Kafka to ClickHouse. PostgreSQL retains only video metadata. ClickHouse handles billion-row aggregations in sub-second because it stores columns contiguously, enabling SIMD-vectorized scans.

**Unique viewer counting at scale:** COUNT DISTINCT over millions of rows is O(n) in memory. Redis HyperLogLog provides approximate unique counts (< 0.81% standard error) with constant memory (12KB per counter, regardless of cardinality). Each view event adds the viewer ID to a HyperLogLog key namespaced by video ID. The PFCOUNT command returns the approximate unique count in O(1). For a video analytics dashboard, 99.2% accuracy is indistinguishable from 100% to the video creator.

**Bot and duplicate prevention:**

1. Session-based deduplication: the same session_id can only count as one view per video per hour
2. Minimum watch duration threshold: views with watch_duration < 3 seconds are recorded but excluded from "meaningful" view counts
3. Rate limiting on the `/analytics/view` endpoint: max 10 view events per minute per IP prevents programmatic inflation
4. User-agent filtering: known bot user-agents are excluded from analytics but still recorded for audit

**View count consistency:** The `view_count` on the videos table is incremented atomically with `UPDATE videos SET view_count = view_count + 1`. This can diverge slightly from the true count in view_events if a transaction fails after inserting the event but before incrementing the counter. We accept this -- the dashboard aggregation from view_events is authoritative, while view_count is an approximate counter for display in the video grid.

**The trade-off:** We accept slight inaccuracy (HyperLogLog approximation, view_count divergence) for massive performance gains. We also accept analytics delay (up to 5 seconds at local scale, up to 5 minutes with materialized views) in exchange for not blocking the video playback path on analytics writes. If the analytics service is completely down, video playback and sharing still work -- degraded analytics don't affect the core experience.

### Deep Dive 3: Share Link Security and Access Control

> "Share links are the primary distribution mechanism. Getting the security model wrong means either unauthorized access to private videos or broken sharing workflows."

**The problem:** Share links must be simultaneously easy to create and use (one click to generate, one click to view) and secure (unguessable, revocable, optionally password-protected and time-limited). We need to balance convenience against security, and we need to support different access policies (public, password-protected, time-limited, download-allowed) without creating a complex permission system.

**Token design:** Share tokens are `crypto.randomBytes(32).toString('hex')` -- 256 bits of entropy encoded as 64 hex characters. At 256 bits, even generating 1 billion tokens per second for 100 years, the probability of a collision is approximately 2^-196 -- effectively zero. Tokens are stored in the `shares` table with a UNIQUE index, and lookups use this index for O(log n) performance.

**Why not UUIDs?** UUID v4 has 122 bits of randomness, which is cryptographically adequate for most purposes. But share tokens are user-facing and security-critical. Three reasons to use crypto.randomBytes instead:

1. 256 bits vs 122 bits provides 2^134 more combinations -- defense in depth against future cryptographic advances
2. The 64-character hex format is visually distinct from UUIDs (no hyphens), preventing confusion with internal resource IDs
3. UUIDs include version and variant bits that reduce effective entropy; crypto.randomBytes is pure randomness

**Why not signed URLs (HMAC)?** Signed URLs encode the video ID and permissions into the URL itself, verified by an HMAC signature. This avoids database lookups on every view -- the server validates the signature cryptographically without touching the database. But signed URLs have two critical weaknesses:

1. **Revocation:** To revoke a single signed URL, you must rotate the signing key, which invalidates ALL signed URLs. With token-based shares, revocation is `DELETE FROM shares WHERE id = $1` -- instant and surgical.

2. **Password protection:** Adding a password to a signed URL requires embedding a password hash in the URL itself (insecure -- visible in browser history) or maintaining a server-side record (which defeats the "no database lookup" benefit). Token-based shares store the password hash in the database row alongside the token.

> "Token-based shares trade a database lookup per access for surgical revocability and clean password support. At 60 lookups/second, this trade-off is heavily in our favor."

**Password protection flow:**

1. Owner creates a share with a password. The password is bcrypt-hashed (10 rounds, ~100ms) and stored on the share row. The plaintext password is never stored
2. Viewer accesses the share URL `/share/:token`. The server finds the share row, detects a password_hash exists, and returns 401 with `{ requiresPassword: true }`
3. The client shows a password prompt. The viewer enters the password
4. The client retries with `?password=...`. The server bcrypt-compares the input against the stored hash. On match, it returns the video with a presigned playback URL. On failure, it returns 401

**Expiration enforcement:** Expiration is checked server-side on every share access -- not via client-side timers, CDN TTLs, or presigned URL expiry. If `expires_at < NOW()`, the server returns 404 regardless of whether the token is correct. This ensures expired links cannot be replayed even if the URL is cached in a browser, shared on Slack, or bookmarked. The check is a simple timestamp comparison -- negligible overhead.

**Access control matrix:**

| Feature | No Password | With Password | Expired | Revoked |
|---------|-------------|---------------|---------|---------|
| Token lookup | Found | Found | Found | Not found |
| Password check | Skip | Verify bcrypt | N/A | N/A |
| Expiry check | Pass | Pass | Fail (404) | N/A |
| Result | Video + URL | Video + URL | Error | Error |

**Caching strategy at scale:** At 60 lookups/second, PostgreSQL handles token validation trivially. At 60,000/second (viral video with a share link), we would cache validated tokens in Redis:

- Key: `share:validated:{token}` containing the video ID and permissions
- TTL: `min(remaining_expiry, 5_minutes)` -- never cache longer than the share's remaining lifetime
- Invalidation: on share deletion, explicitly delete the Redis key with `DEL share:validated:{token}`
- Password-protected shares are NOT cached -- every access must re-verify the password

This caching layer reduces database load by 99% for popular share links while maintaining correct security behavior.

**The trade-off:** Every share access requires a database lookup (token + JOIN to video + JOIN to user). This is three tables joined on indexed foreign keys -- under 1ms in PostgreSQL. We pay this cost on every access to gain: individual revocation (DELETE one row), password protection (bcrypt on the same row), and expiration enforcement (timestamp comparison on the same row). The alternative (signed URLs with HMAC) saves the database lookup but loses all three of these capabilities.

### Deep Dive 4: Abuse Resistance and the bcrypt Cost of Protected Shares

> "The previous deep dive ended on a deliberate gap: password-protected shares can't be cached. That gap is also the system's cheapest denial-of-service target, so it's worth following through."

**The problem:** A public share link is an unauthenticated endpoint that anyone with the URL can hit. For an unprotected share that's fine — the work is one indexed lookup. For a *protected* share, every single request runs bcrypt at 10 rounds, which is ~100ms of deliberately-expensive CPU. That asymmetry is the whole issue: the attacker spends a few bytes on a request, the server spends a tenth of a CPU-second answering it. Twenty requests per second against one protected share saturates two full cores doing nothing but hashing.

**Why the obvious fix is wrong.** The instinct is to cache the validation result, exactly as we cache unprotected tokens. But caching "this token passed its password check" makes the check meaningless — the cache key is the token, and the token is what the attacker already has. Anyone who fetched the URL after a legitimate viewer authenticated would ride that cached entry straight through. Lowering the bcrypt cost factor is the other tempting fix, and it's worse: it speeds up the offline attack the cost factor exists to prevent, trading a real security property for a throughput problem that has a cheaper answer.

**What actually works: make the *viewer* stateful, not the share.** A successful password check mints a short-lived cookie scoped to that one share token. Subsequent requests present the cookie, the server verifies it, and bcrypt runs exactly once per viewer per session rather than once per request. The security property survives because the cookie is issued only after a real password verification and is bound to a single share.

| Approach | Bcrypt runs | Revocable | Safe |
|----------|-------------|-----------|------|
| ✅ Verify once, issue a scoped short-lived cookie | Once per viewer session | Yes — cookie TTL is short and the share row still gates issuance | Yes |
| ❌ Cache validation by token | Once per TTL, globally | No — cache key is the public token | No: grants access to anyone holding the URL |
| ❌ Reduce bcrypt cost factor | Every request, faster | Yes | No: weakens the offline attack it exists to resist |
| ❌ Nothing (current implementation) | Every request | Yes | Yes, but trivially DoS-able |

> "What I'd flag in review is that this reintroduces exactly the server-side session state the presigned-URL design worked so hard to avoid. I think that's the right call anyway — it's one small key with a short TTL, not video bytes — but it's a real concession and I'd rather name it than pretend the design is uniformly stateless."

**Rate limiting is the layer underneath.** Two Redis-backed limiters run in front of this. A global limiter covers all `/api` traffic, and a stricter one covers uploads, where a single request costs far more than a JSON response. Redis rather than in-memory counters is the important detail: with in-memory state, every API instance keeps its own tally, so an attacker spreading requests across N instances gets N times the allowance and the limit silently means nothing behind a load balancer.

The limits are deliberately per-endpoint rather than one global number. Uploads, share validation, and metadata reads have completely different costs and completely different abuse profiles — a single shared bucket would either be too loose to stop upload abuse or so tight that ordinary library browsing trips it. The cost is more configuration and more ways to misconfigure; the benefit is that the expensive endpoints get the protection they actually need.

**What we give up:** rate limiting is per-IP, which is the wrong unit for both directions. It punishes legitimate users behind a shared NAT — an office of fifty people looks like one very busy client — and it barely inconveniences a distributed attacker with a pool of addresses. Doing better means per-account limits for authenticated routes and something like proof-of-work or a CAPTCHA on the anonymous share path, neither of which is worth building before there's evidence of abuse.

## 9. Failure Handling

> "Let me describe how the backend handles failures in each layer."

**Database failures:** The PostgreSQL connection pool is configured with 20 max connections and a 5-second connection timeout. If the pool is exhausted, new requests fail fast with 503 rather than queuing indefinitely. The health check endpoint (`GET /api/health`) runs `SELECT 1` against the pool -- load balancers use this to remove unhealthy instances.

**Object storage failures:** MinIO/S3 operations (presigned URL generation, object deletion, stat) are wrapped in a circuit breaker (Opossum). If 50% of operations fail within a 10-second window, the circuit opens and subsequent calls fail immediately for 30 seconds. This prevents cascading failures where slow S3 responses consume all Node.js event loop time.

**Upload failure recovery:** If a client fails during upload, the video remains in "processing" status. The client can retry by requesting a new presigned URL -- the old URL may have expired (1-hour TTL). The backend updates the storage_path to the new object name.

**The reconciliation gap.** I want to be precise here rather than wave at a cleanup job, because this is the sharpest unresolved edge in the design. The four upload steps are four independent operations with no transaction spanning them, and there is no distributed transaction available -- one participant is a database, the other is an object store. So two failure modes leak, in opposite directions:

| Client dies after | Leaves behind | Visible to user as |
|-------------------|---------------|--------------------|
| Step 1–2 (row created, no PUT) | A `videos` row in `processing` with no object | A recording stuck "processing" forever |
| Step 3 (PUT done, no complete call) | A real object with a row still in `processing` | Same, but now also paying storage |

Neither self-heals, and nothing currently sweeps them. The honest design question is which side should be authoritative. Marking rows stale after N minutes is easy and wrong on its own -- a viewer on a slow connection legitimately takes longer than any threshold you'd pick for a snappy UI, so you'd fail uploads that were about to succeed. Making the object store authoritative and reconciling rows against a bucket listing is more correct but turns a cheap query into a full-prefix scan, and it's eventually consistent in exactly the window you care about.

The pragmatic answer is both, at different tempos: a short-timeout sweep that only marks rows `failed` when the object genuinely isn't there (a `statObject` check, not a bare timestamp comparison), plus an infrequent, offline reconciliation that garbage-collects objects with no referencing row. What we give up is immediacy -- a user can see a stuck "processing" card for minutes before anything corrects it -- and that's the cost of not having a transaction across the two stores.

**Redis failures:** Redis is used for session storage and caching. If Redis is unavailable, sessions cannot be validated -- authenticated endpoints return 401. The Redis client uses exponential backoff (50ms * attempts, max 2s) for reconnection. Critically, the share validation endpoint can still serve unauthenticated share links without Redis -- share tokens are validated against PostgreSQL directly.

> "That last point is the one I'd highlight. It means a Redis outage degrades the product to read-only public viewing rather than taking it down: creators can't sign in, but every share link already in circulation keeps working. Given that shares are how the content actually reaches people, losing the authoring path while preserving the distribution path is the right way for this system to fail. It's also a direct consequence of choosing Redis-backed sessions over JWTs — with stateless tokens the authoring path would survive a Redis outage too, but we'd have given up the immediate revocation that a sharing product needs.

## 10. Scalability Discussion

> "Let me walk through what breaks at different scale levels."

**10K DAU (current):** Single PostgreSQL instance handles everything. MinIO runs locally. Redis for sessions. No caching or CDN needed.

**100K DAU:** Add PostgreSQL read replicas for video listing and analytics queries. Redis caches hot video metadata (TTL 5 minutes) to reduce database load. Rate limiting moves from in-memory to Redis-backed for consistency across API instances.

**1M DAU:** CDN for video delivery becomes mandatory -- serving 50TB/day of raw video files from origin is cost-prohibitive ($4,500/day at S3 egress pricing vs. $500/day via CloudFront). PostgreSQL analytics queries become slow; migrate view events to ClickHouse. Add Elasticsearch for full-text video search. Multiple API instances behind a load balancer.

**10M DAU:** Shard PostgreSQL by user_id hash for video metadata -- keeps a user's library on one shard. Partition view_events by month for efficient pruning. Move to HLS/DASH adaptive streaming with a transcoding pipeline (FFmpeg workers consuming from a job queue). Consider edge recording processing -- initial transcoding at CDN edge locations to reduce origin bandwidth.

**Key bottleneck evolution:**
1. Storage bandwidth (solved by CDN) --
2. Analytics queries (solved by ClickHouse) --
3. Metadata writes (solved by sharding) --
4. Real-time features (solved by WebSocket infrastructure) --
5. Transcoding throughput (solved by worker fleet auto-scaling)

## 11. Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| Presigned URLs for upload | API stays stateless, no bandwidth bottleneck, S3 handles retries | More client logic, multi-step upload, URL expiration |
| ❌ Proxy upload through API | Simpler client, single endpoint | API becomes memory/bandwidth bottleneck |
| Token-based shares | Individual revocation, password support, expiry | Database lookup per access |
| ❌ Signed URLs (HMAC) | No database lookup, fast validation | Cannot revoke individual links, no clean password model |
| Nullable timestamp for comments | Simple schema, single table and query | No compile-time type distinction between comment variants |
| ❌ Polymorphic comment types | Type-safe variant distinction | Two tables or discriminated union for one nullable field |
| PostgreSQL for analytics (local) | Single database, simpler operations | Aggregation becomes slow past 100M rows |
| ❌ ClickHouse from day one | Sub-second aggregation at any scale | Operational overhead, separate deployment, Kafka pipeline |
| Denormalized view_count | Fast display in video grid, no JOIN needed | Can diverge from authoritative count in view_events |
| ❌ COUNT(*) from view_events | Always accurate | O(n) query per video in grid listing |
| WebM (browser-native) | No server-side transcoding, instant availability | Not universally supported, no adaptive bitrate |
| ❌ HLS/DASH transcoding | Universal playback, adaptive quality | Requires FFmpeg pipeline, storage of multiple renditions |
| Session auth (Redis) | Immediate revocation, simple implementation | Server-side state, Redis dependency |
| ❌ JWT tokens | Stateless, scales horizontally | No revocation without blocklist, token size grows with claims |
| Scoped short-lived cookie after password check | Bcrypt runs once per viewer, not per request | Reintroduces server-side state on the share path |
| ❌ Cache share validation by token | Removes the bcrypt cost entirely | Cache key is the public token — grants access to anyone holding the URL |
| Redis-backed per-endpoint rate limits | Correct behind a load balancer, tuned to each endpoint's real cost | More configuration, more ways to misconfigure |
| ❌ In-memory global rate limit | Zero dependencies | Per-instance counters — N instances means N times the allowance |
