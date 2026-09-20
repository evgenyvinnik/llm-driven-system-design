# Google Search architecture

## System Overview

This project studies web search: acquiring documents, building a searchable index, and serving ranked pages through a browser. The production design below is a proposal for a bounded public-web corpus. It is not a description of Google's infrastructure. The final [Implementation Notes](#implementation-notes) map the proposal to the actual React, Express, PostgreSQL, Valkey, and Elasticsearch implementation, including known defects.

The main learning goals are crawl scheduling, inverted-index retrieval, graph-based ranking, coherent pagination, and the separation between asynchronous content ingestion and latency-sensitive search.

## Requirements

### Proposed production scope

- Discover allowed HTTP(S) pages, extract text and links, and revisit selected pages.
- Search terms and explicit phrases, exclusions, and site constraints.
- Rank matching documents and return titles, destinations, and safe highlighted excerpts.
- Suggest queries while typing without delaying explicit search submission.
- Support shareable searches, keyboard operation, and bounded pagination.
- Give authenticated operators durable crawl/index job status and failure details.

Exclude ads, personalized ranking, image/video search, generated answers, and logged-in browser rendering in the crawler. Public search does not require a user account; administration does.

### Planning targets, not measured performance

| Property | Initial production target |
|---|---|
| Corpus | 100 million selected public pages |
| Query volume | 100 million searches/day; provision initially for 10,000 QPS peak |
| Query latency | p95 API response below 200 ms, measured separately from browser paint |
| Autocomplete | p95 API response below 100 ms, excluding client debounce |
| Availability | 99.9% successful search responses; retrieval errors are not empty results |
| Freshness | Selected high-priority pages refreshed within 24 hours; explicit longer intervals for the tail |
| Navigation | Stable bounded result order during an unexpired search session |
| Correctness | All requested operators applied before candidate ranking and pagination |

These targets need load tests and relevance judgments. A hundred-billion-page corpus is a later redesign exercise, not a claim that adding replicas to this demo reaches Google scale.

## Capacity Estimation

| Assumption | Calculation | Consequence |
|---|---|---|
| 100M pages, average 50 KB retained text | 5 TB before replicas and retained versions | Keep crawl artifacts outside API process memory |
| Average 100 KB searchable storage per page | 10 TB primary index; about 30 TB with two replicas | Benchmark actual mappings and compression before sizing |
| 100M searches/day | About 1,157 QPS average | 10,000 QPS peak is an explicit headroom assumption |
| Ten results at 1 KB each | About 10 KB/page excluding protocol overhead | Roughly 100 MB/s at the assumed peak |
| Crawl 10M pages/day | About 116 fetches/s average | Host permissions and delay still limit individual sites |
| 100M pages / 10M daily fetches | Ten days for uniform coverage, before retries | A 24-hour target can apply only to a prioritized subset |

A cached 100-result navigation window at roughly 100 KB costs about 10 GB for 100,000 concurrent windows, before cache overhead or replication. This makes window size, reuse, and expiry product decisions with infrastructure consequences.

### Local Development Scale

The provided seed has ten documents. Compose runs one PostgreSQL instance, one Valkey instance, and one Elasticsearch node with one primary shard and zero replicas per index. Elasticsearch has a 512 MB configured heap. No throughput or latency measurements were taken during this documentation review.

## High-Level Architecture

Proposed production system; bidirectional arrows denote request/result exchanges.

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

The top row serves a query from an already-published corpus. The lower path acquires and stores content, constructs index generations, and publishes them after validation. Fetchers return discovered URLs to the frontier. The cache is disposable; it does not own crawl state or determine which documents exist.

The return paths make progress explicit: a fetch attempt records durable versioned output before completion; builders checkpoint confirmed document/graph effects; publication records which validated corpus and ranking generation became active. Interrupted work resumes from those records rather than refetching every source or treating an HTTP success as a complete build. Search windows stay bound to their corpus/rank context until expiry; a missing or expired window requires an explicit restart, not a silent mixture of generations.

The query coordinator also calls a separately budgeted suggestion service backed by a prefix index. Static UI assets can be served through a CDN. Those supporting paths are omitted from this overview to keep its two main flows drawable.

## Core Components / Request Flows

### Crawl scheduling and acquisition

Partition the frontier by origin and assign each origin to a leased scheduler owner. Durable URL records track canonical identity, next eligible fetch, priority, attempt ID, lease expiry, and content version. Workers claim due work atomically and acknowledge only their current attempt. Expired attempts become eligible again; a late worker cannot overwrite a newer crawl.

Each fetch rechecks origin policy and validates DNS resolution and every redirect destination before opening a connection. Block private/internal destinations, bound redirects and bytes, apply timeouts, and identify the crawler. Treat unavailable robots responses separately from successful allow rules; network/server failures should defer crawling rather than silently grant permission. The [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html) provides the relevant error and cache semantics.

Store a bounded raw artifact first, then commit its content version and a processing event. If metadata commit fails, the unreferenced object is reclaimed later. The parser emits normalized text and outgoing edges. URL deduplication must not discard an edge merely because its target already exists. Preserve canonical aliases and use near-duplicate detection as a separate quality signal.

Priority balances expected change, importance, and time since last visit. A delayed origin remains scheduled for its next eligible time; an empty immediate batch does not imply the frontier is exhausted. Avoid assuming every site can be crawled once per second.

### Index construction and publication

Start with Elasticsearch document sharding: each shard owns complete searchable documents. A query fans out to the relevant collection's shards, which perform matching locally and return bounded candidates. Adding replicas increases serving capacity and resilience; it does not eliminate fan-out.

Content records carry monotonic versions. A builder consumes durable processing records, rejects superseded versions, validates each bulk item, and records completion only after successful writes. Retry transient item failures individually. Mapping or malformed-document errors go to an inspectable failed-work queue, with replay after correction.

For a first production design, build explicit corpus generations from a consistent crawl checkpoint, attach a versioned ranking configuration and link-score snapshot, run coverage/relevance checks, and activate a completed generation atomically. Retain an older generation while its navigation sessions remain valid. A failed build leaves the last good generation serving.

This costs extra storage and build capacity. A later low-latency ingestion path can use versioned incremental writes and search snapshots, but should preserve the same visible-version and pagination contract. Do not promise hourly whole-corpus rebuilds without measuring build throughput.

### Query processing and ranking

1. Validate query length, page size, supported operators, locale, and pagination window.
2. Parse an explicit query structure. Phrases become required positional matches, exclusions become negative predicates, and site constraints use host equality or an explicitly allowed subdomain boundary.
3. Look up a cached search window under the full query structure, locale, safety policy, page size, corpus generation, ranking version, and freshness-time bucket.
4. On a miss, retrieve lexical candidates across the selected document shards. Apply constraints during retrieval, not after taking a page.
5. Merge candidates using comparable scoring statistics, then rank a bounded set with text relevance, authority, and query-appropriate freshness. Keep nonzero priors for documents without link history.
6. Produce safe excerpts and a bounded ordered result window. Return a page with generation, total relation, freshness timestamp, and continuation information.
7. Record appropriately minimized analytics asynchronously. Logging failure must not make an otherwise successful search fail.

A candidate cutoff can lose a useful result; evaluate that loss with judged queries instead of asserting that a fixed top-1,000 set always contains the best answer. Cheap stored authority factors can be applied in initial retrieval; reserve a separate re-ranking phase for signals that actually justify the added cost.

### Pagination and autocomplete

For the first ten result pages, materialize a bounded ordered window and give it a short-lived opaque session handle. Bind it to the query and ranking context. A page request returns the stored ordering, not a fresh offset query with changing scores. If the window expires or is evicted, respond with an explicit restart outcome. A shared URL preserves search intent, not a permanent copy of the result set.

For deeper traversal, a possible extension is a search snapshot and continuation sort values; it requires a deterministic tie-breaker and resource expiry. Elasticsearch describes the state and ordering constraints in its [pagination reference](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results).

Build suggestions from reviewed, aggregated query data rather than publishing each individual query immediately. Prefix lookups use an independently versioned suggestion index, bounded results, and a short cache TTL. Apply abuse filtering and minimum-frequency thresholds; local history remains a separate source controlled by the browser user.

## Database Schema

### Actual local PostgreSQL schema

The following is the complete checked-in [init.sql](./backend/src/db/init.sql), including all six tables and ten secondary indexes. It records the current implementation, including missing constraints; it is not presented as production-ready DDL.

```sql
-- URLs table (crawl state)
CREATE TABLE IF NOT EXISTS urls (
    id BIGSERIAL PRIMARY KEY,
    url_hash BIGINT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    last_crawl TIMESTAMP,
    last_modified TIMESTAMP,
    crawl_status VARCHAR(20) DEFAULT 'pending',
    content_hash BIGINT,
    page_rank DECIMAL DEFAULT 0.0,
    inlink_count INTEGER DEFAULT 0,
    priority DECIMAL DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id BIGSERIAL PRIMARY KEY,
    url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    content TEXT,
    content_length INTEGER,
    language VARCHAR(10) DEFAULT 'en',
    fetch_time TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Links table (for PageRank calculation)
CREATE TABLE IF NOT EXISTS links (
    id BIGSERIAL PRIMARY KEY,
    source_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    target_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    anchor_text TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source_url_id, target_url_id)
);

-- Query logs table (for analytics and learning)
CREATE TABLE IF NOT EXISTS query_logs (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    results_clicked JSONB DEFAULT '[]',
    duration_ms INTEGER,
    session_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Search suggestions (popular queries)
CREATE TABLE IF NOT EXISTS search_suggestions (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL UNIQUE,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Robots.txt cache
CREATE TABLE IF NOT EXISTS robots_cache (
    id BIGSERIAL PRIMARY KEY,
    domain VARCHAR(255) UNIQUE NOT NULL,
    content TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_urls_domain ON urls(domain);
CREATE INDEX IF NOT EXISTS idx_urls_crawl_status ON urls(crawl_status);
CREATE INDEX IF NOT EXISTS idx_urls_priority ON urls(priority DESC);
CREATE INDEX IF NOT EXISTS idx_urls_page_rank ON urls(page_rank DESC);
CREATE INDEX IF NOT EXISTS idx_documents_url_id ON documents(url_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_url_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_url_id);
CREATE INDEX IF NOT EXISTS idx_query_logs_query ON query_logs(query);
CREATE INDEX IF NOT EXISTS idx_search_suggestions_frequency ON search_suggestions(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_search_suggestions_query ON search_suggestions(query);
```

The local Elasticsearch mappings live in [models/elasticsearch.ts](./backend/src/models/elasticsearch.ts). `documents` uses URL-row IDs as document IDs, English text analyzers, keyword URLs/domains, floating-point ranking fields, and a fetch timestamp. `autocomplete` uses an edge-ngram query field and frequency/last-used fields. The standalone natural-library tokenizer is not the main index's analyzer.

### Proposed production additions

| Record | Identity / access | Required invariant |
|---|---|---|
| URL scheduling | Canonical URL, origin + due time | Unique URL identity, leased attempt, bounded retry policy |
| Crawl version | URL ID + version | Immutable artifact reference; newer attempts cannot be replaced by stale ones |
| Link edge | Source version + target URL | Existing targets still contribute edges; source-version replacement removes obsolete edges |
| Processing event | Event ID + content version | Durable creation with metadata; retry does not create duplicate effects |
| Index generation | Generation ID + manifest | Complete validated corpus checkpoint and ranking version before activation |
| Operator job | Actor + command identity | Durable accepted/running/completed/failed status and auditable failures |
| Search window | Opaque handle + query context | Bounded immutable order; expiry never silently changes its meaning |

Use an explicit binary/text digest representation for hashes, not an unsigned digest squeezed into a signed integer. Retain a collision check on the canonical URL. Large IDs should remain strings at the API boundary rather than silently lose precision in JavaScript numbers.

## API Design

### Existing local endpoints

All paths below are mounted in the current Express app. There are no login, signup, admin authorization, or crawl-stop endpoints.

| Method | Path | Current purpose |
|---|---|---|
| GET | `/api/search?q=...&page=1&limit=10` | Query cache / Elasticsearch result page |
| GET | `/api/search/autocomplete?q=...` | Prefix suggestions; fewer than two characters returns an empty list |
| GET | `/api/search/popular?limit=10` | PostgreSQL popular queries |
| GET | `/api/search/related?q=...&limit=5` | Related-query SQL; current query has an ordering error |
| POST | `/api/admin/crawl/seed` | Add a `urls` array to the frontier |
| POST | `/api/admin/crawl/start` | Start an in-process crawl with `maxPages`, default 100 |
| GET | `/api/admin/crawl/status` | Aggregate index/frontier statistics, not a durable job status |
| POST | `/api/admin/index/build` | Start in-process `indexAll` |
| POST | `/api/admin/pagerank/calculate` | Start in-process graph calculation |
| GET | `/api/admin/pagerank/stats` | Stored rank statistics and top pages |
| GET | `/api/admin/stats` | Index, graph, and query-log statistics |
| POST | `/api/admin/update-inlinks` | Recalculate PostgreSQL inlink counts |
| GET | `/health`, `/ready`, `/healthz`, `/metrics` | Dependency health, readiness, liveness, metrics |

Search accepts `page` without a lower bound and caps `limit` at 50 without rejecting negative or invalid values. Popular/related limits also need validation. Admin `maxPages` and seed-array contents lack suitable bounds.

### Proposed response contract

| Response field | Meaning |
|---|---|
| Query context | Canonical query, interpreted operators, locale, page size |
| Results | Stable ID, title text, safe destination, excerpt text and highlight spans |
| Count | Value plus exact/lower-bound/approximate relation |
| Navigation | Window handle, current page, last available page, expiry |
| Freshness | Corpus generation, ranking version, generated-at timestamp |
| Status | Complete, explicitly partial, rate limited, unavailable, or expired-window outcome |

For example, the same query on page two with a valid window handle returns that window's second page. A request with a mismatched query is rejected; an expired handle asks the client to start a new search. A retrieval outage is a service error, not a successful response claiming zero matches.

## Key Design Decisions

### Document sharding with bounded fan-out

Document shards perform multi-term matching, phrase-position checks, and filtering together. Term partitioning can contact fewer owners, but frequent terms require large posting-list transfers or distributed intersections, and skew creates hot owners. Comparing only the number of network calls ignores the bytes and work behind those calls.

Choose document shards within bounded collections, replica-aware routing, and measured shard counts. The cost is scatter/gather latency and cross-shard score calibration. Language or region routing is useful only when it preserves the selected search scope; broad searches must still cover the full eligible corpus. Elasticsearch's [shard routing documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/search-shard-routing.html) explains replica selection and concurrency controls.

### Published generations and stable result windows

A query should not mix new text with an incompatible ranking snapshot. Generation activation makes publication reviewable and recoverable. Materialized result windows preserve the order a user is browsing even as later generations activate.

The alternative, rerunning offset queries on every click, is simpler and may be acceptable for a basic demo, but it can repeat or skip results after a refresh. The chosen contract costs retained generations, window memory, and an explicit expiry experience. It also caps how deeply a user can browse without starting another search.

### Crawl budgets and link scores

Prioritized, per-origin scheduling uses scarce fetch capacity on changing and useful content while preserving a maximum wait for lower-priority URLs. Pure global priority can starve the tail; plain FIFO spends the same effort on static and rapidly changing pages.

Compute link scores offline against a named graph snapshot, including dangling-node redistribution. Missing link history gets a neutral prior rather than a zero multiplier. The cost is delayed authority information and extra storage for versions; freshness and lexical relevance must still make new documents discoverable. A fixed weekly PageRank schedule is a tunable planning choice, not an observed property of every website.

## Consistency and Idempotency

| Boundary | Proposed guarantee | Mechanism |
|---|---|---|
| URL claim | One current authorized attempt | Atomic claim, lease expiry, attempt token |
| Crawl output | Late fetch cannot replace newer content | Conditional version/attempt commit |
| Object + metadata | References point to stored artifacts | Store artifact first, metadata/outbox transaction, orphan cleanup |
| Index delivery | Repeated messages converge on one version | Deterministic document identity and monotonic version checks |
| Generation activation | Incomplete generation stays invisible | Validated manifest and atomic active-pointer change |
| Browser navigation | Stable order within valid window | Materialized results, bounded expiry, explicit restart |

This is at-least-once work with deduplicated effects, not an exactly-once network delivery claim. Operator command identities belong in durable storage, not a minute bucket and a temporary lock.

## Security / Auth

The proposed admin service verifies an authenticated operator role, rate limits authenticated principals, and records job changes. Public search is anonymous but still subject to abuse controls. An arbitrary `x-api-key` header must not count as a verified identity.

Crawler egress checks cover DNS changes and every redirect. Robots rules govern cooperation with the origin; they are not a substitute for network access controls. Bound fetch size, decompression, parse time, link expansion, and crawl scope to prevent traps.

Render excerpts as text plus permitted highlight spans. Validate destinations before rendering links. Minimize query logging and retention, aggregate suggestions before publication, and provide explicit controls for local history. Search queries and localStorage entries can contain sensitive information.

## Observability

Proposed SLIs separate query service time, network delay, browser render time, and autocomplete debounce. Track successful/failed/partial queries, zero-result rate, cache effectiveness, candidate-retrieval coverage, judged relevance, and freshness by priority tier.

Ingestion needs due backlog age per origin, lease expirations, fetch outcomes, bulk-item failures, content-to-index lag, generation publication failures, and unreconciled operator jobs. Monitoring only the total document count cannot establish that the right versions are searchable.

See the final section for the actual metric names and gaps. No Prometheus server, Grafana, alert rules, or distributed tracing backend is included in Compose.

## Failure Handling

| Failure | Proposed behavior |
|---|---|
| Query cache unavailable | Bounded bypass to the published index; shed excess load |
| Index shard unavailable | Retry a replica within the deadline; report unavailable or explicitly partial results |
| New generation fails validation | Keep the last good generation active; expose build failures |
| Crawl worker crashes | Lease expires; retry eligible work with a new attempt |
| Origin slows or rejects requests | Reduce its budget, honor retry timing, avoid blocking other origins |
| Analytics store unavailable | Drop/buffer within a fixed budget; search still returns |
| Browser receives a late response | Discard it unless its request identity is still current |
| Search window expires | Preserve query text and offer a fresh search; do not substitute another result order silently |

Circuit breakers bound repeated dependency failures; a timeout does not prove a write was cancelled. Work receipts and version checks still need to resolve delayed effects.

## Scalability Considerations

The first serving bottleneck is likely index CPU, I/O, or tail latency under fan-out, not Express routing. Measure shard work and memory before splitting further; excessive small shards increase coordination overhead. Add replicas for query capacity and isolate builders so ingestion does not consume every serving resource.

The first ingestion bottleneck may be a few heavily represented origins. More workers do not increase those sites' allowed rate. Scale across origins and partition frontier ownership while retaining per-origin budgets. Export large graph snapshots into partitioned batch processing rather than loading the entire web graph into one Node.js process.

Coalesce popular cache misses and bound refresh concurrency. Cache-hit ratios depend on traffic and policy, so a five-minute TTL is not evidence of a 70% hit rate. Upgrade from full generations to incremental publication only when measured freshness or build cost requires it.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Index placement | Document shards | Term shards | Local multi-term matching; avoid large distributed postings intersections |
| Crawl scheduling | Priority within origin budgets | Global FIFO | Allocate limited fetch capacity without violating origin policy |
| Publication | Validated generations | In-place uncoordinated rebuild | Keep a failed or incomplete build out of serving |
| Navigation | Bounded stable windows | Fresh offset query per click | Predictable page order with explicit expiry |
| Rank computation | Versioned batch link scores | Synchronous graph work | Keep graph iteration off the query path |
| Snippets | Server-selected text and spans | Raw HTML fragments | Matching context without trusting crawled markup |

## Implementation Notes

### Actual local topology

```
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ React + Vite :5173     │        │ Express :3001 (dev)    │        │ Valkey :6379           │
│ Search + admin UI      │◀──────▶│ Search + admin routes  │◀──────▶│ Cache / counts / locks │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                              ▲          │
                                              │          │
                                              │          └──────────────────────┐
                         SQL reads            │                                 │
                                              │             search / suggestions│
                                              ▼                                 ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ CLI / admin jobs       │        │ PostgreSQL :5432       │        │ Elasticsearch :9200    │
│ Crawl, index, PageRank │◀──────▶│ URLs / content / graph │        │ Docs + autocomplete    │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
            │                                                                   ▲
            │                                                                   │
            │                                                                   │
            │              bulk indexing / rank updates                         │
            └───────────────────────────────────────────────────────────────────┘


Jobs also use Valkey; no worker queue, crawler coordination or load balancer.
```

[README](./README.md) contains setup, ports, and the explicit seed-data preparation. The UI is a client-rendered Vite application, not SSR. [index.ts](./backend/src/index.ts) mounts search/admin routers, metrics, probes, middleware, and starts a single Express listener. CLI jobs import the same services. There is no message broker, durable job runner, CDN, load balancer, or deployment orchestration.

### Actual frontend behavior

[SearchBox](./frontend/src/components/SearchBox.tsx) delegates to [useAutocomplete](./frontend/src/hooks/useAutocomplete.ts): two characters minimum, 200 ms timer, direct fetch, local suggestions and selected index. It clears the timer when text changes but neither aborts already-sent requests nor guards their response identity. Older suggestions can replace newer ones. Selection is not consistently reset on text/results changes, and Enter is handled both by the key handler and form submission without preventing the key's default submission.

Arrow keys and Escape exist for server suggestions, but recent-history entries do not share that keyboard model. There are no complete combobox/listbox roles, active-descendant state, accessible names for all icon buttons, or composition handling. This is partial keyboard support, not verified accessibility conformance.

[searchStore](./frontend/src/stores/searchStore.ts) holds one result object and writes successful searches into localStorage. It has no request generation, abort signal, response cache, schema guard, storage exception handling, or clear-history control. A stale response can overwrite a later search; a failed search can leave earlier results visible alongside an error. [The search route](./frontend/src/routes/search.tsx) reads `q` and `page`, but a URL with no query does not clear the store. Sharing a URL repeats the query; it does not freeze result contents.

[SearchResults](./frontend/src/components/SearchResults.tsx) renders a normal list and numeric buttons for the first ten pages, plus Previous/Next. There is no virtualization, infinite scroll, skeleton UI, prefetch, offline cache, or service worker. [SearchResultItem](./frontend/src/components/SearchResultItem.tsx) inserts title/snippet HTML without escaping or sanitizing it; the backend emits `<b>` highlighting. Its “Indexed” date is actually `fetch_time`.

[The admin page](./frontend/src/routes/admin.tsx) loads stats on mount or manual refresh and schedules one refresh two seconds after an action. Buttons remain usable during work. “Started” means only that the API accepted an in-process invocation, not that the job completed. There is no continuous progress subscription or stop control.

### Actual crawl and persistence limitations

- [helpers.ts](./backend/src/utils/helpers.ts) converts the first 64 hash bits to an unsigned decimal string. `https://example.com/1` produces `17508157248070013214`, above signed `BIGINT`'s maximum. Both URL and content hashes are affected. See PostgreSQL's [numeric ranges](https://www.postgresql.org/docs/16/datatype-numeric.html).
- [crawler.ts](./backend/src/services/crawler.ts) uses a document upsert on `url_id`, but the schema supplies only a nonunique index. PostgreSQL cannot infer the required conflict arbiter; see [INSERT conflict handling](https://www.postgresql.org/docs/16/sql-insert.html). This can fail even after a successful fetch.
- Frontier selection and `crawling` status update are separate, without row locks, atomic claims, lease deadlines, or stuck-work recovery. The read/check/write host timestamp is not distributed exclusion. The first `limit * 2` pending rows can all belong to one delayed host, causing a premature “No more URLs” exit.
- The robots cache is keyed only by hostname and fetches `https://host/robots.txt`, ignoring the page's scheme/port. Errors allow fetching; cached empty text is treated as a miss. Stored PostgreSQL robots rows are never consulted, and crawl-delay directives are not enforced.
- HTML is hashed before parsing, so this is exact raw-content comparison, not SimHash. Fetches lack response-byte and private-network limits. Parsed main text is capped at 50,000 characters; robots, metadata, and fetched bytes have different limits or none.
- Existing URLs return before `links` insertion, losing graph edges to known targets. Anchor text is extracted but not written by the crawler. The “added” count includes existing URLs, and marking a duplicate does not remove a previously indexed document.
- `maxPages` counts successful pages, can overshoot by a batch, and does not bound attempted requests. Failed, skipped, blocked, or duplicate pages count as errors in the run summary. No automatic recrawl or retry scheduler is wired.

[The seed](./backend/db-seed/seed.sql) uses `completed` where jobs require `crawled`, fabricated hashes, explicit IDs without sequence alignment, and no Elasticsearch writes. The README's sample-data preparation handles status and sequence alignment on a fresh demo database; it does not repair the application code.

### Actual indexing and ranking

[Indexer](./backend/src/services/indexer.ts) scans `crawled` documents in batches of 100 using offset pagination. It joins current URL ranks and bulk-writes Elasticsearch under the string form of `url_id`. The current idempotency hash covers title plus only the first 1,000 content characters, omitting description, remaining text, inlinks, rank, fetch time, and index generation. A one-hour Redis marker can therefore skip changed documents or an empty replacement index.

The [Elasticsearch model](./backend/src/models/elasticsearch.ts) logs bulk item failures but resolves normally; `indexAll` then marks the whole batch successful. A successful command exit is not proof of a complete index. It uses `refresh: true` for bulk writes, without staging generations or atomic publication. Mapping initialization logs failures without stopping API startup. It only creates missing indices; it does not migrate existing mappings.

The CLI [buildIndex](./backend/src/scripts/buildIndex.ts) initializes indices and updates PostgreSQL inlink counts before indexing. The admin build endpoint calls only `indexAll`; it does not perform the same preparation. No delete/tombstone pipeline removes old documents from Elasticsearch.

[PageRank](./backend/src/services/pagerank.ts) loads all crawled URL IDs and eligible links into process memory, redistributes dangling-node mass, iterates with damping 0.85 up to 100 times or a 0.0001 max-difference threshold, and normalizes the sum. It updates PostgreSQL rows inside one transaction, then separately issues Elasticsearch bulk updates. There is no staging-table swap, scheduled weekly run, cross-store atomicity, or bulk-item error reconciliation. BIGINT IDs and DECIMAL values are not converted globally from node-postgres's default string representations; TypeScript annotations do not change runtime values.

Actual search uses a fuzzy `multi_match` with `title^3`, `description^2`, and `content`, plus a phrase boost for the flattened query. Its `function_score` multiplies PageRank (`log1p`, factor 1.2), inlinks (`log1p`, factor 1.1), and a Gaussian decay on fetch time (30-day scale, seven-day offset, 0.5 decay). A zero link factor zeros the score. There is no learned weighted sum, separate reranker, anchor-text search, click feature, query expansion, or integrated spelling correction. Tokenizer/BM25 teaching helpers are not called by this retrieval path.

### Actual search consistency and cache behavior

[QueryProcessor](./backend/src/services/search.ts) parses operators but flattens phrases; it applies site/exclusion checks after Elasticsearch has paginated. Site matching uses substring inclusion, exclusions inspect only title/description, and reported totals remain unfiltered. A site-only query returns no results before retrieval. Count relation from Elasticsearch is not preserved.

Query keys are lowercased text plus page, omitting page size and versions. TTL is 300 seconds; autocomplete TTL is 600. Cache hits reuse original query metadata and duration and skip query logging/suggestion updates. Redis reads and writes are on the critical path without fallback. The reported body duration excludes subsequent cache writes, query logging, and suggestion updates.

Autocomplete tries Elasticsearch first and SQL only if it returns no matches; an Elasticsearch error does not trigger that fallback. Search-driven suggestion updates use search-then-insert with generated IDs, allowing duplicates under concurrency. PostgreSQL suggestions mainly come from seed; cache-miss searches update the separate Elasticsearch suggestion index. Popular queries read PostgreSQL. Related-query SQL selects distinct query text but orders by unselected frequency, and its unparenthesized OR/AND conditions also need correction.

### Production patterns actually connected

| Pattern | Actual connection | Practical limit |
|---|---|---|
| Opossum breakers | [indexer.ts](./backend/src/services/indexer.ts) through [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) | Bulk/single indexing only; general ES/Redis/PG wrappers are unused by request services |
| Job deduplication | [admin.ts](./backend/src/routes/admin.ts) through [idempotency.ts](./backend/src/shared/idempotency.ts) | Some jobs use time-bucket keys, 60-second lock, cached result; no durable job state or lease renewal |
| Rate limits | [rateLimiter.ts](./backend/src/shared/rateLimiter.ts) | Search/suggest/admin counters shared in Valkey; global limiter is process-local |
| Logging | [logger.ts](./backend/src/shared/logger.ts) | Pino request IDs via `x-request-id`; mixed console logs in jobs, no distributed trace propagation |
| Metrics | [metrics.ts](./backend/src/shared/metrics.ts) | Query/request and indexing measurements; several declared crawl/index gauges are unpopulated |
| Health probes | [health.ts](./backend/src/shared/health.ts) | Parallel dependency checks; no overall deadline or index-content validation |

For example, the actual indexing boundary illustrates why failure interpretation matters:

```typescript
await this.bulkIndexBreaker.fire(docsToIndex);
await markBatchAsIndexed(docsToIndex, keyGenerator);
```

These two lines are from [indexer.ts](./backend/src/services/indexer.ts). A breaker protects the call, but marking the batch is only correct if every relevant item succeeded. Here the wrapper does not reject bulk-item failures, so the receipt overstates success. Bulk breaker settings are 30-second timeout, 40% error threshold, 15-second reset, with default volume threshold five; the single-document breaker uses 10 seconds, 50%, and 10 seconds. Timeout does not cancel an Elasticsearch write.

The job-lock pattern is `SET ... NX EX 60`, followed by execution, result caching, and unconditional lock deletion. It lacks ownership tokens, renewal, and a second result check after acquiring a lock. Long jobs can overlap and an old worker can delete a newer worker's lock. Crawl-start computes an idempotency key but does not use the wrapper. The configured environment TTL/breaker values are parsed but do not drive these hardcoded helpers.

Rate limits default to 60 search, 120 suggestion, and 10 admin requests per minute; the global process limiter is 200. Redis counter errors allow endpoint requests. The custom store sets expiry separately from the increment, and unverified `x-api-key` values can select search/suggestion buckets. No admin authorization exists. Global limiting exempts `/health` and `/metrics`, but not `/healthz` or `/ready`.

Actual metrics include `search_queries_total`, `search_query_latency_seconds`, `search_query_results_count`, `search_cache_hit_ratio`, `search_index_operations_total`, `search_index_latency_seconds`, and `search_circuit_breaker_state`. The “rolling five minute” cache gauge actually resets counters every 30 seconds. Crawl counters are updated at admin-job completion, not consistently per URL/CLI execution. Crawl latency/error and index-size instruments are declared without update sites; indexed-document gauges can be set from SQL counts instead of actual Elasticsearch contents.

Health treats Elasticsearch red as `degraded`, yet overall health/readiness still accept any ES state except `unhealthy`. Thus `/ready` can return 200 for a red cluster or missing expected indices. Signal handlers exit immediately without draining requests, connections, or in-process jobs.

### Simplified and omitted

The local project substitutes one Express process for separately deployed services, PostgreSQL rows for durable crawl/artifact infrastructure, one Elasticsearch node for replicated collections, and manually invoked jobs for scheduled processing. It includes useful examples of PageRank, caching, logs, limits, and indexing breakers, with the limitations above.

It omits authenticated operations, origin-safe distributed fetching, leased frontier recovery, durable processing events, validated generation publication, deletion propagation, stable result sessions, safe excerpt rendering, complete accessible autocomplete, query-response guards, runtime API schema validation, SSR, offline result storage, multi-region serving, tracing, and a relevance evaluation pipeline. Those are proposed extensions, not implemented guarantees.
