# Push notification service — fullstack interview answer

This is a proposed APNs-inspired service and operator console, paced for 45 minutes.
I would use one architecture drawing and three end-to-end deep dives.
The [architecture](./architecture.md) records the current local implementation separately.

## 🎯 Define the experience and contract — 4 minutes

> "I want to follow one notification from an operator's draft through durable
> acceptance, an attempt to reach a device, and the status shown in the console.
> The most important product decision is what each success message means.
> A broker publication, a device receipt, and a person seeing an alert are different events."

I would clarify whether we own the device transport or call an upstream service.
For this exercise, we own the simulated transport and can collect device acknowledgements.
If we integrate with an external push provider, its acceptance is another boundary,
and we must not fabricate receipt evidence it does not supply.

### User journeys

An application developer registers a destination, sends one test, and investigates its status.
An operations engineer checks aggregate health and drills into a scoped set of failures.
A device receives useful updates after reconnecting without an unbounded flood of stale work.

The first release covers those three journeys.
Bulk campaigns, native notification styling, and a complete application inbox are separate.
A push normally asks an app to fetch current authoritative data.

### Requirements

| Area | Requirement |
|------|-------------|
| Sending | Authorize app/environment, validate content, assign stable operation identity |
| Delivery | Attempt online handoff; retain eligible work while offline |
| Lifecycle | Track acceptance, attempts, receipt evidence, expiry, and supersession |
| Console | Compose a test, inspect its state, and navigate bounded history |
| Recovery | Resolve a lost response without accidentally creating another send |
| Isolation | Keep each user's accessible apps, environments, and device data scoped |

I would target p99 acceptance below 100 ms under admitted load,
and p99 handoff below 500 ms for healthy online routes.
The overview can refresh about every 30 seconds if it exposes observation time.
These are proposed targets, not measurements of this repository or Apple's service.

A disconnected device has no bounded receipt latency.
An operator should see retained or unknown, not a spinner that implies delivery is imminent.
This distinction guides both backend state and frontend wording.

## 🏗️ Architecture and scale — 5 minutes

I would draw the whole path with a separate status read side:

```
┌─────────────────┐     ┌────────────────────┐
│ Operator console│────▶│   Authorized API   │◀──── app provider
│ Draft + results │     │  Accept + inspect  │
└────────┬────────┘     └──────────┬─────────┘
         │                         │ durable commit
┌────────▲────────┐     ┌──────────▼─────────┐
│  Status/metrics │◀────│  Operation + work  │
│    Projection   │     │   Retained state   │
└─────────────────┘     └──────────┬─────────┘
                                   ▼
                        ┌────────────────────┐
                        │  Delivery workers  │────▶ connection leases
                        └──────────┬─────────┘
                                   ▼
                        ┌────────────────────┐
                        │ Connection gateway │◀───▶ device transport
                        └────────────────────┘
```

The API handles authorization, validation, acceptance, and read contracts.
Workers handle retries, expiry, and retained work.
Gateways own persistent sockets and report transport evidence.
The console reads a projection and never connects to the internal delivery broker.

### An illustrative workload

Assume 100 million destinations, 10 million concurrent connections,
and one billion notifications per day: approximately 11,600 requests/second on average.
A tenfold burst is a useful first capacity scenario, not a guaranteed peak bound.

At 1 KB per payload, all-day payload retention approaches 1 TB before indexes and replicas.
If 5% of requests wait offline for four hours on average, the backlog is about
8.3 million messages. Expiry and collapse policies therefore matter before fleet sizing.

Browser traffic is much smaller: one thousand open overview tabs polling every
30 seconds create about 33 reads/second. Serving each from an aggregate projection is
very different from rescanning the entire delivery history every time.

I would measure gateway density with realistic buffers, slow clients, and reconnects.
Connection count and delivery rate scale independently; one assumed memory constant
cannot establish the number of machines required.

### Technology starting point

At moderate scale, PostgreSQL can own operations, pending work, and an outbox transaction.
A relay hands work to a durable broker. Valkey can cache token lookups and presence hints.
React with a router and a resource cache provides the console; component state owns drafts.

At larger scale, partition operation/work ownership by destination and separate history
projections. Moving acceptance to a replicated log is a deliberate redesign of identity
and recovery, not simply installing a queue alongside an unchanged write path.

## 💾 Shared data language — 4 minutes

> "I would agree on the status model and identity fields with the frontend and
> backend engineers together. Otherwise the UI will display whatever a response
> happens to call success, even when the service cannot support that interpretation."

### Operation states

| State or observation | Backend evidence | Console wording |
|----------------------|------------------|-----------------|
| Submitting | Request may not have reached service | Sending request |
| Accepted | Operation and recoverable work committed | Accepted by service |
| Retained | Eligible work remains pending | Waiting for a delivery opportunity |
| Gateway handoff | Current gateway took the attempt | Attempted; receipt not confirmed |
| Receipt | Authenticated destination acknowledged | Device receipt confirmed |
| Expired/superseded/rejected | Defined terminal transition | Ended, with reason |
| Unknown outcome | Browser lacks a resolved operation result | Checking the original attempt |

The operation has a stable identity, destination scope, request fingerprint,
creation time, current state, and revision or ordered lifecycle sequence.
The browser does not rewrite it when the user changes a draft.

Registration records bind token lookup to app/environment and a generation.
Connection leases bind a destination to its current gateway ownership.
Pending records bind an operation to a deadline and optional collapse generation.
These identities prevent unrelated operations from being mixed during retries and reconnects.

### Proposed API contract

| Method | Path | Purpose |
|--------|------|---------|
| GET | /console/session | Identity and allowed app/environment scopes |
| POST | /destinations | Register or refresh a destination |
| POST | /notifications | Accept a scoped operation with stable retry identity |
| GET | /notifications/:id | Read status and bounded attempt evidence |
| GET | /console/overview | Aggregate window, counts, and observation time |
| GET | /console/notifications | Scoped, filtered cursor page |

The API returns structured errors: invalid content, revoked destination, forbidden scope,
rate limit, unavailable service, or unresolved outcome.
These categories support different UI actions and different provider retry policies.

I would not put raw tokens or payloads in shareable investigation URLs.
Use operation IDs and nonsecret filters; the API still verifies access on every lookup.
Knowing an internal device UUID is not authorization to send to it.

## 🔧 Deep dive 1: one test across a lost response — 8 minutes

### Decision: give the intended send a durable identity before treating it as accepted

The operator chooses an app/environment and destination, writes content, and submits.
The frontend validates obvious errors and freezes a request snapshot with an operation ID.
The result panel belongs to that snapshot, even if a new draft is edited afterward.

The backend validates the same content and enforces the user's permitted scope.
It records an operation and recoverable work in one transaction.
Only then does the UI receive accepted state and begin observing later delivery evidence.

### Why both sides need the same identity

Suppose the transaction commits and the HTTP response disappears.
The browser sees a timeout, but the service already has work to deliver.
A new operation ID on retry can produce a second notification.
Showing a definitive failure would encourage precisely that retry.

Instead, the UI enters outcome unknown and looks up the original operation.
The backend resolves the same scoped identity to the same immutable request fingerprint.
If the retry carries different content or a different destination, it returns a conflict.

A disabled button stops one kind of double click.
It does not solve response loss, browser navigation, two tabs, or a provider retry.
Those require durable server identity, not only a loading flag.

### Recoverable acceptance

For the first implementation, I would use an operation table and an outbox record
committed together. A relay publishes work after commit and retries on failure.
The accepted operation remains discoverable if the API process dies before publication.

If the relay crashes after publishing but before saving progress, it can publish again.
Workers must recognize repeat operations and make state transitions idempotent.
The relay's message ID alone does not make a device's external effect exactly once.

The response-loss cases are therefore explicit:

1. No commit occurred: the same request can be accepted later.
2. Commit occurred but response was lost: the same operation is returned.
3. Delivery work was already published: recovery does not invent another operation.
4. Device receipt is uncertain: later evidence or a repeat attempt resolves what it can.

### Frontend request lifecycle

The draft remains editable only as a new draft, or the submitted fields stay frozen until
acceptance resolves. I would choose whichever makes the distinction clearest in the product.
A clear/reset action cannot discard the identity of an unresolved attempt silently.

Field errors remain beside the relevant inputs.
A service outage preserves unsent content, while an authorization error prevents further sends.
A new login clears data from the previous scope and cancels its pending view requests.

For sensitive content, retain only the operation ID across navigation once the server owns
the accepted payload. Persisting every draft and raw token in browser storage is unnecessary.
The server can return an authorized, redacted operation detail when the user returns.

### Why not optimistic delivered state?

A notification is an external action with asynchronous evidence.
Updating the UI immediately to delivered makes the page responsive by saying something
we do not know. It can cause an operator to end an investigation too early.

I would insert a local submitting row if useful, clearly labeled.
Accepted, retained, and receipt states advance only on evidence from the authoritative operation.
This keeps the interface responsive while preserving the meaning of status.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Stable operation plus durable lookup | Safe recovery after lost responses | More states and backend storage/recovery work |
| ❌ New send after timeout with optimistic success | Simple happy-path UI | Repeated effects and misleading status |

### What I give up

The UI sometimes has to say it is uncertain.
The backend pays for durable acceptance before responding.
For a debugging console, that cost is justified because uncertainty is exactly what
the operator is trying to understand.

## 🔧 Deep dive 2: an offline device and a truthful result — 8 minutes

### Decision: retain useful work until a defined terminal event

Now suppose the test is accepted while the device is offline.
The service stores eligible work with a deadline and the UI shows retained.
The operator can inspect its expiry policy without assuming that waiting means success.

A connection mapping is only a route hint.
A worker may read gateway A while the device is reconnecting to B.
The gateway checks ownership generation and capacity; a stale route causes retry or retention.

### Lease ownership crosses the user experience

The device's new connection acquires a later ownership generation.
An old disconnect callback removes only the route it still owns.
This stops the old socket from erasing a valid replacement connection.

Why does the frontend care? Because a false online badge can encourage repeated tests
when the real problem is stale routing. I would show connection observation time and
avoid treating a cached presence record as guaranteed reachability.

The console's own polling or streaming connection is a third, separate connection.
Its health says nothing about the target device's transport.
A green console connection indicator must not imply that all devices are online.

### Keep acknowledgement attached to the exact operation

The worker selects a bounded pending batch and sends attempts through the current gateway.
A valid acknowledgement names the logical operation and destination, and the server
verifies that it came from the authorized device transport.

Receipt updates the operation idempotently and removes only that operation's retained work.
A repeated receipt does not create another terminal effect or error that prevents cleanup.
A missing acknowledgement leaves the operation eligible for reconciliation or retry.

Deleting every pending row for a device after a read/send loop is unsafe.
Some rows can arrive after the read and never be sent; others can be sent but never received.
The backend invariant directly determines whether the console's result can be trusted.

### Collapse with an understandable history

Imagine a device waiting for score update A, followed by newer score update B.
If the app declares those updates replaceable, B can supersede A in one atomic transition.
That transition changes payload, operation identity, generation, priority, and deadline together.

The operation page for A should say superseded, with an authorized link to the newer
operation where appropriate. It should not remain queued forever or suddenly display B's payload.
The UI's immutable request snapshot makes this distinction visible.

Collapse does not deduplicate arbitrary retries.
A retry preserves one operation; a new state update intentionally creates a newer generation.
This semantic difference belongs in the API model before it appears in a form label.

### Expiry and queue budgets

Use per-destination/provider count and byte limits, and a maximum retention period.
Check expiry at scheduling and before handoff, with cleanup reclaiming terminal data later.
No-storage requests need their own policy instead of being represented as unlimited retention.

When a device reconnects, use bounded batches and fair scheduling.
Flushing a huge backlog in one loop can delay new urgent traffic and overwhelm slow sockets.
The device should fetch current application state rather than depend on every old push.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bounded retained work with receipt/expiry/supersession | Recoverable delivery and explainable history | More lifecycle transitions and duplicate-attempt handling |
| ❌ Delete after publication and call it delivered | Low state-management cost | Lost work and status that overstates evidence |

### What I give up

The push stream is not a complete ordered record of business events.
Some obsolete or expired updates are intentionally never delivered.
That is acceptable when the application has a durable source of truth and the console
explains why a push ended without receipt.

> "The backend must preserve responsibility until a real terminal event.
> The frontend must preserve the meaning of that event instead of collapsing every
> intermediate stage into a single green sent badge."

## 🔧 Deep dive 3: fresh diagnostics without streaming the entire fleet — 8 minutes

### Decision: bounded read projections with explicit freshness

Operators need a fleet overview and a precise operation detail.
Those are different query shapes and update cadences.
I would maintain aggregate projections for counts and a per-operation record for investigation.

The overview response includes its measurement window, projection observation time,
and any missing or delayed source information.
The browser refreshes a small snapshot periodically while visible.
An actively investigated operation can refresh faster for a limited period.

### Why not push every event into every browser?

At 100,000 delivery events per second, a raw feed quickly exceeds human reading speed.
Sending it to every operator also multiplies fan-out, browser memory, and rendering work.
It can look lively while making a specific failure harder to inspect.

For one thousand tabs polling every 30 seconds, the read rate is only about 33 requests/second.
The important backend optimization is to serve a projection, not perform a full-history
aggregate for each tab. The important frontend optimization is to bound visible data.

### Correct polling behavior

1. Capture the active session, app/environment, filters, and request generation.
2. Fetch the matching snapshot or operation resource.
3. Schedule the next refresh after the request settles, with backoff on outages.
4. Ignore any response whose context has been replaced.
5. Preserve the last successful data and its observation time on failure.
6. Stop or reduce activity when the view is hidden or no longer being inspected.

Cancellation helps, but an in-flight response can still race it.
A scope/generation check is the final guard against replacing a new view with old data.
For operation status, a revision prevents a stale retained response from overwriting receipt.

The browser should not merge counters from different windows into one apparent snapshot.
Likewise, frontend wall-clock receipt time is not the projection's observation time.
Those two timestamps answer different questions during an incident.

### Moving history and shareable investigations

Use server filters and cursor pages with a stable sort key and tie-breaker.
The URL can carry app/environment, status, time range, and a selected operation ID.
A colleague opening the link gets the same investigation context after authorization.

New activity should appear as an available refresh rather than shifting rows under a
focused operator. A failed query is not an empty query result.
Full identifiers and payload details belong in an authorized detail view, with copy controls.

For short pages, native table semantics are enough.
If continuous long lists become necessary, add virtualization over paginated data;
virtualization alone does not bound the response size or backend query cost.

### When streaming becomes worthwhile

If the product needs subsecond status updates, I would add a scoped event channel
with ordered revisions or resume cursors and snapshot reconciliation.
SSE may fit one-way status updates; commands can remain ordinary HTTP requests.

A reconnect cannot silently resume from "now" and claim no changes were missed.
The server must replay within a supported window or tell the browser to fetch a fresh snapshot.
Duplicate events must not duplicate rows or reverse lifecycle state.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Timestamped projections and bounded polling | Clear recovery, manageable load, stable investigations | Some change-detection latency |
| ❌ Unbounded raw event feed | Immediate event arrival | Gaps, browser overload, unstable navigation |

### What I give up

The overview is not an instant alarm system.
Independent monitoring detects and pages on incidents; the console helps explain them.
I would add streaming only when the user benefit justifies its recovery and ordering costs.

## 🧪 Security, failure handling, and validation — 5 minutes

### Enforce scope on both reads and writes

The browser selects an app/environment from its permitted set.
The server derives identity from the session or provider credential and rechecks every
operation, destination, feedback, and bulk request against that scope.

Device sockets prove their destination identity before receiving payloads.
Acknowledgements cannot name arbitrary other operations.
Raw token hashing reduces exposure in storage, but it does not substitute for these checks.

For the console, prefer a protected session design with deliberate CSRF/XSS defenses.
Do not grant access based on a role label displayed in the navbar.
Logging and metrics must redact raw addressing material and payload content.

### Bulk actions need a different contract

If broadcast enters scope, I would show an audience definition and eligible-count snapshot
before creating a durable job. Bounded workers create stable child identities and report progress.
A parent count distinguishes accepted children from known receipts and terminal failures.

A sequential HTTP loop cannot reliably explain partial progress after a timeout.
It also competes with individual tests and can overrun the request timeout.
The console should inspect a job resource rather than repeat the entire broadcast blindly.

### Scenarios I would test together

- Accept a test but drop the HTTP response; the UI resolves the same operation without another send.
- Disconnect after publication but before receipt; retained work and visible status remain truthful.
- Supersede an offline update while it is being attempted; payload, identity, and deadline stay consistent.
- Reconnect before the old socket closes; cleanup cannot erase the new owner.
- Change filters or users with an old request in flight; previous data cannot replace the new view.
- Lose the read projection temporarily; last-known data remains labeled stale.

I would also test payload byte limits with non-ASCII text, keyboard-only form use,
narrow-screen navigation, duplicate acknowledgements, and storage quotas.
A page-load test alone does not establish any of these cross-layer invariants.

### Where the local repository fits

The local system has an Express/WebSocket process, PostgreSQL, Valkey, and a React console.
It demonstrates registration, pending records, cross-process publication, and polling views.
It has no durable outbox, generation-based routing, authenticated device transport,
or complete operation recovery. Most APIs do not enforce the console session.

Its immediate send result treats publication as delivered; reconnect deletes pending
records before receipt. The console polls overview data every 30 seconds and uses
20-row offset lists without the version/context guards proposed above.
Those limitations should remain explicit until the implementation changes.

## ⚖️ Trade-offs and close — 3 minutes

| Decision | Chosen | Alternative | Main cost |
|----------|--------|-------------|-----------|
| Test workflow | ✅ Stable accepted operation and recovery lookup | ❌ New send after every timeout | Durable identity and uncertain UI states |
| Offline delivery | ✅ Bounded work with terminal evidence | ❌ Publication treated as receipt | More lifecycle/retry coordination |
| Diagnostics | ✅ Timestamped projections and bounded views | ❌ Every raw event in the browser | Some display latency |

> "I would build this around one shared language for an operation. The frontend
> preserves what the operator intended, the backend preserves responsibility after
> acceptance, and the read model shows only the evidence we have. That gives us a
> system that remains understandable when responses are lost, devices reconnect,
> and the fleet is too large to inspect event by event."
