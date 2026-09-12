# 🔗 Design a URL shortener: fullstack interview

> “I would follow one link from the owner's form to a visitor's redirect and then back
> to the owner's activity report. Each step needs a clear meaning of success: a
> committed mapping, an allowed redirect, and a report with known coverage.”

This is a proposed design for a 45-minute interview, not a reconstruction of Bitly's
private system. The repository implements a smaller teaching application. Its actual
behavior and gaps are documented in
[architecture.md](./architecture.md#implementation-notes).

| Time | Discussion |
|------|------------|
| 5 minutes | Product scope, scale, and promises |
| 5 minutes | Architecture and browser/server contracts |
| 9 minutes | Deep dive: one creation result across failures |
| 7 minutes | Deep dive: expiration and deactivation end to end |
| 8 minutes | Deep dive: from redirect observation to useful report |
| 7 minutes | Account state, performance, and failure isolation |
| 4 minutes | Verification and evolution |

## 🎯 Product scope, scale, and promises — 5 minutes

The owner pastes a destination URL, optionally chooses a custom alias and expiration,
and receives a short link to share. The owner can later list and deactivate links or
inspect their activity. An administrator can handle abuse and inspect system health.

A recipient should open the short link without signing in or loading the dashboard.
The backend sends the redirect, and the browser navigates to the destination. I would
keep that path independently available when management or reporting is degraded.

Anonymous creation can be supported, but ownership must be explicit. An anonymous link
does not automatically become part of whichever account later signs in on the same
browser. A future claim feature would need a separate proof-of-ownership contract.

I would leave target editing, custom domains, QR-code generation, billing, and
estimated unique people outside the first version. Basic request counts are enough to
expose the main analytics problem without pretending to solve attribution.

Assume 50 million creations and five billion redirect requests per day. The averages
are roughly 580 and 58,000 per second; representative peaks might reach 5,000 and
200,000. I would call these planning assumptions, not claim that the local demo has
been measured at that scale.

Redirects get a proposed regional p99 budget below 50 ms and 99.99% availability.
Creation can take several hundred milliseconds. Reports can normally lag by a minute,
provided the interface makes freshness and known collection gaps visible.

Seven base62 characters offer about 3.52 trillion possible codes, around 193 years of
allocations at the assumed creation rate. That arithmetic does not eliminate random
collisions. It tells me that keeping retired codes reserved is practical relative to
the risk of sending an old bookmark to a new owner.

The product also needs an explicit deactivation promise. I would propose a five-second
bound for normal propagation, with stronger enforcement tracking for emergency
administrative takedowns. The UI cannot truthfully promise immediate global removal if
the backend only updates one database row.

> “I would agree on those promises before choosing a cache TTL or writing a success
> toast. They determine what both sides of the application have to implement.”

## 🏗️ Architecture and browser/server contracts — 5 minutes

I would use one diagram to keep the discussion connected:

```
┌────────────────┐       ┌────────────────┐
│ Owner UI       │──────▶│ Management API │──────▶ Mapping store
│ Form + reports │◀──────│ and reports    │
└────────────────┘       └───────▲────────┘
                                 │ summaries
                         ┌────────────────┐
                         │ Analytics      │
                         │ workers/store  │
                         └───────▲────────┘
                                 │ retained observations
┌────────────────┐       ┌────────────────┐
│ Visitor        │──────▶│ Resolver/cache │──────▶ Destination
└────────────────┘       └────────────────┘
```

The management API validates and commits link ownership. The resolver reads an
eligible cached mapping or asks the authoritative store. A retained event pipeline
feeds report projections. These are logical responsibilities; the first deployment can
share application code while keeping their capacity budgets distinct.

PostgreSQL is a reasonable initial mapping authority because code uniqueness, account
ownership, and creation receipts fit transactions. At the planned sustained scale,
partitioning becomes necessary, but I would first establish the write and recovery
contract on one authority.

The browser uses React for the form, history, and report view. Local component state
owns draft inputs, open panels, and focus. Account-scoped server data uses a query
layer keyed by resource and filters. Persistent operation references are separate from
both.

| Contract | Information the caller needs |
|----------|-------------------------------|
| Create link | Operation identity, submitted destination, optional alias/expiry, confirmed result |
| Link record | Code, owner-visible target, status, expiration, revision, creation time |
| Link list | Stable cursor, explicit lifecycle fields, account scope |
| Deactivation | Accepted revision and enforcement status or documented propagation bound |
| Analytics report | Code, time range, timezone, metric definition, buckets, freshness, gaps |

The checked-in APIs use `/api/v1/urls` for management and
`/api/v1/analytics/:shortCode` for reports. I would retain that resource shape while
extending the response contracts. Operation recovery and propagation status are
proposed additions, not existing endpoints disguised as documentation.

A redirect remains a direct request to the short-link service. The dashboard bundle is
not involved. Serving static assets through a CDN therefore does not automatically
mean caching redirect responses through that CDN; those are separate decisions.

I would make error categories part of the contract: invalid input, alias conflict,
unauthenticated access, unavailable dependency, and unknown operation outcome. A
generic failure message cannot tell the browser whether it should correct input or
recover a possibly committed link.

## 🔧 Deep dive: one creation result across failures — 9 minutes

Start with a concrete failure: the server commits a new link, then the owner's network
drops before the response arrives. The owner presses retry. A naïve second POST can
allocate another code, leaving the same campaign split across two links and two
reports.

I would bind a submitted draft to a stable creation operation. The browser records the
destination, alias, expiration, and operation identity as one snapshot. A transport
retry reuses that snapshot. A deliberate edit is a new attempt rather than a mutation
of a request that may already have committed.

The API scopes the operation to the caller and binds it to a digest of the inputs. Its
transaction claims the short code, writes the mapping, and records the resulting code
in a durable receipt. A repeated request with the same identity returns that result;
different contents under that identity are rejected.

An anonymous caller needs an unguessable, narrowly scoped way to recover its own
attempt. I would not expose a public operation lookup that reveals other people's
destinations. A signed-in caller's receipt is authorized through its account.

The frontend shows a pending card containing the submitted destination while the
server works. It should not invent a short URL and label it ready. A custom alias can
still lose a concurrent ownership race, and a generated candidate is not usable until
the authoritative transaction commits.

I would preserve the user's newer draft if they keep typing while submission is
pending. One option is to temporarily lock the fields; another is to separate the
draft from the submitted snapshot. What matters is that an old successful response
cannot clear unrelated new input.

After a timeout, the page shows that it is checking the result. It retries or queries
the original operation rather than creating a fresh one. If the service is still
unavailable, it preserves enough context for later recovery and avoids claiming that
the server definitely failed.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ One durable operation and confirmed result | Predictable recovery after response loss | Receipt storage and a few additional UI states |
| ❌ Retry with a new request identity | Simple POST handling | Duplicate links and fragmented analytics |
| ❌ Treat a local pending code as published | Instant-looking completion | Users may share an unowned or nonexistent alias |

The browser's disabled submit button is still useful, but it solves accidental
repeated interaction within one mounted component. It cannot coordinate another tab, a
reload, or a response lost after commit. The durable server receipt is the correctness
mechanism.

For generated codes, I would begin with a cryptographic random candidate and a bounded
retry on the namespace's unique constraint. At this creation rate, that is a sensible
baseline to benchmark. Randomness reduces predictable ordering, but public short codes
still are not secrets.

The local project explores a preallocated pool. That can amortize reservations and
provide local headroom, but it adds refill and abandoned-allocation handling. A
crashed holder's keys cannot safely be reclaimed just because a timer expired if that
holder can later resume and publish them.

Custom aliases use the same namespace as generated codes. Availability hints can
improve the form but do not reserve a name. If two owners submit the same alias, the
final unique claim chooses one winner and returns a conflict to the other.

Both browser and server must agree on allowed characters and length. The database
constraint is not a substitute for a useful form message. Conversely, a correct form
is not enough when callers can use the API directly.

For expiration, the form can accept days, while the API returns the actual deadline.
The confirmed result displays that deadline and the exact destination. I would avoid
normalizing away URL query information that might be meaningful to the destination.

Copy is an independent success state. The user might have created a valid link but
denied clipboard access. Keep the short URL selectable and report copy failure
directly, instead of leaving the person to infer success from a button click.

> “This design accepts a little more persistence and UI state because creation has a
> durable effect. It makes the difficult failure case understandable without making
> the normal form complicated.”

## 🔧 Deep dive: expiration and deactivation end to end — 7 minutes

Now the owner deactivates a link that has become popular. The database update
succeeds, the dashboard removes the row, and the user assumes sharing has stopped. But
a resolver still has yesterday's target string in cache and keeps redirecting
visitors.

I would fix the product contract at both ends. In the UI, deactivation is a lifecycle
transition with pending and accepted states, not the disappearance of history. In the
resolver, the cached record includes status, expiration, revision, and a fixed
freshness deadline.

Expiration is checked on every hit. The cached record cannot extend the link's own
lifetime. A link created with a deadline five minutes away must not remain usable for
a day just because the mapping cache has a one-day default TTL.

For deactivation, the management transaction commits a newer revision and an outbox
record. Propagation workers distribute the change. Normal serving decisions are
bounded by the proposed five-second freshness policy, even if the notification is
delayed.

There is a subtle race: a lookup starts before deactivation, pauses, then writes its
old result into the cache after the invalidation. Deleting a key once does not prevent
that refill. Cache writes need revision checks against newer state or tombstones.

An old authoritative read also carries its original freshness deadline. It must not
receive a new lifetime merely because its response arrived late. This bounds stale
decisions when invalidation has not yet been observed, with a margin for clock
uncertainty.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Cache complete lifecycle records with a bound | Fast redirects with a clear stale-data policy | Revision propagation and careful refill handling |
| ❌ Cache a destination string for a fixed day | Minimal lookup logic | Expiration and deactivation can be bypassed |
| ❌ Always query the database | Simpler immediate status decisions | Popular links and database outages dominate navigation |

The mutation response tells the UI what has actually happened. It can state that
deactivation was accepted and is propagating, then confirm enforcement where the
product exposes that distinction. An emergency takedown should show regions that have
not yet enforced it rather than a misleading universal success.

If a serving region is partitioned, stronger takedown guarantees require it to stop
serving once its control state is too old or be withdrawn from traffic. Continuing
indefinitely with stale data is a different availability choice, not immediate
revocation.

I would use a 302 with an explicit HTTP policy for mutable links. The proposal sends
`no-store` to compliant browser and shared caches while using an internal cache whose
lifecycle we control. The HTTP directive is defined in [RFC
9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5).

Back in the dashboard, an older list response must not restore the active badge after
deactivation. Query invalidation and resource revisions prevent that. Selection is
keyed by code, so a reorder does not silently switch an open report to another link.

I would retain deactivated rows in history with a clear status and filter. Reusing the
code or hiding all evidence of the old link would create a different product behavior.
The current demo's soft-delete action and status-free owner response illustrate why
naming and data shape need to agree.

## 🔧 Deep dive: from redirect observation to useful report — 8 minutes

A visitor opens the short URL. The resolver decides it is eligible and sends the
redirect. What can we now promise to show the owner? At most, we have observed a
request; we have not proved that the visitor was human or that the destination loaded.

I would name the primary metric accordingly. Preview bots, repeated requests, and
client retries need a stated inclusion policy. “Unique people” would require a
separate approach, additional privacy decisions, and an explanation of uncertainty.

Assign an event ID at the observation boundary and retain it before claiming durable
admission. Retrying publication keeps the same ID. Scheduling work after sending the
response is fast, but a process crash before retention creates a permanent collection
gap.

For this product, I would favor redirect availability during an admission outage and
disclose reduced analytics coverage. If every successful redirect had to retain an
event, the resolver would need to wait for durable acknowledgement and fail or use
another durable path when that acknowledgement was unavailable.

A broker acknowledgement and a worker acknowledgement concern different stages.
Neither makes a separate database counter update duplicate-safe. [RabbitMQ's
acknowledgement guide](https://www.rabbitmq.com/docs/confirms) distinguishes
publication confirmation from consumer completion.

A worker can commit an event's effect and crash before acknowledging it. The event
will be delivered again. I would make duplicate detection and aggregate contribution
atomic, so replay of the same retained identity does not increase the report twice.

This is not the same as suppressing two genuine HTTP requests from one browser. The
first problem is repeated processing of one observation; the second is how the product
defines its audience metric. Keeping those separate prevents an attractive but false
exactly-once claim.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Delayed aggregates with coverage metadata | Scalable reports with understandable freshness | Event identity, replay rules, and visible lag |
| ❌ Update one mapping counter for every click | Simple first implementation | Hot-row contention and partial-write inconsistencies |
| ❌ Stream every click into a client counter | Appears live | Reconnect gaps, duplicate handling, and browser overload |

At the assumed five billion requests per day, 200 bytes per raw event means about 1 TB
daily before indexes and replicas. I would use time-partitioned analytics storage,
bounded detailed retention, and compact projections for common report ranges.

A viral link should not force all workers to serialize updates to its mapping row.
Separate bucketed analytics from link ownership. A report API reads those projections
and returns the processed-through watermark, metric definition, requested range, and
any known admission gaps.

The browser stores that response under its full query identity: account, code, range,
and timezone. If the user switches links while a request is pending, a late response
cannot replace the new selection's report.

I would keep a last successful report visible during refresh and label it
appropriately. A failed first load is an error state, not zero activity. An empty
bucket becomes zero only when it is known to be covered; an unprocessed interval
remains incomplete.

Timezone belongs in the aggregate query. Formatting an already grouped UTC day in
another zone does not produce that zone's daily total. Hourly buckets likewise need
full timestamps rather than just an hour number that repeats on another date.

Polling aggregated reports while visible is a good initial choice. Stop or slow
polling when hidden, back off on errors, and refresh on return. If live monitoring
becomes necessary, push aggregate versions or invalidations and recover from snapshots
after reconnect.

For visualization, I would start with daily bars and small referrer/device tables.
They are easier to interpret and make accessible than an animated event stream. The
server should not send raw IP-bearing event records merely to draw a chart.

> “The useful report is one whose number, time range, and completeness belong
> together. A faster animation cannot repair missing or duplicate observations
> upstream.”

## ⚙️ Account state, performance, and failure isolation — 7 minutes

There are two authorities for private UI state: the server decides access, and the
browser decides whether a response still belongs to the visible context. Both are
needed.

Suppose Alice's report request is in flight when she logs out and Bob signs in. The
old response was authorized for Alice, but it must not render in Bob's session. I
would scope queries to the account, increment a session generation on account changes,
and reject responses from old generations.

Abort signals reduce unnecessary work, but a response may already be complete. The
context check remains necessary. Logout also clears account-derived caches and
selections rather than only hiding the user's name in the header.

A persisted user object can help the initial shell render, but the app should
reconcile it with the server before exposing privileged actions. An expired session
produces a clear login state while preserving any safe recoverable draft or operation
reference.

Server analytics routes check link ownership independently of the UI. A short code is
public by design, so knowing it cannot authorize a raw activity query. Administrative
role changes should take effect on subsequent requests, with suitable protection
against accidental loss of all administrative access.

For sessions, cache authorization only within the authoritative expiry. Logout and
revocation need to account for old cache fills in flight. These are the same general
stale-response concerns we saw with links, applied to a different resource and
stricter access policy.

The dashboard's rendering load is not the service's redirect rate. Most owners view a
small page of links and one report. I would begin with stable server pagination,
bounded aggregates, and ordinary rows; virtualize only if a measured continuous-list
use case warrants it.

Route-load heavy admin or chart code. Keep the basic shortening form responsive on a
modest device. Long URLs need readable wrapping or truncation with a way to inspect
the full destination. Loading one report should not disable an unrelated form through
a global busy flag.

Accessibility work follows the user journey: associate validation errors with fields,
announce creation and copy results, preserve keyboard focus, and make a detail panel
escapable with focus restored to its opener. The report should have a text or table
representation alongside color and bars.

On the backend, separate budgets for creation, redirect misses, and analytics. A Redis
outage should not release unrestricted fallback traffic onto PostgreSQL. Coalesce
popular misses, cap concurrency, and return controlled errors when the fallback budget
is exhausted.

A breaker helps reduce repeated failing dependency calls, but a timeout does not
necessarily cancel a database query. The caller can see failure after the transaction
later commits. The creation receipt remains necessary for recovery.

The event pipeline needs progress monitoring, not merely connection monitoring. After
a broker reconnect, restore the consumer and verify committed progress. Quarantine
malformed events after bounded retries; immediate requeue loops consume capacity
without repairing bad data.

At larger scale, partition mappings by code and maintain an owner-list index. Keep
custom and generated claims under the same namespace authority. Multi-region reads
need a deliberate new-link visibility policy, otherwise the owner can receive success
and immediately get a regional miss.

Operational measurements should connect to the experience: creation outcomes recovered
after timeout, redirect latency by cache outcome, deactivation enforcement age,
admitted or dropped observations, and report lag. Use bounded metric labels rather
than individual URLs or short codes.

I would add destination abuse handling and shared creation/report quotas before
exposing the system broadly. Syntactic URL validation does not establish a safe
destination. Logs should avoid raw tokens and sensitive query parameters, and raw
analytics should have a defined retention policy.

## 🧪 Verification and evolution — 4 minutes

I would verify the complete creation journey under response loss: commit the link,
interrupt the response, recover the attempt, and confirm that the user receives the
same code. Concurrent custom-alias claims should produce one winner with a useful
conflict for the other caller.

For lifecycle correctness, expire a warm link and verify that it stops resolving.
Pause an old lookup, deactivate the link, then release the lookup and check that it
cannot resurrect the old state. Confirm that the dashboard reports acceptance and
enforcement according to the agreed contract.

For analytics, crash a worker after commit but before acknowledgement and replay the
event. The report should gain one contribution. Interrupt collection and ensure the UI
shows incomplete coverage rather than silently filling missing buckets with zero.

For account isolation, release Alice's delayed response after Bob signs in. For report
identity, rapidly change code, range, and timezone. No old result should replace the
current context, even if request cancellation arrives too late.

Load tests should include a single viral link, random invalid-code scans, and backlog
recovery alongside ordinary traffic. These stress different shared resources.
Page-render smoke tests alone cannot establish those properties.

The local implementation currently has direct fetch state, a target-only cache,
disconnected creation idempotency middleware, and separate click/counter writes. Its
admin changes do not invalidate cached links, and broker reconnect does not restore
consumption. The proposed design addresses those gaps; this documentation does not
claim they are already fixed.

> “I would evolve the system by first making creation recoverable, then enforcing
> lifecycle changes through the cache, and then making report effects repeatable and
> coverage visible. Those changes improve a real owner and visitor journey before
> adding more features.”
