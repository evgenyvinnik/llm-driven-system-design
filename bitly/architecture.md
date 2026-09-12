# Bitly architecture

## System Overview

Design a URL-shortening service with reliable link creation, fast redirects, owner management, and delayed click analytics. This document describes a proposed production architecture first, then maps it to the local Express, PostgreSQL, Valkey, RabbitMQ, and React implementation. Proposed guarantees are not claims about the current demo or Bitly's private system.

The central distinction is between publishing a durable mapping, deciding whether it may still redirect, and recording an observation about a redirect request. These have different consistency and availability requirements.

## Requirements

### Functional requirements

- Create HTTP(S) short links, optionally with a custom alias and expiration.
- Keep one owner for each code in a shared, case-sensitive namespace; reserve service routes.
- Resolve valid links without loading the management application.
- Let authenticated owners list and deactivate their links; let administrators handle abuse.
- Report request counts, daily activity, referrers, and device categories with explicit freshness and coverage.

Custom domains, destination editing, billing, authenticated destination access, and unique-person attribution are outside the first production design. A public short code is a locator, not a secret or an authorization credential.

### Non-functional targets

These are planning assumptions, not measured results: redirect availability 99.99%, regional p99 resolution under 50 ms excluding the destination, and p99 creation under 300 ms under the agreed load. Target analytics publication within one minute in normal operation and publish lag during an outage.

A committed code must not later resolve to another owner's target. Expiration must be evaluated at resolution time. Ordinary deactivation has a proposed five-second propagation bound; emergency takedowns require acknowledged enforcement at serving regions or withdrawal of regions that cannot enforce them. Availability during a control-plane partition follows that policy rather than silently extending an unlimited stale mapping.

## Capacity Estimation

| Assumption | Calculation | Design consequence |
|------------|-------------|--------------------|
| 50 million creations/day | About 580/s average; plan for 5,000/s peaks | Durable namespace and indexed owner listing |
| 5 billion redirect requests/day | About 58,000/s average; plan for 200,000/s peaks | Regional caches and separate redirect capacity |
| 500 bytes per mapping | About 25 GB/day; 9.1 TB/year raw | Partition before this sustained scale; add indexes/replicas separately |
| 200 bytes per retained event | About 1 TB/day; 90 TB for 90 days raw | Separate analytics storage and bounded retention |
| Seven base62 characters | 62⁷ = 3,521,614,606,208 possibilities | About 193 years of allocations at 50 million/day before exclusions |

The code-space estimate is capacity, not a collision-free lifetime for random draws. After one year, roughly 0.5% of that space is occupied; a new independent draw has a comparable collision probability if assignments are well distributed. Unique constraints and retries remain necessary. Do not reuse retired codes just to save space: old messages and bookmarks can otherwise lead to an unrelated target.

Cache sizing follows the active working set, including keys, metadata, and allocator overhead. A million cached entries at an assumed 600 bytes each is about 600 MB before replication and process overhead. Measure this with representative URLs; a 2,048-character limit does not imply a fixed 2 KB average.

### Local Development Scale

One API, one worker, PostgreSQL, Valkey, RabbitMQ, and Vite are sufficient to explore the flows. Additional API and worker processes share infrastructure. There is no configured load balancer, sharding, benchmark, or production-sized event history. See the [README](./README.md) for ports and resource setup.

## High-Level Architecture

```text
┌────────────────┐       ┌────────────────┐
│ Management UI  │──────▶│ Management API │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Mapping store  │
                         └───────┬────────┘
                                 │ revisions / invalidation
                                 ▼
┌────────────────┐       ┌────────────────┐
│ Short-link GET │──────▶│ Regional       │──────▶ Destination
└────────────────┘       │ resolver/cache │         via 302
                         └───────┬────────┘
                                 │ request observations
                                 ▼
                         ┌────────────────┐
                         │ Durable log    │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Analytics      │──────▶ Management API
                         │ workers/store  │
                         └────────────────┘
```

A CDN can serve management assets. Redirect response caching is a separate policy because it changes revocation and measurement. Logical services can begin in one application while retaining independent capacity limits; they need separate deployments when redirect traffic or analytics work interferes with management writes.

## Core Components / Request Flows

### Creation and namespace ownership

Validate the input, bind a creation attempt to the caller and request contents, then atomically claim the code and record the resulting link. Return success only after that transaction commits. For generated codes, a cryptographic random candidate with a bounded retry on the unique constraint is a reasonable initial production choice. At the assumed creation rate, measure that design before adding an allocator service.

Custom aliases enter the same namespace. An availability lookup is advisory; the final insert decides which simultaneous request wins. Define length, character set, case sensitivity, and reserved routes consistently at every boundary. Validate the URL scheme and structure without changing the destination's query semantics or fetching the target in the creation transaction.

The local project's preallocated key pool is a useful alternative for studying batch coordination. A production pool would need one namespace for generated and custom codes, bounded asynchronous refill, fenced allocation ownership, and safe retirement or reclamation. It does not eliminate database coordination or the mapping insert.

### Resolution and changes

A cache record carries the target, active state, expiration, revision, and an absolute freshness deadline assigned when the authoritative record is read. Resolve only if it remains active, unexpired, and fresh enough for the deactivation policy. Cache TTL never extends past link expiration.

Deactivation commits a new revision and a durable invalidation event. Consumers must reject an older refill after observing a newer revision or tombstone. Even if invalidation is delayed, an old read cannot obtain a new five-second lifetime merely by arriving late: its freshness deadline was fixed at the authoritative read. Account for clock uncertainty when enforcing that bound.

Use explicit redirect cache headers consistent with this policy. A 302 alone is not an end-to-end measurement or revocation contract. Browser and shared-cache rules are separate from the service's Redis cache. [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5) defines the response `no-store` directive; the proposed mutable-link response uses it to prevent compliant HTTP caches from storing the redirect.

### Analytics admission and processing

Define a click as an observed eligible redirect request, not proof of a human visit or successful destination load. Apply a stated policy to bots, previews, repeated requests, and failed resolutions. A browser retry can be another observation even when it came from one user action.

Assign an event ID once at the observation boundary. Retrying its publication keeps that ID. Decide whether the product requires durable admission before replying: a lossless promise for admitted events requires an acknowledgement from durable infrastructure, with its latency and failure policy. For this product, prioritize redirect availability and disclose analytics gaps if the admission path cannot retain an observation within its budget.

Workers acknowledge only after applying an event's effect durably. Duplicate detection and aggregate updates must share a transaction or an equivalent atomic ingestion contract. Retain deduplication information for at least the supported replay window. Separate retrying the same event from defining unique visitors; these solve different problems.

Use time partitions, aggregated query tables, and a raw-event retention policy in a dedicated analytics store. A popular link should not make all workers contend on one mapping row. Publish processing watermarks and known admission gaps with dashboard results.

## Database Schema

### Current local schema

The following is the current [initialization SQL](./backend/src/db/init.sql), with comments removed. It is executable local evidence, not a claim that these tables implement the production guarantees above. In particular, `urls.user_id` has no foreign key, roles have no check constraint, and there are no operation receipts, outbox records, mapping revisions, or event deduplication keys.

```sql
CREATE TABLE IF NOT EXISTS urls (
    short_code VARCHAR(10) PRIMARY KEY,
    long_url TEXT NOT NULL,
    user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    click_count BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    is_custom BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_urls_user_id ON urls(user_id);

CREATE INDEX IF NOT EXISTS idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_urls_active ON urls(is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS key_pool (
    short_code VARCHAR(10) PRIMARY KEY,
    is_used BOOLEAN DEFAULT false,
    allocated_to VARCHAR(50),
    allocated_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_unused_keys ON key_pool(is_used) WHERE is_used = false;

CREATE TABLE IF NOT EXISTS click_events (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(10) NOT NULL REFERENCES urls(short_code),
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    referrer TEXT,
    user_agent TEXT,
    ip_address INET,
    country VARCHAR(2),
    city VARCHAR(100),
    device_type VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_click_events_short_code ON click_events(short_code);

CREATE INDEX IF NOT EXISTS idx_click_events_time ON click_events(clicked_at);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE OR REPLACE FUNCTION generate_short_code(length INTEGER DEFAULT 7)
RETURNS VARCHAR AS $$
DECLARE
    chars VARCHAR := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    result VARCHAR := '';
    i INTEGER;
BEGIN
    FOR i IN 1..length LOOP
        result := result || substr(chars, floor(random() * 62 + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION populate_key_pool(count INTEGER DEFAULT 1000)
RETURNS INTEGER AS $$
DECLARE
    inserted INTEGER := 0;
    new_code VARCHAR;
BEGIN
    FOR i IN 1..count LOOP
        new_code := generate_short_code(7);
        BEGIN
            INSERT INTO key_pool (short_code) VALUES (new_code);
            inserted := inserted + 1;
        EXCEPTION WHEN unique_violation THEN
            -- Skip duplicates
        END;
    END LOOP;
    RETURN inserted;
END;
$$ LANGUAGE plpgsql;

SELECT populate_key_pool(10000);
```

### Production extensions

| Record or index | Purpose |
|-----------------|---------|
| Link revision, status, expiry, owner FK | Enforce lifecycle and preserve authoritative ownership |
| Creation receipt unique by caller and operation ID | Bind a retried request digest to one committed result |
| Outbox entry committed with link changes | Recover invalidation after a publisher crash |
| Common code ownership record, if using a pool | Prevent custom aliases and allocated keys from diverging |
| Owner plus created-time/code index | Stable cursor pagination without large offsets |
| Event identity and transactional contribution | Apply a retained event once within the replay horizon |
| Time-partitioned events and rollups | Retention and dashboard queries independent of redirect writes |

Once mappings span shards, route code claims deterministically to one authority. Owner listing becomes a separate maintained index. Do not promise a transaction spanning unrelated shards without specifying the coordination or changing the receipt layout.

## API Design

### Existing application routes

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | `/api/v1/auth/register` | Create a user; no automatic login |
| POST | `/api/v1/auth/login` | Set cookie; also return user and bearer token |
| POST | `/api/v1/auth/logout` | Delete session and clear cookie if operations succeed |
| GET | `/api/v1/auth/me` | Require a valid session and active user |
| POST | `/api/v1/urls` | Create, optionally associated with authenticated user |
| GET | `/api/v1/urls` | List owned links using limit/offset, including inactive rows |
| GET | `/api/v1/urls/:shortCode` | Anonymous details; restrict to owner when authenticated |
| PATCH | `/api/v1/urls/:shortCode` | Owner updates active flag or expiration; no target update |
| DELETE | `/api/v1/urls/:shortCode` | Owner soft-deactivates; return 204 |
| GET | `/:shortCode` | 302 on a resolved mapping; cold invalid/expired/inactive links return 404 |
| GET | `/api/v1/analytics/:shortCode` | Authenticated aggregate lookup without ownership enforcement |
| GET | `/api/v1/analytics/:shortCode/clicks` | Authenticated raw events without ownership enforcement |
| GET | `/api/v1/admin/stats`, `/analytics` | Administrative system summaries |
| GET | `/api/v1/admin/urls`, `/users`, `/key-pool` | Administrative lists and pool counts |
| POST | `/api/v1/admin/urls/:shortCode/deactivate`, `/reactivate` | Change status in SQL without cache invalidation |
| PATCH | `/api/v1/admin/users/:userId/role` | Change role to user/admin |
| POST | `/api/v1/admin/users/:userId/deactivate` | Deactivate a user |
| POST | `/api/v1/admin/key-pool/repopulate` | Add generated pool keys, default 1,000 |
| POST | `/api/v1/admin/cleanup-expired` | Manually deactivate expired rows; no scheduler |

Creation example with a database-compatible custom alias:

```http
POST /api/v1/urls
Content-Type: application/json

{"long_url":"https://example.com/article","custom_code":"article7","expires_in":86400}
```

A successful response is a formatted link with `short_code`, `short_url`, `long_url`, creation/expiration timestamps, click count, and custom-code flag. Normal link responses omit `is_active`. `expires_in` is seconds at the API, while the UI accepts days. The local creation handler generally reports service failures as 400, including some post-commit failures; it does not implement the proposed conflict and unknown-operation contract.

The proposed API adds bounded input schemas, consistent alias lengths, stable cursors, lifecycle revisions, owner checks for every analytics read, and recoverable creation receipts. Those changes require implementation, not just a new header in the browser.

## Key Design Decisions

### Random allocation versus a preallocated pool

A unique mapping insert already arbitrates ownership. Random candidates plus a bounded uniqueness retry keep the initial production write path small and avoid stranded batches. At low namespace occupancy, most inserts need one attempt. This costs collision handling and does not make codes secret.

A pool moves candidate generation and reservation out of many individual requests and can absorb a temporary allocator interruption. It adds refill scheduling, unused reservations, and fencing for a process that appears dead but later resumes. A simple shared counter would expose sequential IDs, but block allocation can avoid a counter round trip per link; it is not inherently incapable of the assumed throughput. Choose additional coordination from measurements and operational needs.

### Cached resolution versus immediate revocation

Reading authoritative status on every redirect makes deactivation simpler but transfers viral traffic and database outages directly to the redirect path. Caches reduce that dependence. The cost is a specified interval in which an old decision may still be served.

A short, enforced freshness deadline and revision-aware invalidation make that cost bounded. Expiration can be checked locally because its deadline is already in the record. Emergency abuse removal needs an enforcement protocol across active serving regions; deleting one Redis key is insufficient. If the product insists on immediate globally authoritative decisions through a partition, it must accept unavailable regions.

### Asynchronous analytics versus lossless observation

Moving aggregation behind a queue prevents report computation from delaying navigation. It does not by itself retain every observation. Publication must be confirmed to establish admission, and repeated delivery requires repeatable effects.

Waiting for admission adds a dependency to redirects. This design allows redirects to continue during an admission outage and reports reduced coverage. A billing-grade requirement would change that choice: retain before success, or reject the operation when durable admission is unavailable. Neither policy makes request counts equal to human visits.

## Consistency and Idempotency

The proposed creation transaction includes the mapping and a caller-scoped operation receipt. A retry with the same digest returns the stored result; changed input with the same operation ID is rejected. A timeout triggers lookup/retry of that operation, not automatic allocation of a second link. Validation failures before acceptance can be corrected with a new attempt.

Mutation revisions prevent lost updates, and an outbox recovers propagation after a crash. Consumer-side revision checks prevent an old invalidation/refill from overriding newer state. Event deduplication controls repeat processing of admitted events within a defined retention horizon; it cannot recover an observation that was never retained.

Locally, the URL insert, key-used update, cache write, click insert, and click-counter update do not share these transactions. Idempotency middleware exists but is registered after the creation router. Normal requests therefore receive none of its intended protection.

## Security / Auth

Production enforces owner authorization on details, mutations, and analytics, plus a separate administrator role for moderation. Short-code knowledge only permits public resolution. Return bounded aggregate data by default; protect raw events, define retention, and minimize IP/referrer collection because these can identify users or contain sensitive URL parameters.

Validate HTTP(S) targets and block reserved aliases consistently. Abuse reporting, destination reputation checks, and emergency removal are separate capabilities from syntactic validation. Rate-limit creation and expensive analytics by appropriate actor and network dimensions, with shared accounting across replicas. Preserve legitimate redirect bursts instead of blindly applying a low per-IP cap to all shared-network users.

Keep session expiry authoritative and bound cache TTL to its remaining lifetime. Session deletion must invalidate cached authorization, including concurrent repopulation. Role and active-user checks should reflect current authority. Audit administrative mutations without recording raw session tokens or destination query secrets.

## Observability

Measure redirect latency by cache outcome, authoritative lookup failures, stale-decision rejection, deactivation propagation age, creation conflicts and recovered attempts, admitted/dropped observations, worker lag, duplicate suppression, and poisoned events. Separate HTTP completion from successful destination navigation.

Use bounded route templates and low-cardinality dimensions. Monitor the age of the oldest unprocessed event and consumer progress; a connected broker socket is not evidence of a functioning pipeline. Analytics responses should expose data freshness to users, not only to operators.

## Failure Handling

| Failure | Proposed response | Current local limitation |
|---------|-------------------|--------------------------|
| Cache unavailable | Bounded SQL fallback with overload protection | Mapping errors become misses after client retries; auth cache errors propagate |
| Mapping store unavailable | Serve only eligible fresh records; fail cold requests | Warm target strings can redirect without current expiry/status |
| Creation response lost | Recover one durable operation result | Retry can allocate another code; no active idempotency handler |
| Invalidation delayed | Enforce fixed freshness deadline and revision ordering | Most status/expiry writers do not invalidate at all |
| Broker unavailable | Continue redirects with disclosed observation gaps | Deferred fallback or ignored publish failure; no gap accounting |
| Worker crashes | Replay retained event with duplicate-safe effect | Event insert and counter update can diverge or repeat |
| Poisoned event | Bounded retries, quarantine, operator visibility | Requeue loop without backoff or dead-letter handling |
| Process shutdown | Stop admissions, drain bounded work, close dependencies | API/worker close dependencies without draining HTTP/in-flight work |

## Scalability Considerations

Redirect reads and analytics writes grow differently. Isolate their pools and capacity first. Cache hot mappings regionally, coalesce concurrent misses, and use a bounded negative cache to resist random-code scans. Negative entries must be invalidated when a new mapping is published.

Partition the mapping namespace by code when a single store cannot meet measured write, storage, or maintenance needs. Keep custom-code claims on the same owner shard. Regional replicas need an explicit new-link visibility policy so a successful create is usable immediately at the returned address.

The first analytics bottleneck is likely the single `urls.click_count` row for a viral link or the raw-event queries, not code-space exhaustion. Move analytics effects to partitioned storage and rollups; size consumers for backlog recovery above normal arrival rate. Define retention and deduplication horizons together.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Initial production allocation | Random candidate plus unique insert | Preallocated pool | Fewer ownership states; add batching if measured need justifies it |
| Redirect freshness | Cached records with deadlines and revisions | SQL check on every redirect | Bound staleness while absorbing read bursts |
| Analytics outage | Continue redirects and disclose gaps | Require retained event before response | Navigation availability is the primary product requirement |
| Dashboard counts | Delayed event-derived projections | Increment mapping row per request | Avoid hot-row contention and enable replay |
| Link retirement | Preserve code ownership | Reassign expired aliases | Prevent old references from reaching unrelated destinations |

## Implementation Notes

### Actual runtime and data setup

[The API entry point](./backend/src/index.ts) serves authentication, URL management, analytics, administration, redirects, and operational endpoints in one Express process. [The worker](./backend/src/workers/analytics-worker.ts) is separate. The browser runs React 18 and uses Zustand plus direct fetch calls; there is no server-query cache library or live event transport.

[Compose](./docker-compose.yml) starts PostgreSQL 16, Valkey 7 with AOF, and RabbitMQ 3 management. Only PostgreSQL and Valkey have named data volumes. The schema initializes fresh PostgreSQL volumes, and each manual schema execution attempts to add more keys. There are no automatic users or migrations. The optional SQL fixture has nine links and 1,146 events; repeated seeding appends events while retaining existing counters. The administrator hash requires an explicit local reset for a known password, as shown in the README.

[Configuration](./backend/src/config.ts) defaults to API port 3000 and independently defaults `BASE_URL` to that address. Server variants use ports 3001–3003 without adjusting generated URLs or the Vite proxy. There is no load balancer, `.env` loader, or background cleanup service.

### Creation and the actual key pool

[The key service](./backend/src/services/keyService.ts) stores a batch in a process-local array. Allocation uses one transactional `UPDATE` over rows selected with `FOR UPDATE SKIP LOCKED`, preventing two current allocators from claiming the same pool row. The similarly named Redis `keyPoolCache` helper is unused.

```sql
SELECT short_code FROM key_pool
WHERE is_used = false AND allocated_to IS NULL
LIMIT $1 FOR UPDATE SKIP LOCKED
```

This pattern amortizes reservation across a batch; it still coordinates in PostgreSQL. Startup claims 100 keys. Every request awaits refill below 50 remaining keys, so refill is synchronous on that path, not a background task. Concurrent refill calls are not coalesced. There is no automatic pool generator or allocated-key expiry/reaper. Crashed processes strand unused reservations; reclaiming by age alone would be unsafe if a previous holder resumed.

When both local and database pools are empty, generation falls back to `Math.random` without reservation or collision retry. SQL pool generation uses `random()` and checks only pool uniqueness. Custom-alias preflight checks both tables, but races with subsequent generation remain; the final URL primary key can reject a collision. A generated/custom common namespace is not enforced as one atomic claim.

[URL creation](./backend/src/services/urlService.ts) commits the mapping, then marks a generated key used, then awaits a cache write whose errors are swallowed. A key-mark failure can report 400 after the link already exists. The configured 365-day default expiration is unused; absent or zero duration means no expiration, and negative values can create already-expired rows that are nevertheless cached.

URL validation checks HTTP(S) syntax and 2,048 JavaScript string units, not reachability or reputation. It lacks a complete input schema. Custom codes allow 4–20 characters while both tables allow 10; `metrics` and `ready` are not reserved and collide with earlier routes. Destinations are stored as supplied. PATCH cannot clear expiration with null because the route converts null to undefined.

### Redirect cache and lifecycle gaps

[The redirect router](./backend/src/routes/redirect.ts) uses its own lookup helper; the similar URL-service lookup is not the called implementation. [Mapping cache](./backend/src/utils/cache.ts) reads a destination string, with no expiry, active flag, or revision:

```typescript
const result = await redis.get(`url:${shortCode}`);
await redis.setex(`url:${shortCode}`, ttl || CACHE_CONFIG.urlTTL, longUrl);
```

The default TTL is 86,400 seconds. Only a miss reaches SQL's active/expiration predicates. Creation warms this cache regardless of expiration. Owner deletion or an explicit owner `is_active: false` update deletes it; expiry changes and [administrator status/cleanup writes](./backend/src/services/adminService.ts) do not. An in-flight old SQL read can refill after deletion. The current cache therefore has neither correct expiration nor the proposed five-second deactivation bound.

The response uses 302 without explicit Cache-Control. No human-visit proof follows from that status. Invalid, inactive, and expired cold lookups all return 404; dependency failures can return 500. Redis mapping errors become misses only after client retry behavior, and an awaited failed cache set can also delay a response.

### Click delivery and aggregation

The router schedules both queue publication and its SQL fallback with `setImmediate`, after choosing the redirect response. The fallback named `recordClickSync` is deferred too; it does not synchronously delay that response, though it consumes shared database capacity. A process failure before the callback loses the observation.

[Queue wiring](./backend/src/utils/queue.ts) declares durable `click-events` with a 24-hour message TTL and sends persistent messages through a plain channel. It uses no publisher confirms. Publisher confirmation and consumer acknowledgement cover different legs of delivery. [RabbitMQ's acknowledgement guide](https://www.rabbitmq.com/docs/confirms) explains that distinction.

The router ignores the publisher's boolean result when a connection appeared available, so publication failure does not trigger its SQL fallback. The underlying `sendToQueue` boolean is a buffer-flow signal, not a durable receipt; false requires handling backpressure, not assuming the event was never sent. See the [amqplib channel API](https://amqp-node.github.io/amqplib/channel_api.html#channel_sendToQueue).

Events contain code, timestamp, referrer, user agent, raw request IP, and a heuristic device type. There is no event ID, deduplication, IP hashing, geolocation, or unique-visitor algorithm. Country/city columns are not populated by this path.

The worker prefetches 10 messages but processes each with separate click INSERT and counter UPDATE statements. This is concurrent delivery, not batch insertion. Failure between writes leaves divergent counts; redelivery can duplicate an insert or both effects. Poisoned messages are requeued without backoff, attempt limits, or a dead-letter destination and can churn until TTL expiry.

Initial worker connection retries are bounded. A later connection-close callback reconnects the channel but does not restore the consumer. Broker connectivity can appear healthy while the worker no longer drains events. There is no automatic replay from another retained source.

[Analytics queries](./backend/src/services/analyticsService.ts) read raw PostgreSQL events directly. Total/referrer/device counts are all-time; daily activity covers the recent 30-day window and omits empty days. Queries run separately without a common snapshot. Global hourly grouping uses hour number without date, merging partial hours across the last-24-hour boundary and sorting by clock hour. There are no rollups, analytics cache, ClickHouse instance, or raw-event retention job.

The admin total-click statistic sums denormalized URL counters, while other totals count events. Active URL statistics ignore expiration. Pool-used counts do not include custom links. These quantities can disagree even without a display bug.

### Authentication, authorization, and browser behavior

[Authentication](./backend/src/services/authService.ts) uses bcrypt with 10 rounds and UUID session tokens. SQL sessions expire after seven days; Redis maps tokens to user IDs for seven days. The cookie is HttpOnly, SameSite=Lax, and Secure only in production mode. Login also returns the token for bearer use.

A warm session still reads the current user from PostgreSQL, so role changes and user deactivation take effect on the next authenticated request. It does not recheck the SQL session's expiry or deletion. A cache miss reloads an unexpired SQL session but grants a full new seven-day cache TTL instead of the remaining lifetime; bearer use can outlive SQL expiry. Logout deletes SQL first, then Redis; a cache failure can leave cached access and prevent cookie clearing. There is no coordinated protection from concurrent cache repopulation.

Session-cache errors propagate instead of using the mapping cache's fail-open behavior. [Optional authentication](./backend/src/middleware/auth.ts) catches such failures and continues anonymously, so even a browser with a cookie can create an unowned link during an authentication dependency failure.

Owned list/update/delete routes check the owner. Anonymous details are unrestricted, including inactive and expired rows; an authenticated details request is filtered to its owner. Both analytics routes require authentication but omit ownership checks, including raw events with IPs and user agents. Admin role changes have no last-administrator or self-demotion protection.

[Frontend authentication](./frontend/src/stores/authStore.ts) persists user state. Route guards call the server check only when no stored user exists. There is no universal expired-session interceptor, and logout does not reset [URL state](./frontend/src/stores/urlStore.ts) or invalidate outstanding requests. Older account/query responses can replace newer state.

Creation waits for a response before adding the returned link, but uses no operation key. Its shared loading/error state also covers list/delete operations. Inputs remain editable during submission, and success clears the current draft even if the user changed it. Copy failures only log to the console.

[The link list](./frontend/src/components/UrlList.tsx) fetches 50 rows without paging controls. Delete removes a row after server success, but reload returns inactive rows and the formatter omits status. Analytics fetches have no cancellation/context guard or freshness watermark. [Admin tables](./frontend/src/components/AdminDashboard.tsx) also fetch one page; searches are submitted explicitly, with no debounce or stale-response protection. There is no virtualization or automatic analytics refresh.

### Operational patterns actually wired

This project keeps shared helpers under `backend/src/utils/`, rather than `src/shared/`.

| Pattern | Actual wiring and purpose | Practical limit |
|---------|---------------------------|-----------------|
| Database breaker | [database.ts](./backend/src/utils/database.ts) wraps normal queries through [circuitBreaker.ts](./backend/src/utils/circuitBreaker.ts) to reduce repeated failing calls | Transactions and health queries bypass it; fallback replaces all failures with a generic open-circuit error |
| Prometheus metrics | [metrics.ts](./backend/src/utils/metrics.ts) and HTTP completion hooks record latency, counts, cache outcomes, and breaker state | No queue-depth metric; raw fallback paths can create unbounded labels; successful SQL durations exclude failures/transaction queries |
| Structured logs | [logger.ts](./backend/src/utils/logger.ts) and Pino HTTP record requests and service events | Most service logs do not use request context; URL error logs can include query secrets; no durable admin audit trail |
| General API limiter | Entry point applies 200 requests/minute by IP | Process-local store; creation's intended 100/hour middleware is after the terminal router; redirect limiter is unused |
| Health/readiness | `/health`, `/health/detailed`, and `/ready` inspect liveness, SQL, Redis status, and optional queue connection | No consumer-progress proof or active Redis PING; failed SQL health queries can leak a checked-out client |

The database breaker has a five-second timeout, 50% threshold after a minimum volume of 10, and a 30-second reset period. A timed-out query is not canceled and may commit after the caller sees failure. Its fallback can label ordinary query errors as circuit-open errors even when the circuit remains closed.

`dbConnectionsActive` counts open pool connections, not currently busy queries. `/metrics` first queries pool statistics in PostgreSQL, so a database outage can prevent scraping otherwise useful process metrics. Helmet's CSP is disabled unconditionally. Shutdown handlers close dependencies and exit without stopping HTTP admission or draining in-flight consumers.

### Simplified and omitted production capabilities

The demo uses one PostgreSQL database for mappings, users, sessions, and raw click history; one shared Valkey; and RabbitMQ instead of a large retained analytics log and dedicated warehouse. It omits region ownership, sharding, outbox propagation, durable operation receipts, revision-aware caches, event deduplication, dead-letter recovery, retention, abuse scanning, and CDN configuration.

[Four page smoke checks](./tests/smoke.spec.ts) and screenshot configuration establish only limited rendering coverage. The admin check uses Alice's ordinary user account and can pass after a redirect to another page. No cache-race, queue-recovery, transactional analytics, or production-load result was established by this documentation review; implementation defects are documented rather than repaired here.
