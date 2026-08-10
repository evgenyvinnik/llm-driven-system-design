# Yelp - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 📋 Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. As a full-stack engineer, I'll focus on how the frontend and backend integrate for geo-spatial search, the end-to-end review submission flow with optimistic updates, and the search experience from autocomplete to results rendering. Let me start by clarifying what we need to build."

---

## 🎯 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Search Experience (End-to-End)** - Autocomplete suggestions, geo-spatial search with filters, paginated results with faceted navigation, URL state synchronization
2. **Business Detail Pages** - Business info fetched from API, reviews with infinite scroll, rating display and aggregation
3. **Review System** - Star rating and text submission, photo upload, optimistic UI updates with rollback, idempotent submission handling
4. **User Flows** - Session-based authentication, role-based access (user, business_owner, admin), business owner management dashboard

### Non-Functional Requirements

- **Latency**: API p95 < 300ms, FCP < 2s
- **Consistency**: Strong for reviews, eventual for search index
- **Reliability**: Idempotent mutations, retry-safe
- **Integrity**: Ratings must be expensive to manipulate — see §8b
- **Type Safety**: A contract both sides honor — see §3, where this is the weakest link

The consistency line is the one that shapes the architecture, so it is worth stating precisely rather than as a slogan. **A review must be durable the instant the user is told it was posted** — that is money and reputation, and "we lost your review" is unrecoverable trust damage. **A review becoming findable by search seconds later is invisible**, because nobody posts a review and then immediately searches for it. Splitting the requirement that way is what licenses the async indexing in §3b; treating both halves as "strong" would put a search cluster in the write path for no user-visible benefit.

---

## 🏗️ 2. Full-Stack Architecture Overview (5-6 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ SearchBar   │  │ FilterPanel │  │ MapView     │  │ ReviewForm  │         │
│  │ (debounce)  │  │ (URL sync)  │  │ (list view) │  │ (optimistic)│         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                │                 │
│         └────────────────┴────────────────┴────────────────┘                 │
│                                   │                                          │
│                          ┌────────▼────────┐                                 │
│                          │   API Service   │  (fetch + typed helpers)        │
│                          └────────┬────────┘                                 │
└───────────────────────────────────┼─────────────────────────────────────────┘
                                    │ HTTP/REST
┌───────────────────────────────────┼─────────────────────────────────────────┐
│                              BACKEND                                         │
│                          ┌────────▼────────┐                                 │
│                          │   API Routes    │  (Express + handler validation) │
│                          └────────┬────────┘                                 │
│                                   │                                          │
│         ┌─────────────────────────┼─────────────────────────┐               │
│         │                         │                         │               │
│  ┌──────▼──────┐          ┌───────▼───────┐         ┌───────▼───────┐       │
│  │   Search    │          │   Business    │         │    Review     │       │
│  │   Service   │          │    Service    │         │   Service     │       │
│  └──────┬──────┘          └───────┬───────┘         └───────┬───────┘       │
│         │                         │                         │               │
│         ▼                         ▼                         ▼               │
│  ┌─────────────┐          ┌─────────────┐           ┌─────────────┐         │
│  │Elasticsearch│          │ PostgreSQL  │           │  RabbitMQ   │         │
│  └─────────────┘          │  + PostGIS  │           └──────┬──────┘         │
│                           └─────────────┘                  │                │
│                                   │                        ▼                │
│                           ┌───────▼───────┐         ┌─────────────┐         │
│                           │    Redis      │         │Index Worker │         │
│                           │   (Cache)     │         └─────────────┘         │
│                           └───────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two things about this topology are worth calling out before the deep dives.

**Postgres is both the source of truth and one of the two search indexes.** It isn't merely the durable store with search bolted on beside it — the `nearby` path queries PostGIS directly and never consults Elasticsearch, so the "database" and the "geo index" are the same box on the diagram. That is why an Elasticsearch outage degrades one feature rather than the product.

**The index worker is the only component that may lag.** Everything else on the write path is synchronous and transactional; the queue exists specifically to hold the one piece of work whose delay a user cannot perceive.

### Technology Stack

| Layer | Frontend | Backend |
|-------|----------|---------|
| Language | TypeScript | TypeScript |
| Framework | React 19 + TanStack Router | Express.js |
| Styling | Tailwind CSS | - |
| State | Zustand | - |
| Validation | HTML constraints + handler checks | Handler-level checks |
| HTTP | `fetch` wrapper with `credentials: 'include'` | - |
| Database | - | PostgreSQL + PostGIS |
| Search | - | Elasticsearch |
| Cache | - | Redis |
| Queue | - | RabbitMQ |

---

## 🔍 3. Deep Dive: The API Contract Between Two TypeScript Codebases (4-5 minutes)

Frontend and backend are both TypeScript, which makes it tempting to say the contract is type-checked. It is not, unless something deliberately makes it so.

Each side declares its own `Business`, `Review`, and search-response shapes. They agree today because a person kept them in agreement. Nothing in the build would notice if the backend renamed a column and passed the row straight through — both sides would compile, and the field would arrive `undefined` at runtime. This is not hypothetical: it is the single most common way these two-package repos break, and the symptom is always a UI rendering `undefined` rather than an error anyone can trace.

| Option | What it actually guarantees | Cost |
|--------|----------------------------|------|
| Duplicated interfaces (status quo) | Nothing — two independent claims about one contract | Silent drift |
| Shared types package | Both sides name the same fields | Monorepo build wiring; still doesn't check that the *handler* returns that shape |
| Types generated from the DB schema | The contract tracks the real source of truth | Codegen step; regenerate on every migration |
| Runtime schema validation at the edge | Catches violations in production, not at build | Per-request cost; schemas to maintain |

The honest answer is that the first two are weaker than they look. A shared type still doesn't stop a handler from returning a raw `pg` row — `pool.query` yields `any`, so the compiler has nothing to check against. What closes the gap is an **explicit mapping layer**: the handler constructs the response object field by field, typed against the shared definition, so the row→DTO translation is the thing the compiler verifies.

**The rule I'd enforce: never return a database row directly.** Not for casing, but because a raw row makes the database schema the public API — a column rename becomes a breaking change nobody noticed, and every column added is published to clients whether or not it should be. Three boring lines of mapping make the contract a decision instead of a leak.

Runtime validation still earns its place at exactly two boundaries: request bodies (an operator's typo) and anything user-submitted that reaches the database (a review's length, a photo's size). Inside those boundaries, types are enough.

---

## 🔍 3b. Deep Dive: Two Indexes for One Search Box (6-7 minutes)

"Find me a good taco place nearby" is two queries in one sentence, and they want opposite index structures.

*Taco* is relevance: tokenize, stem, boost a name match over a description match, tolerate "tacoo". *Nearby* is geometry: points within a radius, ordered by distance. An inverted index has no notion of a kilometer; an R-tree has no notion of a taco.

So both stay live, and the query shape decides which leads. Text search goes to Elasticsearch — `multi_match` across name/description/categories, optionally narrowed by a `geo_distance` filter, ranked by relevance. "Browse what's near me," which carries no text at all, never touches Elasticsearch: it runs `ST_DWithin` against a GIST index in PostGIS and orders by `ST_Distance`.

**Why not collapse to one?** Each direction fails specifically. Postgres-only means implementing relevance with `ILIKE` or `tsvector`: no per-field boosting, no fuzziness, no completion suggester — and a match on the business *name* ranking the same as one buried in a description is a visibly worse product. Elasticsearch-only means a pure geometry question, over data Postgres already holds exactly and authoritatively, now depends on a search cluster's availability *and its index freshness*.

**What this costs is a sync problem**, and it is the price of the whole design: two indexes over the same entities, which can disagree about what exists during an indexing lag. A newly created business is immediately findable by ID and by "nearby," and invisible to text search until the indexer catches up.

That is also why indexing goes through a durable queue rather than happening inline. Synchronous indexing puts a second datastore's availability into the write path of *posting a review* — a slow cluster makes submission slow, an unreachable one makes it fail, and the failure is nonsensical to the user because their review was valid and Postgres accepted it. Queuing inverts the priority correctly: the write always succeeds, search catches up. The accepted consequence is that with the queue down, the lag is unbounded, which is why a reconciliation job is a requirement rather than a nicety.

**And the subtlest line in the search path: fallback results are never cached.** When the circuit breaker opens and search degrades to Postgres, those results are returned but not written to Redis. Without that condition, an Elasticsearch outage doesn't just degrade search for its duration — it poisons the cache, so relevance-free results keep being served for the full TTL *after* ES recovers, and the cache keeps repopulating with degraded results the whole time the breaker is open. Refusing to cache them makes recovery immediate. The cost is that the fallback path gets zero cache relief exactly when the system is under the most stress.

---

## 🔍 3c. Deep Dive: Who Owns the Star Rating (4-5 minutes)

Every business card in every search result shows a rating. Computing `AVG(rating)` at render time means aggregating a business's whole review history on every impression — so it has to be denormalized, and the moment it is, someone has to own keeping it correct.

The column that makes this work is not the average. It's **`rating_sum` stored alongside `review_count`**, with `rating` derived from the two. Storing only the average and trying to update it incrementally is the trap: you cannot back one contribution out of a mean without knowing both the count and the total. With the sum, an edited review is `sum - old + new` in a single statement — exact, not approximate, and no recomputation.

It lives in a **database trigger** rather than application code for the same reason aggregates usually should: the trigger runs inside the transaction that changed the review, so a crash cannot leave a business with 47 reviews and a rating computed from 46. Application-level maintenance is a second statement that can fail independently, and nothing reconciles it afterwards.

What I give up: the logic is invisible to anyone reading the TypeScript, it can't be unit-tested with the rest of the app, and a bulk import fires it per row.

**The deeper problem it doesn't solve** is that an unweighted mean is a bad ranking signal. A business with one 5-star review outranks one with two hundred at 4.8, which is exactly backwards as a recommendation. The standard fix is a Bayesian prior — shrink toward the global mean in proportion to how few reviews there are — and the reason not to reach for it immediately is explainability: users understand "4.5 stars from 200 reviews" and cannot verify a shrunk score against the reviews they can see. My inclination is to keep the displayed average honest and apply the shrinkage only to *ranking*, so the sort order is statistically sane while the number on the card remains something a user can check.

---

## 🔎 3d. Deep Dive: URL as the Search State (3-4 minutes)

Search state lives in the URL — query, location, every filter, and the page number — not in a store.

The pull toward a store is real: filters are a form, forms are component state, and syncing to the URL on every keystroke is extra work. It's still wrong for this surface, for three reasons that only show up after launch. **A shared link has to reproduce what the sender saw** — "check out these tacos near me" is one of the primary ways a discovery product spreads, and it silently doesn't work if the results depend on invisible state. **The back button has to behave**, and if filters live in a store, backing out of a business page restores the route but not the filters the user spent thirty seconds setting. **And reload has to be non-destructive**, which store-held state only survives if you also persist it, at which point you've reimplemented the URL badly.

The two details that make it workable: filter changes use `replace` rather than `push`, so adjusting four filters leaves one history entry instead of four and the back button goes where the user expects; and the URL is the single source of truth, with components reading from it rather than mirroring it into local state, because a mirror is a second copy that can disagree during navigation.

What it costs is that every filter change is a navigation, so the results component must handle rapid successive updates without flashing empty — and long filter combinations make ugly URLs, which matters exactly as much as it sounds like it does.

---

## 🔍 4. Deep Dive: Search Flow End-to-End (8-10 minutes)

### Frontend: SearchBar with Autocomplete

The SearchBar component uses a debounced query (200ms delay) to fetch autocomplete suggestions. It maintains local state for the input value and suggestions list. An AbortController cancels in-flight requests when the user types more. Suggestions display business names with categories, and clicking navigates to /search with query params.

### Backend: Autocomplete Endpoint

The autocomplete endpoint validates input with Zod (min 2, max 50 chars), checks Redis cache first (key: autocomplete:{query}), then queries Elasticsearch using multi_match with bool_prefix type on name.autocomplete, categories, and description fields. Results are cached for 5 minutes.

### Backend: Search Endpoint with Geo-Distance

The main search endpoint builds an Elasticsearch query with geo_distance filter (using lat/lng/radius), text matching with fuzziness, and optional filters for category, minRating, and priceLevel. Sort options include distance (using _geo_distance), rating (desc), reviews count (desc), or relevance (score + distance). Aggregations provide facets for categories and price levels. Results are cached for 2 minutes with a cache key built from normalized query parameters.

### Frontend: Search Results Page

The SearchPage component syncs filters with URL search params, fetches user geolocation if not provided, and displays results in list or map view. FilterPanel updates URL params on change (replacing history to avoid back button pollution). Pagination controls navigate pages. The results count shows cache hit status for transparency.

---

## 🔍 5. Deep Dive: Review Submission Flow (8-10 minutes)

### Frontend: Review Form with Optimistic Updates

"I'm implementing optimistic updates because reviews should feel instant. The form generates a UUID idempotency key, creates a temporary review with a temp-{key} id, adds it to the UI immediately, then sends the POST request. On success, we swap the temp review for the real one. On failure, we remove the temp review and show an error."

The ReviewForm component uses react-hook-form with zodResolver for validation. It tracks submission state and handles three scenarios: success (replace temp with real review, update business rating), conflict (user already reviewed this business), and rate limit (show retry message).

### Backend: Review Creation with Idempotency

The backend review route first checks if the idempotency key exists in Redis (cached for 24 hours). If found, it returns the cached response. Otherwise, it starts a PostgreSQL transaction:

1. Check for existing review (unique constraint also catches this)
2. Insert review (database trigger updates business rating_sum and review_count)
3. Get updated business rating
4. Commit transaction
5. Publish index.update event to RabbitMQ for async Elasticsearch sync
6. Invalidate Redis caches (business:{id} and search:* keys)
7. Cache response with idempotency key
8. Return review with user info and updated business rating

### Frontend: Business Page with Optimistic Reviews

The BusinessDetailPage maintains state for business and reviews. The handleOptimisticAdd function adds the temp review and calculates a new average rating. The handleOptimisticRemove function removes the temp review and refetches business data to restore correct rating. The handleReviewCreated function swaps temp for real review and updates the rating from the server response.

---

## 🔍 6. Deep Dive: API Client with Type Safety (4-5 minutes)

"I'm using a typed API client wrapper around Axios. Each endpoint has a specific function with typed parameters and return values. This catches API mismatches at compile time rather than runtime."

### Typed API Client

The api module exports domain-specific clients:

**searchApi**: search(params: SearchRequest) returns SearchResponse, autocomplete(q: string) returns suggestions array

**businessApi**: getById(id) returns Business, getReviews(id, page, limit) returns reviews with hasMore, createReview(businessId, data, idempotencyKey) returns CreateReviewResponse

**authApi**: login, register, logout, me endpoints for session management

The base Axios instance includes credentials (for session cookies) and a response interceptor that redirects to /login on 401 errors.

---

## 🔍 7. Deep Dive: Rate Limiting Integration (3-4 minutes)

### Backend: Rate Limit Middleware

The rateLimit middleware uses a Redis Lua script for atomic check-and-increment. It tracks request count per key (e.g., user ID or IP) within a sliding window. Response headers include X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset. When exceeded, returns 429 with Retry-After header.

Configuration example for reviews: limit 10, windowSeconds 3600 (10 reviews per hour per user).

### Frontend: Handling Rate Limit Errors

The Axios response interceptor catches 429 errors, extracts the retryAfter value from the response, and shows a user-friendly toast message like "Too many requests. Please try again in X minute(s)."

---

## 🔍 8. Deep Dive: Error Handling (3-4 minutes)

### Backend: Error Middleware

The error handler middleware handles multiple error types:
- **ZodError**: Returns 400 with validation details (path and message for each issue)
- **AppError**: Custom errors with statusCode, message, and optional code
- **Database constraint violations** (code 23505): Returns 409 "Resource already exists"
- **Unknown errors**: Returns 500 "Internal server error" and logs full stack trace

### Frontend: Error Boundary

A React ErrorBoundary component catches rendering errors, logs them (with error reporting in production), and displays a fallback UI with a reload button. This prevents the entire app from crashing due to component errors.

---

## 🛡️ 8b. Deep Dive: Rate Limiting as an Integrity Mechanism (4-5 minutes)

On most products rate limiting is a politeness feature protecting the servers. Here it is the *product's* integrity mechanism, because ratings drive revenue for the businesses being rated — which means there is a real adversary with a financial motive, and the thing being protected is the trustworthiness of the score, not the CPU.

That changes the design. A single global cap can't express what abuse looks like, because the abusive pattern and the legitimate one differ in shape, not volume. Four independent limits, all as atomic Redis operations:

| Limit | Bound | The attack it addresses |
|-------|-------|------------------------|
| Reviews per user | 10 / hour | Bulk posting from one account |
| Reviews per user **per business** | 2 / day | One account grinding down one competitor indefinitely — well inside any global cap |
| Review actions per IP | 20 / hour | Many fresh accounts from one source, which per-user limits are blind to by construction |
| Votes per user | 5 / minute | Vote-brigading a review into invisibility, which is cheaper than writing one |

The per-user-per-business limit is the one worth defending in an interview, because it's the one a global limit cannot substitute for: a prolific honest reviewer covering fifty different businesses is unaffected, while the single-target pattern is stopped at two per day. The per-IP limit exists because per-user limits assume accounts are expensive, and they aren't.

**What this costs:** four counters per action, four ways to be wrong, and a false-positive surface a single limit wouldn't have — a shared office or campus NAT hits the per-IP bound with entirely legitimate traffic. The mitigation is that the IP limit is deliberately the loosest of the four and applies to actions rather than reviews, so it degrades a shared network's experience rather than blocking it.

**And the honest limitation: these bound volume, not coordination.** A campaign of thirty real accounts, each posting one review from a different address, stays under every limit here and is exactly the attack that matters. Catching it needs a different class of signal — account age at time of review, text similarity across reviews, or the timing correlation between accounts that otherwise share nothing. Rate limits are the floor, not the defense.

---

## ⚖️ 9. Trade-offs and Alternatives (3-4 minutes)

### API Design

| Option | Decision |
|--------|----------|
| ✅ REST | Simple, cacheable, familiar - fits CRUD well |
| ❌ GraphQL | Flexible queries but adds complexity, harder caching |
| ❌ tRPC | Full type safety but tight coupling, learning curve |

### State Management

| Option | Decision |
|--------|----------|
| ✅ Zustand | Lightweight, simple - right-sized for this app |
| ❌ TanStack Query | Great for server state but overkill for simple cases |
| ❌ Redux | Predictable with DevTools but too much boilerplate |

### Validation

| Option | Decision |
|--------|----------|
| ✅ Zod (shared) | Type inference + runtime validation - single source of truth |
| ❌ Yup | Mature and expressive but no TypeScript type inference |
| ❌ io-ts | Functional style but steep learning curve |

---

## 📊 10. Monitoring and Observability (2-3 minutes)

### Frontend Performance Metrics

Web Vitals collection (CLS, FID, FCP, LCP, TTFB) using the web-vitals library. Metrics are sent to the backend via navigator.sendBeacon to avoid blocking page unload. Each metric includes the page path and timestamp.

### Backend Request Tracing

A tracing middleware generates/propagates request IDs (X-Request-ID header), logs method, path, status, duration, and userId on response finish. Prometheus metrics track HTTP request duration histograms with labels for method, path, and status code.

---

## 🧵 11. What Breaks First (3 minutes)

Asked to operate this, the order things fail is more useful than a scaling diagram.

**Search and Postgres disagree.** Indexing is async through a queue, and nothing schedules reconciliation. A broker outage leaves the two permanently divergent — businesses that exist and are reachable by URL but cannot be found by searching for them. This is the failure users report as "your search is broken" and operators can't reproduce, because the record is right there in the database. It needs a drift metric before it needs a fix: count rows in Postgres against documents in the index, and alert on the delta.

**The search cache fragments.** The cache key includes the caller's exact coordinates, so two users a hundred metres apart never share an entry. Hit rate collapses precisely in dense areas where load is highest and results would be nearly identical. Snapping coordinates to a grid before keying fixes it — and the grid size is a real trade-off, because coarse enough to be useful is also coarse enough to make "0.2 miles away" wrong.

**Ratings stop meaning anything at the low end.** Covered in §3c: the unweighted mean makes one review outrank two hundred. This degrades quietly as the long tail of businesses grows, and it is a ranking-quality failure with no error message attached.

**Review abuse outgrows rate limits.** The limits bound volume per identity; a coordinated campaign is under all of them. This is the failure with an actual adversary behind it, so it gets worse specifically as the platform becomes worth attacking.

Note what is *not* on this list: request throughput. Nothing here is CPU- or connection-bound at any plausible scale for this product. Every real failure is a consistency, ranking, or integrity problem — which is a fair summary of what local-discovery systems are actually about.

---

## 🚀 Summary

The key full-stack insights for Yelp's design are:

1. **Shared Type System**: TypeScript types and Zod schemas shared between frontend and backend ensure contract consistency and catch mismatches at compile time

2. **End-to-End Search Flow**: Debounced autocomplete with abort controllers, geo-aware search with Elasticsearch, and URL-synchronized filters provide seamless UX

3. **Optimistic Updates with Rollback**: Review form adds temp review immediately, updates on success or rolls back on failure - keeps UI responsive while maintaining consistency

4. **Idempotency for Mutations**: UUID-based idempotency keys prevent duplicate reviews on network retries, with Redis-cached responses for repeat requests

5. **Rate Limiting Integration**: Backend enforces limits with clear headers; frontend handles 429 errors gracefully with user-friendly retry messages

6. **Type-Safe API Client**: Axios wrapper with typed methods ensures request/response types match backend contracts

7. **Error Handling at All Layers**: Zod validation errors, database constraints, and application errors are handled with appropriate status codes and user-friendly messages

This architecture delivers a cohesive experience where frontend and backend work together to provide fast, reliable, and user-friendly business search and review functionality.
