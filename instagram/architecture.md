# Instagram (Photo Sharing) — Architecture

## System Overview

Instagram lets people upload photos, follow each other, and scroll a home feed of posts from the accounts they follow, alongside 24-hour stories and direct messages. Two problems make it a real design exercise. First, **media ingestion**: a 3 MB photo has to be uploaded over a phone connection, resized into several renditions, and published exactly once, even when the client retries and the processing fleet crashes half way. Second, **feed generation**: a feed load must be a cache lookup, yet one post from an account with a hundred million followers cannot turn into a hundred million cache writes. The answer is a hybrid: precompute timelines on write for normal accounts, merge in high-follower accounts on read.

This document describes the production-scale design first. [Implementation Notes](#implementation-notes) describe what the local Express + PostgreSQL + Valkey + RabbitMQ + MinIO + Cassandra + React implementation actually runs.

**Learning goals**

- Hybrid fan-out: push to cached follower timelines below a follower threshold, pull and merge above it.
- Treating a precomputed timeline as a cache: lazy rebuild, capped size, expiry, keyset pagination.
- An upload pipeline that survives retries and crashes: idempotency keys, a transactional outbox, idempotent workers, bounded retries and a dead-letter queue.
- Visibility rules (private accounts, unpublished posts, conversation membership) enforced on every read path.
- Polyglot persistence: PostgreSQL for the graph and posts, Redis for timelines, object storage for media, Cassandra for messages.

## Requirements

### Functional requirements

1. **Post**: upload one to ten photos with a caption, location and per-photo filter; the post appears once its images are processed.
2. **Home feed**: posts from followed accounts (and your own), newest first, with infinite scroll.
3. **Engage**: like, save and comment on posts; follow and unfollow accounts; private accounts approve who can see their posts.
4. **Stories**: 24-hour posts shown as rings in a tray, with "seen" state and a viewer list for the author.
5. **Direct messages**: one-to-one conversations with read receipts, typing indicators and reactions.
6. **Explore**: popular posts from public accounts you don't follow.

Out of scope: video transcoding, feed ranking models, search, notifications, ads and content moderation (each mentioned where it would plug in).

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Feed load | p99 < 200 ms server-side for a page of 20 |
| Post creation acknowledgement | p99 < 500 ms after the upload finishes |
| Publish latency | Post visible to followers within 5 s (p95) of the upload |
| Image delivery | p99 < 100 ms from the CDN edge |
| Availability | 99.95% for feed and reads; uploads may queue but must never be lost |
| Correctness | One "Share" creates at most one post; a private account's posts are never shown to non-followers |
| Durability | No accepted upload is lost (originals kept until processing succeeds) |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Daily active users | 500M | |
| New posts | 100M/day → ~1.2K/s average, ~3.5K/s peak | Processing is asynchronous and sized for peaks |
| Feed loads | 5B/day → ~58K/s average, ~150K/s peak | A feed read must be a cache lookup plus one hydration query |
| Read:write ratio | ~50 feed loads per post | Precompute on write wherever it is affordable |
| Original uploads | 3 MB × 100M ≈ 300 TB/day | Clients upload straight to object storage, never through API servers |
| Renditions | ~1.5 MB per post ≈ 150 TB/day | Immutable keys, CDN with a one-year TTL |
| Image egress | ~1 MB per feed page × 150K/s ≈ 1.2 Tbps peak | The CDN must absorb well over 95% |
| Timelines | 500 ids × ~80 B ≈ 40 KB per user; 500M users ≈ 20 TB of RAM | Cap at 500 entries, expire idle timelines after 7 days |
| Celebrity fan-out | One post to 100M followers = 100M writes ≈ 100 s of a 1M-writes/s cluster | Don't push for large accounts; pull them at read time |
| Direct messages | 10B/day → ~115K/s average, ~300K/s peak | Write-optimized store partitioned by conversation |

### Local Development Scale

One API process, one image worker, and PostgreSQL, Valkey, RabbitMQ, MinIO and Cassandra from Docker Compose. The seed has ten users and eighteen posts, so `FEED_CELEBRITY_THRESHOLD` (default 10,000) can be lowered to 4 to make the seeded account `alice` a "celebrity" and exercise the pull path. Ports and setup are in the [README](./README.md).

## High-Level Architecture

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

1. **Create (1).** The client gets a signed upload URL and PUTs the original photo straight into object storage. It then calls `POST /api/v1/posts` with an `Idempotency-Key`; the Post service writes the post (status `processing`), its media rows, the key and an outbox event in one PostgreSQL transaction, and answers `202`.
2. **Read (2).** `GET /api/v1/feed` reaches the Feed service, which reads the viewer's precomputed timeline from Redis, pulls recent posts of followed celebrity accounts from PostgreSQL, merges both by time and hydrates one page in a single query. Images come from the CDN.
3. **Publish (3).** The outbox relay puts a media job on Kafka. A media worker resizes the original into renditions, marks the post `published` and emits `post-published`; fan-out workers push the post id into followers' cached timelines, except for authors with 10,000+ followers, whose posts are pulled at read time instead.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| CDN | Serves image renditions | Image requests | Keys are immutable, so nothing is ever purged |
| API gateway | TLS, session check, rate limits, routing | Requests | Rejects abusive clients before any service work |
| Post service | Signed URLs, post creation, likes, comments, follows | Writes (~3.5K posts/s peak) | Owns `posts`; the outbox relay runs beside it |
| Feed service | Timeline read, celebrity merge, hydration | Feed loads (~150K/s peak) | Stateless; the hottest read path |
| Object storage | Originals and renditions | Bytes stored | Originals deleted after processing |
| PostgreSQL | Users, posts, follows, likes, comments, outbox | Rows; sharded by user id | Read replicas serve hydration |
| Redis cluster | Timelines, post objects, sessions, rate limits | Active users (~20 TB) | A cache: losing it makes feeds slower, never wrong |
| Kafka | `media-jobs`, `post-published` | Upload rate | Partitioned by author id |
| Media workers | Resize and encode, then publish | Queue depth | CPU-bound; autoscaled on lag |
| Fan-out workers | Push post ids into follower timelines | Follower edges written | Skip celebrity authors entirely |

Direct messages and stories are separate subsystems (a WebSocket gateway with Cassandra, and a stories service with its own tray cache); they are described under [Stories and direct messages](#stories-and-direct-messages).

## Core Components / Request Flows

### Creating a post

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

- The upload goes straight to object storage, so a 10 MB photo never occupies an API server. The signed URL is scoped to one object key and expires after 15 minutes.
- The `Idempotency-Key` is generated once per draft on the client. Step 5 returns the stored post if the same user already used that key with the same request fingerprint (caption, location, filters and a hash of each file), and `422` if the key was reused with a different request.
- Step 6 is one transaction: the post, its media rows, the idempotency key and an outbox event either all commit or none do. The primary key on `(user_id, key)` serializes concurrent retries: the second insert waits for the first transaction and then conflicts, and that request answers with the winner's post.
- `202 Accepted` is honest: the post exists but is not visible to followers until the pipeline publishes it.

### Reading the feed

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

- The timeline is a Redis sorted set: score = post time in milliseconds, member = post id, capped at 500 entries. The cursor is `(time, id)` of the last item returned, so new posts arriving at the head never shift later pages.
- Step 4 is the read-time half of the hybrid. It fetches recent posts of followed accounts above the celebrity threshold; production keeps each celebrity's last 100 post ids in a Redis list so this is one pipelined read rather than a database query.
- Step 6 loads author, media, and the viewer's like and save state for the whole page in one round trip; posts that were deleted or are not published drop out here, so a stale timeline entry can never render.
- If the timeline is missing (new user, evicted, idle for a week), the Feed service marks it as built and rebuilds it from PostgreSQL before reading. If the reader scrolls past the 500 cached entries, the next page comes from PostgreSQL with the same cursor.

### Publishing and fan-out

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

- Every step is safe to repeat, because delivery is at least once: the relay may publish an event twice, and Kafka redelivers after a crash. Step 2 skips posts that are already published; step 3 writes deterministic keys (`images/{postId}/{index}/{size}`) so a retry overwrites rather than orphans; step 4 re-checks the status under a row lock so two concurrent deliveries can't both publish.
- Fan-out reads followers a page at a time (keyset on follower id) and writes each page as one Redis pipeline. A Lua script adds the post only to timelines that already exist: inactive users get no writes and rebuild on their next visit.
- A failed job is retried after 5 seconds, up to three attempts, then sent to a dead-letter queue and the post is marked `failed` so the author sees "Upload failed — retry".

### Stories and direct messages

**Stories** are posts with `expires_at = created_at + 24h`, processed synchronously into two sizes. The tray (the row of rings) is cached per viewer for at most 60 seconds and never past the earliest expiry in it; a ring is "seen" only when every active story in it has been viewed. Creating or deleting a story invalidates the trays of the author's followers, batched like fan-out and skipped for celebrity accounts, which rely on the short TTL.

**Direct messages** use a WebSocket gateway for delivery and Cassandra for storage. Messages are partitioned by conversation and clustered by a TimeUUID, so "newest 50 in this conversation" is one sequential read of one partition; the inbox is a second table partitioned by user and clustered by last-message time. Every conversation-scoped operation first checks that the caller is a participant.

## Database Schema

### Production schema

PostgreSQL, sharded by user id into logical shards (the approach Instagram described publicly). Post ids are 64-bit and time-ordered (41 bits of milliseconds, 13 bits of shard, 10 bits of sequence), so the id itself sorts by time and doubles as the feed cursor.

```sql
CREATE TABLE posts (
  id            BIGINT PRIMARY KEY,               -- time-ordered: ms | shard | sequence
  user_id       BIGINT NOT NULL,
  caption       TEXT CHECK (length(caption) <= 2200),
  status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'published', 'failed')),
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX posts_author_recent ON posts (user_id, id DESC) WHERE status = 'published';

CREATE TABLE post_media (
  post_id      BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position     SMALLINT NOT NULL,
  original_key TEXT,                              -- deleted after processing
  rendition    TEXT,                              -- images/{postId}/{position}/
  width        INTEGER,
  height       INTEGER,
  PRIMARY KEY (post_id, position)
);

-- The graph is stored twice so both directions are single-shard reads:
-- "who do I follow" (feed pull) and "who follows this author" (fan-out).
CREATE TABLE following (follower_id BIGINT, followee_id BIGINT, created_at TIMESTAMPTZ,
                        PRIMARY KEY (follower_id, followee_id));      -- sharded by follower
CREATE TABLE followers (followee_id BIGINT, follower_id BIGINT, created_at TIMESTAMPTZ,
                        PRIMARY KEY (followee_id, follower_id));      -- sharded by followee

CREATE TABLE likes (
  post_id BIGINT, user_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)                  -- a like is set membership: naturally idempotent
);

CREATE TABLE outbox_events (
  id BIGSERIAL PRIMARY KEY, aggregate_id BIGINT NOT NULL, event_type TEXT NOT NULL,
  payload JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE INDEX outbox_pending ON outbox_events (next_attempt_at, id) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  user_id BIGINT, idempotency_key TEXT, request_hash CHAR(64) NOT NULL,
  post_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)          -- serializes concurrent retries
);
```

Cassandra holds messages:

```sql
CREATE TABLE messages_by_conversation (
  conversation_id UUID, message_id TIMEUUID, sender_id UUID, content TEXT,
  PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE conversations_by_user (
  user_id UUID, last_message_at TIMESTAMP, conversation_id UUID,
  other_user_id UUID, other_username TEXT, last_message_preview TEXT, unread_count INT,
  PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC);
```

Redis keys:

| Key | Type | Contents | Lifetime |
|-----|------|----------|----------|
| `timeline:{userId}` | Sorted set | Post ids scored by time, plus a "built" marker | 500 entries; expires after 7 idle days |
| `user_posts:{userId}` | List | Last 100 post ids of a celebrity author | Rewritten on publish |
| `post:{id}` | String | Post object for hydration (published posts only) | 5 min, deleted on every write |
| `story_tray:{userId}` | String | Rings for the viewer | ≤ 60 s and ≤ the earliest expiry |
| `sess:{sid}` | String | Session | 7 days |
| `ratelimit:{action}:{user}` | Counter | Rate-limit window | Window length |

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql). Every statement is guarded (`IF NOT EXISTS`, `CREATE OR REPLACE TRIGGER`), so it can be applied repeatedly to an existing database. The DM tables are in [`backend/db/cassandra-init.cql`](./backend/db/cassandra-init.cql).

| Production | Local | Difference |
|------------|-------|------------|
| `posts` with time-ordered `BIGINT` ids | `posts` with UUID ids | Order and cursors use `(created_ms, id)`, computed from `created_at` |
| `following` + `followers` (two shardings) | One `follows` table | Indexed both ways, plus `(following_id, follower_id)` for keyset fan-out |
| `likes`, `comments`, `comment_likes`, `saved_posts` | Same, with triggers | Triggers keep `like_count`, `comment_count`, comment likes and follower counts in step |
| `outbox_events`, `idempotency_keys` | Same | — |
| `user_posts:{id}` list for celebrities | — | Celebrity posts are read from PostgreSQL |
| Stories and views in a dedicated store | `stories`, `story_views` tables | View dedup by a unique `(story_id, viewer_id)` |

## API Design

### Production API

```
POST   /api/v1/uploads                      signed PUT URLs for n files
POST   /api/v1/posts                        Idempotency-Key → 202 post (processing) | 409 | 415 | 422
GET    /api/v1/posts/{id}                   post, viewer's like/save state | 404 if not visible
DELETE /api/v1/posts/{id}                   author or admin
POST   /api/v1/posts/{id}/like              200 {idempotent} | 404 if not visible; DELETE to unlike
GET    /api/v1/feed?cursor=&limit=20        {posts, nextCursor, degraded?}; cursor = "<ms>_<id>"
GET    /api/v1/feed/explore?cursor=         popular public posts you don't follow
POST   /api/v1/users/{id}/follow            idempotent; DELETE to unfollow
GET    /api/v1/stories/tray                 rings with seen state
WS     /api/v1/messages/socket              send, receive, typing, read receipts
```

- Errors are JSON `{error}` with an honest status: `404` for anything the caller may not see (private posts, other people's conversations), `415` for non-image uploads, `422` for a reused idempotency key, `429` with `RateLimit` headers when limited.
- Cursors are opaque to clients. Offsets are rejected: an offset into a feed that gains posts at the head repeats and skips items.

### Local routes

The local API serves everything from one Express process under `/api/v1`; see [Implementation Notes](#implementation-notes).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/register`, `/auth/login`, `/auth/logout`; GET `/auth/me` | Session auth (session id regenerated on login) |
| POST | `/posts` | Multipart create (`media` × ≤ 10, `caption`, `location`, `filters`), optional `Idempotency-Key` |
| GET, DELETE | `/posts/:postId` | Detail (visibility-checked, includes `status`) and delete |
| POST, DELETE | `/posts/:postId/like`, `/posts/:postId/save` | Idempotent toggles |
| GET | `/posts/:postId/likes`, `/posts/:postId/comments`, `/comments/:id/replies` | Lists, visibility-checked |
| POST, DELETE | `/posts/:postId/comments`, `/comments/:id`, `/comments/:id/like` | Comments and comment likes |
| GET | `/feed?cursor&limit`, `/feed/explore?cursor&limit` | Home feed and Explore (keyset cursors) |
| GET, PUT, POST, DELETE | `/users/:username`, `/users/me`, `/users/:userId/follow`, `/users/:username/{posts,followers,following}` | Profiles and the graph |
| GET, POST, DELETE | `/stories`, `/stories/tray`, `/stories/user/:userId`, `/stories/:id/view`, `/stories/:id/viewers` | Stories |
| GET, POST | `/messages/conversations[/:id[/read\|/typing\|/messages/:mid/reactions]]` | DMs over HTTP, participants only |
| GET | `/api/health`, `/api/health/live`, `/api/health/ready`, `/api/health/detailed`, `/metrics` | Operations |

## Key Design Decisions

### 1. Hybrid fan-out: push below 10,000 followers, pull above

Reading a feed on demand means "posts from everyone I follow, newest first" — a merge over hundreds of authors on every app open, so the most engaged users get the slowest feed, at 150K loads per second. Pushing each post id into every follower's timeline at publish time turns that into one sorted-set read. Push breaks for large accounts: one post from an account with 100M followers is 100M writes, minutes of a whole Redis cluster, mostly to people who won't open the app that day. So authors at or above a follower threshold are never pushed; each feed read merges their recent posts in, which costs one extra read of the handful of celebrities a viewer follows. The cost is two code paths and a threshold to tune: I'd start at 10,000 followers and adjust it with two signals, fan-out lag and feed read latency.

### 2. The timeline is a cache, not a record

Timelines can be evicted, can expire, and are capped at 500 entries; PostgreSQL stays the source of truth. A timeline carries a "built" marker; a read that finds no marker rebuilds the timeline from PostgreSQL, marking it first so a fan-out that lands during the rebuild isn't lost. Fan-out writes only to timelines that exist, so dormant accounts cost nothing. A reader who scrolls past the cap continues from PostgreSQL with the same cursor. The cost is a slower first load after inactivity — one indexed query instead of a cache read.

### 3. Direct uploads, asynchronous processing, and a transactional outbox

Resizing takes seconds of CPU; holding an HTTP request for it ties up a server per upload and couples the user's success to the image library not failing. So the client uploads to object storage, the API records the post as `processing`, and workers publish it later. The tricky part is the hand-off: "commit the post, then publish the job" loses the job whenever the broker is down or the process dies between the two steps, leaving a post stuck in `processing` forever. Writing the job as an outbox row in the same transaction as the post, and relaying it afterwards, makes the hand-off atomic. The cost is at-least-once delivery — the relay can publish twice — which is why every worker step is idempotent.

### 4. Keyset cursors on (time, id)

The feed, Explore and lists are paged by the position of the last item, never by offset. With offsets, every new post at the head shifts page 2 by one, so the reader sees a duplicate; posts deleted above the offset make the reader skip one. A `(time, id)` cursor is stable under both and maps directly onto `ZREVRANGEBYSCORE` and an index range scan. The cost is that pages can't be jumped to by number, which a feed never needs.

### 5. Cassandra for messages

Messages are append-only, read newest-first within one conversation, and written far more often than read. Cassandra's partition-per-conversation with TimeUUID clustering makes that one sequential read, and writes are appends. TimeUUID rather than a timestamp keeps two messages in the same millisecond from overwriting each other. The cost is no joins and no transactions with PostgreSQL: the inbox denormalizes usernames and avatars, which must be refreshed by an event when a profile changes.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Create post | One post per draft, across timeouts and concurrent retries | `Idempotency-Key` stored with a request hash; primary key `(user_id, key)` in the same transaction as the post |
| Job hand-off | A committed post always gets its processing job | Transactional outbox, relay with broker publisher confirms |
| Job processing | Effectively once | At-least-once delivery + skip if published + deterministic object keys + status re-check under a row lock |
| Fan-out | Every follower with a cached timeline gets the post | Idempotent `ZADD`; a redelivered job re-runs fan-out; a missing timeline is rebuilt from PostgreSQL |
| Likes and follows | No double counts | Unique keys; `INSERT … ON CONFLICT DO NOTHING`; counters in the same statement (trigger); `idempotent: true` tells the client its optimistic +1 was redundant |
| Feed vs database | Eventually consistent, seconds | Hydration drops deleted and unpublished posts; unfollow removes the author's posts from the timeline |
| Post cache | Never serves a processing post; stale ≤ 5 min for author name and avatar | Only published posts cached; invalidated on like, comment, delete, publish |
| Messages | Ordered and unique per conversation | TimeUUID clustering key |

## Security / Auth

- **Sessions**: an `HttpOnly`, `SameSite=Lax` cookie backed by Redis; the session id is regenerated at login and registration, so a planted id can't ride an authenticated session.
- **Visibility**: authors see their own posts in any state; others see only published posts, and private accounts' posts only if they follow. The rule applies to post detail, comments, replies, likes lists, like/save/comment actions and stories. A refused request is a `404`, so ids can't be used to probe.
- **Messages**: every conversation-scoped request checks membership first (`404` otherwise).
- **Rate limits**: per user (per IP when anonymous), in Redis so they hold across instances: 10 posts/hour, 30 follows/hour, 100 likes/hour, 5 failed logins/minute, 60 feed pages/minute.
- **Input**: image MIME types only, known filter names, captions ≤ 2,200 characters, UUID-shaped ids; renditions are re-encoded, which strips EXIF metadata, including GPS location.

## Observability

- **Feed**: latency split by timeline hit or rebuild, pushed versus pulled posts per page, the degraded-response rate.
- **Fan-out**: posts by mode (`push`, `pull`), timeline writes, fan-out lag (publish to last write) — this is the "visible within 5 s" SLO.
- **Pipeline**: outbox backlog and the age of the oldest pending event (alert above 5 minutes), job outcomes (`published`, `duplicate`, `retried`, `dead_lettered`), dead-letter depth (alert above 0), processing duration.
- **Correctness**: idempotent replays and key mismatches, duplicate likes absorbed.
- **Health**: liveness is the process; readiness checks PostgreSQL and Redis and fails as soon as shutdown starts; the detailed check includes object storage, the broker and the outbox backlog.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Broker down | Uploads still succeed; posts wait in `processing` | Events stay in the outbox; the relay reconnects with backoff and drains them |
| Worker crash mid-job | Job redelivered | Idempotent steps; deterministic keys; status check under a row lock |
| Image can't be processed | Post marked `failed` after 3 attempts | Retry queue (5 s), then dead-letter queue for inspection |
| Fan-out fails after publish | Job fails and is retried | The retry finds the post published and re-runs only the fan-out |
| Redis timeline lost | Slower first feed load | Rebuild from PostgreSQL on read |
| PostgreSQL slow | Feed requests would pile up | Circuit breaker returns an empty page flagged `degraded`; the client shows a banner |
| Object storage down | Uploads fail fast with `503`, nothing written | Client retries with the same idempotency key |
| Client retries a create | Same post returned | Idempotency key replay |

## Scalability Considerations

1. **Fan-out for mid-size accounts breaks first.** Accounts just under the threshold generate the most writes per post; batching followers into pipelines keeps a 10,000-follower post to a few round trips, and the threshold can move down if fan-out lag grows.
2. **Celebrity reads become hot keys.** Every follower of a celebrity reads that account's recent posts; keep them in a `user_posts:{id}` list replicated across Redis replicas, plus a short in-process cache in the Feed service.
3. **Timeline memory** grows with active users (~20 TB); the cap and the 7-day expiry bound it, and a compact encoding of 64-bit ids halves it.
4. **PostgreSQL** shards by user id with posts co-located with their author; the graph is stored twice (by follower and by followee) so fan-out and feed pulls each read one shard.
5. **Media processing** is the most elastic tier: autoscale workers on queue lag; uploads queue rather than fail during spikes.
6. **Multi-region**: reads (feed, CDN, replicas) are served regionally; post writes go to the author's home region, and `post-published` events replicate to other regions' fan-out.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Feed generation | Hybrid: push < 10K followers, pull above | Pure push or pure pull | Cheap reads without million-write posts |
| Timeline store | Redis sorted set, capped, rebuildable | Durable timeline table | It's a cache; PostgreSQL is the record |
| Fan-out targets | Cached timelines only | Every follower | Dormant accounts cost nothing; rebuild on return |
| Pagination | Keyset `(time, id)` cursor | Offset | Stable while posts arrive and disappear |
| Upload path | Direct to object storage, async processing | Through the API, synchronous resize | API servers never hold bytes or CPU work |
| Job hand-off | Transactional outbox | Commit, then publish | A post can never be stuck without its job |
| Create retries | Idempotency key in the post's transaction | Disable the button | Survives timeouts, refreshes and races |
| Messages | Cassandra, partition per conversation | PostgreSQL | Append-heavy, newest-first reads |
| Private content | `404` on every read path | Filter only in lists | No probing by id |

## Implementation Notes

### What runs

[`backend/src/index.ts`](./backend/src/index.ts) starts one Express process ([`app.ts`](./backend/src/app.ts)) serving every route, the outbox relay, and a periodic purge of expired idempotency keys. [`workers/image-worker.ts`](./backend/src/workers/image-worker.ts) is the media worker. The frontend is React 19 + TanStack Router + Zustand + Tailwind, with a virtualized feed.

### Production patterns implemented

**Hybrid fan-out** — [`services/feedService.ts`](./backend/src/services/feedService.ts) and [`services/timeline.ts`](./backend/src/services/timeline.ts). After a post is published, `fanOutPost` checks the author's `follower_count`; below `FEED_CELEBRITY_THRESHOLD` it pages through followers by keyset (`FEED_FANOUT_BATCH_SIZE`, default 1,000) and writes each page as one Redis pipeline of a Lua script that only touches timelines that exist:

```lua
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
return 1
```

`getFeedPage` reads the timeline page and the celebrity candidates in parallel, rebuilds a timeline whose `~built` marker is missing (marker first, then the query), continues from PostgreSQL past the 500-entry cap, merges by `(created_ms, id)`, and hydrates the page in one SQL statement (author, media as a JSON array, the viewer's like and save state). Follow copies the author's 50 newest posts into a cached timeline; unfollow removes them; delete removes the post from every timeline it was pushed to. [`routes/feed.ts`](./backend/src/routes/feed.ts) validates cursors (`400` on offsets), clamps `limit` to 50, and wraps the read in an Opossum breaker whose fallback is an empty page flagged `degraded`. There is no feed response cache any more; it served stale like state for 60 seconds.

**Upload pipeline** — [`routes/posts.ts`](./backend/src/routes/posts.ts) validates (images only, known filters, caption length), replays a known `Idempotency-Key` ([`services/idempotency.ts`](./backend/src/services/idempotency.ts)), uploads originals to MinIO before opening a transaction, then commits post + media + key + outbox event together; a losing concurrent retry rolls back, deletes its uploads and returns the winner's post. [`services/outbox.ts`](./backend/src/services/outbox.ts) claims due events with `FOR UPDATE SKIP LOCKED`, publishes each with a broker confirm, and backs off failures (1 s doubling to 60 s); while RabbitMQ is down it claims nothing and reconnects in the background. [`services/queue.ts`](./backend/src/services/queue.ts) uses a confirm channel, retries failed jobs through a new `image-processing-retry` queue (5 s delay) up to `MEDIA_JOB_MAX_ATTEMPTS` (3), dead-letters poison messages immediately, and re-registers the consumer after a reconnect. The main queue's arguments are unchanged, so existing broker volumes keep working. [`services/mediaPipeline.ts`](./backend/src/services/mediaPipeline.ts) is the idempotent worker described in [Publishing and fan-out](#publishing-and-fan-out).

**Visibility and authorization** — [`services/visibility.ts`](./backend/src/services/visibility.ts) implements the rules in [Security / Auth](#security--auth) for posts, comments, replies, likes, saves and stories. [`routes/messages.ts`](./backend/src/routes/messages.ts) checks conversation membership before every conversation-scoped route. [`routes/auth.ts`](./backend/src/routes/auth.ts) regenerates the session id at login and registration and maps a racing duplicate sign-up to `409`.

**Caches with invalidation** — post detail entries (`post:v2:{id}`) are written only for published posts and deleted on like, unlike, comment, comment delete, post delete, publish and failure. Story trays live for at most 60 seconds, never past the earliest expiry in them, and are dropped when the viewer views a story or a followed author adds or deletes one.

**Operations** — graceful shutdown fails readiness, stops accepting connections, drains requests (up to 10 s), stops the relay, then closes PostgreSQL, Redis, Cassandra and RabbitMQ. `/api/health/detailed` reports object storage (it used to report "ok" with MinIO down), the broker, and the outbox backlog with the age of its oldest event. Metrics (prom-client) include `instagram_feed_fanout_total{mode}`, `instagram_feed_fanout_timeline_writes_total`, `instagram_outbox_pending_events`, `instagram_image_job_outcomes_total{outcome}` and `instagram_idempotent_replays_total{result}`. Logs are Pino JSON with a per-request trace id.

**Frontend** — likes and saves are optimistic with rollback through [`hooks/useOptimisticToggle.ts`](./frontend/src/hooks/useOptimisticToggle.ts): extra taps are ignored while a request is in flight, failures roll back and are announced in an `aria-live` region, and an `idempotent: true` response undoes the optimistic +1. The composer sends one `Idempotency-Key` per draft and lands on the new post's page, which shows the processing state. The feed passes opaque cursors, de-duplicates pages, and has error, retry and degraded states.

**Tests** — 91 vitest tests in 7 files run offline with mocked infrastructure: routes ([`app.test.ts`](./backend/src/app.test.ts)), feed algorithm, timeline primitives, worker, queue (retry, dead-letter, reconnect), outbox relay and idempotency fingerprints.

### Simplified or substituted

- Uploads go through the API (multer, 10 MB per file) to MinIO instead of signed URLs to S3; there is no CDN.
- RabbitMQ replaces Kafka, and the media worker performs fan-out itself instead of emitting `post-published` to separate fan-out workers.
- One PostgreSQL instance with UUID ids; order and cursors use `created_at` in milliseconds plus the id. Celebrity posts are read from PostgreSQL rather than a `user_posts` list.
- The feed is chronological; there is no ranking model. Explore orders by `likes + 2 × comments`.
- Sessions in Redis instead of OAuth. Direct messages are HTTP endpoints on a single-node Cassandra, with no WebSocket push.
- Stories are resized inside the request (behind a breaker). Renditions are four JPEG sizes plus a full-size copy, with no WebP or AVIF.

### Omitted

Video, ranking, search beyond `ILIKE`, notifications, moderation, multi-region, sharding and read replicas.

### Known limitations

- Celebrity status is decided from the current `follower_count` at publish and at read. An author who drops below the threshold leaves posts made while above it out of timelines until a rebuild.
- RabbitMQ classic queues have no delivery limit: a job that crashes the worker process (rather than throwing) is redelivered indefinitely. Retries use one fixed 5-second delay.
- The Cassandra inbox moves a conversation to the top with a read, a delete and an insert, so two concurrent senders can leave a duplicate row; the unread count is read-modify-write; usernames and avatars in it are still not refreshed after a profile change.
- Rate limits use `express-rate-limit` with a Redis fixed-window store, not a sliding window.
- Likes, comments and follower lists still page on `created_at` alone, so equal timestamps can skip a row.
- The frontend keeps server data in component state rather than a query cache, and Explore search requests are not cancelled when superseded.
- Locally verified with PostgreSQL and Redis only; the RabbitMQ, MinIO and Cassandra paths are covered by unit tests with mocks.
