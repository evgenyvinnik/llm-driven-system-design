# Google Search: backend system design interview

A 45-minute spoken outline for a proposed public-web search service.
The local implementation is compared with the proposal at the end.

## 🎯 Requirements and estimates — 5 minutes

> “I would separate acquiring the web from answering a query.
> A user's search should read an existing index, not wait for a crawler.
> The difficult boundaries are deciding what to crawl, publishing a trustworthy index,
> and keeping query latency predictable as the corpus grows.”

I would narrow the first design to a selected corpus of public text pages.
It includes terms, phrases, exclusions, site filters, ranked snippets, and suggestions.
Ads, image search, generated answers, and personal ranking are outside this discussion.

Public search can be anonymous.
Crawl administration and index publication require authenticated operators.
A successful search may be slightly stale; a failed search must not masquerade as empty.

| Assumption | Estimate | Design implication |
|---|---|---|
| Selected corpus | 100M pages | Large enough to require partitioned storage |
| Retained text | 50 KB/page, about 5 TB | Store versions outside query processes |
| Search volume | 100M/day, about 1,157 QPS average | Plan for 10,000 QPS peak, then measure |
| Crawl budget | 10M/day, about 116 fetches/s | Only a subset can meet a daily freshness goal |
| Query latency | p95 below 200 ms at the API | Bound fan-out, candidates, retries, and cache waits |
| Availability | 99.9% successful searches | Keep ingestion failures off the serving path |

Ten million daily fetches do not refresh a hundred-million-page corpus every day.
I would prioritize a selected daily tier and give the tail a longer schedule.
That arithmetic prevents an impossible freshness promise from entering the design.

The index-size multiplier depends on field mappings and compression.
For planning, 100 KB indexed storage per page means roughly 10 TB before replicas.
Two replicas would bring that to roughly 30 TB, before retained generations.

## 🏗️ High-level architecture — 6 minutes

> “I would draw the query path across the top and the ingestion path underneath.
> They meet at a published index, which is the key boundary in this system.”

```
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Browser / clients      │        │ Query coordinator      │        │ Query / window cache   │
│ Query + page           │◀──────▶│ Parse, rank, snippets  │◀──────▶│ Query/rank/corpus key  │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                              ▲
                                              │
                                              │  candidates / retrieval
                                              │
                                              ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Crawl frontier         │        │ Published index        │        │ Index publisher        │
│ Host leases + due URLs │        │ Document shards        │◀──────▶│ Validate + activate    │
└────────────────────────┘        │ Replicated generations │        └────────────────────────┘
            ▲                     └────────────────────────┘                    ▲
            │                                                                   │
            │  work / links                                                     │
            │                                          build / acknowledge      │
            │                                                                   │
            ▼                                                                   ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Fetch + parse          │        │ Durable pages + graph  │        │ Index + rank builders  │
│ Robots / egress checks │◀──────▶│ Versioned crawl output │◀──────▶│ Effects / checkpoints  │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘

Ingestion publishes asynchronously; queries never fetch the live web.

Publisher exposes only a validated generation; old generations expire after use.
```

The query coordinator parses intent, checks the cache, retrieves candidates,
combines ranking signals, and formats snippets.
It can be replicated independently from crawling and index construction.

On ingestion, a frontier assigns eligible URLs to fetchers.
Fetchers return discovered links and durable versioned content.
Builders transform that content into an index and link-score snapshot.
Publication exposes only a validated generation to queries.

I would follow one interrupted build through the return paths:

1. A fetch attempt completes only after its versioned artifact and processing obligation are durable; discovered links still follow the frontier's host budget.
2. Builders resume retained versions and checkpoint confirmed item effects, including removals. A successful bulk request is not proof every item succeeded.
3. The publisher validates the complete corpus/rank generation, records activation, and retains the previous good generation under a bounded rollback/session policy.
4. Queries and cached windows identify their generation. If a window expired or its generation is unavailable, return an explicit restart rather than mix result orders.

For suggestions, I would use a separately budgeted prefix index.
It is a side path from the coordinator, not a requirement for a search to succeed.
Its source is reviewed aggregate query data, not every raw search immediately published.

I would start with Elasticsearch document shards for retrieval,
PostgreSQL for a bounded frontier and job metadata,
object storage for retained artifacts, and a disposable distributed query cache.
Those choices fit the initial scope; they are not a claim about Google's stack.

## 💾 Data model and APIs — 5 minutes

### Records that matter

| Record | Key data | Access pattern |
|---|---|---|
| URL | Canonical identity, origin, due time, priority, attempt lease | Claim eligible work within an origin budget |
| Crawl version | URL ID, monotonic version, artifact reference, fetch outcome | Recover and rebuild without refetching the web |
| Link edge | Source content version, target URL, optional anchor text | Construct a named graph snapshot |
| Processing event | Event ID, URL/version, stage status | Retry unfinished work with bounded duplicate effects |
| Index manifest | Generation, corpus checkpoint, rank version, validation result | Activate only complete builds |
| Search window | Query context, ordered results, expiry | Stable bounded pagination |
| Operator job | Actor, command identity, state, failure details | Distinguish acceptance from completion |

URL identity and edge identity are different.
If a new page links to an already-known target, that edge still belongs in the graph.
A content hash helps identify duplicates; it does not replace version ordering.

Large identifiers should cross the API as strings.
The physical hash representation must match its database type's range.
Neither a TypeScript annotation nor a shortened digest proves correctness.

### API surface

| Method | Proposed endpoint | Purpose |
|---|---|---|
| GET | `/api/search` | Query and bounded page/window; return ranked results and status |
| GET | `/api/search/autocomplete` | Prefix suggestions with an independent limit |
| POST | `/api/admin/crawl/jobs` | Accept an authenticated, bounded crawl command |
| POST | `/api/admin/index/jobs` | Accept an index-build command |
| GET | `/api/admin/jobs/:id` | Read durable accepted/running/completed/failed status |

Search responses carry count value and relation, freshness timestamp,
corpus/ranking versions, and a navigation handle.
Unsupported syntax and invalid limits are validation errors.
A timed-out retrieval is a service error, not a successful zero-result response.

The operator job endpoints are proposed contracts.
The local project's existing admin paths are listed in its architecture document.

## 🔧 Deep dive: a polite, recoverable crawler — 8 minutes

### Decision

> “I would schedule within per-origin budgets and use leased attempts.
> Priority decides which eligible page is valuable; a lease decides who may fetch it.
> Those are different decisions.”

A global priority queue alone can overload a popular host.
A FIFO queue can spend the entire budget on stale, low-value duplicates.
I would select an eligible origin, then a due URL within that origin.

### Claim-to-commit flow

1. Normalize the URL conservatively and check its canonical identity.
2. Atomically claim a due URL with an attempt ID and expiry.
3. Reserve capacity under the origin's politeness budget.
4. Check robots policy, destination safety, and fetch limits.
5. Fetch and store a bounded artifact with its content version.
6. Commit metadata and a processing event only if the attempt is still current.
7. Record the next eligible fetch based on outcome and observed change frequency.

A worker crash leaves an expiring lease, not a permanently stranded row.
Another worker may retry after expiry.
If the old worker later finishes, its stale attempt cannot overwrite newer content.

### Scheduling trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Priority within origin budgets | Spend fetch capacity usefully while limiting each origin | More scheduling state and ownership coordination |
| ❌ Global priority only | Simple ranking of work | Busy origins dominate and can be fetched concurrently |
| ❌ Unbounded FIFO | Easy queue mechanics | No explicit freshness policy or protection from crawl traps |

The chosen design gives up maximum raw throughput against any single origin.
That is intentional: adding machines does not give us permission to hit a site faster.
We scale by covering more eligible origins concurrently.

Priority also needs aging or a maximum wait.
Otherwise low-ranked pages never get revisited and cannot become important later.
If all currently inspected hosts are delayed, wait for eligibility rather than declare completion.

### Content and graph correctness

A parser extracts text and all usable outgoing edges.
When a source page changes, its current graph edges replace the older version's edges.
Otherwise removed links continue contributing authority forever.

Exact content hashes catch byte-identical duplicates.
Near-duplicate pages require a separate similarity policy,
with careful canonical selection so useful distinct pages are not suppressed.
I would start simple and measure duplication before introducing that machinery.

The raw artifact is stored before committing its database reference.
An orphaned artifact can be collected later if the metadata transaction fails.
The transaction includes a durable processing event so indexing can resume after a crash.

### Host failures and egress

Robots requests use the correct origin, including scheme and port.
A server/network failure is different from a valid allow response.
I would defer or use an eligible cached policy according to the protocol.

Validate every resolved destination and redirect before connecting.
Do not allow a public seed URL to redirect the crawler into internal services.
Bound redirects, bytes, decompression, parse time, and discovered-link expansion.

This work runs away from query servers.
A malicious or slow page should consume a bounded fetch slot,
not block someone trying to search already-indexed documents.

## 🔧 Deep dive: index placement, versions, and publication — 8 minutes

### Decision

> “I would shard documents, retain versioned crawl output,
> and publish validated index generations.
> Fewer RPCs are not automatically cheaper if each RPC moves a huge posting list.”

An inverted index maps terms to matching document IDs and positions.
With document sharding, each shard can evaluate all terms and phrase constraints
against the documents it owns before returning a small candidate set.

A query fans out across the selected collection's shards.
The coordinator merges candidates and accounts for score comparability.
Replica-aware routing helps distribute reads, while shard sizing controls coordination cost.

### Sharding trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Document shards | Local multi-term/phrase matching and bounded candidate replies | Scatter/gather and score calibration |
| ❌ Term shards | Fewer term owners contacted | Posting-list transfer, distributed intersections, frequent-term hot spots |
| ❌ One enormous shard | No merge layer | Storage, recovery, and query capacity become a single bottleneck |

For a common two-word query, term sharding may require intersecting very large lists.
Counting two servers versus many document shards hides that data movement.
Term placement can be valid for specialized workloads, but I would not claim
Elasticsearch implements it simply because I drew term names inside boxes.

### Versioned writes

Each processing event identifies a URL and content version.
Repeated delivery must converge on the same indexed version.
A late event must not overwrite a newer document, even if its network call succeeds later.

A deterministic ID prevents duplicate document identities.
It does not by itself prevent stale content from replacing fresh content.
That requires a version check or a build process pinned to a consistent checkpoint.

A bulk response can succeed at the HTTP level while individual items fail.
The builder inspects every item and records only confirmed successes.
Transient failures are retried individually; permanent failures remain visible to operators.

### Publication flow to add under the overview

```
┌────────────────────────┐          ┌────────────────────────┐
│ Crawl checkpoint       │          │ Build generation G     │
│ + graph version        │─────────▶│ Inspect every item     │
└────────────────────────┘          └────────────────────────┘
                                                │
                                                │
                                                │
                                                │
                                                │
                                                ▼
┌────────────────────────┐          ┌────────────────────────┐
│ Keep serving G - 1     │          │ Validate G             │
│ if build fails         │◀─────────│ Coverage + relevance   │
└────────────────────────┘          └────────────────────────┘
                            fail                │
                                                │
                                                │
                                                │  pass
                                                │
                                                │
                                                ▼
                                    ┌────────────────────────┐
                                    │ Activate manifest G    │
                                    │ Retain old sessions    │
                                    └────────────────────────┘
```

The cost is extra disk, build time, and temporary retention of old generations.
I accept that for a first design because an interrupted rebuild cannot replace
our last working index with a half-built corpus.

Incremental publication is a reasonable next step when freshness demands it.
It still needs versioned updates, deletion propagation, and stable query snapshots.
I would not add that complexity before measuring the full-generation bottleneck.

## 🔧 Deep dive: relevant results within a latency budget — 8 minutes

### Decision

> “I would apply semantic constraints during retrieval,
> bound ranking work, and cache a coherent result window.
> I would spend expensive ranking effort only where it improves measured relevance.”

The parser produces a structured representation of terms and operators.
Quoted phrases require positional matches.
Exclusions remove candidates, and site constraints use explicit host boundaries.
All those predicates run before selecting the page.

Filtering ten retrieved results in application memory is not equivalent.
It can leave one result on page one while eligible matches exist farther down,
and the unfiltered count becomes misleading.

### Candidate retrieval and rank signals

Begin with lexical relevance, field boosts, and cheap stored quality signals.
If a richer ranker is justified, retrieve a bounded candidate pool
and apply the expensive model only to that pool.

Measure recall at the candidate cutoff using judged queries.
A reranker cannot recover a relevant page that retrieval never returned.
Navigational and rare-term queries may need different candidate strategies.

Link authority is computed offline against a named graph snapshot.
PageRank distributes rank through outgoing links and redistributes dangling-node mass.
Its convergence threshold and schedule must be tested against corpus size and change.

Do not multiply by an unguarded zero authority value.
New documents need a neutral prior so lexical relevance can make them discoverable.
Fetch time is also not publication time: repeatedly recrawling old content
must not make it appear newly written.

### Ranking trade-off

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Bounded candidates + justified reranking | Predictable CPU budget and richer scoring where useful | Candidate cutoff can lose relevant results |
| ❌ Expensive scoring on every match | Broadest use of features | Latency and cost grow with common-query match sets |
| ❌ Lexical score alone forever | Simple, explainable baseline | Misses quality signals when they are demonstrably useful |

The alternative is not inherently wrong at small scale.
I would keep a lexical baseline for evaluation and fallback,
and only retain a ranker that improves quality within the budget.

### Cache and navigation consistency

The cache key includes the query structure, locale, safety policy, page size,
corpus generation, rank version, and freshness-time bucket.
Leaving out page size can return the wrong shape even without any index changes.

Materialize a bounded ordered window, for example the first 100 results,
and let a short-lived session refer to it.
Next/Previous uses that ordering while the window is available.
Expiry or eviction asks the client to restart explicitly.

This trades memory for stable browsing.
For example, 100,000 windows at about 100 KB each already need roughly 10 GB,
before replication and object overhead.
The product should cap depth and retention rather than expose unlimited page jumps.

A shared query URL can recreate search intent without preserving a temporary window.
For deeper snapshot traversal, we could later use a point-in-time index view
and deterministic continuation sort values, with explicit resource expiry.

### Degradation

The cache is optional: use a bounded timeout and bypass it if possible.
Coalesce popular misses and shed excess work so bypass does not overload the index.
Try a healthy shard replica within the remaining deadline.

Return a clear unavailable or partial status when retrieval cannot complete.
Do not cache a failure as a successful empty result.
Analytics and suggestion learning happen asynchronously after response preparation.

## 📈 Scaling, observability, and verification — 3 minutes

The first serving bottleneck is likely index work or fan-out tail latency.
Measure query CPU, shard queues, retrieval completeness, and merge cost.
Add replicas for read capacity and isolate indexing resources from serving.

The frontier and graph eventually outgrow a single PostgreSQL node.
Partition by origin ownership and export graph snapshots to batch workers.
The whole graph must not remain a required in-memory object in a Node.js API process.

I would track crawl due-age, expired leases, bulk-item failures,
publication lag, cache misses, query latency, partial results, and judged relevance.
A document count alone does not establish freshness or correctness.

| Failure experiment | Invariant to verify |
|---|---|
| Worker dies after fetching | Lease recovery resumes work; late output cannot overwrite newer content |
| One bulk item fails | Failed item remains retryable; generation is not falsely complete |
| New index generation is bad | Last good generation continues serving |
| Cache is unavailable | Bounded bypass or explicit overload response |
| Rank version changes mid-session | Existing window retains its original order |

## 🧭 Close and local comparison — 2 minutes

> “My design keeps the crawl pipeline recoverable and the query path bounded.
> The main decisions are origin-aware scheduling, document-sharded retrieval,
> and explicit publication and navigation versions.”

The repository demonstrates PostgreSQL frontier/content tables, Elasticsearch retrieval,
manual crawl/index/PageRank jobs, a Valkey cache, and indexing circuit breakers.
It runs a small local corpus, not the distributed system drawn above.

Its crawler lacks atomic claims and recovery, can overflow signed hash columns,
and writes an upsert without the needed unique constraint.
Its indexer can mark failed bulk items complete; ranking and PostgreSQL/ES updates
are not published as one generation. Query operators and cache keys also have gaps.

Those limitations are documented with source references in [architecture.md](./architecture.md).
[README.md](./README.md) contains the sample-data preparation and actual commands.
