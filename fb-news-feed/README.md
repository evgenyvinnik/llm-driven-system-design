# Facebook News Feed

A local learning project for a ranked social feed. It combines precomputed feed entries for ordinary authors with posts pulled at read time from high-follower accounts. The browser demonstrates a virtualized home feed, text/image-URL posting, optimistic likes, comments, profiles, and follow/unfollow.

The [architecture](./architecture.md) separates the production proposal from the implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [full-stack](./system-design-answer-fullstack.md) interview answers explain the design as a 45-minute discussion.

## What works, and what is a placeholder

| Surface | Current behavior |
|---------|------------------|
| Accounts | Register/login with bcrypt and opaque bearer sessions; token retained in localStorage |
| Home feed | Merge pushed/pulled candidates, rank, cap each author to three posts per response, render with TanStack Virtual |
| Composer | Text or externally hosted image URL, Public/Friends selector; prepend after server response |
| Engagement | Like/unlike on home-feed records; load and add comments |
| Profiles | Read posts, follower/following lists, follow/unfollow, delete own posts |
| Search | Search usernames/display names from the header |
| API-only features | Public explore feed, profile update, comment deletion, admin deletion of others' posts/comments |
| Placeholders | Share, comment Like/Reply, and Edit Profile buttons have no action; no upload/video pipeline, admin dashboard, or notifications UI |

The backend accepts authenticated WebSockets and exports a broadcast helper, but **nothing calls that helper and the frontend opens no socket**. New posts/counts are not delivered live to other viewers. Profile cards reuse home-feed like actions, so liking a post not present in the home store sends no request, and profile counts are not reconciled by that store.

**The Friends selector does not provide reliable privacy enforcement.** Feed hydration omits a final permission check, a signed-in nonfollower can read a friends post by ID, and comments can be read without checking post privacy. Use this as a local teaching demo while studying those gaps.

## Stack

React 19, TypeScript, Vite, TanStack Router, TanStack Virtual, Zustand, and Tailwind CSS on the frontend. Node.js 20+, Express, `ws`, PostgreSQL 16, and Valkey 7 through ioredis on the backend. Pino, prom-client, and an Opossum feed breaker are wired. There is no Kafka worker, Cassandra, upload storage, or ML service in Compose.

## Run locally

Commands start in `fb-news-feed/` unless stated otherwise. Use Node.js 20 or newer. Avoid running another project on ports 5173, 3000, 5432, or 6379.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U postgres -d newsfeed
docker compose exec -T redis redis-cli ping
```

A fresh PostgreSQL volume runs [init.sql](./backend/src/db/init.sql) automatically. Once it is ready, load the fixture **once**:

```bash
docker compose exec -T postgres psql -U postgres -d newsfeed -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The schema and user/friendship seed inserts are not rerunnable migrations: tables/triggers already exist and fixed users conflict on another run. An existing volume is not reinitialized by Compose. Inspect it before deciding whether it needs repair or a disposable reset.

```bash
docker compose down
# Destructive reset: removes this project's database/cache volumes.
docker compose down -v
```

### Option B: Native installation (no Docker)

On a fresh Homebrew setup on macOS:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE postgres WITH LOGIN PASSWORD 'postgres';"
createdb -O postgres newsfeed
PGPASSWORD=postgres psql -h localhost -U postgres -d newsfeed -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=postgres psql -h localhost -U postgres -d newsfeed -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
pg_isready -h localhost -U postgres -d newsfeed
valkey-cli ping
```

If the role/database exists, inspect it and skip creation instead of rerunning the schema blindly. Set the connection environment below to match your installation. Do not start native and Docker services on the same ports.

### Backend

```bash
cd backend
npm install
npm run dev
```

The default port is 3000. The backend does not load a `.env` file; export nondefault settings in the shell before starting it.

### Frontend

In another terminal starting at the repository root:

```bash
cd fb-news-feed/frontend
npm install
npm run dev
```

Open [the app](http://localhost:5173). Vite proxies `/api` to port 3000. There is no `/ws` proxy and no frontend socket client.

### Demo accounts

All four fixture hashes were checked against password **`password123`**.

| Email | Username | Notes |
|-------|----------|-------|
| john@example.com | john_doe | Seeded materialized feed; follows Jane and Tech Guru |
| jane@example.com | jane_smith | Follows John and Tech Guru |
| tech@example.com | tech_guru | Explicit celebrity flag and synthetic one-million follower count |
| admin@example.com | admin | Admin role; no separate dashboard |

The seed creates four follow edges and eleven public posts. Follower/engagement counters are illustrative numbers, not counts derived from matching relationship/like/comment rows. Only John's feed is materialized explicitly; other users can see celebrity candidates or the popular fallback rather than a complete pushed history.

## Suggested walkthrough

1. Log in as John and inspect the merged feed, including Tech Guru's posts.
2. Create a text post or supply an image URL. Posting waits for inline fan-out before returning; the composer inserts the response at the top.
3. Like a home-feed post, expand comments, and add a comment. Other windows do not update live, and the visible comment count is not incremented by the local comment form.
4. Search for a user and open their profile. Try follow/unfollow and return to the home feed; the known cache invalidation gap can leave old membership until a cache miss/rebuild.
5. Compare the request/response with the proposed snapshot-pagination and mutation-reconciliation designs in the interview answers.

The home page's “You've seen all posts!” text is stronger than the implementation can establish: candidate limits, the per-author cap, and broken ranked pagination can end a response while eligible posts remain.

## Environment and multiple instances

| Setting | Default |
|---------|---------|
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` |
| `POSTGRES_DB` | `newsfeed` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres` / `postgres` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` |
| `PORT` | `3000` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `NODE_ENV` / `LOG_LEVEL` | Development with debug/pretty logging; production defaults to info/JSON |

These are separate host/port settings, not `DATABASE_URL` or `REDIS_URL`. The cache has no configured password/TLS option in this client setup.

`npm run dev:server1`, `dev:server2`, and `dev:server3` run on 3001, 3002, and 3003 from separate backend terminals. They share SQL and Redis; the Vite proxy still targets 3000, so retain a default instance or deliberately retarget the proxy for an experiment. No load balancer or durable fan-out worker is supplied.

## API map

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/logout` | Account/session lifecycle |
| GET | `/api/v1/auth/me` | Current profile and role |
| GET | `/api/v1/feed` | Authenticated home feed; posts/cursor/has_more |
| GET | `/api/v1/feed/explore` | Public, seven-day popular posts with offset paging |
| POST / GET / DELETE | `/api/v1/posts` / `/api/v1/posts/:postId` | Create / read / soft-delete |
| POST / DELETE | `/api/v1/posts/:postId/like` | Like/unlike; repeated operations return 409/404 rather than desired-state success |
| GET / POST | `/api/v1/posts/:postId/comments` | Read/add comments |
| DELETE | `/api/v1/posts/:postId/comments/:commentId` | Author/admin comment deletion |
| GET / PUT | `/api/v1/users/:username` / `/api/v1/users/me` | Profile read/update |
| GET | `/api/v1/users/:username/posts`, `/api/v1/users/:username/followers`, `/api/v1/users/:username/following` | Profile posts and relationships |
| POST / DELETE | `/api/v1/users/:username/follow` | Follow/unfollow |
| GET | `/api/v1/users?q=...` | User search; minimum two-character query |

A login/register response returns a UUID bearer token. SQL sessions last seven days and Redis initially caches the user ID for seven days. Cache misses check SQL, then refill Redis for a fixed hour, even if less SQL lifetime remains. Redis errors do not produce a functioning auth fallback. Logout has separate SQL/cache deletion steps and does not revoke an already-open socket.

## Known implementation boundaries

- **Fan-out:** runs inside the request, without an outbox or retry worker. Errors are logged and the result is ignored by post creation, so a saved post can fail to reach feeds. Redis pipeline command errors are not inspected.
- **Cache:** ordinary fan-out uses millisecond scores, while follow backfill and seed rows use seconds. Follow/unfollow does not invalidate Redis. The author gets a SQL feed entry but no own-cache update; the celebrity branch returns before adding that entry.
- **Paging/ranking:** the home cursor is a native Date string, then parsed as a number for Redis. Ranking and celebrity candidates change across pages; timestamp filtering cannot provide a stable ranked continuation. Zero-engagement posts score zero regardless of freshness/affinity.
- **Interactions:** likes/comments/counts update through separate writes, not transactions. A late optimistic rollback can overwrite newer intent. Profile state and the home store are separate, and comment drafts/caches live inside virtualized cards and disappear on unmount.
- **Lifecycle:** the feed array has no memory cap, deduplication, request cancellation, or account generation. Reset responses can erase newly created posts; logout does not clear feed data. There is no explicit scroll restoration or new-post banner.
- **Operations:** the feed circuit breaker falls back to another query against the same PostgreSQL dependency. `/health/ready` reports ready when SQL works even if Redis auth fails. No rate limiter, graceful shutdown, or socket heartbeat/backpressure policy is installed.

## Development and verification

```bash
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix frontend run type-check
npm --prefix backend run lint
npm --prefix frontend run lint
curl -f http://localhost:3000/health
curl -f http://localhost:3000/health/ready
curl -f http://localhost:3000/metrics
```

There is no backend test/migration script. Project-level `npm run test:e2e` and repository-level `npm run test:smoke fb-news-feed` use Playwright after installing the relevant test dependencies/browsers and starting infrastructure/backend. The smoke login helper uses **alice@example.com**, which is absent from the supplied seed; screenshot configuration correctly uses John. The login/register checks only render forms, and the feed assertion checks a generic main element.

This documentation review inspected source/configuration, checked the fixture password, and ran eight isolated source checks with mocked dependencies. It did not run the stack, build, or benchmark. Application defects above were documented, not repaired.
