# 📸 Instagram — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Instagram looks like CRUD on photos, but it hides two pipelines with opposite problems. The upload pipeline moves 300 TB of originals a day through seconds of CPU work each, and every step has to be safe to retry, because phones time out and workers crash. The feed pipeline has to answer 150,000 loads a second from a cache, yet one post from an account with a hundred million followers can't become a hundred million cache writes. So I'll build a write path where every hand-off is idempotent, and a hybrid feed: push to followers' timelines for normal accounts, pull for celebrities."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the two numbers that shape the design |
| High-level architecture | 10 min | One overview, three flows: create, read, publish |
| Data model & API | 7 min | What lives where, how it's keyed and sharded |
| Deep dive 1: hybrid fan-out | 8 min | Push vs pull, the celebrity threshold, timelines as a cache |
| Deep dive 2: a retry-safe upload pipeline | 7 min | Idempotency keys, outbox, idempotent workers |
| Deep dive 3: direct messages | 4 min | Why Cassandra, and how the keys are chosen |
| Scale, failures, wrap-up | 4 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope. Instagram is a dozen products; I'll take the core loop of posting and the feed, plus stories and DMs at a lighter depth."

### Functional requirements

1. **Post** one to ten photos with a caption and a filter; the post appears once its images are processed.
2. **Home feed**: posts from accounts I follow, newest first, infinite scroll.
3. **Engage**: like, save and comment; follow and unfollow; private accounts limit who can see their posts.
4. **Stories** that expire after 24 hours, with "seen" rings.
5. **Direct messages** between two people, with read receipts.

Out of scope: video, ranking models, search, notifications, ads. I'll say where ranking would plug in.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Feed load | p99 < 200 ms for 20 posts | It's the app's first screen |
| Create acknowledgement | p99 < 500 ms after upload | The user is watching a spinner |
| Publish latency | Visible to followers within 5 s (p95) | Posting should feel live |
| Availability | 99.95% reads; uploads may queue, never be lost | A lost photo is unrecoverable trust damage |
| Correctness | One Share = at most one post; private posts never leak | Duplicates and leaks are user-visible bugs |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Daily actives | 500M | |
| Posts | 100M/day → ~1.2K/s, ~3.5K/s peak | Processing must be async and elastic |
| Feed loads | 5B/day → ~58K/s, ~150K/s peak | A feed read is a cache read plus one query |
| Uploads | 3 MB × 100M ≈ 300 TB/day | Clients upload straight to object storage |
| Image egress | ~1 MB per page × 150K/s ≈ 1.2 Tbps peak | A CDN carries almost all of it |
| Timelines | 500 ids × ~80 B ≈ 40 KB/user → ~20 TB RAM | Cap, expire idle ones, treat as a cache |
| Celebrity post | 100M followers = 100M writes | At ~1M writes/s cluster-wide, that's 100 s per post |

"Two numbers drive everything: 150K feed loads per second means reads must be precomputed, and a 100-second fan-out for a single celebrity post means they can't be precomputed for everyone."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the system once, then walk the three journeys: creating a post, reading the feed, and the asynchronous publish that connects them."

```
 ┌──────────────────────────────────────────┐                           ┌───────────────────────┐
 │ Mobile app / web client                  │── GET image renditions ──▶│ CDN                   │
 │ feed list, uploader, media cache         │── (1) PUT original ─┐     │ image renditions      │
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

1. **Create (1).** The client gets a signed URL and uploads the original straight to object storage; then `POST /api/v1/posts` with an idempotency key. The Post service writes the post as `processing`, its media rows, the key and an outbox event in one transaction, and answers `202`.
2. **Read (2).** The Feed service reads the viewer's timeline from Redis, pulls recent posts of any celebrity accounts they follow, merges the two by time, and hydrates the page in one query. Images come from the CDN.
3. **Publish (3).** The outbox relay puts a media job on Kafka. A media worker resizes the original, marks the post published and emits `post-published`; fan-out workers push the post id into followers' cached timelines, unless the author is a celebrity.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, session check, rate limits | Requests | Abuse stops here |
| Post service | Uploads, posts, likes, comments, follows | ~3.5K posts/s peak | Owns `posts`; runs the outbox relay |
| Feed service | Timeline read, celebrity merge, hydration | ~150K loads/s peak | Stateless, the hottest path |
| Object storage + CDN | Originals, renditions, delivery | Bytes | Renditions are immutable: cache for a year |
| PostgreSQL | Users, posts, graph, likes, outbox | Rows; sharded by user | Source of truth |
| Redis cluster | Timelines, post objects, sessions | Active users | Losing it is slower, never wrong |
| Kafka | `media-jobs`, `post-published` | Upload rate | Partitioned by author |
| Media workers | Resize and encode, then publish | Queue lag | CPU-bound, autoscaled |
| Fan-out workers | Push to follower timelines | Follower edges | Skip celebrity authors |

"Why separate the Feed service from the Post service? They have opposite profiles: the feed is 50 times the traffic, read-only and latency-critical; posting is bursty and write-heavy. Separate pools let a viral posting spike never slow down feed reads."

### Flow 1: creating a post

```
Client                               Post service   Object storage           PostgreSQL
   │                                       │               │                      │
   │ 1 POST /uploads                       │               │                      │
   │──────────────────────────────────────▶│               │                      │
   │ 2 upload ids + signed PUT URLs        │               │                      │
   │◀──────────────────────────────────────│               │                      │
   │ 3 PUT original (signed URL)                           │                      │
   │──────────────────────────────────────────────────────▶│                      │
   │ 4 POST /posts, Idempotency-Key K      │               │                      │
   │──────────────────────────────────────▶│               │                      │
   │                                       │ 5 key K seen for this user?          │
   │                                       │─────────────────────────────────────▶│
   │                                       │ 6 1 tx: post + media + key + outbox  │
   │                                       │─────────────────────────────────────▶│
   │ 7 202 post (status processing)        │               │                      │
   │◀──────────────────────────────────────│               │                      │
   ················ response lost, client retries with the same K ·················
   │ 8 POST /posts, Idempotency-Key K      │               │                      │
   │──────────────────────────────────────▶│               │                      │
   │ 9 202 same post, Idempotent-Replayed  │               │                      │
   │◀──────────────────────────────────────│               │                      │
   │                                       │               │                      │
```

"The client generates the idempotency key once per draft. If the `202` is lost and the app retries, step 5 finds the key and returns the original post instead of creating a second one. Everything in step 6 is one transaction, so there is no moment where the post exists without its processing job."

### Flow 2: reading the feed

```
Client                   Feed service                            Redis   PostgreSQL
   │                           │                                   │          │
   │ 1 GET /feed?cursor=ms_id  │                                   │          │
   │──────────────────────────▶│                                   │          │
   │                           │ 2 timeline entries below cursor   │          │
   │                           │──────────────────────────────────▶│          │
   │                           │ 3 post ids + times, built marker  │          │
   │                           │◀──────────────────────────────────│          │
   │                           │ 4 followed celebrities' posts below cursor   │
   │                           │─────────────────────────────────────────────▶│
   │                           │ 5 merge by (time, id), keep 20    │          │
   │                           │ 6 hydrate 20 posts (one query)               │
   │                           │─────────────────────────────────────────────▶│
   │ 7 posts + nextCursor      │                                   │          │
   │◀──────────────────────────│                                   │          │
   │                           │                                   │          │
```

"The cursor is the `(time, id)` of the last post I returned, not an offset, so posts arriving at the head don't shift the next page. Step 6 hydrates all twenty posts — author, media, and my like and save state — in one round trip, and drops anything deleted or unpublished, so a stale timeline entry can't render."

### Flow 3: publishing and fan-out

```
S3               Media worker           PostgreSQL    Kafka              Fan-out              Redis
 │                     │                     │          │                   │                   │
 │                     │ 1 media-job                    │                   │                   │
 │                     │◀───────────────────────────────│                   │                   │
 │                     │ 2 processing?       │          │                   │                   │
 │                     │────────────────────▶│          │                   │                   │
 │ 3 GET + PUT images  │                     │          │                   │                   │
 │◀────────────────────│                     │          │                   │                   │
 │                     │ 4 publish (locked)  │          │                   │                   │
 │                     │────────────────────▶│          │                   │                   │
 │                     │ 5 post-published               │                   │                   │
 │                     │───────────────────────────────▶│                   │                   │
 │                     │                     │          │ 6 post-published  │                   │
 │                     │                     │          │──────────────────▶│                   │
 │                     │                     │ 7 followers page             │                   │
 │                     │                     │◀─────────────────────────────│                   │
 │                     │                     │          │                   │ 8 ZADD timelines  │
 │                     │                     │          │                   │──────────────────▶│
 ·························· failure: retry in 5 s, 3 tries, then DLQ ····························
 │                     │                     │          │                   │                   │
```

"Every step is safe to repeat. The worker checks whether the post is already published, writes renditions under deterministic keys so a retry overwrites instead of orphaning, and flips the status under a row lock so two deliveries can't both publish. Fan-out writes are `ZADD`s, which are idempotent by nature."

---

## 💾 Data Model (4 min)

"PostgreSQL is the source of truth for anything relational, Redis holds what the feed reads, object storage holds bytes, and Cassandra holds messages."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `posts` | `id` (64-bit, time-ordered), `user_id`, `caption`, `status`, counters | `(user_id, id DESC)` where published; sharded by `user_id` |
| PostgreSQL | `post_media` | `(post_id, position)`, `original_key`, rendition prefix, size | Original deleted after processing |
| PostgreSQL | `following` / `followers` | `(follower_id, followee_id)` and the reverse | The graph is stored twice so both directions are single-shard reads |
| PostgreSQL | `likes` | `(post_id, user_id)` | The primary key makes a like idempotent |
| PostgreSQL | `outbox_events` | `id`, `event_type`, `payload`, `published_at`, `next_attempt_at` | Partial index on unpublished rows |
| PostgreSQL | `idempotency_keys` | `(user_id, key)`, `request_hash`, `post_id` | Written in the post's transaction; 24 h retention |
| Redis | `timeline:{user}` | Sorted set: score = post time, member = post id | 500 entries max, 7-day idle expiry, a "built" marker |
| Redis | `user_posts:{author}` | Last 100 post ids of a celebrity | Read by every follower's feed: replicated |
| Redis | `post:{id}` | Hydrated post object | Published posts only; deleted on writes |
| Cassandra | `messages_by_conversation` | Partition `conversation_id`, cluster `message_id` (TimeUUID desc) | One partition per conversation |
| Cassandra | `conversations_by_user` | Partition `user_id`, cluster `last_message_at` desc | The inbox, denormalized |

"The post id deserves a word. I'd use 64-bit ids that embed the millisecond, the shard and a sequence number, as Instagram described publicly. Ids then sort by time, so the id is the feed cursor and the sorted-set score, and every shard can mint ids without coordination."

"Why PostgreSQL for posts instead of a wide-column store? Posts, likes and the graph need uniqueness constraints and transactions — a like must not double count, and a post and its outbox event must commit together. Sharding by user id keeps a user's posts on one shard. The graph is the exception that needs two copies: fan-out asks 'who follows this author', the feed pull asks 'whom does this viewer follow', and each copy is sharded by the side it's queried by."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/uploads                   → signed PUT URLs, one per file
POST   /api/v1/posts                     Idempotency-Key → 202 {post, status: processing} | 415 | 422
GET    /api/v1/posts/{id}                → post + my like/save state | 404 if not visible
POST   /api/v1/posts/{id}/like           → 200 {idempotent} | 404;  DELETE to unlike
GET    /api/v1/feed?cursor=&limit=20     → {posts, nextCursor, degraded?}
POST   /api/v1/users/{id}/follow         → 200 {idempotent};  DELETE to unfollow
GET    /api/v1/stories/tray              → rings with seen state
WS     /api/v1/messages/socket           → send, receive, typing, read receipts
```

- **`202` on create.** The post exists but isn't visible to followers yet; the response says so, with a `status` the client can show.
- **Idempotency key on create, natural idempotency elsewhere.** A post is an event, so retries need a key; a like is set membership, so `INSERT … ON CONFLICT DO NOTHING` is enough, and the response says whether anything changed.
- **Opaque keyset cursors.** Offsets repeat and skip items in a feed that changes while you scroll.
- **`404` for anything you may not see**, not `403`, so ids can't be used to probe a private account.
- **Rate limits per action** in Redis: 10 posts an hour, 30 follows, 100 likes, 5 failed logins a minute.

---

## 🔧 Deep Dive 1: Hybrid Fan-out (8 min)

"The decision: push post ids into followers' timelines at publish time for normal accounts, and pull celebrity posts at read time."

### Why pushing works for most accounts

A feed read becomes one sorted-set range read plus one hydration query, regardless of how many accounts I follow. Publishing pays instead: a post from an account with 300 followers costs 300 writes, batched into a single Redis pipeline. With 50 feed loads per post, moving the work to write time is the right side of the ratio.

### Why pure push fails

Fan-out cost is proportional to followers. A post from an account with 100 million followers is 100 million writes; at a million pipelined writes a second for the whole timeline cluster, that's 100 seconds of the entire cluster for one photo — and most of those followers won't open the app today. Worse, celebrities post during events, exactly when everyone else does.

### Why pure pull fails

Pulling means each feed load merges the latest posts of every account I follow. Someone following 1,000 accounts costs a 1,000-way merge per open, at 150K opens a second, and the most engaged users get the slowest app.

### The hybrid

| Approach | Feed read | Publish | Where it breaks |
|----------|-----------|---------|-----------------|
| ❌ Pure push | 1 range read | O(followers) | Celebrity posts take minutes and swamp Redis |
| ❌ Pure pull | O(followed accounts) merge | O(1) | Heavy users, every app open |
| ✅ Hybrid, threshold 10K | Range read + merge of a few celebrities | O(followers) below 10K | Two code paths; a threshold to tune |

1. At publish, the fan-out worker reads the author's follower count. At or above the threshold it writes only the author's own timeline. Below it, it pages through followers 1,000 at a time and writes each page as one pipeline.
2. At read, the Feed service fetches the timeline page and, in parallel, the recent posts of the celebrities the viewer follows (a `user_posts` list per celebrity, so it's a pipelined read), merges by `(time, id)`, and hydrates the top 20.

"I'd start the threshold at 10,000 and tune it with two signals: fan-out lag, which goes up when the threshold is too high, and feed latency, which goes up when it's too low and viewers follow many 'celebrities'."

### The timeline is a cache

Three rules keep it cheap and correct:

- **Write only timelines that exist.** A small Lua script does `ZADD` and trim only if the key exists. Dormant users get no writes and their memory expires after seven idle days.
- **Rebuild lazily, marker first.** A read that finds no "built" marker rebuilds from PostgreSQL. I set the marker before running the rebuild query, so a fan-out that lands during the rebuild finds the key and isn't skipped.
- **Cap at 500, continue from the database.** A reader who scrolls past the cap gets the next page from PostgreSQL with the same cursor.

**What I give up.** Two read paths to keep consistent, a little extra work on every read for people who follow celebrities, and a slower first load after a week away. In exchange, no post ever costs more than 10,000 writes, and a lost Redis node degrades latency rather than correctness.

> "If ranking comes in, it consumes this candidate set: the merged timeline and celebrity posts are the input, and a light model reorders the top few hundred. Pagination then runs over a ranked snapshot cached per session instead of over time."

---

## 🔧 Deep Dive 2: A Retry-Safe Upload Pipeline (7 min)

"Every hand-off in posting can happen twice — the client retries, the relay republishes, the broker redelivers. The decision is to make each step idempotent rather than trying to make delivery exactly-once."

### Step 1: client → API, with an idempotency key

The client generates a key per draft and reuses it for every retry. The server stores `(user, key, request hash, post id)` in the same transaction as the post. A retry with the same key and body returns the original post; the same key with a different body is a client bug and gets `422`. Two concurrent retries race on the primary key: the second insert waits for the first transaction, conflicts, rolls back, and returns the winner's post.

### Step 2: API → queue, with a transactional outbox

The naive version is "commit the post, then publish the job". If the broker is down, or the process dies between the two, the post is stuck in `processing` forever and nobody notices. Writing the job into an `outbox_events` row in the same transaction makes the hand-off atomic. A relay claims due rows with `FOR UPDATE SKIP LOCKED` (so several relays never take the same row), publishes with broker confirms, and stamps them published. If it crashes after the broker confirms but before stamping, the event goes out twice — which step 3 has to tolerate.

### Step 3: queue → worker, idempotent

The worker skips posts that are already published, writes renditions under deterministic keys, and flips the status under a row lock. A failure goes to a retry queue with a delay, three attempts in total, then to a dead-letter queue, and the post is marked `failed` so the author can retry. Poison messages that can't even be parsed go straight to the dead-letter queue instead of looping.

| Approach | Verdict |
|----------|---------|
| ✅ Idempotency key + outbox + idempotent worker | Correct under client retries, crashes and redelivery |
| ❌ Commit, then publish | Loses jobs whenever the broker or process fails in between |
| ❌ Distributed transaction (database + broker) | Couples availability of both; few brokers support it well |
| ❌ Disable the Share button | Prevents double taps, not retries after a timeout |

**What I give up.** An extra table write per post, a relay process to operate, and the discipline that every consumer must be idempotent. Publish latency gains the relay's polling interval unless the API nudges the relay after commit, which it does.

---

## 🔧 Deep Dive 3: Direct Messages (4 min)

"The decision is Cassandra for message storage, behind a WebSocket gateway."

Messages are append-only, read newest-first within one conversation, and written at around 300K per second at peak. In Cassandra, `messages_by_conversation` is partitioned by conversation and clustered by a TimeUUID in descending order, so "the latest 50 messages" is one sequential read of one partition, and writes are appends to a commit log. The TimeUUID matters: with a plain timestamp, two messages in the same millisecond share a clustering key, and one silently overwrites the other.

The inbox is a second table, partitioned by user and clustered by last-message time. Moving a conversation to the top means deleting and re-inserting its row, because the sort key is part of the primary key; I'd keep a small `(user, conversation) → last_message_at` lookup to avoid a filtered scan, and accept that two concurrent senders can briefly duplicate a row that a read de-duplicates.

Delivery runs through a WebSocket gateway; when the recipient is connected to another gateway node, Redis pub/sub carries the message across. Every conversation-scoped request checks membership first — a conversation id must never be enough to read someone's messages.

| Approach | Verdict |
|----------|---------|
| ✅ Cassandra, partition per conversation | Append-heavy writes, one-partition reads, linear scaling |
| ❌ PostgreSQL messages table | Works for a while; a huge, mostly cold B-tree, and sharding it by conversation is Cassandra rebuilt by hand |

**What I give up.** No joins and no transactions with PostgreSQL: the inbox copies usernames and avatars and needs a profile-changed event to refresh them.

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** fan-out lag for accounts just below the threshold during busy hours (more fan-out workers, or lower the threshold); hot celebrity `user_posts` keys (replicas plus a short in-process cache in the Feed service); media processing during peaks (autoscale on queue lag; uploads queue rather than fail); timeline memory as daily actives grow (compact 64-bit encoding, shorter idle expiry).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Broker down | Posts stay "processing" longer | Jobs wait in the outbox; the relay reconnects and drains them |
| Worker crash mid-job | Nothing | Redelivery; idempotent steps |
| Corrupt image | "Upload failed — retry" | 3 attempts, then dead-letter and `failed` status |
| Redis node lost | Slower first feed load | Timelines rebuild from PostgreSQL |
| PostgreSQL slow | Feed banner "temporarily unavailable" | Circuit breaker returns an empty page marked `degraded` |
| Object storage down | Upload fails fast | `503`; the client retries with the same key |

**What I'd watch:** feed p99 split by timeline hit or rebuild; fan-out lag (publish to last timeline write — the 5-second SLO); outbox backlog and the age of its oldest event (alert above 5 minutes); job outcomes and dead-letter depth (alert above zero); idempotent replays, which spike when clients struggle on bad networks.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Feed generation | Hybrid push/pull at 10K followers | Pure push or pure pull | Cheap reads without million-write posts |
| Timeline store | Capped Redis sorted sets, rebuildable | Durable timelines | A cache over PostgreSQL, sized to active users |
| Pagination | Keyset `(time, id)` cursor | Offset | Stable while the feed changes |
| Upload path | Direct to object storage, async processing | Through the API, synchronous | API servers hold no bytes and no CPU work |
| Job hand-off | Transactional outbox | Commit, then publish | A post can't be stranded without its job |
| Create retries | Idempotency key in the post's transaction | Button disabling | Survives timeouts and concurrent retries |
| Messages | Cassandra + WebSocket gateway | PostgreSQL + polling | Append-heavy, newest-first, real-time |

"With more time I'd add the ranking stage on top of the candidate set, video transcoding with adaptive bitrate, and content moderation as a stage between processing and publish."
