# 📸 Instagram — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one photo through its whole life: picked in the composer, uploaded over a flaky connection, processed, pushed into followers' feeds, scrolled past and liked. Most of the hard parts sit on the seam between client and server, so I'll focus on four contracts both sides rely on: an idempotency key that makes Share safe to retry, a `status` that makes asynchronous processing visible, an opaque cursor that keeps infinite scroll stable while the feed changes, and an `idempotent` flag that keeps optimistic likes honest."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the composer to a follower's feed, plus the core flows |
| Data model & API contract | 7 min | Server tables, client cache keys, the fields both sides depend on |
| Deep dive 1: one post per Share | 8 min | Idempotency from the button to the database |
| Deep dive 2: the feed, end to end | 9 min | Hybrid fan-out behind a stable cursor and a fast list |
| Deep dive 3: likes and privacy | 4 min | Optimistic UI on an idempotent, visibility-checked API |
| Failures, scale, wrap-up | 4 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Users post one to ten photos with a caption and filter, scroll a home feed of the accounts they follow, like, save, comment and follow, view 24-hour stories, and message each other. Private accounts limit who sees their posts. Out of scope: video, ranking models, search, notifications.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Feed page | p99 < 200 ms for 20 posts |
| Backend | Publish latency | Visible to followers within 5 s (p95) |
| Backend | Create acknowledgement | p99 < 500 ms after the upload |
| Frontend | Feed route | LCP < 2.5 s on mid-range mobile; JS < 150 KB gzipped |
| Frontend | Interactions | INP < 200 ms; CLS < 0.05 while images load |
| Both | Correctness | One Share = at most one post; private posts never shown to non-followers |

**Scale.** 500M daily users post 100M photos a day (~1.2K/s, 3.5K/s at peak) and load the feed 5B times a day (~58K/s, 150K/s at peak) — about 50 reads per post. Originals add up to ~300 TB a day; image egress peaks around 1.2 Tbps, almost all of it from a CDN.

"The ratio says feeds must be precomputed. The client side says something just as important: an upload is the request most likely to time out, so its retry story has to be designed, not hoped for."

---

## 🏗️ End-to-End Architecture (8 min)

```
 ┌──────────────────────────────────────────┐                           ┌───────────────────────┐
 │ React SPA / mobile app                   │── GET image renditions ──▶│ CDN                   │
 │ feed cache, upload queue (key K)         │── (1) PUT original ─┐     │ image renditions      │
 └──────────────────┬───────────────────────┘                     │     └───────────┬───────────┘
                    │ POST /api/v1/posts                 signed   │                 │
                    ▼ (2) GET /api/v1/feed?cursor=       URL      │                 │
 ┌────────────────────────────────────────────────────────────┐   │                 │ cache miss
 │ API gateway · TLS, session check, rate limits              │   │                 │
 └──────────┬─────────────────────────────────────┬───────────┘   │                 │
            │                                     │               │                 │
            ▼                                     ▼               │                 ▼
 ┌──────────────────────┐              ┌──────────────────────┐   │     ┌───────────────────────┐
 │ Feed service         ├───────────┐  │ Post service         │   └────▶│ Object storage (S3)   │
 │ merge + hydrate      │           │  │ create, like, follow │         │ originals, renditions │
 └──────────┬───────────┘ celebrity │  └──────────┬───────────┘         └───────────────────────┘
            │ ZREVRANGE   posts,    │             │ INSERT post                 ▲
            │ timeline    hydrate   │             │ + outbox                    │
            ▼                       │             ▼                             │
 ┌──────────────────────┐           │  ┌──────────────────────┐                 │ GET original,
 │ Redis cluster        │           │  │ PostgreSQL (sharded) │                 │ PUT renditions
 │ timelines, post cache│           └─▶│ posts, follows, likes│◀────────────┐   │
 └──────────────────────┘              │ outbox               │ status =    │   │
            ▲                          └──────────┬───────────┘ published   │   │
            │                                     │                         │   │
            │ ZADD to                             │ (3) outbox              │   │
            │ followers                           │ relay                   │   │
            │                                     ▼             media-jobs  │   │
 ┌──────────┴─────────┐                ┌──────────────────────┐         ┌───┴───┴───────────────┐
 │ Fan-out workers    │ post-published │ Kafka                ├────────▶│ Media workers         │
 │ push to timelines  │◀───────────────┤ media-jobs, published│◀────────┤ resize, then publish  │
 └────────────────────┘                └──────────────────────┘         └───────────────────────┘
                                                                post-published
```

1. **Create (1).** The composer uploads photos straight to object storage through signed URLs, then sends `POST /api/v1/posts` with the draft's idempotency key. The Post service writes the post as `processing` plus an outbox event in one transaction and answers `202`; the client shows a processing card.
2. **Read (2).** The feed list asks for the next page with the previous page's cursor. The Feed service merges the viewer's Redis timeline with recent posts of followed celebrity accounts and hydrates the page in one query.
3. **Publish (3).** A media worker resizes the photo and marks the post published; fan-out workers push the post id into followers' cached timelines, except for authors with 10,000+ followers, who are pulled at read time.

| Layer | Choice | Why |
|-------|--------|-----|
| Client | React SPA; query cache for server state; upload queue in IndexedDB | The cache dedupes and invalidates; drafts survive refreshes |
| Edge | CDN for images, gateway for the API | Images are immutable; the gateway rate-limits |
| Post service | Uploads, posts, likes, follows; outbox relay | Write-heavy and bursty |
| Feed service | Timeline merge and hydration | Read-heavy, latency-critical |
| Storage | PostgreSQL, Redis timelines, object storage | Source of truth, cache, bytes |
| Async | Kafka, media workers, fan-out workers | Seconds of CPU and millions of writes off the request path |

### Flow: creating a post across the wire

```
Composer                    Post service              PostgreSQL             Media worker
    │                             │                        │                       │
    │ 1 POST /posts + key K       │                        │                       │
    │────────────────────────────▶│                        │                       │
    │                             │ 2 post + outbox, 1 tx  │                       │
    │                             │───────────────────────▶│                       │
    │ 3 202 {status: processing}  │                        │                       │
    │◀────────────────────────────│                        │                       │
    │ 4 show processing card      │                        │                       │
    ·················· relay publishes media-job; worker resizes ···················
    │                             │                        │ 5 status = published  │
    │                             │                        │◀──────────────────────│
    │ 6 GET /posts/:id            │                        │                       │
    │────────────────────────────▶│                        │                       │
    │ 7 published + URLs          │                        │                       │
    │◀────────────────────────────│                        │                       │
    │                             │                        │                       │
```

"The client polls the post with backoff (or listens on its socket) because the server's answer to 'is it done?' is the `status` field. The client never guesses: it shows 'processing' until the server says 'published'."

### Flow: one feed page

```
FeedList                  Feed cache             Feed service           Redis   PostgreSQL
    │                          │                       │                  │          │
    │ 1 fetchNextPage()        │                       │                  │          │
    │─────────────────────────▶│                       │                  │          │
    │                          │ 2 GET /feed?cursor=c  │                  │          │
    │                          │──────────────────────▶│                  │          │
    │                          │                       │ 3 timeline page  │          │
    │                          │                       │─────────────────▶│          │
    │                          │                       │ 4 celebrity posts           │
    │                          │                       │────────────────────────────▶│
    │                          │                       │ 5 hydrate page              │
    │                          │                       │────────────────────────────▶│
    │                          │ 6 posts + nextCursor  │                  │          │
    │                          │◀──────────────────────│                  │          │
    │ 7 append, skip seen ids  │                       │                  │          │
    │◀─────────────────────────│                       │                  │          │
    │                          │                       │                  │          │
```

"Steps 3 to 5 are the server's half of the hybrid; step 7 is the client's half of the cursor contract — append the page, skip any id already shown."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `posts` | `id` (time-ordered 64-bit), `user_id`, `status`, `caption`, counters | Sharded by user; `status` drives the UI |
| PostgreSQL | `post_media` | `(post_id, position)`, rendition prefix, `width`, `height` | Dimensions let the client reserve space |
| PostgreSQL | `idempotency_keys` | `(user_id, key)`, `request_hash`, `post_id` | Same transaction as the post |
| PostgreSQL | `outbox_events` | `id`, `type`, `payload`, `published_at` | Relayed to Kafka |
| PostgreSQL | `following`, `followers`, `likes` | Composite primary keys | A like is a set membership |
| Redis | `timeline:{user}` | Post ids scored by time | Capped at 500; rebuilt when missing |

### Client side

| Cache key | Holds | Changed by |
|-----------|-------|------------|
| `['feed']` | Pages of posts with `nextCursor` | Next page; pull-to-refresh refetches the head |
| `['post', id]` | One post incl. `status`, `isLiked`, `isSaved` | Like and save mutations (patched in feed pages too) |
| `['tray']` | Story rings with `hasSeen` | Viewing a story |
| IndexedDB `drafts` | Files, edits, caption, idempotency key, stage | The upload queue; deleted on success |

### The contract

```
POST  /api/v1/uploads                  → signed PUT URLs
POST  /api/v1/posts                    + Idempotency-Key → 202 {post, status} | 415 | 422
GET   /api/v1/posts/{id}               → post incl. status, isLiked | 404 if not visible
GET   /api/v1/feed?cursor=&limit=20    → {posts, nextCursor, degraded?}
POST  /api/v1/posts/{id}/like          → 200 {idempotent} | 404;  DELETE to unlike
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same request → same post for 24 h; different request → `422` | Retry after timeouts, refreshes and double taps without duplicates |
| `status` | `processing` until images exist, then `published` (or `failed`) | Show a processing card and swap in real images |
| `nextCursor` | Keyset position `(time, id)`; stable as posts arrive | Infinite scroll without repeats or gaps |
| `degraded` | Set when the server returned an empty page to protect itself | Show "temporarily unavailable" instead of "follow someone" |
| `idempotent` | The like or unlike changed nothing on the server | Keep the optimistic state but undo the count change |
| `404` | Same answer for "doesn't exist" and "not allowed to see" | Remove the post from the UI; don't retry |
| `width`, `height` | Every image has its dimensions | Reserve the slot before the image loads |

---

## 🔧 Deep Dive 1: One Post per Share (8 min)

"The scenario: someone taps Share on a train, the request times out, and they tap again — or close the tab and reopen it. Without a design, they get two posts in every follower's feed. Each layer has a job."

**Browser.** When Share is tapped, the composer freezes the draft and generates a key with `crypto.randomUUID()`, storing both in IndexedDB before any network call. Every retry — automatic, the Retry button, or a reopened tab that finds a pending draft — sends the same key. Editing the draft creates a new key, because it's now a different request.

**Post service.** It looks the key up for this user. A match with the same request fingerprint (caption, filters and a hash of each photo) returns the stored post with `Idempotent-Replayed: true`; a match with a different fingerprint is `422`. Otherwise it writes the post, its media, the key and an outbox event in one transaction. Two concurrent retries race on the key's primary key: the loser's insert waits, conflicts, rolls back, and answers with the winner's post.

**Pipeline.** Because the job is an outbox row committed with the post, no broker outage can strand a post in `processing`. Workers are idempotent, so the relay publishing twice or the broker redelivering doesn't create a second set of images.

**Back in the browser.** The `202` carries `status: processing`. My own feed shows the card with the local preview; the post page says "still processing"; when the status turns `published`, the cached post is replaced with the server's version and its CDN images.

| Approach | Verdict |
|----------|---------|
| ✅ Client key in IndexedDB + server key in the post's transaction | Correct across timeouts, refreshes and concurrent retries |
| ❌ Disable the button | Stops double taps, not retries after a timeout or a reload |
| ❌ Server dedupe by caption and image hash alone | Merges intentional duplicates, and two concurrent requests both pass the check |
| ❌ Commit, then publish the job | A broker blip strands the post in `processing` forever |

"What I give up: a table row per key for 24 hours, IndexedDB code for drafts, and a visible 'processing' state instead of pretending the post is live. That honesty is cheaper than one duplicate post."

---

## 🔧 Deep Dive 2: The Feed, End to End (9 min)

"The feed has to be a cache read on the server and a smooth list on the client, while the data underneath changes constantly."

### Server: hybrid fan-out

For authors below 10,000 followers, publishing pushes the post id into each follower's Redis timeline, in pipelined batches of 1,000 followers, and only into timelines that exist. For authors above the threshold, nothing is pushed; each feed read pulls their recent posts and merges them in. Pure push fails on celebrities: a 100M-follower account would cost 100M writes per photo. Pure pull fails on heavy users: a thousand-way merge on every app open. The cost of the hybrid is two code paths and a threshold to tune.

The timeline is a cache. A missing one is rebuilt from PostgreSQL (marked as built first, so a fan-out landing mid-rebuild isn't lost); it holds 500 entries; a reader who scrolls past that continues from PostgreSQL with the same cursor.

### The seam: a keyset cursor

The cursor is the `(time, id)` of the last post returned. With an offset, every new post at the head shifts the next page by one, and the client shows a duplicate; a deleted post makes it skip one. The keyset cursor is stable under both. The client treats it as opaque and still de-duplicates by id when appending, as a belt-and-braces guarantee for retried pages.

### Client: a list that stays fast

The list is virtualized with measured rows: only rows in view are mounted, and heights come from the rendered row, not a guess, so the scrollbar doesn't jump. Each image slot reserves its aspect ratio from the server's `width` and `height`, uses `srcset` so phones fetch the 640-pixel rendition, and shows a tiny blurred placeholder. The next page is requested two screens before the end.

| Approach | Verdict |
|----------|---------|
| ✅ Hybrid fan-out + keyset cursor + virtualized list | Cheap reads, stable paging, constant DOM |
| ❌ Pull on every read + offset pages | Slow for heavy users; duplicates while scrolling |
| ❌ Push to everyone | A celebrity post takes minutes and floods Redis |
| ❌ Render every loaded post | Fine at 20, crashes mobile tabs at 500 |

**Degradation is part of the contract.** If PostgreSQL is struggling, a circuit breaker returns an empty page with `degraded: true` instead of piling up requests; the client shows a banner with a retry button and keeps whatever is already on screen.

---

## 🔧 Deep Dive 3: Likes and Privacy (4 min)

```
PostCard            Feed cache                   Post API                        PostgreSQL
    │                    │                           │                                │
    │ 1 liked, count +1  │                           │                                │
    │───────────────────▶│                           │                                │
    │                    │ 2 POST /posts/:id/like    │                                │
    │                    │──────────────────────────▶│                                │
    │                    │                           │ 3 visible? INSERT ON CONFLICT  │
    │                    │                           │───────────────────────────────▶│
    │                    │                           │ 4 0 rows: already liked        │
    │                    │                           │◀───────────────────────────────│
    │                    │ 5 200 {idempotent: true}  │                                │
    │                    │◀──────────────────────────│                                │
    │                    │ 6 keep liked, undo +1     │                                │
    ··················· 404 (no longer visible) or 5xx: roll back ·····················
    │                    │                           │                                │
```

**In the UI**, the heart fills and the count moves immediately. Taps during a pending request are ignored, so like and unlike can't race. On an error the snapshot is restored everywhere the post is cached, and an `aria-live` region announces it.

**In the backend**, a like is a row keyed `(post_id, user_id)`, inserted with `ON CONFLICT DO NOTHING`; the counter changes in the same statement through a trigger, so the row and the count can't drift. If nothing was inserted, the response says `idempotent: true` and the client undoes its +1 — the server's count already included this like.

**Privacy** is checked on the same request: the like is refused with `404` unless the viewer may see the post (published, and public or followed). The same rule guards post detail, comments, replies and likes lists, so a post id from an account that went private reveals nothing. The client treats that `404` as "remove this post", not "retry".

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic toggle + idempotent endpoint + visibility check | Instant, truthful, private |
| ❌ Wait for the server | 100–300 ms of dead tap on every like |
| ❌ Counter-only `like_count + 1` without a like row | Double counts on retries; no "did I like it?" |

---

## 📈 Failures & Scale (2 min)

| Failure | What the poster sees | What a follower sees | Mitigation |
|---------|----------------------|----------------------|------------|
| Upload times out | Draft card with Retry | Nothing | Same idempotency key; server replays the post |
| Broker down | "Processing" for longer | The post a little later | Outbox keeps the job; relay drains it on reconnect |
| Image fails 3 times | "Upload failed — retry" | Nothing | Retry queue, then dead-letter queue and `failed` status |
| Redis timeline lost | Nothing | Slower first feed load | Rebuild from PostgreSQL |
| PostgreSQL slow | — | "Feed temporarily unavailable" banner | Breaker + `degraded` page |
| Post goes private | — | Post disappears on next interaction | `404` handled as removal |

**What breaks first as we grow:** fan-out lag for accounts just under the threshold (more workers, or a lower threshold); hot celebrity post lists read by millions of followers (Redis replicas plus a short in-process cache); and image egress, which is why renditions are immutable and cached at the edge for a year.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Create safety | Client key in IndexedDB + server key in the post's transaction | Disabled button | Survives timeouts, refreshes and races |
| Async processing | `202` + visible `status` | Synchronous resize | No seconds-long requests; honest UI |
| Job hand-off | Transactional outbox | Commit, then publish | No stranded posts |
| Feed generation | Hybrid push/pull at 10K followers | Pure push or pull | Cheap reads without celebrity write storms |
| Paging | Opaque keyset cursor + client dedupe | Offsets | Stable while the feed changes |
| Likes | Optimistic + `idempotent` reconciliation | Pessimistic | Instant and still correct |
| Privacy | `404` on every read and write path | Filtering only in lists | No probing by id |

"With more time I'd add push delivery of the 'published' transition over the existing messaging socket instead of polling, a service worker for offline reading, and the ranking stage on top of the merged candidates."
