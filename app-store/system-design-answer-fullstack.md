# App Store — System Design Answer (Fullstack Focus)

*45-minute system design interview format — Fullstack Engineer Position*

## 📋 Problem Statement

Design an app marketplace like the App Store: developers publish apps with rich media, users search and browse quality-ranked charts, download apps, and leave reviews — and the review corpus has to resist manipulation. As a fullstack engineer I care about the **seams**: how a keystroke in the search box becomes a quality-ranked result list, how a review travels from a client form through an integrity pipeline to a published (or rejected) verdict, and how a developer's upload becomes a searchable, downloadable app. The through-line is that the hard work happens **off the request path** — search re-ranking, integrity scoring, and media handling all have to feel instant to the user while doing real work behind them.

## 🎯 Requirements Clarification

- **Scope:** discovery (search + charts), app detail, reviews with integrity, and the developer publish lifecycle. Commerce (paid purchases, subscriptions, payouts) I'll treat as an entitlement layer behind an interface — most apps are free and the interesting problems are discovery and trust.
- **Consistency bar:** app metadata and reviews can be eventually consistent (seconds); a developer publishing an app should see it live quickly; download entitlement must be exact.

### Functional Requirements
- Search with filters + category browse + precomputed charts (Top Free/Paid/Grossing)
- App detail: metadata, screenshots, ratings, reviews
- Reviews: submit, vote helpful, developer response, integrity gating
- Developer portal: create/update app, upload media, submit, publish, analytics

### Non-Functional Requirements
- Search p95 < 100ms, app detail < 200ms
- Reviews visible within seconds of passing integrity; never block the writer
- Publish → searchable within seconds
- No lost events between a DB write and downstream processing

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React SPA (Vite + TanStack Router)           │
│   Consumer: Home/Charts · Search · App Detail · Reviews         │
│   Developer: Dashboard · App Editor · Media Upload · Analytics  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST (session cookie)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express API (stateless, xN)                  │
│   /apps · /apps/search · /apps/:id/reviews · /developer/*       │
└───┬───────────────┬───────────────┬───────────────┬─────────────┘
    ▼               ▼               ▼               ▼
┌────────┐   ┌────────────┐   ┌──────────┐   ┌───────────────┐
│Postgres│   │Elasticsearch│  │  Redis   │   │    MinIO      │
│apps,   │   │search index │  │sessions, │   │icons,         │
│reviews,│   │+ suggest    │  │cache,    │   │screenshots,   │
│outbox  │   │+ similar    │  │idempotency│  │packages       │
└───┬────┘   └────────────┘   └──────────┘   └───────────────┘
    │ outbox rows
    ▼
┌────────────┐   consume   ┌────────────────────────────────┐
│  RabbitMQ  │────────────▶│ Workers: reviewWorker (integrity)│
│            │             │          downloadWorker (counts) │
└────────────┘             └────────────────────────────────┘
```

Two disciplines meet here: a **read path** optimized with Elasticsearch + Redis for discovery, and a **write path** that uses Postgres as the source of truth and a transactional outbox to hand work to RabbitMQ workers. The API servers are stateless; all durable state and all async work live behind them.

## 🔧 Deep Dive 1: End-to-End Search with Quality Re-Ranking

The seam between a fast-feeling UI and a relevance engine.

```
User types "photo editor"
   │  debounce 150ms, ≥2 chars
   ▼
SearchBar ──GET /apps/search?q=photo+editor──▶ API
   │                                            │ Redis cache check (5-min TTL, page 1)
   │                                            ▼
   │                                    Elasticsearch multi_match
   │                                    (name^3, developer^2, fuzzy)
   │                                            │ fetch 2× requested
   │                                            ▼
   │                                    Quality re-rank in the service
   │                                    text score (0.6) + quality (0.4)
   ▼◀────────────ranked page──────────────────┘
Render results (skeleton → list)
```

**Frontend discipline.** The input keeps two states: the immediate value (drives the text field) and a debounced value (drives the request), so typing never blocks on the network. A stale-while-revalidate cache keeps repeated queries instant and shows the last good results while the new ones load, so the list never flashes empty. Suggestions are typed by kind (app / developer / category) so the dropdown communicates *what* each hit is.

**Backend discipline — why re-rank instead of trusting Elasticsearch's `_score`?**

> "Text relevance alone is exactly what App Store Optimization spam exploits — stuff the right keywords and you outrank a better app. So I fetch roughly twice the page size from Elasticsearch to get headroom, then re-rank in the service blending the text score (~60%) with quality signals — rating, review count, downloads (~40%). The cost is extra CPU per query and a second sort, but the alternative is surfacing keyword-stuffed junk above the app users actually want. I fetch 2× rather than 10× because re-ranking a huge candidate set would blow the latency budget for marginal quality gain."

**What I give up:** the Elasticsearch index is refreshed when an app is published, not via change-data-capture, so an edited-but-unpublished app can rank on slightly stale text. For a marketplace that's acceptable (metadata edits are rare relative to reads); the fix at scale is an outbox → indexer so edits propagate in seconds.

## 🔧 Deep Dive 2: The Review Pipeline — Client Form to Integrity Verdict

A review must feel submitted instantly, but its integrity score is real work that can't run in the request.

```
ReviewForm  ──POST /apps/:id/reviews──▶  Review API
 (client validation:                      │ server re-validate
  rating 1–5, title, body)                │ must have downloaded app
                                          │ reject duplicate review
                                          ▼
                              ┌── single Postgres txn ──┐
                              │ INSERT review (pending) │
                              │ INSERT event_outbox row │
                              └───────────┬─────────────┘
                                          │ relay
                                          ▼
                                      RabbitMQ ──▶ reviewWorker
                                                     │ Redis dedup (idempotent)
                                                     │ 6-signal integrity score
                                                     ▼
                                          UPDATE review status
                                          published / rejected
```

**Why the outbox, not "insert then publish"?** This is the decision I'd defend hardest:

> "The naive version inserts the review, then publishes `review.created` to RabbitMQ. Those are two systems and you cannot make both commit atomically — if the process dies between the Postgres commit and the publish, the review is saved but its integrity job never runs, so it sits `pending` forever and is invisible. The transactional outbox writes the event into an `event_outbox` table *inside the same Postgres transaction* as the review insert. Either both land or neither does. A relay then reads unpublished rows and pushes them to RabbitMQ, marking them sent. The price is at-least-once delivery — the relay can publish a row twice if it crashes after publishing but before marking it — so `reviewWorker` dedups on the event id in Redis before doing work. I'd rather pay idempotency-on-the-consumer than risk silently losing events."

**The integrity score itself** is a weighted sum of six signals the worker computes: review velocity (0.15 — many reviews in 24h looks like spam), content quality (0.25 — generic phrases like "great app" score low, specifics like "fixed the crash on launch" score high), account age (0.1), verified download (0.2 — did this user actually install the app?), coordination (0.2 — a review count spiking to 5× the app's baseline flags review-bombing), and originality (0.1). Below ~0.3 the review is rejected, mid-range flags for manual review, above ~0.6 publishes. It's deliberately heuristic — false positives happen (a genuine one-liner scores low) — because synchronous ML scoring would block the write and full ML detection is out of scope.

**Frontend closes the loop:** the form shows the review as "submitted, pending review" immediately (optimistic-ish), and the app's review list refetches when the worker publishes. Error states are specific — 403 "download the app first," 409 "you already reviewed this."

## 🔧 Deep Dive 3: The Developer Publish Pipeline

The other big fullstack seam: how a developer's upload becomes a live, searchable, downloadable app.

```
Developer Editor                         API / Storage
   │ create app (status: draft)          Postgres apps row
   │ request presigned URL ──────────────▶ MinIO presigned PUT
   │ PUT icon/screenshots ───────────────▶ MinIO (bypasses API)
   │ submit for review ──────────────────▶ status: pending
   │ publish ────────────────────────────▶ status: published
   │                                        └─▶ index doc in Elasticsearch
   ▼                                        └─▶ now appears in /apps/search
App is live
```

**Why presigned uploads?** App icons and screenshots (and, at scale, multi-hundred-MB packages) should never stream through the API servers — that ties up request-handling capacity and memory on binary I/O.

> "The editor asks the API for a presigned PUT URL, then uploads the media directly to MinIO. The API only ever handles the small metadata request and stores the resulting object key. Small icons can go through a `multipart` endpoint for convenience, but anything large takes the presigned path. The trade-off is a two-step client flow — get URL, then PUT — and the client has to handle a partial upload (URL issued, PUT failed). But it keeps the API servers stateless and cheap to scale horizontally, which is the whole point of putting object storage behind them."

**Publish is the consistency moment:** flipping `status` to `published` in Postgres and indexing the document in Elasticsearch are two writes to two systems. Locally that's done inline on publish; at scale it's the same outbox pattern as reviews — write `app.published` to the outbox in the publish transaction, let an indexer consume it — so a crash between the DB flip and the ES index can't leave an app "published but unsearchable."

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|----------|----------------|-----------|
| Search ranking | Fetch 2× + quality re-rank | Trust ES `_score` | Beats ASO keyword-stuffing |
| Review processing | Async via outbox + worker | Sync integrity in request | Non-blocking writes, no lost events |
| Event publishing | Transactional outbox | Insert-then-publish | Atomic with the DB write |
| Consumer safety | Redis dedup (idempotent) | At-most-once delivery | Survives at-least-once redelivery |
| Charts | Precomputed `rankings` table | Rank on each request | Avoids full-catalog scan per load |
| Media upload | Presigned PUT to MinIO | Stream through API | Keeps API servers stateless/cheap |
| Search freshness | Reindex on publish | CDC on every edit | Simpler; edits are rare vs reads |
| Auth | Session + Redis | JWT | Immediate revocation |

## 📈 Scalability: What Breaks First

1. **Elasticsearch relevance drift.** As the catalog grows, "reindex on publish" leaves edits invisible to search until republish. Fix: outbox → dedicated ES indexer so every metadata change propagates in seconds; shard the index by locale.
2. **The single RabbitMQ / worker pool.** Review and download volume both flow through one broker. Fix: partition by event type, scale `reviewWorker`/`downloadWorker` as independent consumer groups; at 100M events/day this is where RabbitMQ gives way to Kafka's partitioned log.
3. **Ranking freshness vs. cost.** Precomputed daily charts feel stale for fast-moving categories. Fix: incremental ranking off the download/review event stream rather than a nightly full recompute.
4. **Hot app-detail reads.** A featured app's page is read-heavy; Redis cache-aside on app detail + denormalized rating aggregates absorb it, and CDN edge-caching of the (public) detail response is the next step.

## 🚀 Closing: What I'd Build Next

With more time I'd wire the outbox into an Elasticsearch indexer for near-real-time search freshness, add a real entitlement/purchase layer behind the existing `purchases`/`app_prices` schema (with idempotent checkout keyed on a client UUID), and move chart generation to an incremental job over the event stream. The consistent theme: keep the user-facing paths fast by pushing every expensive, failure-prone operation — integrity scoring, indexing, ranking, media handling — onto the durable async side of the outbox.
