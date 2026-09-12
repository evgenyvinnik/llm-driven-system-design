# Facebook Live Comments Architecture

## System Overview

This project studies the comment and reaction experience beside a live video. The hard boundary is between accepting a viewer's meaningful comment and deciding how much of a busy conversation another viewer can consume. Batching reduces message overhead; it does not eliminate the bytes, browser work, or moderation obligations attached to those comments.

**Production proposal:** authenticated posting, durable acceptance, a bounded and explicitly sampled live feed, independent reaction aggregation, recoverable subscriptions, and moderation that reaches both cached and connected readers. This is a Facebook Live-inspired design, not a description of Facebook's internal architecture. **Local implementation:** one Express/WebSocket process, PostgreSQL, Valkey Pub/Sub, and a React demo. The final Implementation Notes map the proposal to source and identify missing guarantees.

## Requirements

| Scope | Proposed requirement |
|-------|----------------------|
| Comments | Post plain text; distinguish pending, accepted, rejected, and unknown outcomes |
| Consumption | Recent history, follow-live mode, bounded reading mode, explicit gap/sampling indicators |
| Reactions | Six reaction types; aggregate totals with representative, bounded animation |
| Moderation | Reject prohibited posts; hide/pin comments and ban writers with authorized actions |
| Recovery | Reauthenticate, resume from a supported cursor, or explicitly reset an expired view |
| Availability | 99.9% monthly regional posting availability; a target, not measured here |
| Latency | Healthy-path p95 acceptance-to-display under 500 ms; initial recent view under 1 second |
| Client responsiveness | Keep typing responsive and memory bounded during a two-hour session on a measured low-end device profile |
| Consistency | Durable accepted comments and idempotent retries; approximate viewer presence and delayed reaction totals |

Video ingest, transcoding, rich comment media, threaded discussions, arbitrary offline comment queues, and multi-region active/active writes are outside the initial scope. Comments can be hidden after acceptance, so even a mostly chronological feed is not literally append-only.

## Capacity Estimation

### Production assumptions

Consider a hot stream with 100,000 viewers and 1,000 comments/second. At an illustrative **200 bytes per serialized comment**, full delivery costs 200 KB/second per viewer, or **12 MB/minute**, before transport overhead, avatars, and video. Aggregate comment egress is 20 GB/second, or 160 Gbit/second. Real records with nested author metadata can be larger.

A 100 ms batch carries about 100 comments under a steady arrival assumption and produces roughly ten frames/second **per batch publisher**. At one publisher and 100,000 viewers this is one million socket sends/second instead of 100 million individual-comment sends. It still carries the same 20 GB/second of comment payload. Simultaneous publishers, timer delays, or bursty input invalidate a hard ten-frame or hundred-item limit.

Capping an ordinary viewer's selected feed at 20 comments/second reduces that illustrative payload to 4 KB/second per viewer and 400 MB/second overall. This is a product choice that omits comments, not a compression trick. Persist accepted comments separately, confirm the author's own post, reserve a small budget for pins, and label the selected view. Even 20 comments/second exceeds comfortable reading speed.

At a platform average of 2,000 comments/second, the same 200-byte assumption gives 34.56 GB/day of raw comment payload. Indexes, author fields, replicas, moderation events, and receipts add storage. A 500-entry client window represents only half a second at 1,000 entries/second, or 25 seconds at 20; window size cannot substitute for admission policy.

### Local Development Scale

Run a few browser windows and optionally two or three server processes against one PostgreSQL/Valkey pair. No load result establishes the production rates. PostgreSQL has a 20-connection pool per process; comment insertion is followed by extra queries and a shared stream-count update. Those are likely bottlenecks before the idealized fan-out figures become relevant.

## High-Level Architecture

Production proposal; static assets and video use separate CDN paths.

```
┌────────────────────┐       ┌──────────────────────┐
│ Browser + video UI │──────▶│ Edge / session check │
└────────────────────┘       └──────────┬───────────┘
                                       │
             ┌─────────────────────────┴─────────────────────┐
             ▼                                               ▼
┌────────────────────────┐                    ┌────────────────────────┐
│ Comment / moderation   │                    │ WebSocket gateways     │
│ writer, stream shards  │                    │ Bounded socket queues  │
└────────────┬───────────┘                    └────────────▲───────────┘
             ▼                                            │
┌────────────────────────┐       ┌────────────────────────┴───┐
│ PostgreSQL shards      │──────▶│ Outbox relay / feed service│
│ Comments + receipts    │       │ Sampling + cursor coverage │
│ Stream order + outbox  │       └────────────┬───────────────┘
└────────────┬───────────┘                    │
             │                                ▼
             │                  ┌────────────────────────────┐
             └─────────────────▶│ Recent-view cache + replay │
                                │ Reaction snapshots         │
                                └────────────────────────────┘
```

The feed service fans each selected stream update to **every gateway with interested viewers**. A competing-consumer group alone would deliver it to only one member and strand other viewers. Redis Pub/Sub can distribute the fast path, while durable ordered events and a bounded replay API establish recovery. The diagram's durable outbox/replay layer is absent locally.

## Core Components / Request Flows

### Durable comment acceptance

1. Authenticate the actor, validate stream access/status, bound text bytes, and check the current ban/moderation policy. Browser limits are only convenience.
2. Check an actor-scoped operation receipt. Bind its identifier to a digest of stream, content, and relevant fields. Return the prior result for the same operation; reject reuse with different data.
3. Apply atomic admission limits, then commit the comment, per-stream ordering position, receipt, and outbox record in one transaction. Revalidate state whose race would violate the write policy in that transaction.
4. Acknowledge durable acceptance to the author. This means saved, not rendered by every viewer. On an ambiguous timeout, the client retries the same operation to recover the result.
5. The outbox relay publishes at least once. The feed service deduplicates, selects a bounded display view, and batches by both maximum delay and maximum bytes. Gateways distribute it to their local audience.

A stream sequencer serializes ordering; its transaction rate is a measurable ceiling. Small transactions, group processing, and separating independent streams help. If one stream outgrows that ceiling, migrate its authority to a durable partitioned log with explicit producer fencing and receipt handling; adding writers to the same hot row does not remove serialization. Do not silently combine SQL acceptance and log acceptance into two independent authorities.

### Join, replay, and reading

The client authenticates a subscription and provides a stream/view identifier, generation, and last applied cursor. A snapshot carries a watermark N. Buffer subsequent updates while installing that snapshot, then apply the compatible tail after N. A cursor covers ordered accepted events, including moderation changes; sampled envelopes also state the covered range and selection policy so intentional omissions are distinguishable from missing transport data.

Use comment IDs for identity and a server cursor for progress. Snowflake gaps are not missing-comment evidence. A snapshot from a changed selection policy or expired retention window returns an explicit reset; the browser discards the incompatible tail. Keep pagination for historical reading separate from the live window and apply the same visibility checks to both.

In following mode, maintain a measured virtual list and scroll to the bottom after layout. In reading mode, freeze a bounded visible snapshot and keep a separate bounded live tail, plus an unseen count. If the retained range expires, explain the gap and offer to jump or load paginated history. Never let a paused reader disable all memory limits.

### Reactions and viewer counts

Treat repeated stream taps as reaction events, not necessarily a unique user vote. Admission and aggregation have their own capacity budget. Accumulate durable/recoverable interval increments into a versioned total per stream; publish **absolute snapshots** with epoch/version on join and periodically thereafter. The browser replaces a newer snapshot and ignores older ones. This proposal differs from the local unsequenced delta protocol.

Allow an immediate decorative animation on the user's tap without counting it again as authoritative total. A missing animation needs no replay. Totals can recover from the next snapshot; required billing/voting semantics would need stronger per-event accounting and a different product contract.

Viewer presence is a count of active viewing connections unless the product explicitly asks for distinct accounts. Aggregate gateway leases with expiration; do not overwrite a shared total with each gateway's local count. Refresh leases and reconcile shutdown/crashes, accepting a stated staleness interval.

### Moderation

Record an authorized hide/pin/ban action durably with its version and audit actor. Hide events remove visible content, invalidate or version cached views, and prevent old backfill or retry receipts from republishing hidden text. Pin membership has a separate small display budget. Bans are enforced when writing, not only when joining; revocation reaches existing connections.

A cheap synchronous filter can reject obvious violations. More expensive review runs asynchronously and may produce a later hide event. That trades lower posting latency for a temporary exposure window; stronger prepublication review adds delay and requires a pending state. Human review and appeal are extensions, not capabilities of the local demo.

## Database Schema

The following is the **exact local initialization schema** from [init.sql](./backend/src/db/init.sql), including its eight explicit indexes. It is not the complete production proposal.

```sql
-- Facebook Live Comments Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    reputation_score DECIMAL(3, 2) DEFAULT 0.5 CHECK (reputation_score >= 0 AND reputation_score <= 1),
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Streams table
CREATE TABLE IF NOT EXISTS streams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'live' CHECK (status IN ('scheduled', 'live', 'ended')),
    viewer_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    thumbnail_url VARCHAR(255),
    video_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id BIGINT PRIMARY KEY,  -- Snowflake ID for time-ordering
    stream_id UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    is_highlighted BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    is_hidden BOOLEAN DEFAULT FALSE,
    moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'spam')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reactions table
CREATE TABLE IF NOT EXISTS reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    reaction_type VARCHAR(20) NOT NULL CHECK (reaction_type IN ('like', 'love', 'haha', 'wow', 'sad', 'angry')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, comment_id, reaction_type)
);

-- User bans table (for moderation)
CREATE TABLE IF NOT EXISTS user_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stream_id UUID REFERENCES streams(id) ON DELETE CASCADE,  -- NULL means global ban
    banned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_comments_stream_id ON comments(stream_id);
CREATE INDEX IF NOT EXISTS idx_comments_stream_created ON comments(stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_stream_id ON reactions(stream_id);
CREATE INDEX IF NOT EXISTS idx_reactions_comment_id ON reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
CREATE INDEX IF NOT EXISTS idx_streams_creator ON streams(creator_id);
CREATE INDEX IF NOT EXISTS idx_user_bans_user ON user_bans(user_id);

-- Seed data is in db-seed/seed.sql
```

### Schema consequences and proposed extensions

The actual comments query filters by stream and visibility, then sorts by **id**, while the compound index uses **created_at**. The primary key can support a global ID-order scan, but it is not an efficient stream-prefixed history index under all distributions. Measure and add a stream/order index for the chosen production query; do not claim the current index already matches it.

The reaction uniqueness constraint includes nullable `comment_id`. Repeated stream-level taps with a null comment are allowed; repeated non-null comment reactions can conflict. The service increments Redis even after `ON CONFLICT DO NOTHING`, so a duplicate comment reaction can inflate cached counts. PostgreSQL normally treats nulls as distinct for uniqueness. [PostgreSQL 16 constraints](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)

Foreign keys establish existence, not that a parent/reaction comment belongs to the supplied stream. There is no SQL text-length limit, per-stream sequence, unique operation receipt, outbox, durable cursor, or invariant limiting pins to one. `updated_at` columns have no automatic update trigger. Stream and comment counts are not maintained by triggers.

| Proposed record | Key and responsibility | Retention/access considerations |
|-----------------|------------------------|---------------------------------|
| Operation receipt | Actor + operation ID, request digest, result/comment ID | Covers supported retry horizon; old requests have explicit expiry |
| Stream authority | Stream ID, owner epoch, next accepted position, status | Storage-fenced ownership; bounded ordering bottleneck |
| Comment/event | Stream + accepted position, stable comment ID, author, visibility version | Recent replay and separately paginated history |
| Outbox event | Unique event ID, stream/order, payload, delivery status | Transactional with accepted mutation; relay retries |
| Selected view | Stream, policy/version, covered cursor range, selected IDs | Bounded replay; reset when unavailable |
| Moderation audit | Action ID, actor, target, version, reason | Access controlled; feed/cache repair derives from the action |
| Reaction snapshot | Stream + epoch/version, counts, aggregation watermark | Replacement semantics; decorative animation is separate |

Shard durable records by stream ownership, with time buckets/retention partitions for large historical collections. A Cassandra projection becomes an option for very large sequential history reads and writes, with bounded stream/time partitions; it is not an automatic replacement for transactional acceptance and operation receipts.

## API Design

### Actual HTTP and socket surface

Routes are defined in [streams.ts](./backend/src/routes/streams.ts), [users.ts](./backend/src/routes/users.ts), and [index.ts](./backend/src/index.ts). All are public demo endpoints.

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/streams`, `/api/streams/live`, `/api/streams/:streamId` | Lists or reads streams |
| POST | `/api/streams`, `/api/streams/:streamId/end` | Creates or ends a stream without ownership checks |
| GET | `/api/streams/:streamId/comments?limit=50` | Cache first; SQL fallback only on empty cache; no cursor or maximum validated limit |
| POST | `/api/streams/:streamId/comments` | Saves from user_id/content/optional parent_id; no live fan-out |
| GET | `/api/streams/:streamId/reactions` | Cumulative stream reaction counts |
| GET | `/api/streams/:streamId/metrics`, `/api/streams/:streamId/viewers` | Cached metrics / local socket count |
| GET / POST | `/api/users` | Lists / creates identities |
| GET | `/api/users/:userId` | Reads profile |
| POST / DELETE | `/api/users/:userId/ban` | Adds/removes bans; DELETE without stream removes all that user's bans |
| GET | `/health`, `/health/live`, `/health/ready`, `/health/db`, `/health/redis`, `/metrics`, `/api/status` | Probes, telemetry, process status |

```json
{"type":"post_comment","payload":{"stream_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","user_id":"22222222-2222-2222-2222-222222222222","content":"Hello!"}}
```

This actual socket request requires a prior `join_stream` with matching claimed IDs. Success arrives through a later `comments_batch`, not an `ack`. `react` requires some joined context but fails to compare it to the supplied payload IDs. `leave_stream`, application `ping`, and the two write types are routed; `delete_comment` is declared in types but not handled.

Actual outbound batches contain `payload.stream_id` and either `comments` or interval `counts`, plus a wrapper timestamp. A join batch is not marked as history. `viewer_count` supplies a local count, and `error` supplies code/message. There are no receipt IDs, retry deadlines, coverage cursors, total versions, or `stream_ended` messages. Browser/server type definitions are separate files, not a shared npm contract.

### Proposed contract additions

Use authenticated actor identity from the session; add operation IDs and content digests to writes, correlated acceptance/rejection responses, machine-readable retry timing, subscription generations, snapshot watermarks, cursor coverage and sampling policy, and versioned moderation/reaction state. Validate every envelope at runtime. TypeScript types alone do not constrain network input.

## Key Design Decisions

### Batch messages, bound the selected view

A short batch amortizes serialization and frame processing while keeping latency within the budget. It does not make a million-viewer payload inexpensive. Sampling/capping is the actual bandwidth reduction, so expose that policy and keep an author's receipt independent of general-feed selection. Sending everything preserves completeness but can saturate mobile bandwidth and replace the whole retained window before the viewer reads one sentence. The cost of selection is missed conversation context and ranking/fairness policy.

### Durable acceptance before fan-out

The proposed SQL transaction gives comments and retry receipts one commit boundary. An outbox closes the save-then-publish failure window through replayable work; duplicates remain possible downstream and require IDs. Publishing before durable acceptance is faster in the best case but can show a comment that disappears after a writer crash. Waiting on every viewer would couple posting to the slowest connection. This design pays a database round trip and stores delivery work without claiming exactly-once transport.

### Independent live and reading state

A virtualizer bounds DOM rows, not retained data, parser cost, or incoming bandwidth. A frozen reading snapshot plus capped live tail protects both position and memory. Unbounded suspension of eviction eventually exhausts memory; continuously removing the reader's anchor without a fallback causes jumps. The price is an explicit gap/history transition after a long read. This is a product behavior, not something CSS can repair by itself.

## Consistency and Idempotency

**Locally**, [idempotency.ts](./backend/src/shared/idempotency.ts) hashes user, stream, content, and the current one-second bucket. It separately GETs and SETEXes a result for 300 seconds, failing open on Redis errors. Neither transport passes the optional service key. Concurrent misses can both insert; a retry in the next second has a new key, while two intentional identical posts in one second can be collapsed. Hash collisions and omission of parent ID further weaken identity. A duplicate WebSocket request can rebroadcast the cached comment even when no new SQL row is created.

Snowflake uses a 2024-01-01 epoch, 10 machine bits, 12 sequence bits, and a default machine value of PID modulo 1024. It does not allocate worker IDs or guard clock rollback. Equal worker IDs can collide; rolling the clock backward can regenerate an earlier timestamp/sequence combination. Sequence overflow busy-waits for time to advance. IDs travel as strings to preserve 64-bit precision. They are neither a global commit order nor a contiguous replay cursor.

**In the proposal**, use a unique actor/operation receipt with digest binding, immutable accepted comment identity, and conditional moderation versions. The response is idempotent within its documented retention window; transport remains at least once or best effort depending on the channel. Expired operations must not silently become fresh writes. A stream epoch plus ordered cursor identifies recoverable history independently of wall-clock IDs.

## Security / Auth

The demo has unrestricted CORS, no authenticated HTTP session or socket upgrade, no socket origin allowlist, and only partial field checks. A caller can select another existing user's ID, create/end streams, or invoke ban routes. Join checks bans through a helper that allows access on database errors; later comment writes do not recheck bans, and HTTP writes bypass that gate. Ended/nonexistent room IDs are not validated at join. SQL parameterization helps with SQL injection but does not authorize these operations.

For production, authenticate before room membership, bind all actions to the session actor, check stream visibility/status/ban state on each mutation, validate lengths/types/IDs, and bound connection/message admission. Apply same-origin/CSRF controls appropriate to session cookies, TLS, moderator permissions, and protected audit access. Render comment content as text. Restrict reaction types before any HTML-based animation rendering; the local floating component has a raw fallback for unknown types, although normal writes encounter the database enum check.

## Observability

[metrics.ts](./backend/src/shared/metrics.ts) exports connection gauges/counters, message-size histograms, comment/reaction counters, peak viewers, database timing/pool state, breaker state/failures, rate-limit violations, and duplicate detections. Pino logs HTTP completion, queries, and gateway/service work. `/metrics` is wired; no Prometheus or Grafana service is supplied.

The local `comment_latency_ms` name/help imply delivery latency, but the observation ends inside comment creation **before batching, Pub/Sub, network delivery, and rendering**. Outbound size observations use the Redis JSON string's character length once per incoming publication, not encoded bytes multiplied by socket recipients. Connection counts represent room membership rather than every open socket; close and error events can both increment close counters. Stream/user labels and retained peak entries create cardinality growth.

Production telemetry should measure writer acceptance latency, outbox age, per-gateway delivery lag, queue bytes, replay/reset rates, selected-versus-accepted volume, cache visibility versions, and browser input latency/heap growth. Use bounded metric labels and sampled traces for stream/user detail. End-to-end timing needs a defined start/end and clock-skew treatment; subtracting unrelated browser/server wall clocks is not a trustworthy latency proof.

## Failure Handling

| Failure | Actual behavior | Proposed handling |
|---------|-----------------|-------------------|
| SQL unavailable/slow | Shared queries use Opossum; no durable write queue fallback | Reject/return unknown appropriately; recover receipt on retry |
| Redis failure after SQL insert | Count/cache work can reject an already-saved post | Outbox-derived projections; accepted result independent of cache health |
| Gateway misses Pub/Sub | Missing batches are not replayed | Cursor gap detection and bounded durable replay/reset |
| Slow browser | Socket sends have no queue/byte budget | Coalesce replaceable state; disconnect/reset when durable-feed budget is exceeded |
| Reader pauses indefinitely | Local list still evicts; animations can grow | Fixed reading/live budgets and explicit expiry transition |
| Stream ends or moderator hides | No connected-view invalidation | Versioned control events plus authoritative read checks |
| Shutdown during a write | Timers flush without awaiting publications; HTTP closes late | Stop admission, drain accepted work, await publications, then close dependencies |

Redis Pub/Sub does not store missed messages for a reconnecting subscriber. The cache/replay layer must be designed separately. [Redis delivery semantics](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics)

## Scalability Considerations

Partition independent streams across writers and caches, then distribute each hot stream's selected feed across many gateways. A single huge stream remains a hotspot in sequencing, moderation, and fan-out; adding shards for other streams does not split it. Size socket fleets by measured bytes, connection memory, send work, and TLS overhead rather than connection count alone.

Replace synchronous increments of one stream counter on every post with reconciled aggregates when scaling ingestion. Separate reaction traffic and prioritize small control/moderation messages. Per-gateway subscription leases avoid broadcasting every stream to every server. Bound slow-client queues, batch bytes, animation count/lifetime, replay buffers, and hidden-tab work. `bufferedAmount` can report bytes queued by a WebSocket sender, but observing it is not itself a backpressure policy. [WebSocket bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Acceptance | Transaction + receipt + outbox | Publish then persist | Recoverable durable result |
| Hot feed | Batches plus explicit selection | Every comment to every viewer | Bounds bytes and reading churn |
| Recovery | Snapshot watermark + covered cursor | Reappend recent rows | Detects gaps and avoids duplicate history |
| Reactions | Versioned absolute snapshots | Unsequenced interval deltas | Next snapshot repairs missed updates |
| Reading | Bounded snapshot + live tail | Suspend all eviction | Preserves position without unlimited growth |
| Presence | Leased gateway contributions | Local count overwrites total | Approximate count across instances |

## Implementation Notes

### Patterns actually implemented

[commentService.ts](./backend/src/services/commentService.ts) calls PostgreSQL before publishing through the gateway batcher. In simplified form, the actual boundary is:

```typescript
const comment = await commentService.createComment(streamId, userId, content);
roomManager.getCommentBatcher(streamId)?.addComment(comment);
```

That sequence avoids broadcasting before the initial insert, but creation also performs a user lookup, stream-counter SQL/Redis writes, three cache commands, and result caching. There is no encompassing transaction or outbox. HTTP posting calls only the first line's service behavior. Redis cache errors do not automatically fall back to SQL; any nonempty cache hit is returned even when short, hidden, or stale, and SQL misses do not populate it.

[circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) wraps the stable shared query function through [db/index.ts](./backend/src/db/index.ts). Its 5-second timeout, 50% threshold with at least five requests, and 10-second retry window limit repeated failing calls. The wrapper forwards query arguments correctly. It does not cancel a timed-out SQL operation, and direct pool/transaction/health queries bypass it. A Redis breaker factory exists but is unused. Readiness checks PostgreSQL and the command Redis connection, not subscriber health or feed freshness.

[redis.ts](./backend/src/utils/redis.ts) implements fixed-window rate counters with separate INCR and first-use EXPIRE commands. An interruption between them can leave a persistent limiter key; limits are not sliding windows or reputation-adaptive. The first limiter consumes budget even if a later check rejects. Pino and prom-client are wired through [shared/index.ts](./backend/src/shared/index.ts); their operational caveats are above.

### Local substitutions and incomplete behavior

- **Batching:** [broadcast.ts](./backend/src/services/wsGateway/broadcast.ts) owns local 100/500 ms timers. Comment buffers contain items; reaction buffers contain deltas and reset after flush. Publication promises are not awaited, buffers have no cap, and there is no sampling, replay, retry, or explicit posting acknowledgment.
- **Rooms:** [room-manager.ts](./backend/src/services/wsGateway/room-manager.ts) subscribes before adding the first connection and fetching 50 reversed recent rows. Concurrent first joins can create overlapping batchers whose timers are overwritten in the maps. Final leave stops only the retained timers and does not write/broadcast zero viewers. A leave during asynchronous join can also race setup. Counts overwrite a shared hash with local membership; PostgreSQL viewer counts are not refreshed by this room path.
- **Storage:** recent comments use LPUSH/LTRIM to 1,000 and an expiry renewed for the whole key on each post; this is not one hour of history per item. At high rate 1,000 rows can cover seconds. Reaction count hashes have no TTL. PostgreSQL persists every accepted reaction before aggregation. Deletion/pin/highlight/reputation helpers exist but have no routes/UI; their mutations do not refresh caches or notify viewers.
- **UI:** [appStore.ts](./frontend/src/stores/appStore.ts) appends to a 200-entry array without deduplication. [CommentList.tsx](./frontend/src/components/CommentList.tsx) renders every row and auto-scrolls only when length changes. There is no virtualizer, reading mode, unseen pill, paging, or moderation reconciliation. Seeded pin/highlight flags only change row styling.
- **Connection/composer:** [useWebSocket.ts](./frontend/src/hooks/useWebSocket.ts) uses direct insecure port 3001, marks connected on socket open before join succeeds, pings every 25 seconds, and retries after a fixed three seconds. Cleanup can schedule stale reconnects; frames have no current-stream/generation check. Server errors go to the console. [CommentInput.tsx](./frontend/src/components/CommentInput.tsx) is a single-line input with maxLength 500, clears immediately, and has no pending receipt, recovery text, cooldown, or multiline handling.
- **Animations:** [FloatingReactions.tsx](./frontend/src/components/FloatingReactions.tsx) schedules a new two-second timeout for every retained reaction whenever the array changes. Sustained arrivals postpone removal of older entries; a per-batch cap of ten per type is not a lifetime cap. Positions are also randomized again during render. Reaction totals accumulate but have no numeric UI, baseline fetch, or reset on stream changes.
- **Process lifecycle:** protocol ping/pong runs every 30 seconds on all server sockets. Shutdown stops room timers, waits an arbitrary 500 ms, then begins closing sockets; Redis/SQL close before the final HTTP server close. New HTTP work and in-flight handlers are not comprehensively drained. Pub/Sub failure can therefore coexist with apparently healthy command-Redis readiness.

### Omitted and verification boundary

No authenticated sessions, broker/outbox, partitioned history store, guaranteed unique workers, moderation feed, global viewer accounting, CDN deployment, autoscaling, or load-adaptive client/server policy is provided. The schema/seed, environment load order, sample video behavior, and actual commands are documented in the [README](./README.md).

The review executed eight isolated checks against actual modules with mocked Redis, SQL, sockets, stores, timers, and clock. They confirmed reaction delta semantics, duplicate/retained client state, postponed animation cleanup, stale short cache behavior, post-insert failure, Snowflake collisions/rollback, concurrent-join timer leakage/stale final viewer count, and reaction identity mismatch. No application code was changed and no full-stack runtime or benchmark was run. Existing smoke coverage does not establish those guarantees.
