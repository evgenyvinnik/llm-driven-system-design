# Push notification service — backend interview answer

This is a 45-minute proposal for an APNs-inspired push service.
It describes my design choices, not Apple's private implementation or measured traffic.
The [architecture](./architecture.md) separates this proposal from the local simulator.

I would draw one architecture and spend most of the discussion on three failure boundaries:
acceptance, offline retention, and ownership of a live connection.

## 🎯 Scope and guarantees — 4 minutes

> "I will design a service that accepts notifications from authorized application
> servers and attempts delivery to registered devices. The difficult part is not
> writing bytes to a socket. It is deciding what we can promise when the device is
> offline, a gateway crashes, or a provider retries after losing a response."

I would first clarify whether we own the device transport or are building a provider
that calls Apple's service. Here I assume we own a simulated device transport.
A provider integration has a different boundary: an upstream acceptance response is
not proof that the native device displayed anything.

### Functional requirements

- Register an application destination and revoke or replace its token.
- Authenticate a provider and authorize its app/environment scope.
- Accept a payload, logical request identity, expiry policy, and delivery class.
- Route promptly to a reachable device or retain eligible work while offline.
- Replace obsolete updates within an explicitly defined collapse group.
- Expose status and bounded operator diagnostics.

I would leave general marketing campaigns and a durable user inbox outside the core.
A push is a hint to refresh application state; the application's authoritative history
should survive independently of whether a notification is delivered.

### Define successful outcomes

| Observation | Meaning |
|-------------|---------|
| Accepted | The service committed responsibility for the operation |
| Attempted | A gateway tried to send the payload |
| Receipt confirmed | An authenticated device transport acknowledged it |
| Application handled | Separate optional evidence from app logic |
| Expired or superseded | No further attempt is required under the policy |

We can offer an acceptance availability target of 99.99% within admitted quotas.
For healthy online routes, I would target p99 gateway handoff below 500 ms.
I would not include a sleeping or disconnected device in that latency guarantee.

The service may attempt the same logical notification more than once.
If the application requires duplicate suppression, the logical identity must survive
retries through the device handler. Network receipt is not a business transaction.

## 📐 Capacity and access patterns — 4 minutes

I would use round assumptions to identify the first bottlenecks:
100 million registered destinations, 10 million concurrent connections,
and one billion notification requests per day.

That is about 11,600 requests per second on average.
A tenfold peak gives a first design point near 116,000 requests per second.
I would revise those assumptions with the interviewer before selecting fleet size.

### Approximate resource implications

| Quantity | Estimate | What it tells me |
|----------|----------|------------------|
| Average payload | 1 KB assumed | Roughly 12 MB/s average ingress before overhead |
| Tenfold burst | About 116 MB/s of payload | Admission and queue buffering matter |
| All payloads retained for a day | About 1 TB before replication/indexes | History retention needs a policy |
| 5% retained for four hours on average | About 8.3 million pending records | Even a small offline share needs bounded storage |
| Ten million live connections | Density must be measured | Socket count and message throughput scale separately |

I would not turn an assumed memory-per-connection constant into a precise node count.
TLS state, buffers, runtime overhead, and kernel settings all affect the result.
Load tests should include slow clients and reconnect bursts, not just idle sockets.

### Important access patterns

The hot lookup starts with an app/environment scope and provider-supplied token.
It needs to find the destination's home shard and current registration generation.
The delivery path then needs a routing hint for that destination.

Offline retrieval is by destination, with a bounded batch ordered by policy.
Collapse updates address one destination and group.
Status lookup addresses one operation; operator history is a separate paginated projection.

These patterns argue against putting raw delivery events and console scans on one
unpartitioned table indefinitely. They do not require every component to become a
microservice before the first reliable end-to-end flow works.

## 🏗️ High-level architecture — 5 minutes

```
┌──────────────┐     ┌─────────────────────┐
│ App provider │────▶│  Auth + acceptance  │
└──────────────┘     └──────────┬──────────┘
                                │ durable commit
                     ┌──────────▼──────────┐
                     │   Operation + work  │
                     │    Token registry   │
                     └──────────┬──────────┘
                                ▼
                     ┌─────────────────────┐
                     │   Delivery workers  │────▶ status projection
                     │ Retention + retries │
                     └──────────┬──────────┘
                                │ route lookup
                     ┌──────────▼──────────┐     ┌──────────────────┐
                     │ Connection gateways │◀───▶│ Presence leases  │
                     └──────────┬──────────┘     └──────────────────┘
                                ▼
                     ┌─────────────────────┐
                     │   Device transport  │
                     └─────────────────────┘
```

### Responsibilities

Acceptance servers authenticate, validate, enforce quotas, and commit operations.
They do not need to hold a socket for every device.
Connection gateways own the sockets and report whether they can accept an attempt.

Delivery workers own scheduling, expiry, and retained work.
A durable queue/log decouples accepted traffic from temporary connection failures.
The status projection is allowed to lag and exposes when it was last updated.

At moderate scale, I would start with PostgreSQL for operation and outbox transactions,
Valkey for cached lookups and presence hints, and a durable broker for delivery work.
A relay publishes the outbox and records its progress.

At the illustrated production scale, I would shard by destination ownership and
consider a replicated log as the acceptance authority. That changes the ownership and
deduplication design; adding Kafka beside the existing database is not sufficient.

### Basic request flow

1. Authenticate the provider and validate destination scope and request limits.
2. Resolve the token to an internal destination and registration generation.
3. Commit a scoped operation and recoverable work.
4. Return acceptance with an operation identity.
5. A worker resolves the current gateway and attempts delivery.
6. Retain or complete the work according to receipt, supersession, and expiry.

A gateway route is a hint, not evidence of receipt.
This is the central distinction I will use in the first deep dive.

## 💾 Data model and API — 4 minutes

I would describe records on the whiteboard rather than write SQL.
The key is which records must change atomically and who owns them.

| Record | Key fields | Required invariant |
|--------|------------|--------------------|
| Destination | Scope, token lookup hash, internal ID, generation, validity | A request cannot cross app/environment ownership |
| Operation | Scoped request ID, destination, fingerprint, state, deadline | One identity refers to one intended notification |
| Work/outbox | Operation ID, scheduling state, publication progress | Accepted retained work has a recovery path |
| Pending group | Destination, collapse group, current operation/generation | Replacement changes identity and content together |
| Connection lease | Destination, gateway, owner generation, expiry | An old owner cannot erase or impersonate a new owner |
| Attempt/receipt | Operation, attempt ID, observed stage, timestamp | Repeated receipt handling does not repeat the effect |

The token lookup hash is useful for equality lookup and reducing raw-token exposure.
It does not replace authentication. An authorized provider still controls access only
to its permitted app/environment, regardless of whether it knows another token or UUID.

Token registration must have a defined relationship to revocation.
A stale cache read should not permanently reactivate a revoked generation.
I would bound cache lifetime and enforce generation checks where stale delivery matters.

### Proposed endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /destinations | Register or refresh a scoped destination |
| DELETE | /destinations/:id | Revoke a destination generation |
| POST | /notifications | Accept one identified operation |
| GET | /notifications/:id | Return authorized operation status |
| POST | /bulk-jobs | Optional durable fan-out request |
| GET | /bulk-jobs/:id | Observe bounded job progress |

The request includes a stable identity, target, payload, deadline/no-storage policy,
and delivery class. A repeated identity with different content is rejected.
Responses separate validation/revocation errors from overload and uncertain outcomes.

The administrative API uses the same scope enforcement as provider APIs.
A login page or a bearer token attached by the browser does not protect an endpoint
unless the server actually checks that identity and its permissions.

## 🔧 Deep dive 1: acceptance that survives a crash — 8 minutes

### Decision: commit recoverable work before reporting acceptance

Consider a provider request arriving while the device appears online.
It is tempting to publish to the gateway channel immediately and return success.
That is fast, but the gateway may already have crashed or may lose the socket before sending.

Even a successful publish only establishes that the broker accepted the publication.
With ephemeral pub/sub, there may be no subscriber and no replayable message.
Persisting Redis data does not turn transient pub/sub into durable work delivery.

For retained notifications, I would commit the operation and its outbox record together.
That transaction is the acceptance boundary. A relay retries publication independently
of whether the provider connection remains open.

### Walk through the crash windows

**Crash before commit:** the provider has no accepted operation and can retry the same identity.

**Crash after commit but before response:** the retry finds the committed operation
and returns its state. It does not create a second logical notification.

**Crash after commit but before publication:** the outbox relay resumes and publishes.

**Crash after publication but before relay progress is saved:** the relay may publish again.
The worker recognizes the same logical operation and applies repeatable state transitions.

**Gateway sends but acknowledgement is lost:** a later attempt may repeat the notification.
The device must recognize the logical ID if duplicate display or effect is unacceptable.

This is durable at-least-once attempt processing with application-level deduplication
where needed. It is not a claim of exactly-once receipt over an unreliable network.

### Idempotency must bind to the request

The key is scoped by provider, application, and environment.
Store a fingerprint of the destination, payload, expiry policy, and relevant options.
If a client reuses the key with different input, return a conflict instead of silently
returning some other device's operation status.

A reservation record needs states such as accepted, processing, and terminal outcome,
with a recovery owner. A boolean cache marker cannot tell whether the first request
failed validation, committed work, or died halfway through processing.

The retention period for operation identity must cover the supported retry horizon.
After the detailed payload is removed, a compact terminal record may remain for deduplication.
The API should make that lifetime explicit rather than imply permanent protection.

### Why not Redis-only deduplication?

A single-key claim is cheap and can absorb repeated traffic.
But a claim written before durable acceptance can strand an operation after a crash.
If the claim disappears, the database still needs to recognize an already accepted request.

I would treat Redis as an optimization over the durable operation record.
If the cache is down, the authority still resolves identity; a cache failure should
not authorize a second external effect or pretend an unknown operation succeeded.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable operation with outbox/recoverable work | Explicit crash recovery and stable retry identity | Commit latency, relay ownership, duplicate attempt handling |
| ❌ Publish first with a cache marker | Short happy path | Lost work and stranded claims across failures |

### What I give up

Every accepted retained request pays a durable-write cost.
Operationally, I must monitor outbox age, retry attempts, and stuck operations.
For a notification that explicitly requests no retention, a simpler best-effort path
may be acceptable, but its response and recovery policy must say so.

> "I would optimize the path only after deciding what accepted means.
> Otherwise we make the benchmark faster by quietly weakening the contract."

## 🔧 Deep dive 2: offline storage, collapse, and expiry — 8 minutes

### Decision: retain bounded useful work, not an unlimited event inbox

A phone may be disconnected for days.
Sending every obsolete score, badge, or synchronization hint when it reconnects wastes
bandwidth and battery and delays the latest information.

I would require a deadline and enforce maximum retained count/bytes per destination
and provider. A collapse group declares that a newer state update can replace an older one.
Distinct business events remain distinct and live durably in the application's history.

### Atomic replacement

Suppose a weather update A is pending with a ten-minute expiry.
A newer update B arrives with another payload and deadline.
Replacing only the payload while preserving A's operation ID or deadline mixes two
logical notifications and makes later acknowledgement ambiguous.

The replacement changes the current operation, generation, payload, priority, and expiry
in one authoritative transition. It marks A superseded in the operation history.
A worker holding an older generation must recheck before handoff.

The collapse namespace includes the destination and app scope.
A collapse identifier is a semantic group, not a universal deduplication key.
Reusing it intentionally discards an older update; retrying an operation should instead
reuse that operation's identity without creating a new generation.

### Reconnection and acknowledgement

1. Verify the reconnecting destination and establish its new connection ownership.
2. Read a bounded batch of eligible pending generations.
3. Recheck expiry and supersession before handing each item to the gateway.
4. Record attempts without deleting retained responsibility.
5. On a valid receipt, complete that exact operation/generation idempotently.
6. Remove only the work that has reached a terminal state.

Deleting every pending row for the device after a batch is unsafe.
New work can arrive during the read/send interval and be deleted without being sent.
A lost acknowledgement also requires retaining enough state to retry or reconcile.

### Expiry is a scheduling rule

A periodic cleanup job reclaims expired storage.
It cannot be the only expiry check, because an item may expire between cleanup runs
or while waiting in a gateway buffer.

I would check the deadline before scheduling and before handoff.
A bounded retry budget stops once there is no useful delivery window left.
An explicit no-storage request is distinct from an unspecified or unlimited deadline.

For truly time-sensitive actions, the application must validate current state when it
handles the notification. A transport expiry alone cannot make a stale business action safe
if the device processes an already received payload later.

### Scheduling under load

Use separate service budgets for urgent and ordinary classes, with fairness within each.
Do not drain one large device backlog in an unbounded loop on the gateway event loop.
Batch and yield so new online traffic remains responsive.

Strict priority is simple, but a continuous urgent stream can starve ordinary work.
Weighted fairness and age-based promotion can provide bounded progress, with quotas to
prevent every provider from labeling all traffic urgent.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bounded retention and atomic semantic collapse | Fresh useful state and controlled reconnect load | Intentional loss of obsolete updates and more lifecycle states |
| ❌ Store every push until acknowledged | Appears simple to explain | Unbounded backlog and stale-message floods |

### What I give up

This push service is not a complete ordered inbox.
Applications need their own durable event store and reconciliation endpoint.
That separation lets push delivery remain efficient while business correctness survives
disconnection, collapse, and expiration.

## 🔧 Deep dive 3: routing to a moving connection owner — 7 minutes

### Decision: use renewable leases with ownership generations

Persistent device connections belong to particular gateway processes.
An API server receiving a notification may run elsewhere, so it needs a routing hint.
I would store destination, gateway, ownership generation, and lease expiry.

The gateway renews ownership while the authenticated connection remains healthy.
A new connection acquires a later generation. Disconnect cleanup removes the mapping
only if it still owns that generation.

### Why a generation matters

Imagine a device reconnects to gateway B while its old socket on A is still closing.
If A blindly deletes the destination's presence entry, it removes B's valid route.
If a delayed send targets A, A must not act as if it is still the current owner.

Conditional cleanup and a generation check make both cases explicit.
A stale route gets a retryable ownership response; the worker resolves again.
The notification remains recoverable while this routing correction happens.

### Why a whole-hash TTL fails

One TTL for all destinations does not represent individual liveness.
A new connection can extend the life of entries for crashed gateways.
If no new connection arrives, a shared TTL can remove routes for devices that are still online.

Per-destination or carefully batched gateway leases tie expiration to actual ownership.
The lease duration balances heartbeat overhead against how long stale routing persists.
A missed heartbeat is evidence of uncertainty, not proof the device disappeared forever.

### Backpressure and gateway draining

A live socket can still be too slow to accept more data.
Bound buffered bytes per connection and requests per gateway.
When the gateway cannot take an attempt, keep or reschedule the durable work instead of
queuing an unlimited amount in process memory.

For deployment, stop assigning new connections, drain active attempts for a bounded
period, and let remaining devices reconnect with jitter.
The new owner does not inherit arbitrary in-memory state as an authority.

A fleet restart can create a reconnect storm much larger than ordinary connection churn.
Admission limits, randomized retries, and staggered draining protect the registry,
lease store, and pending-message reader together.

### Why not synchronously coordinate every send globally?

A globally consistent lookup for every notification can provide stronger ownership reads,
but adds latency and a dependency to the hottest path.
It still does not prove the device received a byte after the read.

I would use leases and destination-local fencing for ownership, with durable delivery
state providing recovery. Cross-region failover needs a home-region ownership policy
and a fence against competing active owners; it cannot be inferred from DNS alone.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Renewable ownership lease and generation | Fast routing with safe handoff/cleanup | Heartbeat load and short retry windows |
| ❌ Unversioned global presence map | Easy happy-path lookup | Stale owners, destructive disconnect races, false liveness |

### What I give up

Some sends take an extra lookup and retry during handoff.
That delay is preferable to dropping accepted work because a route looked current once.
I would measure reroute frequency and lease-expiry age to tune the trade-off.

## 🧪 Failure handling and evidence — 3 minutes

I would validate the guarantees at the failure boundaries, with real state transitions.
The highest-value scenarios include:

- Crash immediately after acceptance but before publication; the relay must recover work.
- Repeat a request after response loss; identity and destination must remain unchanged.
- Acknowledge twice; terminal state and cleanup must remain stable.
- Replace a collapse group while an older generation is in flight; no mixed identity/payload.
- Reconnect during an old disconnect callback; the new route must survive.
- Expire a queued operation during an outage; recovery must not replay it as fresh work.

Metrics distinguish accepted operations, gateway attempts, receipts, expiry, and supersession.
I would monitor oldest retained work, outbox age, gateway buffer pressure, and per-tenant
rejection rates. A publish latency histogram cannot stand in for device receipt latency.

Sensitive identifiers and payloads stay out of metric labels.
The console reads a timestamped projection rather than each worker's local counters.
A health check verifies dependencies; targeted synthetic devices verify the actual path.

The local repository demonstrates hashed token lookup, PostgreSQL history, Valkey routing,
WebSocket clients, and polling administration. It lacks durable acceptance recovery,
authenticated delivery, generation leases, and an active priority worker.
Those are design gaps to explain honestly, not guarantees established by its page smoke tests.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen | Alternative | Cost I accept |
|----------|--------|-------------|---------------|
| Acceptance | ✅ Durable operation and recoverable work | ❌ Publish-only success | Storage latency and recovery machinery |
| Offline behavior | ✅ Bounded retention and semantic collapse | ❌ Unlimited push inbox | Obsolete updates intentionally disappear |
| Connection ownership | ✅ Lease with generation | ❌ Bare presence mapping | Heartbeats and rerouting on handoff |

> "The design keeps three things separate: durable acceptance, a best-known route,
> and evidence of receipt. Retained work survives route failures, collapse keeps
> reconnect traffic useful, and ownership generations stop stale connections from
> corrupting routing. Those are the guarantees I would establish before scaling
> the system to the illustrative traffic numbers."
