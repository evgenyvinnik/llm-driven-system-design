# App Store architecture

## System Overview

An app marketplace helps users discover applications, assess their quality, and
obtain approved releases, while developers maintain listings and respond to users.
The architectural challenges are keeping discovery consistent with publication,
preventing review manipulation without blocking ordinary feedback, and distributing
large immutable artifacts without routing their bytes through the catalog API.

The production sections below describe a **proposed design**. The final
[Implementation Notes](#implementation-notes) trace the current Express/React demo
and its limitations. Scale figures are planning assumptions, not measurements.
The local code implements discovery and metadata management, with incomplete
review/event flows; it has no native installation or commerce integration.

## Requirements

### Functional requirements

- Browse categories, search listings, and inspect reviews and approved release metadata.
- Create developer-owned drafts, upload artifacts, submit a revision for review,
  publish an approved revision, and withdraw an unsafe release.
- Accept one current review per account/app, allow edits and developer responses,
  and apply moderation decisions to an identified review revision.
- Authorize a download against the current release and the caller's access rights.
  If paid apps are required, integrate a separate entitlement authority.
- Show developers publication state, review status, and precisely defined counters.

Payment processing, subscriptions, settlement, native installers, and sophisticated
recommendation models are separate extensions. This design establishes their
interfaces without claiming to design all of them in one interview.

### Non-functional requirements

| Concern | Proposed target or invariant |
|---------|------------------------------|
| Availability | 99.95% monthly availability for catalog and search reads |
| Latency | p95 catalog reads below 200 ms; search below 300 ms, excluding client network |
| Publication | An unapproved revision cannot become the public release |
| Download authorization | Check current release eligibility before issuing access |
| Projection freshness | Normal publication-to-search lag below 60 seconds, observable during failures |
| Review effects | Only the current published review contributes to ratings |
| Retries | Stable operation IDs and durable deduplication for business effects |
| Recovery | Replay derived views from authoritative state and retained events |

These are different guarantees: a minute of search lag is acceptable for a new
listing, while a cached search hit cannot authorize a withdrawn binary.

## Capacity Estimation

Assume 10 million daily users, 20 catalog/detail reads and 5 searches per user.
That is about 2,315 catalog reads/s and 579 searches/s on average; at a 10× peak,
plan for roughly 23,000 and 5,800 requests/s respectively.

At 1 million apps with 10 KB of searchable metadata each, the source text is about
10 GB before indexes, replicas, and object media. Artifact traffic dominates:
1 million daily downloads averaging 100 MB produce approximately 100 TB/day.
That is about 1.16 GB/s average origin-independent delivery demand before peaks.

Assume 500,000 review writes/day, about 5.8/s average and 58/s at 10× peak.
Aggregate volume is manageable, but a coordinated campaign against one app can
concentrate many updates on one rating row. Distribution matters more than averages.

### Local Development Scale

The main seed creates 10 apps and randomized demo reviews. Compose runs one instance
of each dependency and a 512 MB Elasticsearch heap. Multiple API ports share those
same stores; this does not simulate sharded search or redundant infrastructure.
No load test or memory measurement accompanies this document.

## High-Level Architecture

Proposed production boundaries; the API can initially deploy as a modular service.

```text
┌──────────────────────────┐      ┌────────────────────────────┐
│ User / developer UI      │─────▶│ CDN: media and packages    │
└────────────┬─────────────┘      └────────────────────────────┘
             │                                   ▲
             │                                   │
             ▼                                   │
┌──────────────────────────┐      ┌────────────────────────────┐
│ API gateway + auth       │      │ Object storage             │
└────────────┬─────────────┘      │ Immutable artifacts        │
             │                    └────────────────────────────┘
             │                                   ▲
             ▼                                   │
┌──────────────────────────┐                     │
│ Catalog / publishing     │─────────────────────┘
│ Reviews / access         ├─────────────────────┐
└────────────┬─────────────┘                     │
             │                                   │
             │                                   │
             ▼                                   ▼
┌──────────────────────────┐      ┌────────────────────────────┐
│ PostgreSQL               │      │ Read cache                 │
│ Revisions + event outbox │      │ Public metadata            │
└────────────┬─────────────┘      └────────────────────────────┘
             │
             │
             ▼
┌──────────────────────────┐
│ Relay + message queue    │
└────────────┬─────────────┘
             │
             │
             ▼
┌──────────────────────────┐
│ Review/index workers     │
│ Search + rating views    │
└──────────────────────────┘
```

Search serves a derived retrieval index. Publication and access decisions remain
with authoritative records. The CDN serves immutable bytes after an access grant;
it does not decide which app revision is approved.

## Core Components / Request Flows

### Discovery

Normalize the query and filters, retrieve eligible candidates, rank a bounded
candidate set, and return a stable continuation token tied to that query/order.
Keep public metadata caches separate from developer draft views and account data.
Search documents include publication status, region/compatibility filters, and
catalog revision. A periodic reconciler detects missing, obsolete, and withdrawn entries.

A withdrawal may temporarily remain visible in a stale result, but detail and
download authorization check current policy. If immediate search disappearance is
required, add an authoritative withdrawal filter to the result path and budget its
latency and failure behavior explicitly.

### Publication

1. Save an owned draft using an expected metadata revision.
2. Create an upload session with an object key, byte limit, and expected checksum.
3. Verify completion server-side, then scan the immutable artifact.
4. Review the exact metadata/artifact revision; later edits require a new approval.
5. In one transaction, publish that approved revision and append an outbox event.
6. Deliver the event to search/cache workers with retry and version checks.
7. Expose publication and indexing status separately to the developer.

A crash after step 5 leaves the app published with indexing pending. The relay can
recover from the outbox. A search failure therefore does not make an already
committed publication look like a rejected request.

### Reviews and ratings

Accept a bounded review under account/app uniqueness. An initial decision may
publish low-risk content or keep it pending. Store its revision, status, and
moderation reason with an outbox event in the same transaction.

A later decision names the review revision it evaluated. Apply it only if still
current, and update that review's rating contribution transactionally. Published
review edits replace a contribution; rejection removes one; a pending review
contributes zero. This supports corrections without treating retries as new votes.

### Download access and analytics

Resolve the current approved release, check access, and issue a short-lived signed
URL to an immutable object. Define an access-grant event separately from transferred
bytes, completed downloads, and successful installs. CDN transfer logs and native
client receipts have different trust and completeness properties.

For a paid app, an entitlement service must answer the access question. Displayed
price, a prior download counter, and the existence of a `purchases` table are not
proof of entitlement. Commerce is not implemented locally.

## Database Schema

The complete **current executable schema** is
[backend/src/db/init.sql](./backend/src/db/init.sql). The migration reruns that file;
it is not a versioned migration system. The following inventory describes what
exists, including tables that business code does not use.

| Table | Identity and important fields | Current constraints/use |
|-------|-------------------------------|-------------------------|
| `users` | UUID, email, username, password hash, role | Unique email/username; bcrypt authentication |
| `developers` | UUID, user ID, name, verified | Unique user ID; owner of app rows |
| `categories` | UUID, slug, parent ID, sort order | Unique slug; parent FK |
| `apps` | UUID, bundle ID, developer/category, metadata, price, rating totals, status | Unique bundle ID; category/developer/status indexes |
| `app_screenshots` | UUID, app ID, URL, device type, sort order | Cascades on app deletion |
| `app_prices` | UUID, app, country, amount, period | Schema only; no connected pricing flow |
| `purchases` | UUID, user/app/price IDs, payment ID, receipt, expiry | Schema only; user ID lacks a users FK |
| `reviews` | UUID, user/app, stars, body, status, score, response | Stars constrained to 1–5; app/time and user indexes |
| `review_votes` | UUID, review/user, helpful flag | Unique review/user; vote toggle writes counters separately |
| `rankings` | Date, category, type, app, rank, score | PK excludes category; seeded but not used by top-app reads |
| `download_events` | UUID, app/user, version, country, device type | App/time index; written synchronously |
| `user_apps` | User/app, purchased flag, download count/time | Composite PK; **no `id` column** |
| `event_outbox` | UUID, event type, JSON payload, published flag | Unpublished partial index; no writer or relay |

Most statuses and money fields have no business CHECK constraints. Review ownership
uniqueness is not enforced. An app's `version` is a release label, not an optimistic
concurrency token. There are no release, upload-session, moderation-decision,
consumer-inbox, or durable API-operation tables.

### Proposed production additions

| Record | Constraint / access pattern | Purpose |
|--------|----------------------------|---------|
| App revision | Unique app/revision; immutable submitted contents | Bind approval to the reviewed metadata |
| Release | App/version, object key, digest, scan/approval state | Bind access to verified bytes |
| Current public release | One pointer per app, conditional revision update | Atomic publish/withdraw decision |
| Review | Unique account/app, current revision/status | One current rating contribution |
| Moderation decision | Review/revision/decision ID and reason | Reject stale analysis; support appeals |
| Rating contribution | Unique review ID plus applied revision | Reversible, repeatable aggregate effect |
| Operation | Unique caller/action/key, request digest, durable result | Recover ambiguous mutation responses |
| Consumer receipt | Unique consumer/event ID | Apply each downstream effect once |
| Outbox event | Aggregate ID, sequence, payload, delivery metadata | Recover committed changes after broker failure |

Apply these through real migrations with backfill and duplicate reconciliation.
Adding a unique review index before resolving seeded duplicates would fail.
A proposed rating transaction uses the old and new eligible contributions; it must
not blindly increment a total when an event is redelivered.

## API Design

These are the current routes, mounted under `/api/v1`. Source of truth:
[backend/src/routes/index.ts](./backend/src/routes/index.ts).

| Method | Path | Current purpose |
|--------|------|-----------------|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Account/session lifecycle |
| GET / PUT | `/auth/me` / `/auth/profile` | Current account / update profile |
| POST | `/auth/change-password`, `/auth/become-developer` | Password change / create developer profile |
| GET | `/categories`, `/categories/:slug` | Category hierarchy/detail |
| GET | `/apps`, `/apps/top` | SQL catalog and live sorted lists |
| GET | `/apps/search`, `/apps/suggest` | Elasticsearch results / name suggestions |
| GET / POST | `/apps/:id` / `/apps/:id/download` | Detail / record a download action |
| GET / POST | `/apps/:appId/reviews` | Published reviews / create review |
| GET | `/apps/:appId/ratings` | Rating aggregate and distribution |
| PUT / DELETE | `/reviews/:id` | Edit/delete owned review |
| POST | `/reviews/:id/vote`, `/reviews/:id/respond` | Vote toggle / owner developer response |
| GET / POST | `/developer/apps` | Owned apps / create draft |
| PUT | `/developer/apps/:id` | Update owned metadata |
| POST | `/developer/apps/:id/submit`, `/developer/apps/:id/publish` | Submit draft / demo publication |
| POST / DELETE | `/developer/apps/:id/screenshots` / `.../screenshots/:screenshotId` | Add/remove screenshot row |
| POST / GET | `/developer/apps/:id/icon` / `.../upload-url` | Upload icon / request presigned PUT |
| GET | `/developer/apps/:id/analytics`, `.../reviews` | Counters / first page of published reviews by default |

There is no `/charts`, `/search`, purchase, approval, or install route at the API
root. Controller comments mentioning some of those paths are stale.

Proposed mutation responses should include operation ID, entity revision, and
committed status. Submission means accepted for review; publication means the
release pointer committed; search visibility is a separate projection status.
Conflicting revisions should return a conflict, not silently overwrite metadata.

## Key Design Decisions

### Authoritative catalog plus asynchronous search

Search needs text analyzers and relevance retrieval, while publishing needs a
transaction joining ownership, revision, approval, and public-release state.
PostgreSQL plus a derived search index fits those distinct access patterns.

Putting Elasticsearch in the publication transaction's success path creates a
misleading failure: the database commits, the index call fails, and the developer
retries a change that already happened. An outbox makes the committed transition
recoverable and allows truthful “published; indexing” feedback.

The cost is observable lag and an operated relay/reconciler. A search hit can be
stale, so acquisition must revalidate eligibility. At smaller scale, PostgreSQL
full-text search can avoid this entire projection boundary; choose Elasticsearch
when retrieval needs and measured load justify it.

### Revision-aware review decisions

An account-age heuristic can cheaply route suspicious reviews to pending. More
expensive analysis can run asynchronously, but must reference the exact text/rating
revision. Otherwise a delayed result for the original review can approve an edit
that the analyzer never saw.

Immediate publication minimizes user friction but exposes coordinated abuse while
analysis catches up. Holding every review delays ordinary feedback and increases
moderation backlog. A risk-based initial decision plus explicit pending status
accepts operational complexity to balance these requirements. Heuristics are
signals, not proof; record reasons and provide a correction path.

### Immutable releases and direct artifact delivery

A release binds approved metadata to an object digest. Changing bytes behind a
previously approved object key would invalidate that approval, so new contents
require a new revision. Large uploads/downloads go directly to storage/CDN.

Proxying every artifact through Express simplifies one access path, but consumes
API bandwidth and ties catalog availability to slow transfers. Direct delivery
requires upload completion verification, short-lived grants, orphan cleanup, and
withdrawal handling. Signed URLs alone neither scan files nor prove entitlement.

## Consistency and Idempotency

The proposed authoritative mutation and outbox insert share one PostgreSQL
transaction. A relay publishes with broker confirmation and marks progress only
after confirmation; a crash can duplicate delivery. Consumers therefore deduplicate
inside the transaction that applies their effect, scoped by consumer identity.

Search upserts carry monotonic catalog revisions, so an older event cannot restore
withdrawn metadata after a newer update. Rating updates compare the current review
revision and replace its contribution. A reconciliation job verifies totals against
published reviews and repairs drift with an auditable operation.

API idempotency records bind caller, action, key, and request digest to the durable
result. A different payload with the same key is a conflict. Retrying the same
publication after a lost response returns its existing operation status.

The current code has an unused Redis idempotency module and an unused outbox table.
Neither provides these guarantees until integrated with the business transaction.

## Security / Auth

Proposed production controls include developer ownership checks on every mutation,
separate public/draft reads, limited upload sessions, file-type/content validation,
and audit records for approval and withdrawal. Session authentication is sufficient
for the browser scope; native clients and commerce require additional contracts.

The local API hashes passwords with bcrypt cost 10 and stores UUID sessions in
Redis for 24 hours. It accepts an HttpOnly, SameSite=Lax cookie (Secure in production
mode) or a bearer session ID. The browser stores that ID in localStorage as well.
Each authenticated request reloads the user from PostgreSQL, so role changes are
not frozen in the cached session. Password changes do not revoke other sessions.

Developer routes generally enforce both role and ownership; an admin role does
not bypass the requirement for an owned developer record. Public detail/download
reads do not restrict app status. Multer buffers uploads in memory without a
file-size limit or content filter, before controller-level ownership checking.
Rate limiting and stronger artifact controls are not implemented.

## Observability

Proposed service indicators measure successful eligible catalog reads, search
freshness, publication-to-index delay, pending-review age, queue age, stale-decision
rejection, and rating reconciliation discrepancies. Tag download metrics with their
actual meaning: access granted, bytes transferred, or installation reported.

Locally, the API exposes Prometheus process/HTTP metrics and structured Pino logs.
Some domain counters are wired, while declared database/cache/purchase/revenue
metrics do not establish instrumented flows. Worker metric registries are in
separate processes without a scrape endpoint. App-ID download labels grow with
the catalog. The revenue UI calculates an estimate rather than reading transactions.

`/health/live` is process-only. `/health/ready` checks PostgreSQL and Redis.
`/health` checks those plus Elasticsearch and RabbitMQ, returning degraded/200
for noncritical dependency failure. MinIO is absent from runtime health checks,
despite being required before API startup. Probes do not enforce the documented
aspirational hard timeout or verify consumer progress.

## Failure Handling

| Failure | Proposed response |
|---------|-------------------|
| Search unavailable | Explicit unavailable state or bounded labeled catalog fallback; never pretend zero matches |
| Broker unavailable | Commit authoritative changes with outbox; expose increasing projection lag |
| Index update repeated/out of order | Compare catalog revision; ignore old events |
| Review analyzer delayed | Keep pending decision visible to its author; measure queue age |
| Upload completed, API response lost | Resolve the existing upload session and verify the object |
| Publication response lost | Look up operation; retain confirmed state and indexing progress |
| Release withdrawn during stale browsing | Reject new access grants against current release state |

Existing breaker factories are not connected to catalog/search/publishing calls.
The local API often propagates cache failures, and search has no database fallback.
Workers have retry scaffolding but important failure paths are swallowed or lose
messages, detailed below. Treat dependency status and end-to-end operation status
as separate observations.

## Scalability Considerations

Cache popular public metadata and serve images/artifacts from a CDN first; these
changes remove repeated work without weakening publication authority. Bound query
and upload sizes, paginate developer lists, and give search an explicit timeout.

As search grows, partition and replicate the index based on measured shard size and
query distribution. Stable pagination needs a consistent order and a tiebreaker;
changing rank on every page produces duplicates and omissions. Rebuild a new index
from a snapshot, replay later revisions, then switch the read alias.

Shard event processing by app or review identity when ordering matters. For hot
rating rows, partition contribution storage and publish aggregates asynchronously
with a freshness marker. Retain the contribution ledger so rejection and review
edits can be reconciled. Avoid adding distributed writes before a single-database
transaction demonstrably becomes the bottleneck.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Catalog authority | PostgreSQL revisions | Search index as authority | Transactional publication and ownership |
| Search propagation | Outbox with versioned consumers | Request-time dual write | Recover committed changes after dependency failure |
| Review policy | Risk-based pending decisions | Publish everything immediately | Limit abuse while keeping ordinary feedback responsive |
| Rating effects | Replace per-review contribution | Blind event increments | Edits, rejections, and retries remain correct |
| Artifact delivery | Immutable storage/CDN objects | API-proxied binaries | Keep large transfers off the catalog service |
| Browser auth | Server sessions | Long-lived browser bearer credentials | Central revocation with a small browser contract |

## Implementation Notes

### Runtime and implemented patterns

[backend/src/index.ts](./backend/src/index.ts) runs one Express API, initializes
Elasticsearch and MinIO before listening, and attempts RabbitMQ connection.
The two workers are separate entry points. Despite historical ESM claims, the
backend package has no `type: module`; its development script uses `tsx` and its
TypeScript build emits CommonJS. The frontend uses React 19, Vite 6, TanStack
Router, Zustand, and Tailwind. It has no TanStack Query, virtualization, or chart library.

- **Cached reads:** [config/redis.ts](./backend/src/config/redis.ts) provides JSON
  cache helpers. Catalog/review/similar data use five-minute TTLs and search one
  minute. This reduces repeated reads when available, but failures commonly escape
  to callers and invalidation is incomplete. JSON caching also turns Date values
  into strings while TypeScript types still describe Date objects.
- **Transactions:** [reviewService.ts](./backend/src/services/reviewService.ts)
  groups some review/rating writes in PostgreSQL transactions. This is a useful
  starting point, but a transaction alone does not fix stale pre-transaction reads,
  missing uniqueness, or incorrect publication-state predicates.
- **Queue scaffolding:** [shared/queue.ts](./backend/src/shared/queue.ts) declares
  durable queues, persistent messages, prefetch and bounded retry counts. Its channel
  is not a confirm channel; `publish` returning true means buffering succeeded,
  not that a durable broker accepted the business event.
- **Telemetry and probes:** [shared/metrics.ts](./backend/src/shared/metrics.ts),
  [shared/logger.ts](./backend/src/shared/logger.ts), and
  [shared/health.ts](./backend/src/shared/health.ts) wire API metrics/logs/probes.
  For example, `res.on('finish', ...)` measures completed HTTP responses; it does
  not measure artifact receipt, moderation correctness, or consumer effects.

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) and
[shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) contain helpers,
but business routes do not invoke them. `event_outbox` has no write or relay call
site. There is no rate limiter, payment processor, or background ranking job.

### Catalog, search, and publication gaps

[searchService.ts](./backend/src/services/searchService.ts) performs fuzzy
multi-match retrieval with name/developer boosts. It fetches exactly the requested
page, then applies a 60% text-score / 40% quality rerank within that page. This cannot
promote a better candidate from another page, and those score scales are not
calibrated. Quality uses rating average, rating count, and logarithmic downloads;
seeded engagement is not used by the rerank. Similar apps use text similarity and
category, not account preferences.

Top apps are live SQL sorts in
[catalogService.ts](./backend/src/services/catalogService.ts): download count for
free/paid, publication time for new, and price times download count for grossing.
The `rankings` table and Bayesian/five-signal ranking described in older documents
are not connected. SQL fixture statistics and actual reviews need not agree.

App list reads filter published state; detail reads do not. Unknown category slugs
can silently remove the intended filter. Publish SQL accepts draft or approved,
but the controller indexes the returned app even when a pending app did not
transition. Search documents have no status field/filter, so that pending app can
become searchable. Submission has no subsequent approval API/worker.

Metadata updates of published apps synchronously reindex; publication also indexes.
Media and rating changes do not consistently update search, and search/similar
caches are not invalidated. There is no withdrawal reconciler or full reindex CLI.
A database commit followed by index failure returns an error after the change.
The update controller passes omitted fields as present/undefined, so partial PUT
requests can null fields or violate the required app name. The UI usually sends
its full loaded object but has no revision-conflict protection.

### Reviews and events

New-review integrity calculation executes `SELECT id FROM user_apps`, although
that table has only a composite key. Creation therefore fails against the supplied
schema before its insert transaction. The rest of the intended flow is useful
source to study, but is not a working fresh-review demonstration.

The initial heuristic combines velocity, account age, prior download, content,
coordination and a constant originality score; it is not ML or verified payment.
There is no unique user/app review constraint. Edits skip rescoring and can change
rating totals for pending reviews. Stale reads before edit/delete transactions
allow concurrent counter drift. Vote toggles also write counters separately.
`clearReviewCaches` deletes app/rating keys but leaves cached review pages intact.

[reviewWorker.ts](./backend/src/workers/reviewWorker.ts) only deep-analyzes events
already pending. Its score can decrease but cannot reach the publication threshold
from below, so it never promotes those reviews. It catches analysis errors and
can acknowledge them. Deduplication is Redis read-then-set after effects, expires
in 24 hours, and is not transactional or revision-aware.

[downloadWorker.ts](./backend/src/workers/downloadWorker.ts) attempts writes to
`daily_download_stats` and `user_category_preferences`, neither defined by the
schema. Both errors are caught, allowing acknowledgement without analytics effects.
The request already wrote the download counter, event, and optional user-app row
sequentially; failures/retries can partially write or count more than once.

Events publish after database work without an outbox. Retry timers republish on an
unconfirmed channel before acknowledging the original. The dead-letter exchange
is direct but binds `#` literally, so ordinary routing keys do not match that
binding. Reconnection does not re-register consumers. Search-reindex and payout
queues exist without working consumers; graceful worker draining is absent.

### Browser and artifact boundaries

[authStore.ts](./frontend/src/stores/authStore.ts) persists only the session ID;
`fetchUser` is never called on startup. Reloaded developer routes see a null user
and redirect even if the server token remains valid. Logout clears local state
while ignoring request errors, so failed server logout can leave its cookie active.
Authentication middleware also contains unwrapped async dependency calls under
Express 4, so rejections need not reach the application's error handler.

[catalogStore.ts](./frontend/src/stores/catalogStore.ts) shares one loading flag,
pagination object, and current-result slots across requests. It has no cancellation
or route/account identity guard. A late response can populate the next app's page;
errors often appear as empty content or an indefinitely loading detail. Navigation
and search controls disappear at small breakpoints without an alternative menu.

The app-detail Get button and card Get buttons do not invoke download recording.
Review writing/voting, autocomplete, and package/media uploads are API-only or
unconnected. Developer save/publish/reply handlers mostly log errors. ResponseForm
clears its draft before the asynchronous response arrives. Analytics cards compute
price × download count × 0.7; their review count is the loaded page length.

[developerController.ts](./backend/src/controllers/developerController.ts) offers
one-hour presigned PUTs but no completion/scan/release-link step. Package keys use
app ID plus filename; the download placeholder uses bundle ID plus version and
lacks an HTTP scheme. Packages stay private and no signed GET is issued. Icon
uploads overwrite a stable URL; screenshot removal deletes the row, not the object.

### Simplifications and omissions

MinIO substitutes for managed object storage, and one PostgreSQL/Elasticsearch/
Valkey/RabbitMQ instance substitutes for redundant services. Fixtures substitute
for real usage, binaries, and revenue. Direct draft publication substitutes for
app approval. Local sessions substitute for native/platform account integration.

CDN delivery, verified releases, secure download grants, commerce, moderation
operations, event replay/reconciliation, durable API idempotency, multi-region
failover, and ML pipelines are omitted. The [README](./README.md) gives both setup
options and distinguishes its two incompatible seed paths. This audit read source
and validated documentation; it did not execute the stack or repair these defects.
