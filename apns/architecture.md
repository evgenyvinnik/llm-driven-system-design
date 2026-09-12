# APNs-inspired push notification service

## System Overview

This design studies how a push service accepts provider requests, locates connected devices, retains useful work while devices are offline, and reports what actually happened. The production proposal emphasizes durable acceptance, bounded retention, and truthful status. It is an independent design exercise, not a description of Apple's internal architecture.

The repository implements a smaller simulator: one Express process combines APIs and WebSocket connections, PostgreSQL stores state, Valkey routes messages, and a React console polls administrative data. The final [Implementation Notes](#implementation-notes) trace that implementation and its gaps. Production components below are proposed unless explicitly identified as implemented.

### Boundary with Apple's public protocol

Apple's provider interface uses HTTP/2 over TLS and authenticates providers. Delivery is best effort; notifications can be reordered or omitted. Offline storage selects one notification for a device and bundle ID. An explicit zero expiration requests no storage. `apns-id` identifies a request; the documentation does not establish this simulator's 24-hour deduplication contract. Normal payloads allow 4096 bytes, VoIP 5120, and collapse identifiers 64 bytes. Priorities include 10, 5, and 1, with push-type-specific rules; background pushes use 5. See [Apple's current request reference](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

Tokens identify an app on a device and must be refreshed through platform registration. A provider needs the raw token to address Apple; hashing is useful inside a registry but cannot replace the provider's stored addressing material. See [Apple's registration guidance](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns). The simulator's fixed 64-hex validator is a local convention, not a universal token-size rule.

The local subscription names such as `news.sports` are custom fan-out groups. They are distinct from `apns-topic`, which identifies an app topic, and do not implement Apple's separate broadcast channel API. The local feedback polling endpoint is also a teaching interface.

## Requirements

### Functional requirements — proposed production service

1. Authenticate providers and bind every request to an application and environment.
2. Register and revoke device destinations without exposing raw addressing tokens in logs.
3. Accept a bounded notification with an identity, delivery class, expiry policy, and optional collapse group.
4. Attempt prompt delivery to reachable devices and retain eligible offline work until acknowledged, superseded, or expired.
5. Distinguish acceptance, gateway handoff, device receipt, and application action.
6. Let authorized operators inspect status and send narrowly scoped tests.
7. Bound bulk fan-out, storage, and retries so one provider cannot exhaust the service.

### Non-functional targets — assumptions, not measurements

| Concern | Proposed target and boundary |
|---------|------------------------------|
| Acceptance availability | 99.99% for valid, authorized requests within tenant quota |
| Acceptance latency | p99 below 100 ms in the receiving region under admitted load |
| Online handoff | p99 below 500 ms from acceptance to healthy gateway handoff |
| Retention | Explicit maximum expiry and per-device/provider queue budgets |
| Recovery | Accepted retained work survives a gateway crash; repeated attempts are possible |
| Isolation | Provider/app/environment authorization enforced on every access path |
| Console freshness | Aggregate observations normally less than 30 seconds old, with visible timestamps |

A device may be asleep, disconnected, revoked, or unable to display content. The service cannot offer a universal device-delivery latency or claim that transport receipt means a person saw the notification. Pushes should normally tell an app to fetch authoritative state.

## Capacity Estimation

Use an illustrative workload of 100 million registered destinations, 10 million concurrent connections, and one billion requests per day. That is roughly 11,600 requests/second on average; plan a first stress scenario at ten times that rate. These are interview assumptions, not Apple traffic figures or local benchmark results.

At an assumed 1 KB average payload, average ingress is about 12 MB/second and burst ingress about 116 MB/second before transport overhead. Keeping every payload for 24 hours would approach 1 TB/day before indexes, metadata, replicas, and backups. At 5% retained offline work lasting four hours on average, the steady backlog is roughly 8.3 million messages, or 8.3 GB of payload alone. Burstiness and devices offline for days require quotas even when the average looks manageable.

Connection memory must include socket buffers, TLS state, runtime objects, kernel limits, and load-balancer overhead. Measure a gateway's safe connection density and send rate under representative traffic before choosing a node count. Connection count and message throughput are separate scaling dimensions.

### Local Development Scale

Run one to three API processes, one PostgreSQL instance, one Valkey instance, and a few simulated sockets. Each API process has a PostgreSQL pool capped at 20 connections. The small fixture set supports functional exploration, not load claims. Compose runs no Kafka, RabbitMQ, Prometheus server, or Grafana dashboard.

## High-Level Architecture

Proposed production layout:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   App provider   │────▶│Auth + acceptance │────▶│ Durable work log │
└──────────────────┘     └─────────┬────────┘     └─────────┬────────┘
                                   │                        ▼
                         ┌─────────▼────────┐     ┌──────────────────┐
                         │  Token registry  │     │ Delivery workers │
                         │   Lookup cache   │     │  Retained work   │
                         └──────────────────┘     └─────────┬────────┘
                                                            │ route lookup
                         ┌──────────────────┐     ┌─────────▼────────┐
                         │Connection leases │◀───▶│  Gateway fleet   │
                         └──────────────────┘     └─────────┬────────┘
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ Device transport │
                                                  └──────────────────┘

Lifecycle events ──▶ status/metrics projection ──▶ operator console
```

Gateways own persistent connections. Acceptance servers can scale independently. The durable work log and retained-state owner establish recovery; connection presence only suggests a route. Operators read a projection so scanning notification history does not compete with live delivery.

## Core Components / Request Flows

### Acceptance and destination resolution

The gateway authenticates the provider, validates its app/environment scope, and checks payload bytes, delivery class, expiration, and quotas. A scoped operation ID plus a request fingerprint binds retries to the same destination and content. Reusing an ID for different content is a conflict.

A token lookup maps provider-supplied addressing material to an internal destination. Partition by the scoped lookup key, or maintain an explicit token-to-home-shard index. Hashing by internal device UUID alone does not solve the initial lookup when the request contains only a raw token.

Persist the accepted operation and publishable work in one recoverable boundary, such as a PostgreSQL transaction with an outbox at moderate scale. Return acceptance after that boundary succeeds. A relay can retry publishing without creating a second logical operation. At larger scale, a replicated log can become the acceptance authority, with an explicit deduplication owner for each partition.

Local mapping: token lookup and notification inserts exist, but no atomic outbox or recoverable acceptance state joins subsequent routing/storage.

### Online attempt and acknowledgement

A worker reads the current connection owner and generation, then requests delivery through that gateway. The gateway verifies it still owns the generation and has buffer capacity. A stale mapping causes rerouting or retained retry, not successful delivery.

An acknowledgement is authenticated to the destination and operation. Receipt updates durable state idempotently; only then can retained payloads be removed. A lost acknowledgement may produce a repeat attempt. Device-side handling needs a stable logical ID to suppress repeated presentation or effects where required.

Local mapping: all sends use Valkey pub/sub, including same-process delivery. Publishing is reported as `delivered`; the subscriber does not confirm socket receipt to the sender.

### Offline retention, expiry, and collapse

Retained messages have a deadline and count/byte budgets per destination and provider. A scheduler retries eligible work when the destination reconnects. It uses bounded batches, fair scheduling, and rate limits so a reconnect wave does not starve new traffic.

Collapse applies to replaceable state, such as the newest score update. An atomic replacement changes payload, ID, generation, priority, and expiry together, and marks the old operation superseded. Do not collapse unrelated events simply because they share a destination. A strict event history belongs in the application's database.

Check expiry before scheduling and again before handoff. Garbage collection reclaims storage; it is not the only mechanism preventing stale work from being sent. For no-storage requests, an unavailable destination produces an explicit outcome rather than indefinite retention.

Local mapping: PostgreSQL pending rows and reconnect ordering exist; priority lists have no consumer, collapse replacement is not atomic, and zero expiry becomes unlimited retention.

### Console and bulk sends

Operators inspect an observed state with timestamps and a bounded history page. Aggregate freshness and transport health are separate. A test request returns an operation ID; its status can be read after a timeout rather than blindly creating another send.

Bulk sends create a durable parent job with an audience snapshot or a documented membership cutoff. Children get stable IDs derived from the job and destination. Progress distinguishes accepted children, expired/rejected children, and known receipts. Local topic/broadcast loops instead run sequentially inside one HTTP request.

## Database Schema

The complete local schema is [backend/src/db/init.sql](./backend/src/db/init.sql). It contains eight tables. The following summarizes the actual constraints; production additions are listed separately.

| Table | Key data | Actual constraints and indexes |
|-------|----------|--------------------------------|
| `device_tokens` | UUID `device_id`, SHA-256 `token_hash`, bundle, JSONB metadata, validity and timestamps | Device PK, unique token hash, app index, partial valid-token index |
| `topic_subscriptions` | Device UUID, topic, subscribed timestamp | Composite PK; device FK cascades; topic index |
| `pending_notifications` | UUID, device, JSONB payload, priority, expiry, collapse ID, creation time | PK, device FK cascades, unique `(device_id, collapse_id)`, device and expiry indexes |
| `notifications` | UUID, device, topic, payload, priority, expiry, collapse ID, status and timestamps | PK; device FK sets null; separate device/topic/status/created indexes |
| `delivery_log` | Notification UUID, device, status, receipt time | Notification ID PK; device FK sets null; device/status/created indexes |
| `feedback_queue` | Sequence ID, token hash, bundle, reason, event timestamp | PK and `(app_bundle_id, timestamp)` index |
| `admin_users` | UUID, unique username, password hash, role, login timestamp | PK and unique username |
| `sessions` | UUID, admin UUID, token, expiry | PK, admin FK cascades, unique token and expiry indexes; unused at runtime |

The key local pending-table definition is:

```sql
CREATE TABLE IF NOT EXISTS pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)
);
```

Null collapse IDs allow multiple pending rows for a device. Neither pending rows nor delivery-log IDs have a foreign key to `notifications`. That permits the sample pending records to exist without matching history, and makes reconciliation an application concern. There are no database checks restricting priority, status transitions, payload size, or per-device backlog. Timestamps use `TIMESTAMP`, not a timezone-aware type.

### Production additions

| Record or constraint | Purpose |
|----------------------|---------|
| Scoped token identity and registration generation | Bind destination to provider/app/environment and order revocation/re-registration |
| Operation identity and request fingerprint | Durable retry lookup and mismatched-request rejection |
| Outbox/work-log record | Recover work after acceptance and before delivery |
| Retained-work generation and deadline | Atomic collapse, expiry, and exact acknowledgement cleanup |
| Connection lease with owner generation | Reject stale disconnects and stale routing hints |
| Appendable lifecycle events and bounded status projection | Explain attempts without overwriting all evidence |
| Fan-out job and child identity | Resume partial broadcasts with bounded concurrency |

At moderate scale, keep operation, outbox, and pending-state changes in the same PostgreSQL transaction. Partition workload by destination ownership as volume grows; partition/expire history by time. Do not imply the current UUID primary keys alone implement those transitions.

## API Design

Local endpoints and executable examples are in the [README](./README.md#api-reference). The main request shapes are:

```json
{
  "token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "app_bundle_id": "com.example.test",
  "device_info": { "platform": "iOS" }
}
```

Registration returns `device_id` and `is_new`. A REST device send accepts a wrapper:

```json
{
  "payload": { "aps": { "alert": { "title": "Local test", "body": "Hello" } } },
  "priority": 10,
  "collapse_id": "current-score"
}
```

The result contains `notification_id` and `status`. On a successful topic loop, `queued_count` is the number of child calls that completed without throwing, including online sends. Its returned parent UUID is not a persisted notification that can be queried. Broadcast returns counts for valid devices among the first 10,000 registrations it fetched, not a durable job handle.

The `/3/device/:token` variant takes the bare payload and reads `apns-priority`, `apns-expiration`, `apns-collapse-id`, and `apns-id`. It returns a JSON success body and the ID header, or a simplified 410/500 error. It ignores provider authorization, app topic, push type, and most protocol validation. REST sends do not forward an idempotency key.

WebSocket clients send `connect` with `device_id`; notifications contain `type: notification`, `id`, `payload`, and `priority`. Acknowledgements use `type: ack` and `notification_id`. The `connected` response's `pending_delivered` is a publish count, not a receipt count. No console WebSocket endpoint exists.

For the proposed service, use a stable accepted-operation resource, structured retriable/permanent errors, authenticated receipt messages, and a separate bulk-job resource. Do not retrofit these guarantees into the meaning of the current simulator response.

## Key Design Decisions

### Durable acceptance before opportunistic routing

Choose durable acceptance with retryable delivery. A presence entry can become stale between lookup and send; a gateway can crash after acceptance. An ephemeral publish cannot bridge those failures even if Valkey itself uses persistent storage. Durable work lets a new worker recover the operation and try the current route.

The cost is a storage/log write before returning success and duplicate-attempt handling after uncertain outcomes. For expendable telemetry, immediate best-effort publication may be sufficient. For a service promising retained offline work, reporting success while silently losing the only delivery path violates its own contract.

### Bounded retained state and scoped collapse

Choose explicit retention budgets and per-group atomic replacement. A score refresh can discard an old value, reducing reconnect traffic and avoiding stale alerts. A message that represents a distinct event cannot be merged safely without application semantics.

The alternative of keeping every notification indefinitely turns long-offline devices into unbounded queues and creates a reconnect storm. The chosen approach gives up complete push history and requires clear expiration/supersession outcomes. Authoritative business events remain in the app's store and are fetched after reconnection.

### Connection leases as hints, durable state as authority

Choose short renewable leases with owner generations, backed by persistent gateway sockets. They allow fast routing and clean handoff without coordinating every read through a global consensus service. A gateway must still confirm ownership and delivery capacity.

A bare global mapping is simpler but cannot distinguish a dead owner from a live replacement. A disconnect from the old connection can erase the new route. Leases add heartbeat load and brief rerouting delays; these are preferable to interpreting an old routing entry as proof of receipt.

## Consistency and Idempotency

For the proposed service, registration/revocation and operation acceptance require an authoritative conditional write. Console aggregates may lag. Attempts can occur more than once; repeat attempts must use the same logical identity. An acknowledgement does not establish that an app completed a business action.

The local idempotency path uses Valkey `SET NX` before token validation and the history insert. A failed request can therefore retain a claim for 24 hours without any notification record. A retry may return `duplicate` while doing no work. Claims are global, are not bound to payload or destination, and are allowed through when Valkey fails.

The notification UUID primary key stops a second row with the same UUID, but there is no conflict handler that resumes an incomplete operation. Redis eviction/expiry followed by a retry can fail at that insert. Marking processed before queueing means a later routing/storage failure is also not repaired by retry. This is not exactly-once delivery or a complete durable idempotency protocol.

## Security / Auth

The production service needs provider credentials, app/environment binding, authenticated device transport, scoped operator permissions, per-tenant quotas, and protected payload retention. Hashing a high-entropy token reduces raw-token exposure in one database; it neither authorizes a sender nor prevents access through other identifiers. An APNs provider still needs secure access to raw addressing tokens.

Locally, login verifies an unsalted SHA-256 password and stores a 24-hour random bearer session in Valkey. `/admin/me` reads that session. Other admin routes—including account creation, broadcast, and cleanup—have no authentication middleware. Device, notification, and feedback APIs are public. Role labels do not enforce permissions.

A WebSocket client can claim any device UUID or acknowledge any notification UUID without proof of ownership. Invalidating a token does not terminate its socket or remove all existing pending work. CORS is unrestricted and HTTP has no TLS. URLs contain raw tokens on token routes; request logging and current HTTP metric labels can expose them. These are concrete local limitations, not implemented production protections.

## Observability

Implemented hooks expose HTTP totals/durations, send-path outcomes, token operations/cache timings, active local connection counts, connection events, idempotency decisions, process metrics, and dependency health. Structured Pino records include token-audit events and publish/delivery-path events.

Interpret them at their measurement boundaries:

- `apns_notification_delivery_seconds` ends after publication or queue storage, not after device acknowledgement.
- `apns_notifications_sent_total` labels published attempts `delivered`; expired-before-send work is returned/counts as `queued` by the caller.
- `apns_pending_notifications` is declared but never updated. Invalid-device paths decrement the in-flight gauge before throwing and again in the catch path.
- Token timing measures cache access, not the full database lookup. Negative-cache hits are counted even though the caller still queries PostgreSQL.
- HTTP route labels are captured before route matching and fall back to the raw path, causing per-token/per-ID cardinality and disclosure.
- Circuit-breaker and auth/admin audit helpers exist but have no business-path call sites. Health gauges update only when `/health` is requested.

Production metrics should separate acceptance, handoff, authenticated receipt, expiry, supersession, and terminal failure. Track oldest retained work and retry age, not only counts. Aggregate centrally across instances; do not compute fleet p99 from ten recent console rows. Payloads and raw tokens do not belong in high-cardinality labels.

## Failure Handling

| Failure | Proposed response | Local behavior |
|---------|-------------------|----------------|
| Token cache unavailable | Bound fallback load to registry | Cache reads/writes catch errors; token lookup can reach PostgreSQL |
| Routing Valkey unavailable | Retain accepted operation and retry | Direct route lookup/publication throws; no connected breaker/outbox |
| Stale connection owner | Reject generation and resolve again | Publish succeeds without checking subscriber/socket delivery |
| Device disconnects before receipt | Keep work until ack or expiry | Online sends lack pending rows; reconnect deletes rows before ack |
| Provider retries after timeout | Find/resume same scoped operation | Global Redis claim can suppress unfinished work |
| Duplicate acknowledgement | Idempotent terminal transition | Duplicate delivery-log insert can throw after history was updated |
| Concurrent collapse | Replace one complete generation atomically | Separate delete/insert; conflict update omits ID and expiration |
| Process termination | Drain sockets, preserve work, release owned leases | SIGTERM closes listeners and DB/main Redis then exits; no ack drain |

The subscriber connection is not retained for graceful shutdown, and no application heartbeat refreshes device leases. Reconnecting underlying Redis does not replay lost pub/sub messages. A health endpoint that passes database/Valkey probes does not prove transport delivery works.

## Scalability Considerations

Scale acceptance, delivery, and connection fleets independently. Assign a stable owner for each destination's retained-state transitions while allowing device connections to move. Add bounded fan-out workers, outbox relays, and history projections before increasing frontend polling or adding API processes indiscriminately.

The current implementation's first constraints include sequential fan-out requests, full-count history scans, unbounded per-device reconnect reads, one shared connection hash, and unused lists that grow for every offline enqueue. More Express instances multiply cleanup loops and connection pools; they do not provide recovery or correct lease ownership.

A production gateway needs bounded socket buffers and fair batching. Priorities should reserve service for urgent traffic while guaranteeing some progress to ordinary traffic. Strictly draining high priority forever can starve older work; blindly flushing a large offline queue can delay new urgent sends.

Multi-region ownership should have an explicit home region, replication policy, and failover fence. Running two active owners without coordinating retained-state generations produces conflicting collapse and acknowledgement decisions. Local pub/sub routing is only a demonstration of cross-process dispatch.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Acceptance | Durable operation plus recoverable work | Publish-only success | Survive the gap between acceptance and gateway delivery |
| Delivery semantics | Repeatable attempts and explicit receipts | Universal exactly-once promise | Network uncertainty prevents inferring receipt from a timeout |
| Offline work | Bounded retention with scoped collapse | Keep everything indefinitely | Bound memory, storage, and reconnect load |
| Connection routing | Renewable lease and owner generation | Unversioned presence map | Reject stale routing and disconnects |
| Console data | Timestamped aggregate projection | Every raw delivery event in browser | Bound load and preserve meaningful status |
| Fan-out | Durable job with bounded children | Sequential HTTP loop | Resume partial sends and isolate bulk traffic |

## Implementation Notes

### Production patterns actually connected

**Token cache with database fallback.** [shared/cache.ts](./backend/src/shared/cache.ts) reads positive entries for one hour and catches cache failures. [tokenRegistry.ts](./backend/src/services/tokenRegistry.ts) queries PostgreSQL on misses and invalidates cached records on updates. This reduces repeated successful lookups, but does not establish measured hit rates or immediate revocation under races.

```typescript
const cached = await getTokenFromCache(tokenHash);
if (cached) return cached;
```

Negative entries return the same null as a cache miss, so the caller still queries the database. An invalidation racing an older lookup can repopulate stale positive state. Registration is read-then-insert, not an atomic upsert; concurrent first registrations can conflict. Re-registration reactivates a token without changing its bundle or clearing old invalidation metadata. Hashing the original hex string also treats upper/lowercase spellings differently.

**Request and token logging.** [shared/logger.ts](./backend/src/shared/logger.ts) supplies Pino HTTP logging and token audit records. These make local flows inspectable, but audit hooks for login/admin actions are not called and request IDs are not propagated through every lifecycle operation. URLs still need redaction; storing a token hash alone does not cover log exposure.

**Prometheus and health endpoints.** [shared/metrics.ts](./backend/src/shared/metrics.ts) and [index.ts](./backend/src/index.ts) connect middleware and expose `/metrics` and `/health`. Health sequentially probes PostgreSQL and Valkey and returns 200 or 503. No monitoring server or alert rules ship in Compose. The measurement gaps described above prevent treating these metrics as a delivery SLO implementation.

**Best-effort duplicate claim.** The connected Redis claim illustrates single-key atomic reservation:

```typescript
const result = await redis.set(key, "1", "EX", CACHE_TTL.IDEMPOTENCY, "NX");
```

It is called before validation, is not coupled to durable work, and has no recovery state. Its limits belong to the current implementation; the production outbox/idempotency proposal is additional work.

### Actual routing and storage behavior

[db/redis.ts](./backend/src/db/redis.ts) stores all routes in one `device:connections` hash. Every connection sets a **one-hour TTL on the whole hash**. There is no per-device lease refresh. With no new registrations of sockets, even live routes disappear together; steady new connections can keep crashed-device entries alive. The separate five-minute `cache:conn:*` helpers are unused.

[index.ts](./backend/src/index.ts) maps a device ID to one socket. Replacing a connection has no ownership generation, so an old socket closing can delete the replacement's local and Redis route. A single socket can also send multiple connect identities without cleaning all older mappings. There is no heartbeat, device credential check, or acknowledgement ownership check.

[pushService.ts](./backend/src/services/pushService.ts) inserts history, marks the ID processed, and then routes or stores. Online publication returns `delivered` without updating history; history remains `pending` until ack. Subscriber absence, a closed socket, and lack of receipt have no retained fallback. Initial expiry sets history to `expired`, yet the caller reports `queued` because it tests only the delivered flag.

Offline storage deletes an older collapse row separately from inserting its replacement. Under concurrent inserts, the conflict handler changes payload, priority, and creation time but retains the existing ID and expiration. Old history records are not marked superseded. This can associate new content with an old identity/deadline. Appending the device UUID to topic collapse IDs can also exceed the local 100-character column limit.

Reconnect reads every unexpired pending row ordered by priority descending then age, publishes them sequentially, and deletes **all pending rows for the device**. That deletion precedes ack and can remove a concurrently inserted row that was not in the fetched batch. Ack handling updates history, inserts delivery log, then deletes pending in separate statements; a duplicate-log failure can prevent the final delete. The fixture pending IDs have no matching history to update.

The expiry task runs every minute in every API process, marks eligible history rows expired, and deletes expired pending rows. Null expiry is never collected. Redis priority lists are only appended; no code calls the dequeue helper or removes entries on delivery/expiry. Priority affects reconnect sorting, not an active battery-aware scheduler.

Topic sends read all valid subscribers, create separate child notifications sequentially, and return a generated but unpersisted parent ID. Child history does not populate its `topic` field. Broadcast only examines the newest 10,000 registered devices before filtering valid ones. Neither flow is resumable, idempotent as a batch, or accurately described as proof of delivery.

### Validation and feedback limits

The REST helper checks for an object-like `aps` and counts JavaScript string length, not UTF-8 bytes. A payload with 3,000 `é` characters is 3,020 code units but 6,020 bytes and passes that size check. Invalid REST priority values default to 10; the `/3` route bypasses those validators altogether. Local `apns-expiration: 0` is converted to null and can be stored indefinitely. There is no push-type-specific priority validation.

[feedbackService.ts](./backend/src/services/feedbackService.ts) returns at most 1,000 entries after a strict timestamp, without a tie-breaking cursor. If many entries share a timestamp, advancing by timestamp can skip unseen rows. Clearing without a cutoff removes all feedback for the bundle. Reads and deletes have no provider binding. Invalidation, cache deletion, and feedback insertion are separate writes; re-registering a token does not retract old feedback or pending messages.

### Frontend and local substitutions

The React console uses TanStack Router, Zustand for session/dashboard state, and component state for paginated lists and the send form. [services/api.ts](./frontend/src/services/api.ts) centralizes fetch and attaches the localStorage bearer token. There is no TanStack Query, virtualization, chart library, form schema library, SSE, or console WebSocket stream.

The dashboard polls every 30 seconds, can overlap requests, and lacks a last-successful-refresh timestamp. Lists use 20-row offset pages; notification filters reset the page but have no abort or stale-response guard. Dashboard state survives logout because it is a separate store, and in-flight responses are not bound to the current session. API failures do not centrally expire authentication. `checkAuth` treats any failure, including a transient outage, as logout.

The send form disables submit during a request but allows fields/mode/clear to change. Its eventual result can appear beside a different draft. It provides no operation key, uncertain-outcome recovery, expiry/collapse controls, or receipt subscription. Broadcast is a direct submit. Navigation links disappear below the small-screen breakpoint without replacement navigation. Table identifiers are truncated without a detail/copy path.

Compose supplies persistent PostgreSQL and Valkey only. The host runs APIs and Vite; ports 3001–3003 select server IDs for manual multi-process experiments. There is no load balancer, native iOS transport, HTTP/2/TLS provider server, provider JWT/certificate verification, durable message broker, connected circuit breaker, connected rate limiter, sharding, multi-region deployment, or complete delivery-recovery loop.

This document reflects a source review. The [five smoke tests](./tests/smoke.spec.ts) check login/page shells and do not establish delivery, authorization, or failure recovery. No application build, database startup, or browser suite was run for this documentation-only revision.
