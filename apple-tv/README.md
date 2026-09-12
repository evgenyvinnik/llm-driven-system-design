# Apple TV+ learning project

A streaming-service **catalog and player-interface simulation**, built with React and Express. Explore movie and series discovery, household profiles, watchlists, progress records, recommendations, and an admin dashboard. The player advances a clock; it does not play video or audio. Its image component and quality menu also lack the metadata expected from the playback response. This project is not affiliated with Apple.

The [architecture](./architecture.md) separates a proposed production streaming platform from the code here. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers explain that proposed design as 45-minute interviews. [CLAUDE.md](./CLAUDE.md) records development history; some historical completion claims exceed the current implementation.

## What you can explore

| Area | Implemented behavior | Boundary |
|------|----------------------|----------|
| Discovery | Featured titles, movies, shows, details and episode lists | Header search has no handler; API search uses PostgreSQL ILIKE |
| Accounts | Registration, cookie sessions, profile creation/selection/deletion | Kids filtering is partial; profile changes do not reliably clear old client data |
| My List | Add/remove from cards, details and watchlist page | Hero My List button is inert; card checks make one request per card |
| Player | Timer, seek, play/pause, volume/quality state and fullscreen | No media element, HLS engine, ABR, actual audio or subtitle selection |
| Progress | Profile/title SQL upserts, resume lookup, Continue Watching and history | Timer resets interfere with periodic saves; batch route is shadowed |
| Recommendations | Genres from completed history, popularity and release-date rules | No collaborative filtering or ML; ratings are stored but not used in ranking |
| Subscription | Demo monthly/yearly expiry updates and playback-route checks | No billing provider, actual renewals or persisted cancellation |
| Administration | Statistics, content/user tables and featured toggle | Create/update/delete metadata are API-only; no uploader or encoding worker |
| Streaming scaffolding | Generated playlist text and fixed subtitle sample | Video/audio segments are empty; MinIO contains no seeded media |

DRM, offline downloads, device/concurrent-stream enforcement, transcoding, CDN delivery, and native TV/mobile applications are unimplemented. Database tables and plan feature labels are not evidence that those features work.

## Stack and prerequisites

Node.js **20+**, npm, PostgreSQL 16, Valkey/Redis, and MinIO. The frontend uses React 19, Vite 6, TypeScript, TanStack Router, Zustand 5, Tailwind CSS and Lucide. The backend uses Express, pg, express-session/connect-redis, bcryptjs, Opossum, Pino and prom-client. There is no RabbitMQ, FFmpeg worker or HLS.js dependency.

Run the infrastructure using **one** option below. Both use the same local defaults. Keep the standard ports free of other repository projects.

## Option A: Docker Compose (recommended)

From the repository root:

```bash
cd apple-tv
docker compose up -d
docker compose ps
```

Compose starts PostgreSQL on 5432, Valkey on 6379, MinIO on 9000 and its console on 9001. PostgreSQL loads [init.sql](./backend/src/db/init.sql) only when its data volume is first created. The schema uses ordinary CREATE TABLE/INDEX statements and is not a repeatable migration.

```bash
docker compose exec postgres pg_isready -U appletv -d appletv
docker compose exec redis redis-cli ping
curl -f http://localhost:9000/minio/health/live
```

The MinIO initializer creates private `videos` and publicly downloadable `thumbnails` buckets. It does not upload objects. Check its output with `docker compose logs minio-init`; the shell exits successfully even if an earlier command fails.

```bash
docker compose down
# Only for a deliberate fresh start: deletes this project's database/cache/media volumes.
docker compose down -v
```

## Option B: Native installation (no Docker)

Install and start PostgreSQL and Valkey with Homebrew:

```bash
brew install postgresql@16 valkey minio minio-mc
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE appletv LOGIN PASSWORD 'appletv_secret';"
createdb -O appletv appletv
```

These user/database creation commands are for a fresh installation; reuse matching existing resources instead of rerunning CREATE. The [MinIO server](https://formulae.brew.sh/formula/minio) and [client](https://formulae.brew.sh/formula/minio-mc) Homebrew formulas are deprecated but currently available.

Start MinIO in a separate terminal:

```bash
mkdir -p "$HOME/.local/share/appletv-minio"
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin
minio server "$HOME/.local/share/appletv-minio" --console-address ':9001'
```

From `apple-tv/`, initialize the schema once and create buckets:

```bash
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
PGPASSWORD=appletv_secret psql -h localhost -U appletv -d appletv -v ON_ERROR_STOP=1 -1 -f backend/src/db/init.sql
mc alias set appletv-local http://localhost:9000 minioadmin minioadmin
mc mb --ignore-existing appletv-local/videos
mc mb --ignore-existing appletv-local/thumbnails
mc anonymous set download appletv-local/thumbnails
pg_isready -h localhost -U appletv -d appletv
valkey-cli ping
mc ls appletv-local
```

## Configuration

[Backend configuration](./backend/src/config/index.ts) reads process environment variables directly. There is no dotenv loader: export overrides in the terminal that starts the backend or seed. No overrides are needed for the local defaults.

| Variable | Default |
|----------|---------|
| DB_HOST / DB_PORT | localhost / 5432 |
| DB_USER / DB_PASSWORD / DB_NAME | appletv / appletv_secret / appletv |
| REDIS_URL | redis://localhost:6379 |
| MINIO_ENDPOINT / MINIO_PORT / MINIO_USE_SSL | localhost / 9000 / false |
| MINIO_ACCESS_KEY / MINIO_SECRET_KEY | minioadmin / minioadmin |
| SESSION_SECRET | appletv-session-secret-change-in-production |
| PORT | 3000; development scripts explicitly set 3001–3003 |
| NODE_ENV / LOG_LEVEL | Production mode enables secure cookies; log level defaults to info |

`DATABASE_URL` is not read. `MINIO_ENDPOINT` is a hostname, without scheme or port. Session cookie `appletv.sid` has a 24-hour maximum age, HttpOnly and SameSite=Lax. All API instances must share Redis and SESSION_SECRET. Production HTTPS/proxy configuration needs additional work; use normal development mode for the local HTTP walkthrough.

## Seed and start the application

From `apple-tv/`, after the schema exists:

```bash
cd backend
npm install
npm run seed
npm run dev
```

The [TypeScript seed](./backend/src/db/seed.ts) is recommended for the interactive walkthrough. On a fresh database it creates two accounts, three profiles, three series, twelve episodes and four movies, with variant/audio/subtitle metadata. It creates no media objects or segment rows and no initial progress/history/watchlist. Images use external Picsum URLs; seeded avatar paths have no matching image assets.

| Account | Password | Seeded access |
|---------|----------|---------------|
| user@appletv.local | user123 | Monthly, expires 30 days after initial seed; adult and Kids profiles |
| admin@appletv.local | admin123 | Yearly, expires 365 days after initial seed; admin profile |

Seed once: existing emails keep their passwords and expiry, while random IDs cause additional profiles and duplicate titles on subsequent runs. Inserts are not one transaction, so a failure can leave partial data.

In another terminal, from the repository root:

```bash
cd apple-tv/frontend
npm install
npm run dev
```

Open [the app](http://localhost:5173), sign in, and explicitly select a profile. Open a movie or select an episode from a series detail page to explore the timer player. The series-level Play button passes the zero-duration series itself; it does not choose an episode. Visit [Account](http://localhost:5173/account) to simulate a plan change, or [Admin](http://localhost:5173/admin) with the admin account.

The API development port is [3001](http://localhost:3001/health). Vite proxies `/api` to that port. `npm start` defaults to 3000, so use `PORT=3001 npm start` if you want it behind the existing Vite proxy. Health and metrics paths must be accessed on the API port.

### Alternative SQL screenshot fixture

[backend/db-seed/seed.sql](./backend/db-seed/seed.sql) is a different dataset. Use it **instead of** the TypeScript seed on a fresh schema when exploring the existing screenshot configuration. From `apple-tv/` with Docker:

```bash
docker compose exec -T postgres psql -U appletv -d appletv -v ON_ERROR_STOP=1 -1 < backend/db-seed/seed.sql
```

For native PostgreSQL:

```bash
PGPASSWORD=appletv_secret psql -h localhost -U appletv -d appletv -v ON_ERROR_STOP=1 -1 -f backend/db-seed/seed.sql
```

This creates Alice, Bob, Charlie and `admin@appletv.local`, all with **password123** (verified against the stored hash). Alice/Bob have expiring paid tiers; Charlie is free. Admin has no seeded profile, so create one after login. The login page's displayed credentials apply to the TypeScript seed, not this fixture.

The SQL fixture has fifteen catalog entries, but only two movies have variant/audio/subtitle rows. It supplies progress, history, watchlist, ratings, device and download records; device/download records have no working feature behind them. Fixed 2023–2024 release dates age out of the 90-day New Releases query. The fixture is not rerunnable: catalog inserts lack conflict handling, and other randomly generated IDs can duplicate rows. Mixing seeds retains whichever admin password/expiry was inserted first, while adding the other catalog and additional profiles. Keep the datasets separate for a predictable walkthrough.

## Known integration limits

- The player stores a manifest URL but never fetches it. Playback-info returns only id/title/duration/status, omitting artwork, variants, audio and subtitles; the player image has no source and its quality menu is empty. Quality and volume state have no media effect; the subtitle button has no handler. Generated playlists do not establish playable assets or DRM protection.
- The ten-second save interval is recreated whenever position changes, so continuous one-second playback can keep postponing it. Back/unmount saves are best effort; parent cleanup resets the player and can erase state before a child save. There is no unload/offline queue. Pause and wait to inspect a saved position; do not assume reliable cross-device handoff.
- The browser sends neither client timestamps nor Idempotency-Key. Server arrival time therefore orders ordinary browser updates; generic replay middleware is optional and has incomplete key binding/recovery.
- Selected profile is persisted locally, while the authoritative selection is in the cookie session. Restoration does not reconcile them, and switching/logout leaves other stores or in-flight requests intact. Kids filtering applies to some recommendations, not catalog or playback authorization.
- `/api/watch/progress/batch` is declared after `/progress/:contentId`, so ordinary batch requests enter the single-title handler. It does not provide usable offline batch synchronization.
- Most page/mutation failures are logged in the console. Subscription cancel returns a message without changing data; its client helper has no screen control.

See [Implementation Notes](./architecture.md#implementation-notes) for the source-backed boundaries and failure cases.

## Development and verification commands

From `apple-tv/backend/`: `npm run type-check`, `npm run lint`, `npm run dev:server1`, `npm run dev:server2`, or `npm run dev:server3`. There is no backend build, migration or unit-test script. Multiple instances share SQL/Redis; no load balancer is included, and process-local stream counts/breakers are independent.

From `apple-tv/frontend/`: `npm run build`, `npm run type-check`, `npm run lint`, `npm run preview`. Preview does not inherit the development `/api` proxy; provide an API reverse proxy for built assets.

From the repository root, `npm run test:smoke apple-tv` uses the SQL fixture's Alice account and a running stack. These are page-load checks, not playback tests. The profiles smoke test incorrectly expects a `main` element absent from that page; screenshot login also expects `main` immediately after login, which lands on Profiles. Automated capture/test failures here need inspection rather than assuming they prove a streaming defect.

Documentation verification covered source, configuration, links and the SQL password hash. No application stack or real media playback was run during this review.
