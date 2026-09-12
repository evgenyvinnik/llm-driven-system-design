# Apple Music — catalog and playback demo

A local system-design project for music discovery, personal libraries, playlists,
and selecting an audio file by subscription tier and network hint. The app uses
React and an Express API backed by PostgreSQL, Valkey, and MinIO.

**The supplied seed contains metadata, not playable audio.** It creates no
`audio_files` records and uploads no objects. You can browse, sign in, manage
library items, and inspect stream responses, but Play cannot produce music from
a fresh setup without separately supplying compatible audio assets.

See the [architecture](./architecture.md) for the proposed production design and
verified implementation boundaries. The [frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) answers are interview walkthroughs.

## What is implemented

| Area | Current behavior |
|------|------------------|
| Catalog | Album/artist/track details, genre APIs, PostgreSQL substring search |
| Library | Save/remove tracks, albums, artists, or playlist references; history APIs |
| Playlists | Create, read, update, delete, add/remove tracks, and attempt reordering |
| Streaming API | Select one whole-file quality; sign a URL when an audio row exists |
| Player | One HTML audio element, queue, play/pause, seek, volume, shuffle/repeat |
| Radio | Stored station lists and genre/artist/random track selection |
| Recommendations | SQL history/popularity/genre sections, cached for 30 minutes |
| Admin | Statistics and cache clearing in the UI; user/catalog mutations through APIs |
| Operational examples | Redis counters/response caching, Pino logs, Prometheus, health checks |

There is no transcoder, HLS/DASH adaptation, DRM, upload matching, offline download,
lyrics, social activity, collaborative playlist protocol, or gapless playback.
The sync API is not connected to a browser sync loop or offline operation queue.
Personal radio is a finite generated list, not a continuously replenished stream.

The frontend uses React 19, Vite 6, TanStack Router, Zustand 4, Tailwind 3, and
Lucide icons. There is no TanStack Query, virtualization library, Axios retry layer,
or player persistence. Elasticsearch is declared in Compose and dependencies but
has no application integration; it is not required for current search.

## Run locally

Use Node.js 20+ and npm. Choose Docker or native infrastructure, load the SQL seed,
then start the API and frontend. Development uses **API port 3001**, matching Vite.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd apple-music
docker compose up -d postgres redis minio minio-init
docker compose ps
```

This starts PostgreSQL 16, Valkey 7, and MinIO. The one-shot `minio-init` creates
`audio-files` and `album-artwork` and makes both anonymously downloadable.
It does not populate either bucket. Elasticsearch can be started with the full
`docker compose up -d`, but consumes resources without serving this application.

On a **fresh PostgreSQL volume**, Compose executes `backend/src/db/init.sql`.
Existing volumes are not migrated. Wait for PostgreSQL/MinIO health and inspect
the bucket-initialization log before proceeding:

```bash
docker compose exec -T postgres psql -U apple_music -d apple_music -c 'SELECT COUNT(*) FROM users;'
docker compose exec -T redis redis-cli ping
docker compose logs minio-init
curl -fsS http://localhost:9000/minio/health/live
```

The schema and seed are not rerunnable. Load the seed once into an empty schema,
using error stopping and a transaction so a failed seed does not partly apply:

```bash
docker compose exec -T postgres psql -U apple_music -d apple_music \
  -v ON_ERROR_STOP=1 --single-transaction < backend/db-seed/seed.sql
```

`docker compose down` stops infrastructure and retains volumes.
`docker compose down -v` removes this project's data volumes; use it only when
intentionally discarding the local database and objects.

### Option B: Native installation (no Docker)

On macOS:

```bash
brew install postgresql@16 valkey minio minio-mc
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
brew services start postgresql@16
brew services start valkey
```

As checked in September 2026, Homebrew still provides the deprecated
[MinIO formula](https://formulae.brew.sh/formula/minio) and
[MinIO client formula](https://formulae.brew.sh/formula/minio-mc).
The client executable is `mc`. This is a local development setup, not an upstream
maintenance or production-support guarantee.

Create the matching database role using your Homebrew PostgreSQL administrator
account. Reuse an existing matching role/database instead of recreating it.
Run these commands from `apple-music`:

```bash
psql postgres -c "CREATE ROLE apple_music LOGIN PASSWORD 'apple_music_pass';"
createdb -O apple_music apple_music
PGPASSWORD=apple_music_pass psql -h localhost -U apple_music -d apple_music \
  -v ON_ERROR_STOP=1 --single-transaction -f backend/src/db/init.sql
PGPASSWORD=apple_music_pass psql -h localhost -U apple_music -d apple_music \
  -v ON_ERROR_STOP=1 --single-transaction -f backend/db-seed/seed.sql
valkey-cli ping
```

Start MinIO in a separate terminal and leave it running:

```bash
mkdir -p "$HOME/.local/share/apple-music/minio"
MINIO_ROOT_USER=minio_admin MINIO_ROOT_PASSWORD=minio_secret \
  minio server "$HOME/.local/share/apple-music/minio" --console-address ':9001'
```

In another terminal, create the development buckets:

```bash
mc alias set music-local http://localhost:9000 minio_admin minio_secret
mc mb --ignore-existing music-local/audio-files
mc mb --ignore-existing music-local/album-artwork
mc anonymous set download music-local/audio-files
mc anonymous set download music-local/album-artwork
mc ls music-local
curl -fsS http://localhost:9000/minio/health/live
```

The anonymous policies match Compose. They allow object reads without a stream
authorization request; the local bucket configuration does not enforce subscription
access to audio bytes.

### Start the application — either option

From the repository root:

```bash
cd apple-music/backend
npm install
npm run dev
```

In another terminal, from the repository root:

```bash
cd apple-music/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). MinIO's console is at
[localhost:9001](http://localhost:9001), using `minio_admin` / `minio_secret`.

**Do not use `npm run seed`:** the backend script refers to the missing
`src/db/seed.ts`. Use the SQL procedure above. There is no `db:migrate` script.
The app does not load `.env` files; export any nondefault variables in its shell.

## Demo data and things to try

The SQL seed creates 3 users, 5 artists, 8 albums, 26 tracks, 4 genre radio stations,
4 playlists, and sample library/history/preferences. Album totals are recalculated
from the subset of tracks actually inserted. Names are sample catalog metadata;
there are no supplied recordings or artwork files.

| Account | Password | Role / fixture |
|---------|----------|----------------|
| `admin@applemusic.local` | `password123` | Admin statistics and APIs |
| `demo@applemusic.local` | `password123` | Two playlists and saved items |
| `alice@example.com` | `password123` | Two playlists, saved items, and listening history |

The login page and two SQL comments still show `admin123` / `demo123`; those values
are incorrect. The shared seed hash was checked against the installed bcrypt module.

1. Browse artists/albums, or search for `Tycho` in Browse.
2. Sign in as Alice to see history-driven Listen Now sections.
3. Save an album, follow an artist, or use a track's menu to add it to the library.
4. Create a playlist from the sidebar. The UI supports creation/removal, but has
   no track-add picker or working metadata editor; those operations need the API.
5. Sign in as admin and open the dashboard to inspect counts and play history.

The settings quality selector and Upgrade button have no save handler. Genre
links change the URL but Browse does not apply that parameter. Album-card hover
Play needs embedded tracks that normal album-list responses do not contain;
open the album detail to select a track.

To exercise real audio delivery, provide a browser-compatible file, upload it to
`audio-files`, and insert an `audio_files` row for its track ID and selected quality,
with the actual object key and format metadata. No upload/encoding endpoint or
asset-creation script performs those steps. Without a matching row, the stream API
returns an invented localhost URL rather than a useful missing-media error.

## API and configuration

| Method | Path | Purpose |
|--------|------|---------|
| POST / GET / PATCH | `/api/auth/*` | Register/login/logout, current user, preferences |
| GET | `/api/catalog/search`, `/tracks`, `/albums`, `/artists`, `/genres` | Search/lists under `/api/catalog` |
| GET | `/api/catalog/{tracks,albums,artists}/:id` | Individual catalog entries |
| GET / POST / DELETE | `/api/library`, `/api/library/:itemType/:itemId` | Read/add/remove saved items |
| GET | `/api/library/sync?lastSyncToken=...` | Incomplete delta feed |
| GET / POST | `/api/library/history` | Read/record listening events |
| GET / POST / PATCH / DELETE | `/api/playlists/*` | Playlist metadata and track mutations |
| GET | `/api/stream/:trackId` | Whole-file URL with `quality` and `network` query hints |
| POST | `/api/stream/prefetch`, `/progress`, `/end` | Stream helpers under `/api/stream` |
| GET | `/api/stream/:trackId/qualities`, `/api/stream/playback/current` | Declared qualities / reported playback state |
| GET / POST | `/api/radio/*` | Station lists/details/tracks and personal generation |
| GET | `/api/recommendations/for-you`, `/browse`, `/similar/:trackId` | Recommendation routes under `/api/recommendations` |
| GET / POST / PATCH | `/api/admin/*` | Statistics, users, catalog creation, cache clearing |
| GET | `/health`, `/health/ready`, `/healthz`, `/ready`, `/metrics` | Diagnostics outside the API limiter |

| Variable | Default |
|----------|---------|
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` |
| `POSTGRES_DB`, `POSTGRES_USER` | `apple_music`, `apple_music` |
| `POSTGRES_PASSWORD` | `apple_music_pass` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` |
| `MINIO_ENDPOINT` | `http://localhost:9000` |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `minio_admin`, `minio_secret` |
| `PORT` | `3000`; development scripts explicitly use 3001–3003 |
| `NODE_ENV`, `LOG_LEVEL`, `APP_VERSION` | `development`, `info`, `1.0.0` |

`npm run dev:server1`, `dev:server2`, and `dev:server3` run APIs on 3001–3003.
There is no supplied load balancer. `PORT=3001 npm start` uses `tsx` to run source;
it does not start the compiled build. CORS allows localhost frontends on 5173/5174.

## Checks and limitations

Run `npm run build` in each package; the backend also has `npm run type-check`.
Both packages expose lint/format scripts. From `apple-music`, `npm install` then
`npm run test:e2e` runs five page/login smoke tests and can start Vite. PostgreSQL,
Valkey, the seed, and the API must already be available. These tests do not verify
audio playback, concurrent mutations, or synchronization.

- Library state and its change log are separate writes. The sync query can advance
  its cursor past unseen changes; seeded items and playlist mutations are missing
  from the feed. There is no browser delta-sync consumer.
- Playlist idempotency caches completed responses without an in-flight lock or
  durable operation record. Concurrent appends can silently lose an entry; position
  swaps can violate the immediate unique constraint.
- History accepts caller-declared completion without deduplication. The browser's
  one-shot 30-second timer checks position rather than accumulated listening time.
- Session caches can retain old roles/tiers after admin changes. Redis outages
  fail required authentication rather than automatically falling back to PostgreSQL.
- Stream metrics measure URL preparation, not first audible audio. Active-stream
  gauges drift; the browser never calls the progress/end helpers.
- Clear Cache without a pattern flushes the entire Redis database, including
  session caches, rate counters, and replay records. It is not scoped to catalog data.

See [Implementation Notes](./architecture.md#implementation-notes) for evidence.
This pass reviewed source and checked the seed password; it did not run the stack
or repair application code.
