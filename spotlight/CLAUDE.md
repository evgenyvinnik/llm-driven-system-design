# Spotlight — Development with Claude

## Project Context

Spotlight is a search box with an unusual constraint: it has to answer before the user finishes typing, and the thing they're looking for might be a file, an app, a contact, a bookmark, or not a document at all — `47*1.08` and `12 km to miles` are queries too. That makes it two problems wearing one input field. One is retrieval across heterogeneous corpora that have no shared schema; the other is deciding, per keystroke, whether this is even a retrieval query.

The retrieval half is where the design lives. Ranking a file against a contact requires a single comparable score, but "relevance" means different things for each — a file matches on name and content, an app matches almost entirely on name prefix, and a bookmark's title is short enough that BM25 term statistics are nearly meaningless. Worse, textual relevance is often the *wrong* signal: the app you launch every morning at 9am should win over a better lexical match you've never opened.

**Learning goals:** multi-index search with a merged relevance model, edge n-grams for prefix-as-you-type matching, function-score decay for recency and usage signals, dual-write consistency between a system of record and a search index, and query classification that routes non-search intents before the index is ever touched.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 for multi-instance testing |
| **Elasticsearch 8.11** | 9200 | The four search indices. Chosen for edge n-gram analyzers, cross-index search in one request, and `function_score` — none of which Postgres FTS gives you cleanly |
| **PostgreSQL 16** | 5432 | System of record: `indexed_files`, `applications`, `contacts`, `web_items`, plus the behavioral tables `app_usage_patterns` and `recent_activity` that ES never sees |
| **Valkey (Redis)** | 6379 | Present in Compose; `ioredis` backs the idempotency store |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Four ES indices — `spotlight_files`, `spotlight_apps`, `spotlight_contacts`, `spotlight_web` — are created at boot by `initializeElasticsearch` in `backend/src/services/elasticsearch.ts`, each with an identical `edge_ngram_analyzer` (1–20 grams, `standard` as the search analyzer). `services/queryParser.ts` holds the non-search intents (mathjs evaluation, a unit-conversion table across length/weight/temperature/volume/time/data, and natural-language date filters). `services/suggestions.ts` produces the zero-query "Siri-style" panel from Postgres behavioral data. Routes: `routes/search.ts` (`/` and `/suggest`), `routes/index.ts` (per-type indexing plus bulk, all idempotency-wrapped), `routes/suggestions.ts`. Shared modules in `backend/src/shared/`: `rateLimiter.ts`, `circuitBreaker.ts` (Opossum around index writes), `idempotency.ts`, `metrics.ts`, `logger.ts`.

Frontend is React 19 + Zustand + Tailwind — notably **no router**, because the whole app is one modal. `hooks/useKeyboardShortcut.ts` binds Cmd/Ctrl+K, Escape, arrow keys, and Enter at the document level; `hooks/useDebounce.ts` throttles keystrokes into requests. This is the one project here with no authentication at all.

## Key Design Decisions

### 1. Four indices searched together, not one index with a `type` field

Each content type gets its own index with its own mapping, and `searchAll` passes an array of index names in a single request.

One combined index is the tempting simplification, and it degrades relevance in a way that's hard to debug. Elasticsearch computes term statistics per field per index — so with everything in one index, the `name` field would blend file names, app names, contact names, and page titles into one IDF distribution. A term that's rare among contacts but ubiquitous in file paths gets a single global weight that is wrong for both. Separate indices also mean the mappings can genuinely differ: `content` is a full-text field that only files have, `bundle_id` and `usage_count` only apply to apps, and `metadata` is stored with `enabled: false` on files so it round-trips without being analyzed at all.

Searching them together in one request is what makes this affordable — ES merges and re-ranks across indices server-side, so there's no application-level score normalization and no N round-trips. What we give up is that scores from different indices aren't strictly comparable even so, and the shared `function_score` boosts are doing real work to paper over it. Adding a fifth type means declaring a fifth mapping with the same duplicated analyzer block, which is already copied verbatim four times — the first thing to fix with an index template.

### 2. Edge n-grams at index time, standard analysis at search time

Every searchable name field carries a `.prefix` sub-field analyzed with `edge_ngram` (min 1, max 20) and a `search_analyzer` of `standard`.

The asymmetry is the entire point and getting it wrong is the classic mistake. Indexing "Calculator" produces every prefix — c, ca, cal, calc… — so a user who has typed `calc` gets an exact term hit against a precomputed token. That's a dictionary lookup, not a scan. If the *search* analyzer were also edge_ngram, the query `calc` would itself expand to c/ca/cal/calc and match anything starting with "c", flooding results with noise scored by accidental gram overlap. The one-sided expansion gives prefix-as-you-type at term-lookup cost.

The alternatives fail differently. A leading-wildcard query (`*calc*`) can't use the inverted index and scans every term in the field. ES's completion suggester is faster still but lives in a separate FST structure that can't participate in the same `function_score` query as everything else — you'd get suggestions ranked independently of recency and usage, which is precisely the signal blend this project is about.

What we give up is index size: storing 20 prefixes per token multiplies the term dictionary. For a corpus of file names that's a real but acceptable cost; for the `content` field it would not be, which is why `content` has no `.prefix` variant.

### 3. Relevance is textual score *multiplied* by behavioral decay

The query is a `function_score` with `boost_mode: multiply`: a `bool.should` of prefix and fuzzy matches produces the text score, then three functions modify it — a Gaussian decay on `modified_at` (7-day scale, weight 2), a Gaussian decay on `last_used` (3-day scale, weight 3), and a `log1p` factor on `usage_count`.

Pure lexical ranking is wrong for this product in a way that's obvious the moment you use it. Type `re` and BM25 will happily rank a five-year-old `README.md` above the app you opened twenty minutes ago, because it has no idea one of those is part of your life and the other isn't. Personal search is dominated by recency and habit; the text query's job is to *narrow the candidate set*, and the behavioral signals decide the order within it.

Multiply rather than sum is deliberate. Summing lets a strong recency boost drag in a document that barely matches the text at all — a file you touched this morning surfacing for a query about something else entirely, which reads as the search being broken. Multiplying makes the behavioral score a modifier on relevance, so something has to match textually first to be boosted at all. The `last_used` scale being shorter and weighted higher than `modified_at` (3d/weight 3 vs 7d/weight 2) encodes a real claim: what you *opened* recently predicts intent better than what merely *changed* recently, since background processes touch files you've never thought about.

The cost: these five numbers are hand-tuned with no evaluation set. There's no click-through logging, so there's no way to know whether weight 3 beats weight 5 — the `logSearch` call records query, result count, and latency, but never which result was chosen.

### 4. Non-search queries are classified before the index is touched

`parseQuery` runs first on every request. A string matching `^[\d\s+\-*/().%^]+$` is a math expression; `12 km to miles` is a conversion; anything containing from/since/before/after/last/yesterday/today gets a date-filter parse. Math and conversion results are prepended to the result list with a fixed score of 100.

Sending `47*1.08` to Elasticsearch would be worse than useless — it returns nothing, slowly, and then the UI has to decide what to show for an empty result set. Classifying first means the calculator answer appears instantly with zero index cost, and the regexes are cheap enough to run per keystroke. Fixing the score at 100 rather than competing on relevance is the right call because these results are *deterministic*: if the user typed an arithmetic expression, they want the answer, and no document should outrank it.

What we give up is that classification is regex-based and therefore brittle at the edges. A file literally named `2024` is a math expression by the current test. `mathjs.evaluate` is also a real expression evaluator being handed raw user input — safe here because the input is pre-filtered to digits and operators, but the filter *is* the security boundary, and loosening the regex to support variables or functions would quietly turn it into an evaluation sink.

### 5. Postgres and Elasticsearch are dual-written, with a breaker and idempotency on the ES half

Every indexing route writes the row to Postgres with `ON CONFLICT … DO UPDATE`, then pushes the document to ES through an Opossum circuit breaker, with the whole operation wrapped in `withIdempotency`.

The ordering encodes which store is authoritative. Postgres is the system of record and holds data ES never sees at all — `app_usage_patterns` and `recent_activity` drive the zero-query suggestions panel entirely from SQL. ES is a derived, rebuildable projection. So a Postgres failure aborts the request, while an ES failure with the breaker open returns a 503 with `CIRCUIT_BREAKER_OPEN` after the row is already durably stored.

That's also the honest weakness: **there is no dual-write reconciliation**. When the breaker rejects an index operation, the Postgres row exists and the ES document doesn't, and nothing ever notices — the item is simply unfindable, forever, with no error surface after the initial 503. A real system needs either an outbox with a reindex worker or a periodic diff. Idempotency (keyed by content when the client sends no header) at least makes replaying the write safe once someone builds the thing that replays it.

## Current State

Runs with `docker-compose up -d` (Postgres, Elasticsearch, Valkey), then `npm run db:migrate` and `npm run db:seed` in `backend/`, then `npm run dev` (API on 3001). Implemented: the four ES indices created at boot with edge n-gram analyzers, cross-index `function_score` search with fuzzy fallback (`fuzziness: AUTO`, `prefix_length: 2`), prefix autocomplete via `/api/search/suggest`, math evaluation and unit conversion across six categories, natural-language date-filter parsing, a web-search fallback result when fewer than three hits come back, per-type and bulk indexing endpoints with idempotency and circuit breakers, time-and-usage-based suggestions from Postgres, per-route rate limiting keyed by session-or-IP, Prometheus metrics, structured pino logging with request IDs and an audit log, and `/health` `/ready` `/alive` (with `/health` reporting ES cluster status and breaker states).

Seed data comes from `backend/src/seed.ts` — sample apps, contacts, files, and web items are written to Postgres *and* indexed into ES, plus synthetic usage patterns concentrated in working hours (9–11, 14–16) so the suggestions panel has something to show. **There are no user accounts**: this project has no authentication, and `scripts/screenshot-configs/spotlight.json` correctly sets `auth.enabled: false`.

Frontend implements the Cmd/Ctrl+K modal with debounced querying, arrow-key navigation, Enter-to-execute, Escape-to-close, grouped result rendering by type, and the zero-query suggestions panel.

Simulated or omitted: no file-system watcher — indexing is push-only via the API, so nothing is discovered automatically. No content extraction for real formats (no Tika, no PDF/Office parsing); `content` is whatever the caller posts. No messages/email/calendar sources. No on-device ML; "intelligence" is SQL aggregation over usage counts. No click-through logging, so ranking cannot be evaluated.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the checkbox CLAUDE.md. Its Phase 3 listed `- [ ] Date parsing` as unbuilt while `parseDateFilter` in `services/queryParser.ts` already handled today/yesterday/last week/last month/last N days and `parseQuery` routed to it. The old file also had entries like "File watcher (designed, not implemented)" marked `[x]`, which is the checklist format actively working against comprehension — a checked box meaning "not implemented."
- **Rate limiter modernized:** `shared/rateLimiter.ts` now uses `express-rate-limit` v8's `ipKeyGenerator` helper in its `keyGenerator` instead of raw `req.ip`. The raw version mishandles IPv6 (each address in a /64 is treated as a distinct client, so a limit is trivially bypassed); v8 warns on it. Health and metrics endpoints are excluded via `skip` so probes can't consume a caller's budget.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts`, matching the Vite proxy target. `index.ts` still defaults to 3000 when `PORT` is unset. Note `scripts/screenshot-configs/spotlight.json` declares `"backendPort": 3000`, which contradicts both — the harness prefers the config value, so it waits on a port nothing binds.
- **Circuit-breaker errors surface as 503, not 500:** index routes check for Opossum's `EOPENBREAKER` code and return `CIRCUIT_BREAKER_OPEN` with a 503, so a caller can distinguish "Elasticsearch is down, retry later" from "your request was malformed."
- **CI:** the repo-wide smoke-test workflow was removed. Elasticsearch alone needs ~512MB heap and a slow health-gated startup, which a CI runner won't provide; verification is local (`npm run triage spotlight`).

## Open Questions

1. The dual write has no reconciliation path — a breaker-rejected index operation leaves a Postgres row with no ES document and nothing detects it. Is an outbox table plus a reindex worker the right shape, or is a periodic `indexed_files` vs `spotlight_files` diff simpler for a corpus this size?
2. The four analyzer definitions are copy-pasted per index. Would an index template plus a shared component template be worth it, or does it just move the duplication into a place that's harder to read?
3. Ranking weights (2/3/log1p, 7d/3d decay scales) are guesses with no evaluation set, and `logSearch` records the query but never the click. Is adding result-selection logging the highest-value next step for this project's actual thesis?
4. Everything is indexed at write time with `refresh: true`, which forces a segment refresh per document. That's what makes the demo feel instant and it's exactly what you must not do at volume. Where's the cut-off — and does the bulk endpoint deserve different refresh semantics from the single-item ones?
5. `mathjs.evaluate` on user input is safe only because the classifier regex is restrictive. If natural-language queries get richer, does the evaluator need sandboxing, or should the classifier stay deliberately narrow as the security boundary?

## Resources

- [Elasticsearch edge n-gram tokenizer](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-edgengram-tokenizer.html) — including the warning about search-time analysis that decision 2 is built on
- [Elasticsearch function_score query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html) — decay functions and `boost_mode`
- [Elasticsearch multi-index search](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html)
- [mathjs expression parsing](https://mathjs.org/docs/expressions/parsing.html) — and its security notes
- [express-rate-limit IPv6 guidance](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues) — the `ipKeyGenerator` fix
