# Google Search (Web Search Engine) — Development with Claude

## Project Context

A working (small-scale) web search engine: it actually **crawls** real pages, **indexes** them, computes **PageRank** over the discovered link graph, and serves ranked results that blend text relevance with link authority and freshness. The hard part isn't any one stage — it's that crawl, index, and rank each live in the datastore that fits them (Postgres for the link graph, Elasticsearch for the inverted index, Redis for the query cache) and the ranking has to *combine* signals computed in two different systems.

**Learning goals:** polite crawling (robots.txt, per-host rate limits, a URL frontier), building an inverted index and BM25 scoring, the PageRank algorithm over a real link graph, and multi-signal ranking with query caching for sub-200ms serving.

## Architecture at a Glance (what actually runs)

Three datastores, each owning one stage of the pipeline.

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Crawl state / URL frontier, the `links` edge table (link graph), page content, PageRank scores, query analytics | PageRank is an iterative graph computation — it needs the full edge set in a queryable relational store, not a document index |
| **Elasticsearch** (`@elastic/elasticsearch` 8) | Inverted index; BM25 + `function_score` ranking with a `page_rank` field | Production-grade full-text and a query DSL that can multiply BM25 by external signals — reimplementing this by hand would be the whole project |
| **Redis / Valkey** (`ioredis`) | Query-result cache, autocomplete/suggestion sets | Sub-ms cache hits keep repeat queries off Elasticsearch; TTL keeps results fresh |

**Crawler libs:** `axios` (fetch) + `cheerio` (HTML parse) + `robots-parser` (politeness) + `natural` (tokenize/stem). **Frontend:** React 19 + TanStack Router + Zustand + lucide-react (search UI + admin dashboard). Offline pipeline scripts: `crawl`, `build-index`, `calculate-pagerank`, `seed`.

## Key Design Decisions

### 1. Split the pipeline across stores by what each stage needs
The link graph and crawl frontier live in Postgres; the searchable text lives in Elasticsearch; hot query results live in Redis. PageRank *must* see every edge to iterate to convergence, which is a relational/graph workload, while free-text ranking wants an inverted index — no single store does both well. Trade-off given up: PageRank scores computed in Postgres must be **pushed into Elasticsearch** (`updatePageRanks` bulk-updates the `page_rank` field) so ranking can use them, which means the two stores are briefly out of sync after a PageRank run until the bulk update lands.

### 2. Combine signals with Elasticsearch `function_score` (multiply), not app-side re-ranking
Final relevance is one ES `function_score` query with `boost_mode: multiply`: BM25 text match (title boosted ×2) × a `field_value_factor` on `page_rank` × an inlink-count factor × a freshness decay on `fetch_time`. Doing it inside ES means the score, sort, and pagination all happen in one place, over the full result set. Trade-off: re-ranking application-side would allow arbitrary ML models, but it would require pulling back a large candidate set and sorting in Node — ES's two-phase scoring is far cheaper and the multiplicative model is a faithful, teachable stand-in for Google's original text×authority intuition.

### 3. Real PageRank over the crawled graph (damping 0.85), not a popularity proxy
`pagerank.ts` builds an adjacency list from the `links` table and iterates the classic formula (damping factor 0.85, up to 100 iterations, convergence threshold 1e-4) until scores stabilize, then bulk-writes them to ES. This is the actual algorithm, not "sort by inbound-link count." Trade-off: it's a batch job (run via `calculate-pagerank`), so authority scores lag new crawls until the next run — acceptable because link authority changes slowly relative to content.

### 4. Politeness in the frontier, not per-request sleeps
The `URLFrontier` pulls pending URLs grouped by domain and admits only one URL per domain per batch, and `robots-parser` results gate what may be fetched. Politeness is a property of *scheduling*, so it belongs in how the frontier hands out work, not in ad-hoc delays scattered through the fetch code. Trade-off: batch-level per-domain limiting is coarser than a true per-host token bucket with crawl-delay honoring — enough to avoid hammering a host locally, but a production crawler would track per-host budgets precisely.

## Current State

**Implemented and working end-to-end:** the crawler (axios/cheerio, robots.txt parsing + caching, URL frontier with per-domain politeness, incremental recrawl support); tokenization with stopword removal + stemming (`natural`); Elasticsearch indexing with a `page_rank` field; BM25 + `function_score` multi-signal ranking; iterative PageRank in Postgres pushed into ES; query parsing (phrases `"..."`, exclusions `-term`, `site:` filters); Redis query-result caching and autocomplete; snippet generation with highlight; an admin dashboard (seed URLs, start/stop crawler, trigger PageRank, stats); circuit breaker, rate limiter, Prometheus metrics, Pino logging.

**Intentionally omitted:** a Kafka-based real-time crawl→index streaming pipeline (indexing is script/batch driven); learning-to-rank / ML ranking models; index compression; spell correction beyond a basic suggestion framework; distributed shard/replica management beyond a single ES node.

## Iteration & Repair Log

- **Boilerplate CLAUDE.md replaced (2026-07).** The prior version was a "Phase 1 COMPLETED / Phase 2 IN PROGRESS / Phase 3-4" checklist and referenced component files by `.js` name (`crawler.js`, `indexer.js`, `pagerank.js`, `search.js`) — the actual sources are TypeScript (`crawler.ts`, `indexer.ts`, `pagerank.ts`, `search.ts`). Replaced with the real architecture and grounded decisions.
- **Schema-apply path.** Two paths exist and both apply `backend/src/db/init.sql`: the Postgres `docker-entrypoint-initdb.d` mount (auto-runs on a fresh volume — this is why the README's Docker flow can `npm run seed` without an explicit migrate) and `npm run db:migrate` (`src/db/migrate.ts`) for native setups. Sample data loads via `npm run seed`.
- **Pipeline is script-driven.** `crawl`, `build-index`, and `calculate-pagerank` are separate entrypoints (also triggerable from the admin API) rather than a continuous streaming job — intentional for a local, inspectable pipeline.

## Open Questions

1. PageRank is batch. What's the trigger cadence, and when does the Postgres→ES `page_rank` sync window become long enough to visibly misrank fresh high-authority pages?
2. `function_score` multiply is fixed-weight. When is the right time to move to learning-to-rank, and where would training labels (click logs already captured in analytics) plug in?
3. Per-domain-per-batch politeness is coarse. At what crawl volume does it need a true per-host token bucket that honors `Crawl-delay`, and where should that state live (Redis)?
4. The query cache is keyed on the raw query string + page. How should invalidation work when a recrawl/reindex changes results underneath a still-cached query?

## Resources

- [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html) — the original PageRank paper
- [Introduction to Information Retrieval](https://nlp.stanford.edu/IR-book/) — BM25, inverted indexes, ranking
- [Elasticsearch function_score query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html) — the multi-signal ranking mechanism used here
