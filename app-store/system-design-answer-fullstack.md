# App Store Full-Stack — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Consumer, developer, trust workflows | 4 min |
| Architecture | SPA, API, search, media, workers | 8 min |
| Data model | Apps, reviews, media, entitlements, events | 6 min |
| Interfaces | Search, reviews, publishing, downloads | 8 min |
| Deep dives | Ranking, review integrity, uploads, caching | 20 min |
| Trade-offs and close | Scaling and rollout | 4 min |

## Opening — 2 minutes

I am designing an app marketplace with two personas. Consumers browse, search, inspect details, download apps, and leave reviews. Developers upload metadata and media, publish versions, and inspect analytics.

The difficult full-stack seams are discovery quality, review integrity, media processing, and entitlement correctness. Search and detail reads can be eventually consistent. A developer publish should become searchable quickly. A download entitlement and purchase state must be authoritative.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether paid purchases and subscriptions are in scope. I will design free downloads and an entitlement boundary for paid commerce. I would ask whether apps have platform-specific binaries; I will model a version and artifact per platform.

I would ask whether reviews appear immediately. I will accept them quickly, run asynchronous integrity checks, and publish only approved reviews. I would ask whether search is global or country-specific; I will assume country and device can affect ranking.

### Functional requirements

- Browse categories, charts, featured apps, and personalized recommendations.
- Search by app, developer, category, and keywords.
- View app metadata, screenshots, ratings, versions, permissions, and reviews.
- Download an available artifact after entitlement and device checks.
- Submit reviews and vote helpful.
- Developers create drafts, upload media and binaries, submit for review, publish, and inspect analytics.
- Process review integrity, malware checks, media transformations, and search indexing asynchronously.
- Preserve audit history for developer and moderation actions.

### Non-functional requirements

- Search and app detail reads should be low latency and cacheable.
- Publish should become discoverable within seconds after approval.
- No lost events between a committed write and asynchronous processing.
- A failed worker should not block the API write path permanently.
- Download authorization must be exact and auditable.
- Review manipulation should be detected without making the write request wait for all models.

### Out of scope

I will not design malware analysis internals, payment settlement, operating-system installation, or the recommendation model in detail. I will define the interfaces where they connect.

## A — Architecture — 8 minutes

### Combined architecture diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│ React SPA                                                                  │
│ Consumer routes: home · search · app/$id · reviews                         │
│ Developer routes: dashboard · editor · uploads · analytics                │
│ query cache · draft state · upload state · entitlement state               │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS / signed media URLs
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Stateless API                                                               │
│ auth · apps · search · reviews · downloads · developer publishing           │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Catalog service        │ Trust and review      │ Artifact/media service      │
│ metadata · versions    │ integrity · moderation│ upload · scan · transform  │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ PostgreSQL · search index · cache · object storage · outbox/event bus       │
└────────────────────────────────────────────────────────────────────────────┘
                               │ async events
                    ┌──────────▼──────────┐
                    │ Workers              │
                    │ index · review ·     │
                    │ media · analytics    │
                    └─────────────────────┘
```

### Frontend responsibilities

The shell owns session, route, theme, global announcements, and role-aware navigation. Consumer and developer routes share typed API clients but have separate state lifetimes.

Search state includes draft input, committed query, filters, request identity, results, and cursor. Developer uploads have a separate state machine because an upload can be large, resumable, and independent of app metadata editing.

The frontend never trusts a hidden button as authorization. It displays server capabilities and handles permission errors from the API. Result cards and media previews have local error boundaries so one failed asset does not break search.

### Backend responsibilities

PostgreSQL stores canonical metadata, reviews, entitlements, developer drafts, and outbox records. The search index serves discovery. Object storage holds binaries and media. Workers consume events for integrity, indexing, transformations, analytics, and notification.

The API writes canonical records first, then publishes work through an outbox. Read models may lag but expose freshness or publication status.

### Publish flow

1. Developer saves draft metadata.
2. Client requests a signed upload URL for a binary or screenshot.
3. Object storage records the artifact and the API verifies checksum and ownership.
4. Developer submits a version for validation.
5. Scanners and moderation workers produce a verdict.
6. Catalog marks the version approved or rejected.
7. An indexer updates search and charts.
8. Consumers see the published version after the read models refresh.

## D — Data Model — 6 minutes

| Entity | Important fields | Authority |
|---|---|---|
| `App` | app ID, developer, category, status, current version | catalog |
| `AppVersion` | version, platform, artifact, release status | catalog/artifact service |
| `MediaAsset` | object key, checksum, dimensions, transform status | media service |
| `Review` | user, app, rating, body, integrity status | review service |
| `ReviewVote` | review, user, helpful value | review service |
| `Entitlement` | user, app/version, source, status | commerce boundary |
| `ChartEntry` | country, category, period, rank, app | ranking read model |
| `OutboxEvent` | event ID, type, aggregate, payload, published | transactional outbox |

### Review states

A review progresses from submitted to pending integrity, published, rejected, or hidden after moderation. The public endpoint returns only approved content and a moderation reason is visible only to authorized actors.

### App publication states

An app draft can become submitted, scanning, approved, rejected, published, or withdrawn. An artifact can be uploaded but not eligible for publication until checksum, malware, permission, and policy checks finish.

### Entitlement and download

A download request checks user, app, version, device, country, and entitlement. It returns a short-lived signed URL or a controlled download token. Download counts are derived from accepted events and do not authorize access by themselves.

## I — Interfaces — 8 minutes

### Consumer API

```
GET  /api/v1/apps?category=&cursor=          → browse page
GET  /api/v1/apps/search?q=&filters=         → ranked results
GET  /api/v1/apps/suggest?q=                 → typed suggestions
GET  /api/v1/apps/top?category=&country=     → chart page
GET  /api/v1/apps/:id                       → detail and versions
GET  /api/v1/apps/:id/reviews?cursor=        → published reviews
POST /api/v1/apps/:id/reviews                → review command
POST /api/v1/reviews/:id/vote                → helpful vote
POST /api/v1/apps/:id/download               → entitlement check
```

### Developer API

```
POST /api/v1/developer/apps                  → create draft
PATCH /api/v1/developer/apps/:id             → update metadata
POST /api/v1/developer/apps/:id/upload-url   → signed upload URL
POST /api/v1/developer/apps/:id/submit       → submit version
GET  /api/v1/developer/apps/:id/status       → validation status
GET  /api/v1/developer/apps/:id/analytics    → aggregated metrics
POST /api/v1/developer/apps/:id/withdraw     → withdraw release
```

### Client interfaces

| Boundary | Input | Output |
|---|---|---|
| Search route | committed query and filters | result pages and facets |
| App detail | app ID and viewer | canonical detail model |
| Review form | draft rating and text | command state |
| Upload manager | artifact, checksum | progress and verification |
| Developer editor | draft version | validation state |
| Download action | app/version/device | entitlement or denial |

### Async status interface

The client polls or subscribes to upload and publish status using a stable version ID. It distinguishes upload progress, scanning, moderation, indexing, published, rejected, and retryable failure.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Search relevance and freshness

The search service retrieves candidates from the index, then applies quality and policy signals. The frontend debounces suggestions, cancels stale full-search requests, and commits only the active request identity.

The alternative is to trust text score alone. That makes keyword stuffing effective and lets low-quality apps outrank useful ones. Re-ranking costs CPU and may make freshness more complex, but trust is a marketplace requirement.

Search results can be cached by normalized query, country, locale, and viewer scope. A publish event invalidates relevant app detail and index entries. The UI shows a “processing” state when a developer’s app is approved but not yet searchable.

### Deep dive 2: Review integrity pipeline

The write API stores a pending review and returns a review ID quickly. A worker checks rate patterns, account reputation, duplicate text, purchase or download evidence, and moderation rules. The verdict updates review visibility and emits an index/cache invalidation event.

Blocking the write request on every integrity model improves immediate certainty but increases latency and couples availability to the model service. Asynchronous gating gives better availability but requires a pending state and careful anti-abuse rate limits.

Helpful votes are idempotent per user and review. Rating aggregates update only for published reviews and use a version or transaction to prevent lost updates.

### Deep dive 3: Developer upload and publication

Large binaries should upload directly to object storage through short-lived signed URLs. The API records expected checksum and size before issuing the URL. A completion request verifies the object and creates a scan job.

The client uses resumable upload where supported and keeps progress separate from metadata draft state. A failed upload can retry without rewriting the app record. A failed scan leaves the version pending or rejected; it does not publish a partially verified artifact.

### Deep dive 4: Entitlement correctness

The download command checks current entitlement and version policy before returning a signed URL. The token is short-lived and scoped to app, version, user, and device where required. Download analytics are asynchronous and cannot grant access.

The alternative is a public object URL. It simplifies delivery but bypasses revocation, entitlement, and audit. Signed URLs add storage and token lifecycle complexity, but protect paid or restricted artifacts.

### Deep dive 5: Cache and invalidation

App detail, charts, suggestions, and published review pages have different freshness. Detail metadata can use a short TTL, charts refresh on ranking jobs, and reviews invalidate on publication or moderation. The cache key includes locale, country, version, and viewer scope where relevant.

The API returns source version or updated time. The frontend can render stale content while a refresh runs, but it does not show an unpublished app as public merely because a developer draft is cached.

### Deep dive 6: Failure matrix

| Failure | Backend behavior | Frontend behavior |
|---|---|---|
| Search timeout | typed retryable error | preserve query and retry |
| Review worker down | pending review remains | pending status |
| Index lag | catalog stays authoritative | processing label |
| Upload interrupted | artifact remains unverified | resume or retry |
| Scan rejected | version blocked | show developer reason |
| Object storage unavailable | no signed URL | retry download |
| Entitlement denied | no artifact token | explain access state |

### Deep dive 7: Ownership and plugin boundaries

Consumer discovery, developer publishing, and review moderation can be separate frontend feature modules with a shared shell and typed capability contracts. I would not iframe every card or review component. Trusted first-party modules benefit from shared auth, cache, focus, and error boundaries.

An iframe becomes reasonable for untrusted third-party preview code or a separate security domain. Its stronger isolation costs duplicated runtime, postMessage protocols, resize coordination, and accessibility work.

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test a popular app detail page, a search burst after a launch, a review campaign, a large binary upload, and a chart refresh. The full-stack budget includes search latency, index freshness, object bandwidth, review-worker lag, and download authorization.

### What I would measure

- Search request and result-render latency.
- Catalog-to-index publication age.
- Review pending age and integrity rejection rate.
- Upload verification and scan duration.
- Signed URL issuance and download success.
- Cache hit rate by endpoint and country.
- Outbox age, worker retry, and event loss alarms.

### Rollout sequence

1. Ship catalog browsing, detail, and public reviews.
2. Add search index and typed query cancellation in the client.
3. Add developer drafts and direct media upload.
4. Add outbox-backed integrity and indexing workers.
5. Add entitlement-scoped download tokens.
6. Add charts, analytics, and paid commerce after trust paths are stable.

### Alternative architecture review

Database text search is easy for a small catalog but struggles with relevance, fuzzy matching, and ranking freshness. An index plus quality rerank adds operational components but matches the marketplace discovery problem.

Synchronous review moderation reduces pending states but couples user writes to expensive or unavailable models. Asynchronous integrity keeps the write path available and makes “pending” a first-class product state.

Proxying all binaries through the API simplifies authorization but turns the API into a bandwidth bottleneck. Direct signed uploads and downloads require token management and verification, but scale better and preserve entitlement checks.

### Full-stack interview checkpoints

I trace a developer upload from browser progress to signed object, checksum verification, scan, publish, index, and consumer detail response.

I trace a review from form submit to pending integrity, publication, aggregate update, and cache invalidation.

I close by separating catalog authority, search read models, review trust, and download entitlement.

## Scalability and operations

Scale API reads horizontally and use the search index for discovery. Partition workers by app or event type. Store media and binaries in object storage behind a CDN. Use PostgreSQL for canonical metadata and outbox transactions; use analytical storage for download and revenue aggregates.

The first bottleneck is search and media bandwidth, not the catalog write path. The second is integrity worker capacity during review bursts. The third is chart recomputation. Queue depth, index age, scan age, and download token failures reveal these bottlenecks.

## Security and observability

Developer roles, app ownership, moderation roles, and entitlement checks are enforced server-side. Signed URLs are short-lived. Review text is treated as untrusted input and rendered safely. Audit events cover publish, withdraw, moderation, and entitlement changes.

Metrics include search latency, index freshness, review pending age, moderation rejection rate, upload verification failures, signed URL issuance, download success, and cache hit rate. Trace IDs connect browser command, API write, outbox event, worker, and read-model update.

## Testing and correctness review

I would test search request races, publish-to-index freshness, review moderation transitions, duplicate helpful votes, interrupted uploads, checksum mismatch, entitlement denial, signed URL expiry, and app withdrawal.

Backend tests verify outbox replay, worker idempotency, review aggregate updates, developer permissions, and artifact ownership. Browser tests verify query cancellation, upload recovery, pending review status, and safe media fallbacks.

The acceptance criteria are searchable approved content, no leaked artifacts, no duplicate review effects, and a developer who can distinguish uploaded, scanning, rejected, and published states.

## Implementation sequence

1. Build catalog browse, app detail, and published review reads.
2. Add search index, debounce, cancellation, and cache keys.
3. Add developer drafts and signed media uploads.
4. Add outbox workers for integrity, scanning, and indexing.
5. Add entitlement-scoped downloads and audit events.
6. Add charts and analytics from asynchronous aggregates.

The sequence proves the trust and publication seams before adding commerce or personalization. It also keeps failed media and review jobs visible instead of hiding them behind synchronous requests.

## Interview walkthrough: one developer publish

The developer edits metadata and requests a signed upload URL. The browser uploads the artifact directly, reports progress, and calls completion with a checksum. The backend verifies ownership and enqueues scanning.

After approval, catalog state becomes published and an outbox event triggers indexing and chart work. Consumers see the app after the search read model refreshes. A failed worker leaves explicit processing status.

This scenario connects developer UI, object storage, asynchronous workers, catalog authority, and consumer cache freshness.

## Further design decisions

The developer editor saves metadata independently from binary upload progress. A failed upload does not discard the draft, and a verified artifact does not publish until the version passes policy checks.

Consumer search uses committed catalog state, not the developer’s local draft. The UI shows processing status after approval until indexing completes.

Review cards render structured text and media safely. A pending or rejected review is not included in public aggregate ratings.

The shell can host consumer and developer modules with shared auth and API contracts. Untrusted previews may use a sandbox, but ordinary app cards should not each be an iframe.

The production review asks whether every asynchronous step is observable, retryable, and idempotent, and whether download access is still correct if analytics processing fails.

### Final questions

- When is an app searchable?
- When is a review public?
- Who authorizes a download?
- What happens if scanning fails?
- Which state is cacheable?

The answers should point to catalog authority, integrity status, signed artifacts, and outbox-backed read models.

### Launch gate

The launch gate is approved-content visibility, verified artifacts, entitlement-scoped downloads, idempotent workers, and search freshness that developers can understand.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Search | index plus quality rerank | database text search only | relevance and scale |
| Reviews | async integrity gate | synchronous moderation | availability and latency |
| Uploads | signed direct object upload | API proxy upload | avoids API bandwidth bottleneck |
| Downloads | scoped signed URL | public object URL | entitlement correctness |
| Catalog | PostgreSQL source | search index source | transactional metadata |
| Events | outbox plus workers | request-time fan-out | reliable async work |
| Frontend extension | shared modules | iframe per card | interaction and cost |

## Closing — 3 minutes

The system treats catalog and entitlement data as authoritative, search and charts as read models, and review integrity, media processing, and indexing as asynchronous workflows with visible status. The frontend mirrors those boundaries through route-scoped query state, upload state, and publish state.

I would build free app discovery, detail, review submission, direct uploads, and an outbox-backed indexer first. Commerce, recommendation personalization, offline downloads, and third-party extension isolation come after the trust and publication contracts are stable.
