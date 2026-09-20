# Google Search

An educational web search engine with a React search interface, an Express API, an Elasticsearch index, and separate crawl, indexing, and PageRank jobs. It demonstrates the journey from a stored web page to a ranked result. This is a small local implementation, not Google's software or a reconstruction of its current architecture.

The UI provides autocomplete, paginated results, highlighted snippets, recent searches, and an admin dashboard. The crawler and indexing code are useful to study, but several defects currently prevent a clean crawl-to-search workflow. The sample-data preparation below supports exploring search without fetching external websites.

## Documentation

- [Architecture](./architecture.md): proposed production design, exact local schema, source references, and implementation limitations.
- Interview walkthroughs: [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), [full stack](./system-design-answer-fullstack.md). Each starts with a high-level diagram and covers three deep dives in 45 minutes.
- [Development history](./CLAUDE.md): earlier decisions and iterations; some historical feature claims exceed the current implementation.

## What is implemented

| Area | Current behavior |
|---|---|
| Search UI | `/` and `/search?q=javascript&page=1`; React 19, TanStack Router, Zustand, Tailwind |
| Suggestions | 200 ms debounce; Elasticsearch prefix matching with a PostgreSQL fallback when no suggestions match |
| Results | Ten per page by default; title, URL, snippet, PageRank, and fetch date |
| History | Last ten successful searches in browser localStorage; no account or cross-device sync |
| Admin UI | `/admin`; statistics, seed URLs, start crawler, build index, calculate PageRank |
| Crawling | Axios + Cheerio, URL frontier, robots checks, exact HTML hash comparison, discovered links |
| Indexing | PostgreSQL document batches to Elasticsearch, deterministic URL-row IDs, indexing circuit breakers |
| Ranking | Elasticsearch text scoring multiplied by link-rank, inlink-count, and fetch-time factors |
| Operations | Request logs, Prometheus endpoint, dependency probes, rate limits, limited job deduplication |

There is **no authentication**, including on admin endpoints. Crawling accepts HTTP(S) URLs without private-network or redirect destination checks, and result rendering inserts unescaped highlight/fallback HTML. Keep this development stack local; these are concrete implementation gaps.

## Prerequisites

Use Node.js **20 or newer**, npm, and either Docker Compose or the native services below. Infrastructure consists of PostgreSQL 16, Valkey 7, and Elasticsearch 8.11.0. Elasticsearch's configured heap is 512 MB; the processes need additional memory beyond that heap.

Run infrastructure commands from `google-search/`. Backend and frontend dependencies are installed separately.

## Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U searchuser -d searchdb
docker compose exec redis valkey-cli ping
curl --fail http://localhost:9200/_cluster/health
```

The [Compose file](./docker-compose.yml) initializes PostgreSQL from `backend/src/db/init.sql` on a fresh volume. It starts infrastructure only; run the API and UI separately. Service `redis` runs Valkey.

| Service | Host port | Development credentials |
|---|---|---|
| PostgreSQL | 5432 | `searchuser` / `searchpass`, database `searchdb` |
| Valkey | 6379 | No password |
| Elasticsearch | 9200 HTTP, 9300 transport | Security disabled in this demo |

Stop with `docker compose down`. `docker compose down -v` also deletes the project's database, cache, and index volumes; use it only to discard this demo's data.

## Option B: Native installation (no Docker)

On macOS, install PostgreSQL and Valkey with Homebrew. These database creation commands assume a new local database and role:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -c "CREATE ROLE searchuser LOGIN PASSWORD 'searchpass';"
createdb -O searchuser searchdb
pg_isready -h localhost -p 5432
PGPASSWORD=searchpass psql -h localhost -U searchuser -d searchdb -c 'SELECT current_database();'
valkey-cli ping
```

For Elasticsearch, use the matching **8.11.0 macOS archive** from [Elastic's release page](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0), choosing your CPU architecture. This pins the demo's version instead of assuming a Homebrew formula installs the same release. Extract it, enter the extracted directory, and run:

```bash
ES_JAVA_OPTS='-Xms512m -Xmx512m' ./bin/elasticsearch \
  -Ediscovery.type=single-node \
  -Enetwork.host=127.0.0.1 \
  -Expack.security.enabled=false \
  -Expack.security.enrollment.enabled=false
```

Leave it running in that terminal. In another terminal, verify with `curl --fail http://localhost:9200/_cluster/health`. These flags deliberately match the local unauthenticated HTTP client. Elastic documents archive startup and command-line settings in its [8.11 installation guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html); that release line is no longer maintained.

## Start the backend and prepare sample results

From `google-search/backend/`:

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run seed
```

`dotenv` loads `.env` from the backend working directory. Migration executes the consolidated schema; it does not repair existing constraints. Seed inserts sample PostgreSQL data only. On a fresh database it creates 12 URLs, 10 documents, 19 links, 10 query logs, and 15 suggestions. Re-running seed increases suggestion frequencies and appends query logs, so it is not a clean reset.

**Sample-data mismatch:** those ten documents belong to URL rows marked `completed`; the indexer selects `crawled`. Before the first build, prepare this fresh demo database explicitly. For Docker, run from `google-search/`:

```bash
docker compose exec -T postgres psql -U searchuser -d searchdb -v ON_ERROR_STOP=1 <<'SQL'
UPDATE urls SET crawl_status = 'crawled'
WHERE id BETWEEN 1 AND 10 AND crawl_status = 'completed';
SELECT setval(pg_get_serial_sequence('urls', 'id'), (SELECT MAX(id) FROM urls));
SELECT setval(pg_get_serial_sequence('documents', 'id'), (SELECT MAX(id) FROM documents));
SQL
```

For native PostgreSQL, run the same SQL with `PGPASSWORD=searchpass psql -h localhost -U searchuser -d searchdb -v ON_ERROR_STOP=1`. Sequence alignment is needed because the seed explicitly supplies URL/document IDs. This prepares sample data; it does not fix the crawler's hash and upsert defects.

Then, from `google-search/backend/`:

```bash
npm run build-index
npm run calculate-pagerank
npm run dev
```

The build command creates the two Elasticsearch indices, updates inlink counts, and indexes eligible documents. PageRank then updates scores in PostgreSQL and Elasticsearch. Check command logs: a job finishing does not guarantee every Elasticsearch bulk item succeeded. Search responses already cached before a rebuild can remain stale for five minutes.

## Start the frontend

In a separate terminal, from `google-search/frontend/`:

```bash
npm install
npm run dev
```

Open [the UI](http://localhost:5173), try `javascript tutorial`, and inspect [the dashboard](http://localhost:5173/admin). The sample pages are fabricated content; result links need not lead to matching real pages.

Vite proxies `/api` to port **3001**. Backend `npm run dev` sets 3001 explicitly; `dev:server2` and `dev:server3` use 3002 and 3003. There is no supplied load balancer or safe distributed crawler coordination. `npm start` uses the configured port, or **3000** if `PORT` is absent. A built frontend still needs a same-origin `/api` reverse proxy.

## Configuration

The complete template is [backend/.env.example](./backend/.env.example); defaults are in [config/index.ts](./backend/src/config/index.ts).

| Setting | Default / effect |
|---|---|
| `PORT`, `NODE_ENV` | Source defaults: `3000`, `development`; template and dev script use 3001 |
| `DATABASE_URL` | `postgres://searchuser:searchpass@localhost:5432/searchdb` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `CRAWLER_USER_AGENT` | `SearchBot/1.0 (Educational)` |
| `CRAWLER_DELAY_MS` | 1000; scheduler delay check, not a distributed guarantee |
| `CRAWLER_MAX_CONCURRENT`, `CRAWLER_MAX_PAGES` | 5 and 1000; admin start defaults to 100 successful pages |
| `AUTOCOMPLETE_LIMIT` | 10 |
| `SEARCH_RESULTS_PER_PAGE` | 10 in service; HTTP route independently defaults to 10 |
| `SEARCH_CACHE_TTL` | Parsed but unused; actual query TTL is 300 seconds, autocomplete 600 |
| `RATE_LIMIT_{SEARCH,AUTOCOMPLETE,ADMIN}_WINDOW_MS` | 60000 each |
| `RATE_LIMIT_{SEARCH,AUTOCOMPLETE,ADMIN}_MAX` | 60, 120, 10 respectively |
| `RATE_LIMIT_GLOBAL_MAX` | 200 per minute per process and IP |
| `CB_{ES,REDIS,PG}_{TIMEOUT,ERROR_THRESHOLD,RESET_TIMEOUT}` | Parsed template settings; current wrappers use hardcoded options |
| `IDEMPOTENCY_TTL`, `IDEMPOTENCY_LOCK_TIMEOUT` | Parsed but unused by helpers; helper defaults are 3600 and 60 seconds |

## Commands and verification

| Directory | Command | Purpose |
|---|---|---|
| backend | `npm run type-check`, `npm run build` | Type checking / compilation |
| backend | `npm run lint` | ESLint on source |
| backend | `npm run crawl -- --max-pages 10 --seed https://example.com/` | External HTTP crawling experiment; known defects below |
| backend | `npm run build-index` | Update inlinks, then bulk-index eligible PostgreSQL documents |
| backend | `npm run calculate-pagerank` | Calculate graph scores, write PostgreSQL, update Elasticsearch |
| frontend | `npm run type-check`, `npm run build`, `npm run lint` | Static checks / production assets |
| google-search | `npm install`, then `npm run test:e2e` | Existing Playwright page-load smoke tests |

Neither backend nor frontend defines `npm test`. The Playwright tests check page structure, not successful search, relevance, crawling, or persistence. They may pass with an empty index. This documentation review used source inspection and isolated checks; it did not run the live stack or certify these build commands as passing.

Useful probes: `/healthz` reports a live process; `/ready` and `/health` inspect PostgreSQL, Valkey, and Elasticsearch; `/metrics` exposes Prometheus text. Call them on the API port, for example `curl --fail http://localhost:3001/health`.

## Known limitations

- Crawling can fail when unsigned 64-bit URL/content hashes exceed PostgreSQL `BIGINT`. Document writes use `ON CONFLICT (url_id)` without a matching unique constraint.
- URL selection and status updates are separate operations, with no lease recovery. Concurrent crawlers can duplicate work; a crash leaves `crawling` rows stranded. A temporarily delayed host can cause a run to stop early.
- Links to already-known URLs are omitted from the graph. The “new links” count also includes existing URLs.
- Phrases are flattened into ordinary query text; site/exclusion filters run after pagination. Counts can disagree with visible results. Related-search SQL currently has an invalid `DISTINCT`/ordering combination.
- Multiplicative ranking gives zero score when PageRank or inlink count is zero. There is no trained ranker, click tracking, synonym expansion, or active spelling-correction pipeline.
- Search and suggestion requests have no stale-response guard. Highlight/fallback HTML is not sanitized; the autocomplete lacks complete combobox semantics and IME handling.
- Redis failure can fail search. General dependency breaker helpers are not connected to search; indexing breakers do not detect per-item bulk failures. Admin job acknowledgments are not durable job completion records.

See [Implementation Notes](./architecture.md#implementation-notes) for the precise source mapping and production changes needed.
