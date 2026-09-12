# Apple Maps — route-planning demo

A local system-design project for A* routing, PostGIS spatial queries, and a
Leaflet map interface. The backend routes over a **synthetic 20 × 20 grid near San
Francisco**, while the browser displays real OpenStreetMap raster tiles underneath.
The generated streets and randomly placed named POIs do not reproduce the real
road network. This is an algorithm demonstration, not real-world navigation data.

See [architecture.md](./architecture.md) for the proposed production design and
source-backed implementation notes. The [frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) answers are interview walkthroughs.

## What the project does

| Area | Current behavior |
|------|------------------|
| Map | Leaflet pan/zoom, raster basemap, draggable origin/destination markers |
| Routing | In-memory A* over seeded roads; travel time from latest stored/simulated speeds |
| Directions | A route polyline, distance/time totals, and bearing-based turn instructions |
| Search | PostgreSQL full-text POI-name search near the map center; separate geocoding APIs |
| Traffic | Synthetic per-segment speeds generated every 10 seconds by each API process |
| Layers | POIs, traffic lines, and incident markers; requests on map movement or toggles |
| Location | A one-time browser location request that recenters the map |
| Backend exercises | GPS probe ingestion and incident APIs, with limitations below |

Start displays the initial navigation instruction and a fixed ETA. There is no
continuous position watcher, live maneuver advancement, off-route detection,
rerouting, voice guidance, saved navigation session, or offline map package.
The alternatives API returns the primary route only. No account or admin UI is provided.

The frontend uses React 19, Leaflet 1.9, react-leaflet 5, Zustand 4, Vite 6, and
Tailwind 3. The backend is TypeScript/Express with PostgreSQL/PostGIS and Valkey.
It does not run Kafka, ClickHouse, Elasticsearch, a tile server, or a routing engine
such as OSRM. There is no TanStack Query or client-side routing library.

## Run locally

Use Node.js 20+ and npm. Choose one infrastructure option, then seed and start the
application. The default development API port is **3001**, matching the Vite proxy;
`npm start` uses port 3000 unless `PORT` is set explicitly.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd apple-maps
docker compose up -d
docker compose ps
```

Compose starts PostGIS/PostgreSQL 16 on 5432 and Valkey 7 on 6379. On a **fresh
PostgreSQL volume**, it executes `backend/src/db/init.sql` automatically. Wait for
the database health check before seeding. Existing volumes are not migrated.

```bash
docker compose exec -T postgres psql -U maps -d apple_maps -c 'SELECT PostGIS_Version();'
docker compose exec -T redis redis-cli ping
```

Do not rerun the migration on an initialized schema: its table creation statements
are not idempotent. `docker compose down` stops infrastructure and retains data.
`docker compose down -v` deletes the project's PostgreSQL and Valkey volumes; use
that command only when deliberately discarding the local data.

### Option B: Native installation (no Docker)

For macOS, install a PostgreSQL version supported by Homebrew's current PostGIS
formula. As checked in September 2026, it builds for PostgreSQL 17 and 18; simply
installing it alongside PostgreSQL 16 does not supply the extension for that server.
See the [PostGIS formula](https://formulae.brew.sh/formula/postgis).

```bash
brew install postgresql@18 postgis valkey
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"
brew services start postgresql@18
brew services start valkey
```

Use one PostgreSQL service on port 5432. For a fresh native setup, create the role
and database with your Homebrew PostgreSQL administrator account, then enable PostGIS:

```bash
psql postgres -c "CREATE ROLE maps LOGIN PASSWORD 'mapspassword';"
createdb -O maps apple_maps
psql apple_maps -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
PGPASSWORD=mapspassword psql -h localhost -U maps -d apple_maps -c 'SELECT PostGIS_Version();'
valkey-cli ping
```

Reuse an existing matching role/database instead of repeating their creation.
This native option uses a newer PostgreSQL/PostGIS combination than Compose.
From the repository root, install backend dependencies and initialize the empty schema:

```bash
cd apple-maps/backend
npm install
DATABASE_URL=postgresql://maps:mapspassword@localhost:5432/apple_maps npm run db:migrate
```

The migration reads **`DATABASE_URL`**, whereas the API and seed read **`DB_*`**.
The migration's own fallback uses `postgres:postgres`, which does not match Compose.
No entry point loads a `.env` file; export configuration in the shell when needed.

### Seed and start — either option

From the repository root:

```bash
cd apple-maps/backend
npm install
npm run db:seed
npm run dev
```

The seed deletes all navigation sessions, incidents, traffic, POIs, road segments,
and nodes, then creates 400 nodes, 760 two-way segments, 35 POIs, and 760 initial
traffic rows. POI positions and traffic speeds are randomized. All roads are local
or arterial, with no tolls or one-way restrictions, so the avoidance switches do
not demonstrate different paths with this fixture.

**Stop all API processes before reseeding.** The seed is destructive and not
transactional; an error can leave partial data, and its catch handler only logs.
Each running API also writes simulated traffic, which can conflict with replacement
of the road graph. The seed does not clear existing Redis search/place caches.

In another terminal, from the repository root:

```bash
cd apple-maps/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The browser loads its Leaflet CSS from
UNPKG and map tiles from OpenStreetMap, so the basemap still needs internet access.
The source uses OSM tile subdomains; the [current tile policy](https://operations.osmfoundation.org/policies/tiles/)
specifies the canonical tile host, visible attribution, and no bulk/offline prefetch.
There is no local tile fallback or offline-cache feature.

## Try the demo

1. Click near the displayed San Francisco grid to set an origin and destination.
2. Press Get Directions to calculate a route and inspect its turn instructions.
3. Search for a complete POI-name term such as `coffee`; the UI searches names,
   even though its placeholder also mentions addresses.
4. Toggle traffic to load synthetic congestion. Pan or toggle again to refresh;
   there is no periodic browser polling while the viewport stays still.
5. Dragging markers, swapping endpoints, or changing options does not invalidate
   an existing route. Clear the route and select new endpoints before recalculating.

Map/store synchronization lacks an equality guard and can repeatedly feed
`moveend` back into `setView`, causing excessive updates. Route and search requests
also lack response-identity guards. These are source findings, not browser-tested
fixes; the API can be explored independently if the UI misbehaves.

From a terminal with the development API running:

```bash
curl -fsS http://localhost:3001/health/ready
curl -fsS 'http://localhost:3001/api/search?q=coffee&lat=37.7749&lng=-122.4194&radius=10000'
curl -fsS -X POST http://localhost:3001/api/routes \
  -H 'Content-Type: application/json' \
  -d '{"origin":{"lat":37.7749,"lng":-122.4194},"destination":{"lat":37.7849,"lng":-122.4094},"options":{"avoidTolls":false,"avoidHighways":false}}'
```

## API and configuration

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/routes` | Calculate one route |
| POST | `/api/routes/alternatives` | Return primary route in a routes array; alternatives are stubbed |
| GET | `/api/search` | POI-name search with location/category/radius/limit |
| GET | `/api/search/geocode`, `/api/search/reverse` | POI/street substring lookup / nearest POI or road |
| GET | `/api/search/places/:id`, `/api/search/categories` | Place details / category counts |
| GET | `/api/traffic` | Latest stored speeds intersecting a bounding box |
| POST | `/api/traffic/probe` | Attempt process-local probe smoothing |
| GET / POST | `/api/traffic/incidents` | List / attempt incident reporting |
| DELETE | `/api/traffic/incidents/:id` | Resolve an incident; no authentication |
| GET | `/api/map/nodes`, `/api/map/segments`, `/api/map/pois` | Bounded map-data queries |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics`, `/ping` | Diagnostics |

Bounding-box queries use `minLat`, `minLng`, `maxLat`, and `maxLng`.
There is no `/api/routes/calculate`, `/api/traffic/flow`, route-session lookup,
or navigation-position endpoint.

| Variable | Used by | Default |
|----------|---------|---------|
| `DB_HOST`, `DB_PORT` | API and seed | `localhost`, `5432` |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | API and seed | `maps`, `mapspassword`, `apple_maps` |
| `DATABASE_URL` | Migration only | `postgresql://postgres:postgres@localhost:5432/apple_maps` |
| `REDIS_HOST`, `REDIS_PORT` | API | `localhost`, `6379` |
| `PORT` | API | `3000`; dev scripts set 3001–3003 |
| `NODE_ENV`, `LOG_LEVEL`, `SERVICE_NAME` | Logging | `development`, `info`, `apple-maps-backend` |

`npm run dev:server1`, `dev:server2`, and `dev:server3` run separate APIs on ports
3001–3003. Each starts its own simulator and owns its own graph/rate-limit memory.
They share PostgreSQL/Redis, but there is no load balancer or leader election.
Multiple instances multiply traffic writes and overwrite the shared current-speed cache.

## Checks and current limitations

Both packages provide `build`, `lint`, and `format`; the backend also has
`type-check`. Backend `npm start` runs TypeScript through `tsx`, not the compiled
output. Use `PORT=3001 npm start` to match the frontend proxy.

From `apple-maps`, install test dependencies and use `npm run test:e2e` for the
single Playwright smoke test. It only checks that the Leaflet container appears.
It does not validate directions, geolocation, traffic freshness, or incident writes.

- **Routing:** No turn-restriction enforcement or incident closure avoidance.
  Snapping has no maximum distance; drawn connectors are excluded from time/distance
  totals. The 100 km/h A* heuristic assumes a valid upper speed bound that inputs
  do not enforce. Route results are not cached.
- **Traffic:** Every simulator tick inserts one row per segment, sequentially.
  With the fixture this is about 6.57 million rows/day per API process, with no
  retention job. API-submitted probes only update local memory, not PostgreSQL or
  Redis directly, and the next simulation pass overwrites their effect.
- **Incidents:** Reporting queries absent confidence/idempotency columns. Supplying
  the same standard idempotency header to middleware and service also causes a
  duplicate claim before a real insert. The proposed merge/incident workflow is incomplete.
- **Navigation:** Start displays state but no caller advances it. There is no
  connected GPS probe sender, live ETA, or persisted navigation session.
- **Resilience:** Redis failures can fail routes/search. Rate limits are per-process
  memory, and the global 100/minute limit also affects probes, health, and metrics.
  `/health` checks database row counts and stored traffic freshness, not a loaded
  in-memory graph or a verified navigable route.

The [architecture](./architecture.md#implementation-notes) explains these gaps.
This documentation pass checked source; it did not run the application stack or
repair the implementation.
