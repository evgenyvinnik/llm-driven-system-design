# Etsy — handmade and vintage marketplace

A local marketplace learning project with buyer browsing, keyword search, shops, favorites, a server-side cart, and seller tools. It combines a React interface with PostgreSQL catalog/order data, Valkey sessions and caches, and an Elasticsearch search index. The interesting design problems are selling scarce inventory, coordinating purchases across sellers, and keeping search useful as listings change.

**Current implementation:** browsing and seeded order pages provide a useful demo, but fresh-schema checkout fails. The checkout handler inserts `orders.payment_transaction_id`, which [the supplied schema](./backend/src/db/init.sql) does not define. Payment is simulated before this insert. There is no real charge, payment queue, or refund service. See [implementation limits](#implementation-limits) before evaluating checkout correctness.

Read [architecture.md](./architecture.md) for the production proposal and source-grounded implementation map. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers are separate 45-minute interview walkthroughs; their proposed reservations and durable payment workflow are not implemented here.

## What you can explore

| Persona | Interface | Current behavior |
|---------|-----------|------------------|
| Visitor | Home, categories, search, products, shops | Trending cards, filters, product images, related-product suggestions |
| Buyer | Login, favorites, cart, checkout, orders | PostgreSQL cart grouped by shop, delivery form, seeded order history |
| Seller | Shop creation, dashboard, new listing | First-shop statistics, recent orders, status changes, listing creation with image URLs |
| Admin | Seeded account only | No admin API or moderation interface |

Search requires separately indexing seeded products. Favorites and cart changes wait for the API; there is no optimistic cache, real-time inventory feed, or offline checkout. Reviews have an API but no review-reading or submission interface. The dashboard's **Edit** link opens the public product page; it does not provide a listing editor.

## Stack and ports

Use Node.js 20+ and npm. The dependency manifests specify React 19, Vite 5, TypeScript, TanStack Router, Zustand, Tailwind CSS 3, Express 4, `pg`, `ioredis`, `connect-redis`, Opossum, Pino, and `prom-client`.

| Component | Local address | Configuration |
|-----------|---------------|---------------|
| Frontend | http://localhost:5173 | Vite proxies `/api` and `/uploads` to port 3000 |
| API | http://localhost:3000 | One Express process; optional instance scripts use 3001–3003 |
| PostgreSQL 16 | localhost:5432 | User `etsy`, password `etsy_password`, database `etsy_db` |
| Valkey 7 | localhost:6379 | No development password |
| Elasticsearch 8.11.0 | http://localhost:9200 | Single node; development security disabled; transport port 9300 |

Elasticsearch 8.11.0 is the pinned teaching configuration, not a claim that it is a current supported release. Use one infrastructure option below, then follow the common application setup. Existing projects using these ports must be stopped first.

## Infrastructure

### Option A: Docker Compose (recommended)

Run from the `etsy` directory:

```bash
docker compose up -d
docker compose ps
curl -fsS http://localhost:9200/_cluster/health
```

Compose starts PostgreSQL, Valkey, and Elasticsearch with persistent volumes. It does not start the Node processes. PostgreSQL runs `init.sql` when its volume is first created. Elasticsearch uses a 512 MiB heap; allow additional memory for its process, PostgreSQL, and the application.

```bash
# Stop containers while preserving data.
docker compose down
# Reset this project's database, sessions, and search index; deletes its volumes.
docker compose down -v
```

Legacy `docker-compose` is equivalent if that is the executable installed. Repository screenshot automation invokes that spelling.

### Option B: Native installation (macOS, no Docker)

Install and start PostgreSQL and Valkey with Homebrew:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"

# One-time development role and database creation.
psql postgres -c "CREATE ROLE etsy LOGIN PASSWORD 'etsy_password';"
createdb -O etsy etsy_db
PGPASSWORD=etsy_password psql -h localhost -U etsy -d etsy_db -c 'SELECT 1;'
valkey-cli ping
```

For Elasticsearch, download the macOS archive and matching checksum from the official [8.11.0 release page](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0). Select **aarch64** for Apple Silicon or **x86_64** for Intel. The following example assumes the two files are in the current directory; set the architecture accordingly:

```bash
etsy_es_arch=aarch64
shasum -a 512 -c "elasticsearch-8.11.0-darwin-${etsy_es_arch}.tar.gz.sha512"
tar -xzf "elasticsearch-8.11.0-darwin-${etsy_es_arch}.tar.gz"
cd elasticsearch-8.11.0
ES_JAVA_OPTS='-Xms512m -Xmx512m' ./bin/elasticsearch \
  -Ediscovery.type=single-node \
  -Enetwork.host=127.0.0.1 \
  -Expack.security.enabled=false \
  -Expack.security.enrollment.enabled=false
```

Keep this terminal open; use a fresh archive configuration for these local HTTP settings. The archive bundles Java and accepts configuration through `-E` arguments; see Elastic's [archive installation guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html). In another terminal, verify `curl -fsS http://localhost:9200/_cluster/health`. The API creates the `products` index on startup, but does not populate it from PostgreSQL.

Stop native Elasticsearch with Ctrl-C. Use `brew services stop postgresql@16` and `brew services stop valkey` when finished. These stop commands preserve data.

## Application setup

From `etsy/backend`:

```bash
npm install
cp .env.example .env
mkdir -p uploads
npm run db:migrate
npm run db:seed
npm run dev
```

`dotenv` loads `backend/.env` when commands run from the backend directory. `uploads/` is required for the image-upload API; the frontend's new-listing form currently accepts URLs instead. Migration uses `CREATE TABLE IF NOT EXISTS`; rerunning it does not add missing columns to existing tables or fix the checkout/schema mismatch.

| Environment variable | Default / local value |
|----------------------|-----------------------|
| `DATABASE_URL` | `postgresql://etsy:etsy_password@localhost:5432/etsy_db` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `SESSION_SECRET` | Set a development secret in `.env`; source fallback is `dev-secret-key` |
| `PORT` | `3000` |
| `NODE_ENV` | `development` |
| `FRONTEND_URL` | `http://localhost:5173` |

In a second terminal, from `etsy/frontend`:

```bash
npm install
npm run dev
```

Open [the marketplace](http://localhost:5173). Health checks are available at `/api/health`, `/api/ready`, and `/api/live`; `/metrics` exposes Prometheus text. Health and readiness check PostgreSQL and Valkey. They do not verify search index contents, image storage, or checkout/schema compatibility.

### Seed accounts and fixtures

The common setup above uses [the TypeScript seed](./backend/src/db/seed.ts). On a fresh database it creates eight categories, five users, three shops, ten products, and a small buyer cart/favorites/order fixture.

| Login email | Persona | Password with `npm run db:seed` |
|----------------|---------|----------------------------------|
| `buyer@example.com` | Buyer | `password123` |
| `alice@example.com` | Alice’s Handmade Jewelry seller | `password123` |
| `bob@example.com` | Bob’s Woodwork Studio seller | `password123` |
| `carol@example.com` | Carol’s Vintage Finds seller | `password123` |
| `admin@example.com` | Admin-role account, no admin interface | `admin123` |

For richer screenshots, choose [the SQL seed](./backend/db-seed/seed.sql) **instead of** `npm run db:seed`, after migration, on a fresh database:

```bash
# Run from etsy/backend; requires the psql client.
PGPASSWORD=etsy_password psql -v ON_ERROR_STOP=1 \
  -h localhost -U etsy -d etsy_db -f db-seed/seed.sql
```

The SQL fixture uses `password123` for **all five accounts, including admin**. It adds three buyer orders, a multi-shop cart, and illustrative ratings/counters. The root screenshot runner chooses this SQL fixture because it contains user rows. Neither seeder is fully idempotent: repeated runs add duplicate products and can add dependent fixtures. Existing user passwords are not overwritten by the other seeder.

Neither seed populates Elasticsearch. A running, empty index returns zero search results; this does not trigger the SQL fallback.

### Put seeded products into the search index

For a fresh demo index, this one-off command uses the existing indexing helper. Run from `etsy/backend` after dependencies, database, and Elasticsearch are ready:

```bash
node --import tsx --input-type=module <<'NODE'
import db from './src/db/index.ts';
import es, { initializeIndex, indexProduct } from './src/services/elasticsearch.ts';
try {
  await initializeIndex();
  const { rows } = await db.query(`
    SELECT p.*, s.name AS shop_name, s.rating AS shop_rating,
           s.sales_count AS shop_sales_count, c.name AS category_name
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true AND s.is_active = true
  `);
  for (const product of rows) await indexProduct(product);
  await es.indices.refresh({ index: 'products' });
  console.log(await es.count({ index: 'products' }));
} finally {
  await db.pool.end();
  await es.close();
}
NODE
```

The helper logs individual indexing failures rather than throwing them, so inspect errors and the resulting count. Ten documents are expected for either single fresh seed. This command upserts current rows; it is not a complete repair of stale/deleted documents or mappings. Previously cached empty searches can remain for two minutes. Product creation and updates attempt indexing, but there is no retry worker or seed-index script in `package.json`.

### Seller navigation

Log in as a seller from the home page, reload the **home page**, wait for the session check, then navigate to the seller dashboard through the UI. Login returns `shopIds`, while `/api/auth/me` returns the `shops` objects the dashboard expects. Directly reloading a protected seller route can redirect to login before session hydration finishes. The dashboard only displays the first shop.

## Useful commands and verification

| Directory | Command | Purpose |
|-----------|---------|---------|
| `backend` | `npm run build` / `npm run type-check` | Compile / check backend TypeScript |
| `backend` | `npm run start` | Run compiled `dist/index.js` after building |
| `backend` | `npm run dev:server1` through `dev:server3` | Optional API processes on ports 3001–3003 |
| `frontend` | `npm run build` | TypeScript project build and Vite production bundle |
| Either application directory | `npm run lint` | Existing ESLint setup |
| `etsy` | `npm install` then `npm run test:e2e` | Project Playwright smoke tests |
| Repository root | `npm run test:smoke etsy` | Root smoke runner against a running stack |
| Repository root | `node scripts/screenshots.mjs --start etsy` | Start infrastructure/apps, seed, capture, and clean up processes |

The Vite proxy still targets port 3000 when alternate API instances run; no load balancer is included. Shared database and sessions alone do not make checkout concurrency safe.

The Playwright configuration can start Vite, but requires a working backend/database/session service. Its smoke tests log in as Alice and check basic home, cart, favorites, and order page rendering. They do not establish successful checkout, search correctness, or seller workflow correctness. Screenshots use the buyer account. This documentation review used source inspection and isolated mocked handler checks; it did not start the full stack or claim passing runtime tests.

## Implementation limits

- **Checkout and inventory:** the missing payment column blocks a fresh checkout. Even with a compatible database, availability is read before the transaction and decremented without a conditional stock claim. `reserved_until` is set to 15 minutes ahead when adding a new cart row for a one-unit product, but it is never enforced or expired by a worker.
- **Payment and retries:** payment is a random simulation. Its fallback says “queued” without storing a job. The optional Redis idempotency middleware is not used by the frontend; keys are not scoped to a user or request body and can replay another user's response.
- **Cancellation:** buyer cancellation can restock twice under concurrency; seller status changes to cancelled do not restock. Neither path refunds payment. Status transitions have no concurrency guard.
- **Search and freshness:** indexing failures are swallowed, inventory changes do not consistently reach the index, and cache invalidation misses shop-page and search keys. SQL fallback drops price, shipping, attribute filters, and requested sorting. The UI does not disclose degradation and can substitute general catalog results after a search request error.
- **Client state:** protected routes race session hydration; requests can apply stale responses after navigation/account changes. Cart failures can appear as an empty cart. Checkout sends another cart deletion after success, which can remove newly added items.
- **Scope:** no real payment provider, reservation worker, order reconciliation, fulfillment integration, object store/CDN, admin moderation, personalized feed, or WebSocket updates. Uploads are local files. Monetary arithmetic uses floating-point JavaScript values, although PostgreSQL stores decimal amounts.

See [Implementation Notes](./architecture.md#implementation-notes) for source links and the distinction between implemented patterns and their current guarantees.
