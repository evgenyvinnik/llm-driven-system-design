# Facebook Post Search Architecture

## System Overview

Social search combines relevance with authorization. An inverted index can retrieve useful posts quickly, but its copied content and audience fields may lag the source database. The main design problem is using those copies to narrow candidates without treating a stale search document as a current permission grant.

**Production proposal:** asynchronous versioned indexing, efficient visibility-token retrieval, current authorization/content-version checks, stable search sessions, and privacy-aware suggestions. **Local implementation:** one Express API, PostgreSQL, Elasticsearch, Valkey, and a React search/admin interface. The final Implementation Notes trace the actual wiring and known gaps. This is a Facebook-inspired teaching project, not an account of Facebook's infrastructure.

## Requirements

| Area | Proposed contract |
|------|-------------------|
| Search | Keyword/phrase/hashtag search over posts; date, type, author, and audience filters |
| Relevance | Text relevance with measured social/engagement signals; predictable page continuation |
| Privacy | Check current authoritative access and content version before returning private text/snippets |
| Indexing | Durable accepted writes; target ordinary search visibility within 10 seconds |
| Suggestions | Fast public-safe dictionary plus explicitly scoped personal history/directory results |
| UX | Responsive typing, committed query/filter state, independent page errors, accessible result navigation |
| Availability | Target 99.9% regional search-serving availability |
| Latency | Healthy-path p95 search API below 300 ms, p99 below one second; first useful browser results within one second on a defined network/device |
| Resources | Bounded query lengths, page sizes, candidate scans, search-session lifetimes, indexing batches, and browser cache |

These are design targets, not measurements. The initial audience model is Public, accepted Friends, and Private/author-only. Friends-of-friends, custom groups, saved searches, semantic ranking, and media processing are extensions. The local schema accepts friends_of_friends but search gives it direct-friend semantics; other read routes differ again.

A privacy decision has a defined validation point. Requests checked after a completed revocation must be denied. Already downloaded content cannot be recalled; active views should remove invalidated content and revalidate on resume. A ten-minute cache TTL is not a substitute for this contract.

## Capacity Estimation

An illustrative production workload, independent of the tiny fixtures:

| Assumption/calculation | Result |
|------------------------|--------|
| 100M daily searchers × five submitted searches | 500M searches/day, about 5,787/second average |
| Five-times-average search peak | About 28,935 searches/second |
| 100M new posts/day | About 1,157/second average |
| 1 KB raw searchable record per post | 100 GB/day, 36.5 TB/year, 182.5 TB over five years |
| Four suggestion requests per committed search | Up to 2B suggestion requests/day before coalescing/caching |
| 500M response pages × 20 results | 10B returned result items/day before candidate overfetch |

Raw record bytes exclude term dictionaries, postings, stored fields, doc values, replicas, and merge headroom. Select shard counts after measuring indexed size, query fan-out, and recovery time; “1,000 shards” is not a capacity plan. Long friend lists also increase query payload and intersection work; visibility filtering is not constant-time authorization over an arbitrary graph.

### Local Development Scale

Compose has PostgreSQL 16, Valkey 7, and Elasticsearch 8.11.0 with a 512 MB Java heap. The posts index has one primary shard and zero replicas. The SQL fixture contains six users and fifteen posts; the destructive JavaScript seeder contains nine users and twenty-five posts. No 100-user/10,000-post benchmark was performed.

## High-Level Architecture

Production proposal; a CDN serves the static application and authorized/public media through a separate media contract.

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ Search API + auth          │       │ Post / graph authority     │
│ PIT / rank / validation    │       │ SQL + receipts + outbox    │
└─────────────┬──────────────┘       └─────────────┬──────────────┘
              ▼                                    ▼
┌────────────────────────────┐       ┌────────────────────────────┐
│ ES candidate projection    │◀──────│ Versioned index workers    │
│ Exact visibility tokens    │       │ Bulk + retries + repair    │
└────────────────────────────┘       └────────────────────────────┘
```

Search serving builds an exact token filter from the viewer's graph context, retrieves a bounded candidate window, and checks current authoritative visibility and record versions before releasing content. The index is a retrieval projection. Outbox workers maintain that projection, while separate suggestion policy prevents hidden content or personal queries leaking through another endpoint.

## Core Components / Request Flows

### Publish, edit, and delete

1. Authenticate the actor and validate the operation and audience.
2. Commit the post change, monotonically increasing revision, operation receipt, and outbox event in one transaction.
3. Return accepted canonical state independently of Elasticsearch health.
4. A worker reads the event/current record, extracts fields, and submits bounded bulk operations.
5. Inspect every item result; retry transient failures and isolate invalid records with an explicit repair state.
6. Apply revisions monotonically so a delayed edit cannot overwrite a newer restriction or resurrect deleted content.

Use durable tombstones or equivalent retained version state for deletions; physically deleting an index document must not erase the only protection against an older event arriving later. An idempotent document ID prevents duplicate copies, but does not enforce revision order or deduplicate two independently created source posts.

Refresh controls when an indexed change becomes searchable. It is separate from durable acceptance and from the total worker backlog. The proposed normal path batches changes and defines a freshness target; a “wait for refresh” option cannot guarantee a fixed one-second end-to-end delay under every refresh configuration or load.

### Query, rank, and authorize

Normalize syntax according to an explicit query contract. Phrase search needs a phrase operator/parser; a fuzzy multi_match alone is not a phrase-search implementation. Treat exact hashtags separately from analyzed prose when appropriate. Apply date/type/author filters and an exact visibility-token filter before ranking.

Tokens such as PUBLIC, FRIENDS:author, and PRIVATE:author avoid copying every recipient into every post document. A friendship change normally changes the reader's eligible token set, not all the author's post fingerprints. A post's own audience change does require updating its projection. Cache graph-derived sets with versions/invalidation, and retain authoritative checks for stale projections and invalidation races.

Initially, rank within Elasticsearch using BM25 and modest query-time social boosts. Engagement can be a calibrated signal rather than an unbounded substitute for text relevance. A later application reranker must overfetch a meaningful candidate window; reranking only twenty retrieved rows cannot promote a candidate it never saw. Its resulting order must also participate in the pagination contract.

Hydrate a bounded batch against current posts/relationships and compare the indexed revision with the canonical revision. Drop inaccessible, deleted, or stale-version records before returning content, snippets, or action capabilities. Underselecting temporarily after a grant/update is an indexing freshness issue; returning stale private text is an authorization failure.

### Stable search sessions

For the initial in-engine ranker, use a short-lived Elasticsearch point in time (PIT) and search_after. Bind an opaque server cursor to viewer identity, normalized query/filters, fixed social ranking context, index generation, and the returned sort tuple. Freeze time-dependent ranking inputs as well as index state. Close/expire contexts and bound active PITs.

Use the latest returned PIT identifier and the full sort tuple, including its tie-breaker. A unique ID handles equal scores but cannot freeze a changing index/ranking context by itself. The local offset cursor has neither PIT nor search_after. Elasticsearch documents the deep-offset cost, default 10,000-hit window, and PIT continuation behavior in its [pagination guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/paginate-search-results.html).

Authorization remains current despite the PIT. Keep the retrieval query fixed and validate candidates after retrieval; a graph-context revision change may explicitly expire the session rather than silently change its query. Scan a bounded number of extra candidates to fill gaps, advancing the cursor through the last examined hit. Distinguish scan-budget exhaustion, partial dependency results, and true end of this search session.

Do not return an exact-looking total or facet count obtained from stale/private candidates. Prefer verified loaded counts and continuation; provide counts only through an equally authorized computation with an explicit relation/approximation contract. A PIT freezes old records, not permission to disclose them.

### Suggestions and browser state

Use a curated/moderated public suggestion corpus for shared caching. Personal history is viewer-scoped; directory suggestions follow the directory's access policy. If suggestions derive from posts, they need current audience/version protection too. A threshold over distinct users and a time window can reduce accidental exposure in trends, but is not by itself a formal privacy guarantee. Do not publish every submitted private query globally.

The browser separates draft text/filter edits from committed search intent. Suggestions use a short debounce; full results start on Enter/selection/Apply. Each request captures account and search generation; cancellation saves work, while identity checks decide whether a response may commit. Pagination always uses the committed filters and session cursor, not the mutable filter panel.

Render snippets as validated text fragments and marked ranges. Maintain independent first-page, next-page, and suggestion states. Revalidate protected cached results before redisplaying after navigation/resume; account changes clear pages/history and invalidate old requests. Query URLs represent intent, not authorization or private result payloads.

## Database Schema

The following is the **exact local initialization SQL** from [init.sql](./backend/src/db/init.sql): five tables, ten explicit indexes, one function, and two updated-at triggers. Guarded creation makes repeat application possible, but it does not reconcile an older table definition with this one.

```sql
-- =============================================================================
-- Facebook Post Search - Consolidated Database Schema
-- =============================================================================
-- This file contains the complete database schema for the fb-post-search project.
-- It consolidates all migrations into a single file for easier review and fresh installs.
--
-- Usage:
--   psql -U postgres -d fb_search -f init.sql
--
-- For development, prefer using migrations:
--   npm run db:migrate
-- =============================================================================

-- =============================================================================
-- TABLE: users
-- =============================================================================
-- Central user entity storing account information and authentication data.
-- This is the primary identity table referenced by all other entities.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: posts
-- =============================================================================
-- Stores user-generated content with visibility controls and engagement metrics.
-- Posts are indexed to Elasticsearch for full-text search.
-- Denormalized counters (like_count, comment_count, share_count) avoid expensive
-- aggregation queries and are updated via triggers or application logic.
-- =============================================================================
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  visibility VARCHAR(20) DEFAULT 'friends' CHECK (visibility IN ('public', 'friends', 'friends_of_friends', 'private')),
  post_type VARCHAR(20) DEFAULT 'text' CHECK (post_type IN ('text', 'photo', 'video', 'link')),
  media_url VARCHAR(500),
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: friendships
-- =============================================================================
-- Represents directional friendship relationships between users.
-- Each accepted friendship requires two rows (user_id -> friend_id and vice versa).
-- This enables efficient lookups for "who are my friends" queries.
-- The status column supports pending requests and blocking functionality.
-- =============================================================================
CREATE TABLE IF NOT EXISTS friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

-- =============================================================================
-- TABLE: search_history
-- =============================================================================
-- Tracks user search queries for analytics and personalization.
-- Used to generate trending searches and improve search suggestions.
-- Subject to 90-day retention policy (see architecture.md).
-- =============================================================================
CREATE TABLE IF NOT EXISTS search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query VARCHAR(500) NOT NULL,
  filters JSONB,
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TABLE: sessions
-- =============================================================================
-- Stores authentication sessions for session-based auth.
-- Tokens are unique per session and have explicit expiration.
-- Sessions are also cached in Redis for faster validation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
-- Strategic indexes to optimize common query patterns.
-- Each index is designed for specific use cases documented below.
-- =============================================================================

-- Posts: Find all posts by a specific author (user profile pages)
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);

-- Posts: Support chronological feeds and date range filtering
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

-- Posts: Filter by visibility level for privacy-aware queries
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility);

-- Friendships: Find all friendships for a user (friend list, visibility computation)
CREATE INDEX IF NOT EXISTS idx_friendships_user_id ON friendships(user_id);

-- Friendships: Find users who have friended a specific user (reverse lookup)
CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);

-- Friendships: Filter by status (accepted, pending, blocked)
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);

-- Search History: Find a user's search history (recent searches, suggestions)
CREATE INDEX IF NOT EXISTS idx_search_history_user_id ON search_history(user_id);

-- Search History: Support chronological ordering and retention cleanup
CREATE INDEX IF NOT EXISTS idx_search_history_created_at ON search_history(created_at DESC);

-- Sessions: Fast token lookup for authentication validation
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- Sessions: Find all sessions for a user (logout all devices)
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- =============================================================================
-- FUNCTIONS AND TRIGGERS
-- =============================================================================
-- Automatic updated_at timestamp management for auditing.
-- =============================================================================

-- Function: Automatically update updated_at column on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger: Auto-update users.updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Auto-update posts.updated_at
DROP TRIGGER IF EXISTS update_posts_updated_at ON posts;
CREATE TRIGGER update_posts_updated_at
BEFORE UPDATE ON posts
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

The schema has no like-membership table, comments table, operation receipts, outbox, post revision, or deletion tombstone. Counts are integer fields; local likes simply increment. Friendship symmetry and audience enforcement are not database invariants. Only users/posts receive automatic updated_at changes, and no nonnegative-count or post-length checks are declared.

| Proposed record | Purpose / invariant |
|-----------------|---------------------|
| Post revision/tombstone | Monotonic canonical version, audience, deletion state |
| Operation receipt | Actor + operation key unique, payload digest, durable result |
| Outbox event | Post ID/revision and recoverable index work |
| Graph revision | Current accepted relationship context and invalidation ordering |
| Search session | Viewer, PIT/generation, query/ranking context, expiry |
| Index repair task | Failed item, error class, retry state, reconciliation progress |

### Actual Elasticsearch and Redis structures

[elasticsearch.ts](./backend/src/config/elasticsearch.ts) maps IDs, visibility tokens, hashtags, mentions, type, and language as keyword fields; content and author_name as text; timestamps as dates; counters as integers; engagement as float. Content also has a keyword subfield limited to 256 characters. The custom standard analyzer uses English stop words. There is no n-gram field, stemmer configuration, embedding, or media URL in the indexed document; language is hardcoded to en.

| Redis key | Actual contents / lifetime |
|-----------|----------------------------|
| visibility:user | JSON fingerprints/friendIds/userId/updatedAt; 900 seconds |
| session:token | JSON userId/role/expiresAt; initially 86,400 seconds |
| suggestions:prefix | JSON truncated suggestion array; 60 seconds, no viewer/limit in key |
| trending:searches | Cumulative sorted-set query counts; trimmed to 1,000, no TTL or decay |

The retention constants contain a 3,600-second suggestion TTL, but the active suggestion service hardcodes 60 seconds. Cache helpers propagate Redis errors; they are not a general fallback-to-SQL-on-outage layer.

## API Design

### Actual local routes

| Method | Path | Contract |
|--------|------|----------|
| POST | /api/v1/search | Optional bearer auth; query/filters/pagination body |
| GET | /api/v1/search/suggestions | q and limit; optional auth |
| GET | /api/v1/search/trending | Global cumulative query strings |
| GET | /api/v1/search/filters | Advertised types/audiences/sorts; sorts are not implemented |
| GET / DELETE | /api/v1/search/recent / /api/v1/search/history | Personal recent queries / clear history |
| POST | /api/v1/auth/register, /api/v1/auth/login, /api/v1/auth/logout | Account/session lifecycle |
| GET | /api/v1/auth/me | Current user row |
| POST | /api/v1/posts | Save SQL, await synchronous indexing |
| GET | /api/v1/posts/feed, /api/v1/posts/user/:userId, /api/v1/posts/:id | Different local visibility rules |
| PUT / DELETE | /api/v1/posts/:id | Owner/admin edit / hard-delete |
| POST | /api/v1/posts/:id/like | Any authenticated user increments and receives the post |
| GET | /api/v1/admin/stats, /api/v1/admin/users, /api/v1/admin/posts | Admin overview/lists |
| GET | /api/v1/admin/search-history, /api/v1/admin/health | Admin history/health |
| POST | /api/v1/admin/reindex | Bulk upsert all current SQL posts |

```json
{"query":"code","filters":{"post_type":["text"]},"pagination":{"limit":20}}
```

The actual response has results, optional next_cursor, total_estimate, and took_ms. Each result includes full content as well as a snippet, but no media URL, viewer-like state, query ID, PIT, result version, or structured highlight ranges. took_ms is application search duration, not only Elasticsearch's own took value. Client-supplied user_id is ignored; the controller supplies identity from auth middleware.

### Proposed contract additions

Add a query echo/search-session ID, opaque continuation, expiry/reset and partial-result status, structured snippets, and verified result versions/capabilities. Validate query strings, enum arrays, date ranges, IDs, and positive bounded integer limits at runtime. A shared generated type/schema package can reduce drift, but local frontend/backend types are duplicated and controllers do not use Zod request schemas.

## Key Design Decisions

### Indexed tokens plus authoritative checks

Token filtering reduces wasted retrieval work. It does not make arbitrary social-graph intersection O(1), eliminate friendship-cache races, or protect copies of posts whose audience changed. The final current check operates on a bounded candidate batch, not all matching documents in the corpus. Overfetch and cursor progress address sparse authorized results without claiming unlimited work to fill every page.

The cost is extra batched source/graph reads, possible short pages, and conservative omission while indexing catches up. Trusting only the index is cheaper, but a failed public-to-private update or stale PIT would disclose old content. Bloom filters may reject obvious nonmatches as a preliminary optimization; positive matches cannot grant privacy access without exact verification.

### In-engine ranking first, reranking only when justified

The local social should clauses add score contributions for friends/self; they are not a blanket multiplication of the entire BM25 score by two/three. Engagement is likes + 2×comments + 3×shares and is the second sort field, followed by creation time. It only decides ordering after equal relevance scores. There is no recency decay, ML, or application reranking.

A larger reranking stage can improve quality at a latency/candidate-recall cost. Keep a fixed reranked candidate order for a session if introduced; sorting each independently retrieved page is not a global ranked continuation. Calibrate features with judged queries and experiments rather than treating raw ES scores as probabilities or comparable scores across users.

### Asynchronous indexing with explicit repair

PostgreSQL supplies durable accepted state, while Elasticsearch is rebuilt asynchronously. This lets posts survive index outages at the cost of temporary search lag and worker operations. Receipts, outbox recovery, version checks, and item-level bulk accounting close failure gaps that a sequential SQL insert followed by index() cannot.

Rebuild into a new index generation, backfill from a consistent boundary, replay subsequent changes/tombstones, validate coverage, then switch an alias atomically. Continue supporting or explicitly expire PITs on the previous generation within retention limits. An alias swap alone does not capture concurrent writes, and a bulk upsert alone does not remove orphan documents.

## Consistency and Idempotency

Locally, source writes and index writes are separate. createPost catches an indexing failure and returns null after SQL committed; the API returns 500, and a retry can create another UUID/post. updatePost can commit a restriction then return 500, leaving old searchable content. deletePost hard-deletes SQL; deletePostFromIndex catches every error as if it were “not found,” so deletion may return success with a stale index document.

Like requests increment the counter repeatedly without a viewer/post uniqueness key, access check, or unlike operation. Their returned object includes private content. Concurrent reindex/update calls have no external revision check, so a late older index write can overwrite newer state. bulkIndexPosts does not inspect item errors, use the breaker, or remove IDs absent from SQL.

The proposal gives meaningful writes actor-scoped receipts and uses at-least-once workers with idempotent, version-checked effects. Search history is best-effort asynchronous telemetry; it is not part of the accepted-search durability contract. A duplicate document ID is only one of these invariants.

## Security / Auth

[authService.ts](./backend/src/services/authService.ts) compares an unsalted SHA-256 hash, not bcrypt. The login identifier is username. UUID bearer sessions are persisted in SQL for 24 hours and cached with userId, role, and absolute expiresAt. Cache hits check that timestamp but do not re-read the user/role; role revocation or user deletion can leave cached authority. Cache refill sets a 24-hour TTL but still checks the original absolute expiry on each hit.

Redis failure prevents normal session validation; optionalAuth silently continues anonymously, while required/admin auth returns 401. Logout deletes SQL then Redis separately, and the browser ignores logout failure before removing auth_token. The cookie fallback is inert without a cookie parser; no cookie is issued. SESSION_SECRET is parsed but unused. Production needs an adaptive password hash, hardened session transport/lifecycle, and coherent role revocation.

### Actual audience gaps

- Search trusts copied fingerprints/visibility and cached accepted outgoing edges; it does not hydrate from current SQL.
- Friends-of-friends produces the same token as friends, with no second-hop traversal. The invalidation/friend-check helpers have no callers, and no friendship mutation API exists.
- Single-post reads allow public or owner only, denying actual friends. Author lists expose friends posts to any signed-in viewer, while excluding friends-of-friends except for the owner.
- The SQL feed includes public, own, and direct friends posts, but omits friends-of-friends from other authors. Likes accept any signed-in actor and return the full post.
- Hashtag aggregation has no audience filter, and global trends contain submitted queries. A prefix-only suggestion cache mixes authentication context and requested limits.

[SearchResultCard.tsx](./frontend/src/components/SearchResultCard.tsx) passes snippet directly to dangerouslySetInnerHTML. The backend supplies an ES highlight without an HTML encoder or falls back to raw content.substring. Both are untrusted paths. Prefer structured text/ranges or a rigorously encoded and allowlisted markup contract; Elastic documents the difference between default and HTML-encoded highlights in its [highlight settings](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/highlighting.html#highlighting-settings).

## Observability

Pino logs search text, viewer, filters, counts, and duration; these logs contain potentially sensitive query data. A request ID is inserted into incoming headers, but successful domain logs do not use the exported request logger, and no response-header propagation is wired. LOG_LEVEL is not read: development is debug/pretty, production info/JSON, test silent.

Fifteen custom metric families plus default process metrics are declared. Search result metrics increment once per response rather than by returned result count. Database query latency is never observed by the query wrapper. Index-size/connection gauges update during health checks, not on a background collector. Creation lag is observed on indexPost only; boot backfill/update/bulk do not provide a complete freshness measurement.

Production monitoring should distinguish accepted-write latency, oldest unindexed revision, item-level failures, stale-version/authorization drops, session expiry, partial search results, and rendered latency. Sampled privacy tests and reconciliation are needed; a zero-valued privacy counter alone would prove nothing. Do not expose raw private queries in routine analytics.

## Failure Handling

The active Cockatiel policy wraps a five-second aggressive timeout around a five-consecutive-failure breaker with a 30-second cooldown. Its separately defined retry policy is unused by executeWithCircuitBreaker; the Elasticsearch transport still has its own default retry behavior. Callbacks ignore the cancellation signal, so a timeout does not cancel underlying work. A late success can leave the inner breaker closed despite outer timeouts.

Search and health pre-check whether the breaker is Open. In the installed Cockatiel implementation, the transition to a recovery probe happens inside execute(), after the cooldown. Those pre-checks can keep search/health stuck open until another protected operation, such as indexing or a hashtag lookup, invokes the policy. The isolated checks confirmed this behavior with the actual library.

| Failure | Local result | Proposed contract |
|---------|--------------|-------------------|
| Index write fails after SQL commit | Failed creation/update reply, unrepaired projection | Durable receipt/outbox and versioned repair |
| Delete/index bulk partly fails | Success can conceal leftover/missing documents | Inspect item status; retry/reconcile tombstones |
| Elasticsearch outage | Search 500; no cached search fallback | Explicit unavailable/partial result with a bounded deadline |
| Hashtag lookup fails | Caught; no trending/user fallback in that branch | Independent public-safe suggestions and clear degradation |
| Redis outage | Session/visibility/suggestion paths may fail | Defined auth behavior and bounded authorized fallback |
| Old client request completes | Can replace current query/account results | Account/search generations and cancellation |

The global process-local IP limiter allows 1,000 requests per 15-minute window and is installed before probes/metrics, despite a comment claiming they are exempt. Rate-limited requests bypass the later HTTP metrics middleware. This is not a distributed or exact sliding-window limit.

/health is unhealthy only when PostgreSQL is down; Elasticsearch/Redis failures with SQL up are degraded/200. /readyz accepts degraded status. Probes have no explicit end-to-end deadline, and missing index stats do not make ES unhealthy. Startup binds HTTP first, retries ES initialization ten times, and catches/skips backfill failures. SIGINT/SIGTERM call process.exit immediately without draining requests or closing pools.

## Scalability Considerations

Bound authorized candidate scans, friend-token payloads, and open PITs. PITs retain index resources; short lifetimes and explicit restart are preferable to indefinitely retaining every abandoned search. Date filters can prune time-based indices, but queries spanning years still fan out and require coordination. Choose time partitioning/shard sizes from measured query/recovery workloads.

Batch indexing, apply revisions in order, and keep a reconciliation path for missed events. A search-result cache must include query/ranking/viewer context and still meet current authorization requirements. Shared CDN caching is appropriate for static assets and explicitly public-safe suggestions, not arbitrary personalized result JSON.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Privacy | Token retrieval + current batch validation | Trust copied ACLs alone | Stale projections cannot grant access |
| Ranking | ES baseline, measured later reranker | Page-only reranking | Candidate recall and stable serving remain explicit |
| Pagination | Bounded PIT/search_after session | Offset into refreshed rank | Predictable continuation with expiry costs |
| Indexing | Transactional outbox + versioned workers | SQL then inline ES | Accepted changes survive index outages |
| Rebuild | New generation + change catch-up + alias | In-place bulk upsert | Coverage and deletions are verifiable |
| Suggestions | Public-safe corpus + scoped history | Global private-query/hashtag mining | Auxiliary responses respect privacy |

## Implementation Notes

### Implemented patterns and wiring

[searchService.ts](./backend/src/services/searchService.ts) sends a single ES query: content^3, author_name^2, hashtags^2, best_fields, AUTO fuzziness, visibility token filtering, friend/self should boosts, then score/engagement/time sorting. It maps hits directly to results. Offset is parseInt(cursor); total.relation and shard/timed_out metadata are discarded. Normal refreshes can shift pages, and the default result window limits deep offsets.

[visibilityService.ts](./backend/src/services/visibilityService.ts) supplies PUBLIC, PRIVATE:self, FRIENDS:self, and FRIENDS:friend tokens from accepted outgoing SQL rows. Redis caches the JSON for 900 seconds. Neither invalidation nor friendship-check helper is connected to a mutation flow.

[indexingService.ts](./backend/src/services/indexingService.ts) extracts lowercase hashtags/mentions including their prefix, computes likes + 2×comments + 3×shares, hardcodes language=en, and uses refresh=true for writes. In outline, the local post service does:

```typescript
const post = await queryOne<Post>(insertSql, values);
await indexPost(post, authorName);
```

This illustrates two separate stores; it is not a transaction/outbox. See [postService.ts](./backend/src/services/postService.ts) for the actual null/author checks and error handling. [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) supplies the timeout/breaker wrapper with the ordering/recovery limits above. [healthCheck.ts](./backend/src/shared/healthCheck.ts), [metrics.ts](./backend/src/shared/metrics.ts), and [logger.ts](./backend/src/shared/logger.ts) provide the wired operational surface.

### Setup, seed, and maintenance distinctions

[config/index.ts](./backend/src/config/index.ts) loads .env before clients initialize. Zod validates NODE_ENV and string presence/types with defaults; it does not ensure numeric port validity or implement request validation. The database pool has max=20, a two-second connection timeout, and thirty-second idle timeout; queries have no statement deadline. CORS origins are fixed.

[db/migrate.ts](./backend/src/db/migrate.ts) reads exported DATABASE_URL or a default, independently of .env and POSTGRES_*; it executes the consolidated schema without version records. The separate numbered-migration helper used by status/rollback points to a nonexistent directory. db:index points to a missing script. [retention.ts](./backend/src/shared/retention.ts) contains unused ILM/template/rollover helpers; only manual db:cleanup invokes the 90-day search-history cleanup. No session/trend cleanup scheduler is installed.

The two seed paths differ in users, graph, posts, passwords, and destructiveness; the [README](./README.md#fixtures-and-credentials) documents both. Startup backfill only runs if ES count is zero, catches failures per post, and treats any nonempty index as populated on the next boot. Admin reindex reads all SQL IDs and performs a single bulk upsert without checking item errors or deleting orphan IDs. It does not recreate mappings or swap an alias.

### Browser behavior and gaps

- [searchStore.ts](./frontend/src/stores/searchStore.ts) keeps one global query/filter/result array, with no identity guards, deduplication, or bounds. Slow first-page replies overwrite newer results; Load More captures an old array and can append a different query/filter response. Filters mutate immediately in the store even before Apply. Logout leaves search results/history behind.
- [SearchBar.tsx](./frontend/src/components/SearchBar.tsx) fetches suggestions per keystroke without debounce, cancellation, IME handling, or stale-response checks. It supports Enter/Escape but no active-option arrow navigation/combobox roles. User suggestions submit display-name text, not an author ID filter.
- Hashtag suggestions remove # before building an aggregation regex even though indexed values retain #. The prefix is not regex-escaped. Normal suggestions inspect only the top 100 global trend entries and optionally five SQL user matches; cache truncation can poison a later larger limit. Personal recent-search SQL combines DISTINCT with MAX(created_at) ordering without valid grouping.
- [SearchResults.tsx](./frontend/src/components/SearchResults.tsx) maps all accumulated cards, with no virtualizer. Existing results remain during a new request without a committed-query label; a later-page error hides them. Filter-only results are hidden because the route/result component require a nonempty query. No query/filter URL state or explicit scroll restoration exists.
- [admin.tsx](./frontend/src/routes/admin.tsx) checks role in an effect, reads stats/health on mount or after reindex, and lazily loads each first-page table. There are no pagination controls or polling. Its health type expects top-level booleans, while the server returns services.*.healthy, so indicator colors are wrong. Empty/error table loads have limited feedback.
- Auth uses localStorage auth_token and an in-memory API token; there is no cross-tab synchronization or account generation. Root isLoading replaces the entire route while login/register is pending. Result cards expose no working engagement or detail controls, and no media asset is rendered.

### Simplified and omitted components

One process and three data services substitute for search shards/replicas, graph authorities, durable index workers, and distributed caches. There is no Kafka, transactional outbox, receipt/revision protocol, active ILM, ML model, service-worker/offline result cache, live channel, upload service, or shared runtime API schema package. Proposed privacy and snapshot guarantees should not be inferred from the presence of helper names.

### Verification boundary

Ten isolated source-execution checks confirmed offset/lower-bound-total behavior, raw index/snippet return, hashtag/cache scoping defects, ignored bulk/delete failures, SQL/index split outcomes, inconsistent post access and repeated private likes, request/filter races, NaN defaults, SHA-256 fixtures/cached roles, and actual Cockatiel timeout/recovery behavior. Dependencies were mocked except the installed Cockatiel library; no browser payload was executed. No app code, live data, full-stack runtime, build, or load test was changed/run. The smoke/screenshot limitations are recorded in the README.
