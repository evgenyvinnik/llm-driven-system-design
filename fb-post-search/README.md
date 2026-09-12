# Facebook Post Search

A local learning project for searching social posts with Elasticsearch. It demonstrates visibility-token filtering, friend/self relevance boosts, highlighted snippets, typeahead, and an admin inspection dashboard. PostgreSQL stores the source records and relationships; Valkey caches sessions and visibility sets.

The [architecture](./architecture.md) distinguishes the production proposal from the code. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [full-stack](./system-design-answer-fullstack.md) answers turn those ideas into focused interview discussions.

## What the app does

| Surface | Current behavior |
|---------|------------------|
| Search | Anonymous public search or signed-in visibility-filtered search; Enter/suggestion/hashtag commits a query |
| Filters | Date range, post type, and Public/Friends selections with Apply/Clear |
| Results | Snippets, author initials, dates, visibility/type icons, counts, and a raw relevance score; explicit Load More |
| Suggestions | Trending query prefixes, signed-in user-name matches, and a hashtag aggregation path with a prefix bug |
| Accounts | Username/password login, registration, opaque bearer sessions, logout |
| Admin | Overview, first page of users/posts/search history, health indicators, bulk reindex button |
| API-only features | Create/edit/delete posts, recent feed, author posts, increment likes, clear search history |
| Not implemented in the UI | Composer, profile/detail pages, functional Like/Comment/Share controls, uploads/media playback, friendship management, saved searches, live updates |

This is **not a complete privacy boundary**. Search trusts indexed visibility and cached relationships; author listings and likes use different access rules. Suggestions/trends can expose information outside result filtering. Snippets are inserted as raw HTML without sanitization, and passwords use unsalted SHA-256 rather than bcrypt. These limitations are explained in the architecture and should be part of evaluating the demo.

## Stack

Node.js 20+ with Express and TypeScript; PostgreSQL 16; Elasticsearch 8.11.0; Valkey 7 through ioredis. The browser uses React 19, Vite 5, TanStack Router, Zustand, Tailwind CSS, and lucide-react. Cockatiel, Pino, and prom-client provide partial resilience/observability wiring. There is no Kafka worker or frontend virtualizer.

## Run locally

Commands begin in `fb-post-search/` unless stated otherwise. Ports 5432, 6379, 9200/9300, 3000, and 5173 must be available.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U fb_search -d fb_post_search
docker compose exec -T redis redis-cli ping
curl -f http://localhost:9200/_cluster/health
```

A fresh PostgreSQL volume runs [init.sql](./backend/src/db/init.sql). Load the deterministic SQL fixture once before starting the backend:

```bash
docker compose exec -T postgres psql -U fb_search -d fb_post_search -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

Existing volumes retain their data. Schema initialization uses guarded tables/indexes and recreated triggers; it does not upgrade an old table definition. The fixture skips existing keyed users/posts/edges but appends search-history rows on rerun. Do not mix it with the separate destructive JavaScript seeder described below.

```bash
docker compose down
# Destructive: removes this project's database, cache, and index volumes.
docker compose down -v
```

### Option B: Native installation (no Docker)

For a fresh macOS Homebrew PostgreSQL/Valkey installation:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE fb_search WITH LOGIN PASSWORD 'fb_search_password';"
createdb -O fb_search fb_post_search
PGPASSWORD=fb_search_password psql -h localhost -U fb_search -d fb_post_search -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=fb_search_password psql -h localhost -U fb_search -d fb_post_search -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
pg_isready -h localhost -U fb_search -d fb_post_search
valkey-cli ping
```

Inspect existing roles/databases and skip creation when appropriate. Do not run native and Docker services on the same ports.

Use the matching macOS archive from the [Elasticsearch 8.11.0 release](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0). The following follows Elastic's [archive installation](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html), with local-only settings matching this demo's unauthenticated client:

```bash
mkdir -p "$HOME/.local/share/fb-post-search"
cd "$HOME/.local/share/fb-post-search"
FPS_ES_ARCH="$(uname -m)"
case "$FPS_ES_ARCH" in
  arm64) FPS_ES_ARCH=aarch64 ;;
  x86_64) ;;
  *) echo "Choose a supported macOS archive"; exit 1 ;;
esac
FPS_ES_ARCHIVE="elasticsearch-8.11.0-darwin-${FPS_ES_ARCH}.tar.gz"
curl -fLO "https://artifacts.elastic.co/downloads/elasticsearch/${FPS_ES_ARCHIVE}"
curl -fLO "https://artifacts.elastic.co/downloads/elasticsearch/${FPS_ES_ARCHIVE}.sha512"
shasum -a 512 -c "${FPS_ES_ARCHIVE}.sha512"
tar -xzf "$FPS_ES_ARCHIVE"
cd elasticsearch-8.11.0
ES_JAVA_OPTS="-Xms512m -Xmx512m" ./bin/elasticsearch \
  -Ediscovery.type=single-node -Enetwork.host=127.0.0.1 \
  -Expack.security.enabled=false -Expack.security.enrollment.enabled=false
```

Keep this terminal open; Ctrl-C stops Elasticsearch. Verify from another terminal with `curl -f http://localhost:9200/_cluster/health`. The API creates the configured posts index, so no manual mapping command is needed.

### Backend and frontend

In a terminal starting in the project directory:

```bash
cd backend
npm install
cp -n .env.example .env
npm run dev
```

In another terminal starting at the repository root:

```bash
cd fb-post-search/frontend
npm install
npm run dev
```

Open [PostSearch](http://localhost:5173). Vite proxies `/api` to port 3000. The backend listens before Elasticsearch initialization finishes, retries initialization up to ten times, and attempts a sequential backfill only when the index is empty. Wait for the backfill log before checking SQL-fixture searches. A partially populated index is not repaired by restarting; use the admin reindex action for upserts, subject to its limitations below.

## Fixtures and credentials

**The setup above uses [backend/db-seed/seed.sql](./backend/db-seed/seed.sql):** six users, fifteen posts across all four visibility labels, ten accepted directed friendship rows plus one pending row, and ten history entries.

| Username | Password | Notes |
|----------|----------|-------|
| alice | password123 | Friends with Bob and Carol |
| bob | password123 | Friends with Alice, David, and Emma |
| carol | password123 | Friends with Alice and Emma |
| david | password123 | Friend of Bob; pending request to Alice |
| emma | password123 | Friends with Bob and Carol |
| admin | password123 | Email admin@facebook.local; admin dashboard access |

Log in with **username**, not email. The login page's printed `admin / admin123` applies to the other seeder, not this SQL fixture. The SQL hash matches the actual SHA-256 login implementation.

**Alternative `npm run db:seed`:** runs [scripts/seed.ts](./backend/src/scripts/seed.ts). It first initializes Elasticsearch, then deletes existing SQL users, posts, friendships, sessions, and history and attempts to clear the index. It creates nine users, twenty-five posts with randomized authors/dates/counters, and twenty-six accepted directed edges. Its admin is `admin / admin123`; ordinary users are alice, bob, carol, david, eve, frank, grace, and henry with password123. It contains public/friends posts, including coffee and birthday examples, rather than all four visibility labels. It does not clear Redis caches or inspect individual bulk indexing errors. Use it only for a disposable alternative dataset.

## Walkthrough

1. Search for `code` or `#programming` with the SQL fixture. Search is public without login; signing in adds eligible indexed friend/private content.
2. Open Filters, choose a type or visibility, and Apply. Typing updates suggestions immediately; it does not run a full search until Enter or a suggestion click.
3. Compare Alice and David searching for `sunset`: Alice owns the friends post, while David's pending edge should not grant search access under the indexed model. This does not establish the safety of every API endpoint.
4. Log in as the fixture's admin to inspect overview/users/posts/history. The health API returns nested service objects, while the UI expects booleans, so red indicators do not reliably reflect dependency health.
5. Use the interview answers to compare the current offset paging and request races with a proposed search-session contract.

The SQL fixture has no coffee/birthday posts despite the home placeholder. Recent-search retrieval currently uses invalid aggregate/DISTINCT SQL; its failure is hidden by the browser. Admin tables load only their first page, and the health bar is not polled continuously.

## Environment and scripts

| Setting | Actual default / behavior |
|---------|---------------------------|
| `NODE_ENV` / `PORT` | development / 3000 |
| `POSTGRES_HOST` / `POSTGRES_PORT` | localhost / 5432 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | fb_search / fb_search_password / fb_post_search |
| `ELASTICSEARCH_URL` / `ELASTICSEARCH_INDEX` | http://localhost:9200 / posts |
| `REDIS_URL` | redis://localhost:6379 |
| `SESSION_SECRET` | Parsed, but unused by opaque session handling |
| `LOG_LEVEL` | Not read; logger selects debug/info/silent by NODE_ENV |
| CORS | Fixed localhost:5173 and localhost:3000 origins |

The application and most scripts load `.env` through config. **`db:migrate` is different:** it reads exported `DATABASE_URL` or a hardcoded connection string matching Compose, and does not load `.env` or the `POSTGRES_*` settings. Run it from the backend directory when initializing an empty database or reapplying the consolidated schema; it does not record a version history.

`db:status` and `db:rollback` use a different numbered-migration helper and a missing `src/db/migrations` directory; they do not describe or undo `db:migrate`. `db:index` points to the missing `src/scripts/index-seeded-posts.ts`. `db:cleanup` deletes SQL search history older than 90 days when invoked; no scheduler runs it automatically.

`dev:server1`, `dev:server2`, and `dev:server3` run on 3001–3003 in separate backend terminals. They share the three data services, but the Vite proxy remains on 3000. Rate limits and circuit state are per process; no load balancer is supplied.

## API map

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/logout` | Account/session lifecycle |
| GET | `/api/v1/auth/me` | Current user |
| POST | `/api/v1/search` | Query, filters, and pagination; optional authentication |
| GET | `/api/v1/search/suggestions`, `/api/v1/search/trending`, `/api/v1/search/filters` | Suggestions, trends, advertised filter choices |
| GET / DELETE | `/api/v1/search/recent` / `/api/v1/search/history` | Personal history / clear history |
| POST | `/api/v1/posts` | Create; SQL then synchronous indexing |
| GET | `/api/v1/posts/feed`, `/api/v1/posts/user/:userId`, `/api/v1/posts/:id` | Feed, author list, single post |
| PUT / DELETE / POST | `/api/v1/posts/:id` / `/api/v1/posts/:id` / `/api/v1/posts/:id/like` | Edit, hard-delete, increment likes |
| GET | `/api/v1/admin/stats`, `/api/v1/admin/users`, `/api/v1/admin/posts`, `/api/v1/admin/search-history`, `/api/v1/admin/health` | Admin inspection |
| POST | `/api/v1/admin/reindex` | Bulk upsert current SQL posts |

Explicit list limits/offsets are advisable when calling list APIs directly: several optional query-parameter defaults turn an omitted value into NaN. The frontend passes these parameters for its list calls. Search advertises sort choices through `/filters`, but the search request has no sort implementation.

## Known implementation boundaries

- Search reads Elasticsearch content directly, with no current SQL permission/deletion check. Visibility caches last 15 minutes and their invalidation helper has no callers. There are no friendship mutation routes. Friends-of-friends maps to direct friends in search, and other post endpoints enforce different rules.
- Creation can save SQL but return 500 after indexing fails. Deletion removes SQL and swallows any index-delete error. There is no durable retry queue, idempotent creation receipt, or event-version guard. Reindex upserts existing posts; it does not remove orphan documents or rebuild an index atomically, and its success count ignores item failures.
- Suggestions cache by prefix alone, ignoring viewer/authentication and requested limit. Hashtags are stored with `#`, while the aggregation strips it; the aggregation also lacks visibility filtering. Trending queries are global, cumulative, and based on signed-in searches, including repeated page requests.
- The home store has no cancellation, request generations, URL query state, deduplication, result-memory bound, or account reset. Old responses can overwrite a newer search; editing filters before Apply can combine a new filter with an old Load More cursor. A page failure replaces the whole result view with an error.
- The Cockatiel retry policy is unused by the wrapper. A search/health pre-check can prevent half-open recovery; the outer timeout does not cancel Elasticsearch work or necessarily count as an inner breaker failure. Health/readiness can pass with Elasticsearch/Redis down, and the global rate limiter also covers probes/metrics. Shutdown calls process.exit immediately.

## Development and verification

```bash
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix frontend run type-check
npm --prefix backend run lint
npm --prefix frontend run lint
curl -f http://localhost:3000/health
curl -f http://localhost:3000/readyz
curl -f http://localhost:3000/metrics
```

Project-level `npm run test:e2e` and repository-level `npm run test:smoke fb-post-search` use Playwright after installing its dependencies/browser and starting the data services/API. The smoke helper still selects an email field on a username form; its admin case uses Alice and only asserts a generic main element. Screenshot setup uses the correct Alice username but also navigates to admin as Alice. These are not permission or search-correctness tests.

This documentation review read the source and ran ten isolated checks with mocked dependencies and the installed Cockatiel library. It did not start the stack, build, benchmark, or repair application code.
