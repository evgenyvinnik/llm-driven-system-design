# Google Search: full-stack system design interview

A 45-minute spoken outline for a proposed text-search product.
The repository's actual implementation is compared with the proposal at the end.

## 🎯 Requirements and budgets — 4 minutes

> “I would connect two journeys: a page becoming searchable,
> and a person submitting a query and reading the right results.
> They run at different speeds and meet at the published search index.”

The first product searches a selected corpus of public text pages.
It supports autocomplete, terms and common operators, ranked excerpts,
shareable query URLs, and bounded page navigation.

I would leave ads, generated answers, image search, voice search,
and personalized ranking outside the initial interview scope.
Authenticated operators can manage crawl/index jobs; public search is anonymous.

| Planning assumption | Consequence |
|---|---|
| 100M indexed pages | Separate ingestion, durable storage, and indexed serving |
| 100M searches/day | About 1,157 QPS average; assume 10,000 QPS peak for planning |
| Ten results/page | A small complete response and ordinary semantic list are sufficient |
| 200 ms p95 API budget | Bound retrieval, ranking, cache waits, and retries |
| 500 ms submit-to-result target | Network and browser rendering need their own budgets |
| 10M daily fetches | Daily freshness is possible only for a prioritized subset |

The interface should stay usable while requests are outstanding.
A result must belong to the current query and filters.
An unavailable search must be distinguishable from a search with no matches.

These are design assumptions to validate, not measured behavior of the local demo.

## 🏗️ High-level architecture — 6 minutes

> “I would start with this connected diagram and trace both journeys.
> The browser owns interaction; the server owns search semantics;
> the publishing pipeline decides which corpus is visible.”

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                    │
│                                                                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Search + result views  │     │ Navigation model       │     │ Data access            │  │
│  │ Draft / focus / text   │◀───▶│ URL / window / expiry  │◀───▶│ Guard response / cache │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                                                                            ▲               │
│                                                                            │               │
└────────────────────────────────────────────────────────────────────────────┼───────────────┘
                                                                             │
                                 HTTPS search / suggest / status             │
                                                                             │
                                                                             ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Published index        │        │ Query cache            │        │ Search API             │
│ Document shards        │        │ Query/rank/corpus key  │◀──────▶│ Rank / window / status │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
   ▲        ▲                                                                             ▲
   │        │                                                                             │
   │        │                   Cache miss: API queries index                             │
   │        └─────────────────────────────────────────────────────────────────────────────┘
   │
   │  publish / ACK
   │
   ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Index + rank pipeline  │        │ Pages + link graph     │        │ Frontier + fetchers    │
│ Verify / publish / ACK │◀──────▶│ Durable crawl versions │◀──────▶│ Host budget / robots   │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘

New crawl content becomes visible after indexing; the UI receives complete pages.
```

For the user journey, submitting the search commits a URL and a request identity.
Data access asks the API for a ranked page.
The API reads the query cache or retrieves from the published index on a miss.
The response is validated and rendered only if it still matches the active search.

For the content journey, fetchers write versioned pages and outgoing links.
The pipeline builds and validates a searchable generation with rank metadata.
It publishes that generation while the previous good one remains recoverable.
Queries never wait for a live fetch of the web.

I would use a publication change while someone reads page two as the recovery example:

1. The browser continues its matching result window, preserving query intent and reading position.
2. The API uses that window's corpus/rank context; an expired or unavailable window causes an explicit restart.
3. Fetchers and builders recover from durable versions and confirmed effect checkpoints, independently of the active search request.
4. Publication exposes a validated generation and records the outcome. Earlier windows either retain their supported generation or expire visibly; they never silently append new ordering.

The cache is a branch off the API, not a mandatory storage authority.
If it fails, bounded direct retrieval can continue subject to capacity.
Suggestions use an independently budgeted prefix service behind the same API boundary.

The first implementation could use React, a router, and a small shared store,
Express query services, Elasticsearch, PostgreSQL metadata, object storage,
and a distributed cache. The diagram's responsibilities matter more than those brands.

## 💾 Shared model and API contract — 5 minutes

### Ownership across the boundary

| Data | Owner | Why |
|---|---|---|
| Draft text and active suggestion | Browser input | Editing must not wait for server agreement |
| Submitted query and requested page | URL/router | Sharing and Back/Forward should preserve intent |
| Current response and loading/error state | Browser request model | Prevent mismatched results after navigation |
| Operator parsing and ranking | Search service | One interpretation across all clients |
| Result window and expiry | Search service | Stable navigation while the corpus changes |
| Crawl version and index generation | Ingestion/publisher | Search must expose a known corpus state |
| Recent local queries | User-controlled browser preference | Separate from aggregate public suggestions |

### Proposed endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/search` | Query, page size, optional result-window/page |
| GET | `/api/search/autocomplete` | Prefix and locale; bounded suggestions |
| POST | `/api/admin/crawl/jobs` | Authenticated, bounded job submission |
| GET | `/api/admin/jobs/:id` | Durable job state and failure information |

I would use a small REST contract because these operations have predictable shapes.
GraphQL can also express them; it would not remove the need for cache identity,
request validation, or a stable pagination contract.

The response contains result IDs, plain titles, safe destinations,
excerpts and highlight spans, count relation, freshness, and navigation expiry.
The server returns the interpreted query so operator behavior can be explained.

Both sides validate at runtime where untrusted data enters.
Shared TypeScript declarations improve maintenance but disappear at runtime.
I would test the contract with malformed limits and unexpected response fields.

The job response means “accepted” and includes an ID.
Only a later completed state means all required processing succeeded.
This distinction prevents a two-second UI refresh from becoming a false completion signal.

## 🔧 Deep dive: keeping search intent and visible results aligned — 8 minutes

### Decision

> “I would separate draft typing from submitted search state,
> then guard every response against the active request.
> This makes the browser's behavior understandable even when requests finish out of order.”

Typing updates the input immediately and starts a 200 ms suggestion debounce.
The user can submit at any point; autocomplete is optional assistance.
Submission commits the query to the URL, resets the requested page,
and creates a new search generation.

The generation belongs to the complete query context.
It changes for query, filters, locale, page size, or navigation session changes.
The response and its error/loading state are accepted only for the current generation.

### The race to explain

A user searches for “java,” then quickly submits “python.”
The Python request returns first and becomes visible.
The Java request later succeeds or fails.
Either outcome must be ignored rather than replace Python results or their status.

Aborting superseded fetches helps reduce waste.
It is not the correctness boundary: cancellation can race with completion.
The final state-update guard is still required.

### Trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ URL intent + keyed response lifecycle | Correct Back/navigation and predictable display | More explicit state than a single result object |
| ❌ One global unkeyed response | Easy initial implementation | Late requests can show the wrong query's results |
| ❌ Disable all interaction during fetch | Avoids some overlap | Makes slow networks block useful editing |

The chosen approach allows a user to keep refining the query.
It gives up the simplicity of one mutable response slot,
but that complexity represents real concurrent interactions already happening.

### Input behavior

A focused combobox provides a suggestion list with explicit active-option state.
Arrow keys navigate, Escape dismisses, and Enter accepts or submits once.
Recent-history and server-suggestion choices should use the same selection action.

During composition, Enter completes text entry rather than submit a query.
On dismissal or unmount, invalidate pending popup requests.
A late suggestion response must not reopen a popup the user closed.

I would test focus and announcements on keyboard and screen readers.
The [WAI-ARIA combobox guidance](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
is a reference for interaction, not evidence that the local UI already conforms.

### Results and failures

A new query gets a clear loading state without freezing the input.
A same-query page transition can retain the previous page temporarily,
but must label it as old and avoid pairing it with the new page number.

“No matches” follows a completed search.
“Search unavailable” follows a failed request.
“Some results unavailable” requires a partial-response contract from the server.
The browser should not infer those outcomes from an empty array alone.

Retry preserves the query and follows server retry timing.
Avoid unbounded automatic retry loops during overload.
Optional suggestion failures should never block explicit search submission.

## 🔧 Deep dive: coherent ranking, caching, and pagination — 8 minutes

### Decision

> “I would apply query constraints before ranking,
> then serve a bounded stable result window.
> The browser and server need to agree what ‘page two’ refers to.”

The server parses phrases, exclusions, and site operators into one query structure.
The index evaluates those constraints while retrieving candidates.
For site filters, hostname boundaries matter: substring matching is insufficient.

Filtering only after taking ten hits can produce a nearly empty page
while valid matches exist later in the candidate set.
It also makes the displayed count disagree with visible results.
I would define count value and exact/lower-bound/approximate relation explicitly.

### Retrieval and ranking

Document shards perform multi-term matching locally and return bounded candidates.
The coordinator merges them with comparable scoring and applies useful rank signals.
A more expensive reranker is optional and requires evidence of relevance improvement.

A fixed candidate cutoff can lose relevant pages.
I would measure recall before claiming that reranking the first thousand hits is sufficient.
New pages also need nonzero quality priors so missing link history does not erase relevance.

Link scores are computed offline from a named graph snapshot.
They are distinct from the time a document was last fetched.
The server should not treat a new fetch of unchanged text as a new publication date.

### Cache contract

A cache key includes the canonical query structure, locale, safety policy,
page size, corpus generation, ranking version, and a freshness-time bucket.
The cached object contains the ordered result window and its context.
It never represents the global source of truth for the corpus.

For an initial ten-page limit, a window might hold the first 100 results.
The response includes a short-lived handle for that ordering.
Page changes refer to that handle; the browser can cache visited pages within it.

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Bounded stable window | Consistent navigation and reusable results | Memory, expiry, and capped depth |
| ❌ Rerun an offset query on every click | Simple numbered URLs | Changed scores can repeat or skip results |
| ❌ Unlimited retained sessions | Long-lived stable navigation | Unbounded memory and retained-index cost |

The trade-off is visible expiry.
If the window disappears, the server returns an explicit restart outcome.
The browser retains the query and asks for fresh results,
instead of silently returning a different order under the old handle.

A shared query URL recreates the query, not an immutable result page.
That is an honest contract for a changing public corpus.
If deep traversal becomes necessary, a snapshot and deterministic continuation
can extend the model, with bounded resource lifetime.

### Outages and overload

Use a short cache deadline and bounded bypass to the index.
Coalesce identical misses so a hot query does not create a simultaneous retry storm.
If the index cannot complete retrieval, return unavailable or explicitly partial results.

A five-minute TTL does not guarantee any particular hit ratio.
Measure the traffic distribution and freshness tolerance before tuning retention.
A completed cache write should not be required to return a successful search.

### Safe response rendering

The server chooses excerpts using its matching context.
It returns text and permitted highlight spans, not arbitrary crawled HTML.
The client renders text, validates destinations, and falls back to plain text on bad spans.

This avoids duplicating stemming and phrase logic in the browser,
while keeping the response small and the rendering boundary explicit.
Ten result cards need ordinary pagination, not virtualization or streamed reordering.

## 🔧 Deep dive: from fetched page to published result — 8 minutes

### Decision

> “I would make crawl work retryable and index publication explicit.
> A completed HTTP fetch is not yet a searchable result,
> and an accepted admin request is not a completed index job.”

The frontier keeps URL identity, origin, priority, next eligible fetch,
and a leased attempt token.
An atomic claim prevents two current workers from owning the same attempt.
Expired work is recoverable, and stale completions cannot overwrite newer versions.

Per-origin budgets control request spacing and concurrency.
More crawler instances add coverage across origins, not permission to overload one site.
Priority needs aging so long-tail pages eventually get revisited.

### Content flow

1. Check robots policy, DNS resolution, and every redirect destination.
2. Fetch with bounded bytes, time, and decompression work.
3. Persist an artifact, then commit its content version and processing event.
4. Parse text and outgoing edges, including links to targets already known.
5. Build documents against a corpus checkpoint and named graph/ranking version.
6. Inspect all indexing item outcomes and retain failures for retry or correction.
7. Validate and publish the completed generation; update durable job status.

The metadata commit and processing event belong together.
Otherwise a crash after content storage can leave a page that never reaches indexing.
An orphaned artifact is cheaper to reclaim than a missing processing event is to discover.

### Publication trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Validated generation publication | Failed rebuilds leave the last good corpus serving | Extra storage and build capacity |
| ❌ Replace the active index during a build | Minimal staging state | Queries can see an incomplete corpus |
| ❌ Treat bulk HTTP success as complete | Easy job bookkeeping | Failed items disappear behind a false success report |

A deterministic document ID handles repeated delivery of the same identity.
A version check prevents a late old update from replacing a newer document.
Those are separate invariants, and both matter during retries.

Deletion also needs a versioned event.
Otherwise removing a page from the document store leaves an old searchable hit behind.
The publisher must account for deletes and failed items when validating a generation.

### What the admin UI should say

| Job state | UI message / action |
|---|---|
| Accepted | Show job ID and scope; avoid claiming progress yet |
| Running | Show meaningful completed/failed counts and last update |
| Failed | Explain the failed stage and whether a retry resumes or restarts |
| Completed | Show published generation or confirmed completed operation |

The admin can poll a durable job endpoint at a modest interval.
A push channel is optional if operators need frequent progress updates.
Neither transport can replace durable state after a process restart.

The public search path continues against the last good generation during failures.
New content becomes visible after publication, according to the freshness policy.
This is eventual visibility with explicit checkpoints, not exactly-once network delivery.

### Security at both ends

Authenticate operators before accepting crawl seeds or build commands.
Do not trust a caller-supplied API-key string as an identity by itself.
Validate crawl destinations at connection time, including redirects and private networks.

Search text and excerpts are untrusted at the UI boundary.
Aggregate and filter query data before using it for public suggestions.
Give users control over local history and apply deliberate retention to server logs.

## 📈 Scaling and verification — 4 minutes

I would measure the end-to-end path instead of adding component latency guesses.
Break down submit-to-render into request wait, retrieval, ranking, payload transfer,
and browser rendering on representative devices.

On the backend, index CPU/I/O and shard fan-out are likely early bottlenecks.
Add replicas for serving capacity and isolate builders from query workloads.
The crawler scales across origins; a single site's budget remains unchanged.

On the frontend, repeated network work and bundle size matter more than ten DOM cards.
Optional prefetch should be bounded and work for keyboard/touch intent,
not depend exclusively on a mouse hover.

### Scenarios that cross the boundary

| Scenario | Expected behavior |
|---|---|
| Search A finishes after B | Browser retains B's results and status |
| Site filter excludes early candidates | Retrieval still fills the page from eligible matches |
| Page size differs for the same query | Cache entries cannot return the wrong page shape |
| Search window expires | UI preserves intent and offers a fresh search |
| Bulk indexing has one failed item | Job/generation cannot falsely claim complete success |
| Crawler crashes before acknowledgment | Work is recovered with version/attempt protection |
| Excerpt contains markup | It appears as text or permitted highlights only |

Track query latency, partial/error rate, relevance judgments, cache effectiveness,
crawl due-age, failed indexing items, and time from content version to publication.
An increasing document count alone does not tell us whether search is correct.

### Choices to leave visible

| Choice | Why it fits | Cost accepted |
|---|---|---|
| ✅ Separate draft and request state | Responsive editing with correct results | Explicit lifecycle logic |
| ✅ Stable bounded result windows | Predictable page navigation | Expiry and memory |
| ✅ Document-sharded retrieval | Local matching of multiple constraints | Bounded scatter/gather |
| ✅ Validated publication | Search survives a failed rebuild | Extra storage and build coordination |

## 🧭 Close and repository comparison — 2 minutes

> “The design connects the product promise to backend guarantees.
> Search intent is explicit, result pages have a defined lifetime,
> and published content has a recoverable path from crawl to index.”

The repository has a React search/admin UI, Express routes, PostgreSQL content,
Elasticsearch text scoring, Valkey caching, and manual PageRank/index jobs.
It is useful for examining those boundaries on a small dataset.

The local code does not yet provide the guards shown here:
request races can overwrite results, highlight HTML is unsanitized,
admin operations are unauthenticated, and job acknowledgment is not durable completion.
Crawl schema/hash defects and seed statuses also affect the local workflow.

Current indexing lacks per-item success handling and generation publication;
search filters and cache keys do not fully preserve request semantics.
The proposal explains how I would evolve those boundaries, not what is already deployed.

See [architecture.md](./architecture.md) for source-verified details
and [README.md](./README.md) for the actual demo setup and limitations.
