# Facebook News Feed Architecture

## System Overview

A ranked social feed is a read-heavy materialized view over posts, relationships, and engagement. The design has three independent obligations: accepted mutations must survive retries, candidate distribution must fit the follower distribution, and the client must page through a stable reading order while current privacy rules remain authoritative.

**Production proposal:** durable posting with asynchronous hybrid fan-out, permission-checked hydration, short-lived ranked feed sessions, desired-state engagement, and bounded browser state. This is a Facebook-inspired teaching design, not a claim about Facebook's actual infrastructure. **Local implementation:** Express, PostgreSQL, Valkey, and a React/TanStack Virtual frontend. Final Implementation Notes describe the code and its limitations; proposed services and guarantees are not implicitly implemented.

## Requirements

| Area | Proposed requirement |
|------|----------------------|
| Feed | Ranked recent candidates from followed accounts; labeled public discovery fallback |
| Posting | Text and processed image references; durable, retryable author result |
| Relationships | Follow/unfollow; explicitly defined friends visibility and revocation |
| Engagement | Like/unlike as desired state; comments with recoverable outcomes |
| Reading | Stable pagination within a feed session; new content offered through a refresh affordance |
| Privacy | Revalidate access on hydration, detail, comments, engagement, and media access |
| Availability | Target 99.9% regional feed-serving availability |
| Latency | Target healthy-path p95 feed API under 300 ms and first useful browser content under 1.5 seconds on a specified network/device |
| Freshness | Target ordinary fan-out visible within 10 seconds; publish acceptance does not wait for every recipient |
| Resources | Bounded candidate sets, fan-out chunks, feed-session lifetimes, browser pages, and media players |

The initial production contract defines Friends as mutually active relationships. The local code generally treats following as sufficient and has additional privacy defects. Stories, messaging, video playback, shares, custom audiences, notifications, and ML ranking are extensions rather than prerequisites for the first design.

## Capacity Estimation

These are a consistent example workload, not measurements or facts about Facebook:

| Assumption/calculation | Result |
|------------------------|--------|
| 100M daily users × 10 feed reads/day | 1B reads/day, about 11,574 reads/second average |
| Five-times-average read peak | About 57,870 reads/second |
| 20M posts/day | About 231 posts/second average; about 1,157 at a 5× peak |
| 2 KB raw record per post | 40 GB/day, 14.6 TB/year before indexes, replicas, and media |
| 95% of posts pushed × 50 average recipients | 950M feed insert attempts/day, about 10,995/second average |
| One author with 10M followers | 10M candidate insert attempts for one push-mode post |
| 10M cached feeds × 500 entries × 24 raw bytes | 120 GB for ID/score values alone, excluding Redis structure/allocator overhead |

A follower threshold is a scheduling heuristic, not a guarantee about audience activity or cost. Moving a popular author to pull mode avoids per-follower candidate writes but still creates candidate reads, hydration, ranking, and possibly notification fan-out. A hot account's notification channel does not make delivery to millions of sockets free.

### Local Development Scale

Use a few browser sessions against one PostgreSQL/Valkey pair. The seed's 150/320/one-million follower counts are illustrative values; there are only four actual follow edges. A celebrity flag exercises the pull branch without generating a million local accounts. No benchmark establishes the throughput targets above.

## High-Level Architecture

Proposed production services; static assets and processed public media use a separate CDN. Personalized responses and private media require audience-aware access, not a shared public edge cache.

```
┌──────────────────────────┐       ┌──────────────────────────┐
│ Feed API + session check │       │ Post / graph / like API  │
│ Candidate hydration      │       │ Authorized operations    │
└────────────┬─────────────┘       └────────────┬─────────────┘
             │                                  │
             ▼                                  ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ Ranked feed sessions     │       │ SQL shards               │
│ Ordered IDs + cursors    │       │ Records/receipts/outbox  │
└────────────▲─────────────┘       └────────────┬─────────────┘
             │                                  ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ Candidate aggregation    │◀──────│ Durable fan-out workers  │
│ Pushed + pull timelines  │       │ Bounded recipient chunks │
└──────────────────────────┘       └────────────┬─────────────┘
                                                ▼
                                   ┌──────────────────────────┐
                                   │ Notification gateways    │
                                   │ Authorized refresh hints │
                                   └──────────────────────────┘
```

Post and relationship authorities persist source records and outbox work. Candidate workers materialize pushed IDs; followed high-fan-out authors contribute their author timelines at read time. Feed serving batches those sources, filters authorization, ranks once for a short-lived session, and pages its ordered IDs. Hydration still checks current deletion/access state on every page.

Gateways may send lightweight refresh hints over WebSocket or SSE; ordinary mutations remain HTTP operations. A hint does not contain private content or establish permission. The browser offers a new-feed banner rather than automatically reordering a reading user's session.

## Core Components / Request Flows

### Post creation and hybrid distribution

1. Authenticate the actor, validate content/media and requested audience, and resolve an actor-scoped operation ID with request-digest binding.
2. Commit the post, operation result, and outbox event together. Return durable acceptance to the author; recipient distribution is asynchronous.
3. A retryable worker evaluates the author's distribution policy. Ordinary authors get bounded batches of recipient candidate inserts, unique by viewer/post. High-fan-out authors update an author timeline read by their followers.
4. Track chunk progress, retry failures, and rebuild caches from durable projections. Inspect per-command pipeline errors; batching network calls is not a transaction.
5. Send coalesced refresh hints to interested online viewers. New candidates enter the next feed session, not the middle of an existing ranked page sequence.

Choose push/pull using follower count, active audience, post frequency, and observed work. The local threshold of 10,000 is an experiment default. Policy transitions need a version and overlap period: read/dedupe old pushed entries plus the applicable author timeline until historical coverage is safe. Simply flipping a flag can strand older posts or double the read work.

### Feed session and page retrieval

The first request gathers bounded pushed candidates and recent posts from followed pull-mode authors. Batch author-timeline reads rather than issuing one sequential round trip per author. Hydrate and permission-filter candidates, rank/diversify them, then store a limited ordered list with viewer identity, graph/ranking versions, creation time, and an expiry, for example ten minutes.

Return an opaque cursor identifying that session and the next position. An offset is safe **inside this immutable ordered list**; offsetting into a freshly reranked database query is not. A score plus stable ID only resolves ties; it cannot prevent movement across pages when the score itself changes. PostgreSQL also requires a deterministic order to make ordinary LIMIT/OFFSET subsets predictable. [PostgreSQL LIMIT/OFFSET](https://www.postgresql.org/docs/16/queries-limit.html)

For subsequent pages, advance through the frozen order and recheck current access/deletion before returning content. Overfetch within the session to fill around newly hidden rows. Cursor progress covers examined positions, not just displayed rows. A revoked friendship can remove content even within a frozen session: stable order is not a snapshot of permanent permission.

On expiry, return an explicit reset/refresh response. Do not silently reinterpret the cursor against a new ranking. Display an end-of-session message rather than claiming the user has seen every eligible post ever created. A labeled public discovery mode has its own policy/session and fresh viewer-specific like state.

### Relationships and visibility

Store directed follow edges but evaluate mutually active edges for the proposed Friends contract. Follow/unfollow operations use transactional relationship/counter updates and publish invalidation work. A delayed fan-out task may contain an obsolete audience; current authorization at read/mutation time is the final defense.

Existing browser content also needs revocation/removal notifications or revalidation on resume. A private image URL must not remain an unrestricted permanent public link merely because its post metadata is protected. The local demo takes arbitrary external URLs, so it does not implement audience-protected media.

### Engagement and browser reconciliation

Use an idempotent desired-state operation such as liked=true/false with operation identity. In one transaction, change the unique membership row if necessary, adjust the canonical count only for that transition, and record a versioned result/event. Counts can be aggregated differently at larger scale, but then expose their staleness rather than claiming strongly consistent display.

The client keeps an authoritative base plus its latest pending intent. Serialize operations for one viewer/post, coalesce rapid toggles, and reconcile versioned results without letting an old failure undo a newer action. An unknown outcome resolves via the same operation/readback; a generic rollback assumes too much about whether the server committed.

Store posts by ID with page membership kept separately. Both profile and home views use the same entity state, so one like updates both. Card-local drafts cannot survive virtualization unmounts; keep meaningful pending comments/drafts outside the mounted card with per-account bounds and cleanup.

## Database Schema

The following is the **exact local initialization SQL** from [init.sql](./backend/src/db/init.sql): nine tables, seventeen explicit indexes, one timestamp function, and three triggers. It is not an idempotent migration: CREATE TABLE/INDEX/TRIGGER statements will fail if rerun against an initialized database.

```sql
-- Facebook News Feed Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    follower_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    is_celebrity BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Posts table
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    image_url VARCHAR(500),
    post_type VARCHAR(20) DEFAULT 'text' CHECK (post_type IN ('text', 'image', 'link')),
    privacy VARCHAR(20) DEFAULT 'public' CHECK (privacy IN ('public', 'friends')),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    share_count INTEGER DEFAULT 0,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Friendships/Following table
CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'blocked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

-- Likes table
CREATE TABLE likes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);

-- Comments table
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Feed cache table (for storing fan-out feed items)
CREATE TABLE feed_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    score DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);

-- User sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications table
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Affinity scores table (for ranking)
CREATE TABLE affinity_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score DOUBLE PRECISION DEFAULT 0,
    last_interaction_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, target_user_id)
);

-- Indexes for performance
CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC);

CREATE INDEX idx_friendships_follower ON friendships(follower_id);
CREATE INDEX idx_friendships_following ON friendships(following_id);
CREATE INDEX idx_friendships_status ON friendships(status);

CREATE INDEX idx_likes_user ON likes(user_id);
CREATE INDEX idx_likes_post ON likes(post_id);

CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_user ON comments(user_id);

CREATE INDEX idx_feed_items_user ON feed_items(user_id);
CREATE INDEX idx_feed_items_user_score ON feed_items(user_id, score DESC);
CREATE INDEX idx_feed_items_user_created ON feed_items(user_id, created_at DESC);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

CREATE INDEX idx_affinity_user ON affinity_scores(user_id);
CREATE INDEX idx_affinity_score ON affinity_scores(user_id, score DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed data is in db-seed/seed.sql
```

### Local schema implications

The unique viewer/post, viewer/liked-post, and directed-follow constraints prevent duplicate rows at the database boundary; they do not make the associated counters, cache updates, or responses transactional. There are no post/comment length checks, nonnegative count checks, or database prohibition on self-follow. Application checks are partial. Only users, posts, and comments have updated-at triggers.

Feed `score` is used as a recency value, not the computed ranking score. Ordinary fan-out inserts milliseconds, while follow backfill and fixtures use epoch seconds. The cache preserves these inconsistent units. The stream of posts and the selected ranked list therefore need separate schemas/identities in the proposal.

| Proposed extension | Important fields/invariant |
|--------------------|----------------------------|
| Operation receipts | Actor + operation ID unique, digest, result, supported retry expiry |
| Outbox and chunk tasks | Event identity, author/policy version, recipient progress, retry status |
| Candidate entries | Viewer/post uniqueness, canonical time units, source/policy generation |
| Feed sessions | Viewer, ranked ordered IDs, model/graph versions, expiry, next position |
| Engagement result | Viewer/post desired state, operation identity, canonical count/version |
| Visibility changes | Post/relationship version, actor, deletion/revocation event |
| Media references | Owned upload ID, processing status, dimensions, authorized derivatives |

Shard posts by author and candidate feeds by viewer. Both directions of the follow graph need access paths: storing edges by follower does not make “all followers of this author” a single-shard lookup without a reverse index/projection. A wide-column candidate store can be introduced for write volume, with bounded viewer/time partitions; canonical transactional records need not migrate with it.

## API Design

### Actual local routes

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/logout` | Session lifecycle |
| GET | `/api/v1/auth/me` | Authenticated user/profile/role |
| GET | `/api/v1/feed` | Authenticated candidate merge/ranking; posts/cursor/has_more |
| GET | `/api/v1/feed/explore` | Public seven-day popular list; offset/limit |
| POST | `/api/v1/posts` | Create, await inline fan-out, return post |
| GET / DELETE | `/api/v1/posts/:postId` | Read / author-or-admin soft-delete |
| POST / DELETE | `/api/v1/posts/:postId/like` | Add/remove unique membership with separate counts |
| GET / POST | `/api/v1/posts/:postId/comments` | Read/add comments |
| DELETE | `/api/v1/posts/:postId/comments/:commentId` | Author/admin delete |
| GET | `/api/v1/users?q=...`, `/api/v1/users/:username` | User search / public profile |
| PUT | `/api/v1/users/me` | Update profile fields |
| GET | `/api/v1/users/:username/posts` | Profile posts, timestamp-only cursor |
| GET | `/api/v1/users/:username/followers`, `/api/v1/users/:username/following` | Offset-paged relationships |
| POST / DELETE | `/api/v1/users/:username/follow` | Follow/unfollow with SQL backfill/removal |
| GET | `/metrics`, `/health`, `/health/live`, `/health/ready` | Instrumentation and probes |

```json
{"content":"A new post","post_type":"text","privacy":"public"}
```

This is an actual creation body sent with `Authorization: Bearer <token>`. `X-Idempotency-Key` is optional, despite the middleware factory's requireIdempotency name. The browser sends no such header. Success returns the post object directly, not an envelope with success/data or an optimistic-conflict array.

The server accepts a token query parameter on WebSocket upgrade without a path restriction. It sends `connected` and can forward externally published `feed_updates:<userId>` messages. The exported broadcast helper is not invoked; there are no inbound subscription/ping handlers, celebrity subscriptions, engagement broadcasts, or frontend socket client. This is infrastructure scaffolding, not working end-to-end live feed delivery.

### Proposed additions

Add feed-session cursors/expiry responses, explicit discovery mode, authorized refresh hints, desired-state/versioned likes, correlated operation receipts, and consistent structured errors. Shared generated schemas/types should be accompanied by runtime validation. Bound list limits and content/media fields; the actual routes largely use unchecked parseInt/defaults and truthiness tests.

## Key Design Decisions

### Hybrid distribution instead of a universal push/pull rule

Push precomputes work once for recipients, improving repeated reads at the cost of candidate writes and asynchronous lag. Pull avoids a huge writer burst but charges candidate retrieval to each reading follower. Batched queries can make pull cheaper than one query per followed account, so that alternative is not inherently hundreds of sequential SQL calls. The correct boundary depends on observed workload.

The hybrid choice adds transition policy, duplicate candidate sources, and two recovery paths. A queue changes when fan-out work happens, not its total size. “Followers notified” should not mean “all devices displayed the post,” and inactive-recipient pruning requires rebuild behavior when a viewer returns.

### Frozen ranked sessions instead of drifting score cursors

A bounded session makes pagination and scroll restoration explainable. A tie-breaker gives equal scores a deterministic order but cannot hold scores still. Recomputing rank on page two can move an unseen post above the cursor and omit it forever. Client deduplication hides repeated IDs but cannot recover omitted records.

The cost is server/session storage and stale ranking during reading. New-post hints and user-driven refresh restore freshness without silently moving content. Current privacy/deletion checks remain live even while ranking is frozen. Chronological mode would use its own stable time-plus-ID contract and eligibility policy, not merely swap one ORDER BY in an already filtered candidate set.

### Canonical mutation state instead of unconditional rollback

Desired-state likes and versioned responses make retries and rapid toggles tractable. Repeating liked=true does not count twice. A client overlay keeps the interface responsive while the canonical base remains explicit. Blindly decrementing after any failure can undo a later successful unlike or replay a stale count.

This costs per-entity operation tracking and reconciliation. For post/comment creation, retain recoverable drafts and operation IDs; text being visible optimistically is not durable acceptance. Other viewers' new posts belong behind a refresh affordance, because automatic insertion changes the reader's position.

### Ranking baseline and quality limits

The actual heuristic is engagement (likes + 3×comments + 5×shares) × 1/(1+0.08×ageHours) × (1+min(affinity,100)/100) × 1,000. At 12.5 hours, the reciprocal decay is half its age-zero value; it is not an exponential decay with a repeating half-life. An old viral post can still dominate a new modest one, and zero engagement yields zero score regardless of recency or affinity.

For a proposed baseline, give fresh unseen content a nonzero prior, compress very large engagement counts, decay affinity, and reserve some candidate/display budget for freshness and author diversity. These are product hypotheses to evaluate, not a claim that a 2× affinity cap guarantees a healthy feed. Add negative feedback and model experiments later without changing the feed-session continuity contract.

## Consistency and Idempotency

Locally, post insertion, fan-out, author lookup, and response caching are separate. A row can exist despite a 500 response; fan-out can fail despite a 201. The middleware caches successful response status/body asynchronously for 24 hours under user/path/key. It neither reserves the operation atomically nor binds it to a request digest, and cache failures allow processing. Reusing a key with changed text can return an old post; concurrent misses can create two posts. The current route's local path is '/', so it is not a robust general cross-router identity.

Like/unlike/comment/follow operations also have independent membership, count, affinity, and Redis writes. Existing likes return 409, missing likes return 404; concurrent inserts can hit SQL uniqueness errors. Redis like counts are increments/decrements without a baseline read or reconciliation, so seed counts and cached counts disagree and cached counters can become negative. Affinity accumulates through like/comment and single-post GET view operations, without decay or reversal; the Redis affinity mirror is not used by feed ranking.

The proposal uses transactional records/receipts/outbox and idempotent consumer effects, not exactly-once transport. Candidate duplication is tolerable; duplicate canonical engagement changes or lost accepted post results are not. Explicit operation retention and feed-session expiry prevent old requests/cursors from silently acquiring new meaning.

## Security / Auth

Actual login/register creates a seven-day SQL session and a Redis user-ID value with the same initial TTL. HTTP checks Redis first, then always reads the user row; an empty cache falls back to SQL and caches for one fixed hour without clamping to remaining session lifetime. Redis command failure returns 500 rather than falling back. SQL/cache logout writes are separate, so stale cache can preserve access after a partial failure. A socket checks only Redis at connection time and is not revalidated on logout or expiry.

Tokens are opaque UUIDs, not JWTs and not cookie sessions. The browser stores a plain token key as well as a persisted auth-storage token field. This is still server-side session authentication. Production session transport should minimize script exposure, constrain origins, use TLS, and apply CSRF protections if moved to cookies; session revocation must include long-lived channels.

Privacy has concrete local gaps: final home hydration checks deletion only; a single-post friends check denies only when no relationship **and no authenticated user**, allowing authenticated strangers; comment read/add and likes check existence rather than audience. Profile posts generally allow a one-way follower to see Friends posts. Unfollow removes SQL candidates but leaves Redis IDs, and hydration does not repair that authorization gap. Soft-deleted rows are filtered on hydration even if stale IDs remain cached.

Use one current audience predicate on every read and mutation, including media and discovery. Treat caches/candidates as hints, not grants. The demo has no rate limiter, complete schema validation, moderation service, or admin dashboard; admin role checks only extend deletion rights. CORS is configured, but no socket origin check or Helmet/security middleware is installed.

## Observability

Pino request logs include a request ID, method/path, status, and duration; component logs cover auth/feed/fan-out/cache work. Request-scoped IDs are not propagated automatically to those separate component operations. Development defaults to debug/pretty output and production to info/JSON. `/metrics` exposes HTTP/feed/fan-out/cache/auth/WS/breaker/health measurements and default process metrics.

`db_query_duration_seconds` is declared but never observed by the direct pool-query paths. Fan-out success metrics can count unchecked pipeline failures and do not establish that followers received a notification. Feed latency includes its fallback work but not browser rendering. HTTP labels normalize UUIDs/numeric segments/usernames, while arbitrary unknown paths can still create cardinality. The WS “new_post” counter labels every forwarded message that way regardless of its actual payload.

The feed breaker uses the critical preset: 5-second timeout, 25% error threshold after at least three requests, 30-second reset, ten-second rolling window. State gauge values are closed=0, half-open=1, open=2. Its fallback queries the same PostgreSQL pool for 20 popular public posts, ignores requested limit/cursor, sets all is_liked values false, and is not protected by the original breaker timeout. A database outage can therefore make the fallback fail or wait too.

Production monitoring should separate acceptance from fan-out completion, cache coverage from cache hit rate, session resets from true history exhaustion, and canonical mutation state from UI intent. Track task age, partial chunk failures, candidate/hydration authorization drops, stable-session page latency, restore success, and browser resource growth. Avoid private content/tokens in telemetry.

## Failure Handling

| Failure | Actual behavior | Proposed behavior |
|---------|-----------------|-------------------|
| Saved post, fan-out error | Logged failure is ignored by creator route | Durable chunk task retries and reconciliation |
| Redis unavailable | Some feed helpers miss safely; auth/direct cache paths fail | Defined dependency readiness and bounded fallback capacity |
| Follow/unfollow races stale feed | SQL changes without Redis invalidation | Graph version/invalidation plus current authorization |
| Ranking changes between pages | Timestamp cursor over reranked candidates | Frozen ordered session, explicit expiry/reset |
| Like result lost or reordered | Independent writes and generic rollback | Desired-state receipt and newest-intent reconciliation |
| Account changes during a request | Old response can update shared store | Account/session generation and cancellation |
| Gateway/socket closes during subscription | Cleanup handlers installed after awaited work | Early cleanup registration, bounded lifecycle, reauthentication |

`/health` reports 200 degraded if just one dependency is down; readiness requires SQL but ignores Redis status even though authentication uses Redis directly. Both checks await both probes without an explicit deadline, and startup waits for both dependencies before listening. No shutdown handler drains HTTP, sockets, or fan-out, and there is no automatic retry queue or polling recovery.

## Scalability Considerations

Keep durable post acceptance short and distribute recipient tasks across workers in bounded chunks. Materialize active recipients where useful, with rebuild-on-return coverage; do not infer activity from a comment in the current fan-out code, which writes all active relationship rows regardless of recipient activity. Use a shared gateway subscriber per process/channel rather than one Redis connection per viewer.

Batch pull-mode author reads and cap the total candidate budget before expensive ranking. A cache that contains ten IDs is not necessarily a complete recent candidate window; record coverage or merge with durable data. Request coalescing, TTL jitter, and bounded rebuild concurrency prevent a cache loss from sending every viewer to the database at once.

Pipelining reduces network round trips and socket overhead; it does not remove per-command server work, make a Redis/SQL write atomic, or remove the need to inspect replies. Bound pipeline size and retry only known idempotent effects. [Redis pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/)

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Distribution | Hybrid, workload-aware policy | Universal push/pull | Limits extremes of write/read amplification |
| Posting | Transactional receipt/outbox | Inline fan-out as acceptance | Durable result independent of audience size |
| Pagination | Expiring ranked ID session | Fresh ranking with score cursor | Stable order while reading |
| Privacy | Current authoritative hydration | Trust cached membership | Revocation survives stale candidates |
| Likes | Desired state + versioned result | Blind increments and rollback | Retries and rapid toggles converge |
| Browser | Bounded normalized pages and drafts | Infinite retained arrays/players | Limits memory while preserving meaningful state |

## Implementation Notes

### Implemented patterns and exact wiring

[fanout.ts](./backend/src/services/fanout.ts) chooses pull when is_celebrity is true **or** follower_count is at least 10,000. Pull writes a capped 100-entry celebrity sorted set with no TTL and returns before creating the author's feed entry. Push reads active follower edges, issues one multi-row SQL insert, and pipelines three Redis commands per follower. It then inserts the author's SQL feed entry but does not refresh the author's cache. In outline:

```typescript
await fanoutPost(post.id, userId, post.created_at);
res.status(201).json(response);
```

This is awaited inside [posts.ts](./backend/src/routes/posts.ts); the returned success flag is ignored. It is not a Kafka worker or durable asynchronous job. removeFanout deletes all SQL candidates and removes Redis IDs only for current followers and the celebrity set, leaving other stale IDs to deletion filtering at hydration.

[cache.ts](./backend/src/shared/cache.ts) supplies the feed sorted-set cache, capped at 1,000 entries with expiry renewed for the whole key for 24 hours. Cache misses load at most three times the requested page size from SQL and merge those IDs into the cache; a later nonempty hit need not cover the rest of history. Celebrity cache misses query SQL but do not warm that cache. Follow/unfollow never call the exported invalidation helper. There is no L1 cache, post-object cache usage, affinity expiry, or counter sync worker.

[circuit-breaker.ts](./backend/src/shared/circuit-breaker.ts) protects the stable feed generation function and forwards its parameters; [feed.ts](./backend/src/routes/feed.ts) registers the popular fallback. [idempotency.ts](./backend/src/shared/idempotency.ts) intercepts successful JSON responses only on the post-creation route. Logger, metrics, and health are wired through [shared/index.ts](./backend/src/shared/index.ts), with the limits described above.

### Feed correctness and browser behavior

- **Candidate order:** pushed cache uses epoch milliseconds; SQL follow/seed uses seconds. SQL fallback filters feed_items.created_at but the returned home cursor is String(last ranked post.created_at). Parsing that native Date string as a float yields NaN for Redis; timestamp filtering also conflicts with score ordering. Celebrity reads always fetch their newest ten IDs without applying the cursor.
- **Ranking:** SQL affinity values supply the multiplier. The so-called MAX_CONSECUTIVE diversity rule actually limits an author to three total rows in the response candidate loop. It can return has_more=false with many remaining candidates. Zero-engagement ties have no explicit stable ID tie-breaker. Popular fallback returns is_liked=false and no continuation.
- **Home UI:** [routes/index.tsx](./frontend/src/routes/index.tsx) uses a 400px estimate, overscan three, and dynamic measurement, with fetch-on-scroll within 500px of the bottom. It has no getItemKey override for the virtualizer (which defaults to index), explicit composer scroll margin, retained-page budget, deduplication, or restoration controller. JSX post IDs alone do not change the virtualizer's measurement identity. Images have no dimensions, responsive sources, or lazy/decode policy.
- **State:** [feedStore.ts](./frontend/src/stores/feedStore.ts) appends arrays without dedupe/cap. A loading guard can suppress a requested reset; a late reset response can replace a newly created post. No request generation or account reset protects it. Like rollback adjusts the then-current value and can undo later intent or produce negative counts.
- **Profiles/cards:** [PostCard.tsx](./frontend/src/components/PostCard.tsx) invokes home-store like actions even when displayed from profile-local data. Missing home records produce no request; profile objects do not update from the home store. Comments load only the first 20 oldest rows and ignore has_more; new comments append locally without updating the parent count. Drafts/expanded state are card-local and can disappear on virtualization unmount. Share and comment Like/Reply are placeholders; profile Edit Profile is also unwired.
- **Account/navigation:** [authStore.ts](./frontend/src/stores/authStore.ts) persists a token and separately writes localStorage token. Startup checks auth, but the home beforeLoad guard only tests key presence. Logout clears auth after its request, ignores failure, and does not clear feed state. Profile/search/list requests have no stale-response guards; profile follow actions lack an in-flight gate and do not refresh feed cache or profile post visibility.
- **Composer:** [PostComposer.tsx](./frontend/src/components/PostComposer.tsx) expands a textarea, accepts an image URL, and prepends only after POST succeeds. It sends no operation ID, performs no upload, persists no draft, and lets typing continue during submission; successful completion clears the current draft even if it changed while the request was in flight.

### Simplified or omitted infrastructure

One PostgreSQL/Valkey pair substitutes for shards, candidate workers, durable event transport, and distributed caches. No replayable notification pipeline, live frontend channel, ranking experiment framework, content moderation, upload service, notification UI, rate limiter, or graceful lifecycle is implemented. Feed types are duplicated across frontend/backend files rather than shared through a package. Setup, token behavior, and fixture caveats are in the [README](./README.md).

### Verification boundary

Eight isolated source checks with mocked dependencies confirmed ranking cold-start behavior, native-Date/Redis cursor mismatch, omitted hydration privacy, premature diversity exhaustion, private-post/comment access, unclamped session refill, profile-only/late-rollback like defects, reset-response overwrite, and unchecked fan-out pipeline errors/author cache omission. The common fixture hash matches password123. No application code or live data was changed; the stack, build, and load performance were not exercised. The smoke helper uses an unseeded Alice email, while screenshot configuration uses John.
