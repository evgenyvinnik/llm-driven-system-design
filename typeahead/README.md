# Design Typeahead - Autocomplete System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 10,775 |
| Source Files | 82 |
| .ts | 5,902 |
| .tsx | 2,350 |
| .md | 1,926 |
| .sql | 204 |
| .json | 164 |

## Overview

A typeahead/autocomplete system demonstrating prefix matching, ranking suggestions, and real-time updates. This educational project focuses on building a low-latency suggestion service used by search engines and applications.

## Key Features

### 1. Prefix Matching
- Trie-based data structure with O(prefix length) lookups
- Pre-computed top-10 suggestions at each node, root included (the root's list is `/popular`)
- Character-by-character suggestions; a trailing space is kept, so `java ` suggests `java vs javascript` rather than `javascript`
- Optional fuzzy matching (`fuzzy=true`): prefix edit distance with a budget of 1 edit for 3-5 characters and 2 beyond

### 2. Ranking System
- Multi-factor scoring: popularity, recency, personalization, trending, match quality
- Fixed, hand-set weights (constants in `backend/src/services/ranking-service.ts`)
- Trending from 5-minute windows over the last hour, recomputed every 30 seconds

### 3. Real-Time Updates
- Query log aggregation with buffered writes
- Sliding window counters for trending
- Trie counts updated from each 30-second flush

### 4. Caching Layer
- Redis caching with short TTL for freshness
- Admin changes (add, remove, filter, unfilter a phrase) invalidate every cached prefix of that phrase plus the popular list; count changes from the 30-second aggregation flush wait out the 60-second TTL

## Architecture

```
                    ┌─────────────────┐
                    │   Frontend      │
                    │  (React + TS)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  API Gateway    │
                    │   (Express)     │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│  Suggestion     │ │   Ranking       │ │  Aggregation    │
│    Service      │ │   Service       │ │    Service      │
│  (Trie-based)   │ │ (Multi-factor)  │ │ (Query logs)    │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐  ┌──▼───┐  ┌───────▼───────┐
     │   PostgreSQL    │  │Redis │  │  In-Memory    │
     │   (Analytics)   │  │(Cache)│ │    Trie       │
     └─────────────────┘  └──────┘  └───────────────┘
```

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Databases:**
  - PostgreSQL (query logs, phrase counts, analytics)
  - Redis (caching, trending, user history)
- **Data Structure:** Custom Trie with pre-computed top-k suggestions

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

1. **Start infrastructure:**
   ```bash
   docker-compose up -d
   ```

2. **Install backend dependencies:**
   ```bash
   cd backend
   npm install
   ```

3. **Seed the database with sample data:**
   ```bash
   npm run seed
   ```

4. **Start the backend:**
   ```bash
   npm run dev
   ```

5. **Install frontend dependencies (in a new terminal):**
   ```bash
   cd frontend
   npm install
   ```

6. **Start the frontend:**
   ```bash
   npm run dev
   ```

7. **Open the app:**
   - Frontend: http://localhost:5173 (search page), http://localhost:5173/widgets (four `useTypeahead` widget variants), http://localhost:5173/admin
   - Backend API: http://localhost:3000
   - Health check: http://localhost:3000/health (liveness), http://localhost:3000/health/ready (503 until the trie has loaded)

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **Install PostgreSQL:**
   ```bash
   # macOS
   brew install postgresql@16
   brew services start postgresql@16

   # Create the role and database the backend uses by default
   createuser typeahead
   psql postgres -c "ALTER USER typeahead PASSWORD 'typeahead_password'"
   createdb -O typeahead typeahead
   psql -U typeahead -d typeahead -f backend/src/db/init.sql
   ```

2. **Install Redis:**
   ```bash
   # macOS
   brew install redis
   brew services start redis
   ```

3. **Set environment variables:**
   ```bash
   export PG_HOST=localhost
   export PG_PORT=5432
   export PG_USER=typeahead               # default
   export PG_PASSWORD=typeahead_password  # default
   export PG_DATABASE=typeahead
   export REDIS_HOST=localhost
   export REDIS_PORT=6379
   # Optional
   export CORS_ORIGINS=http://localhost:5173   # comma-separated origins allowed to call the API directly
   export TRUST_PROXY=                          # unset: X-Forwarded-For is ignored (rate-limit keys use the socket IP)
   export TRIE_SYNC_INTERVAL_MS=5000            # how often each instance re-reads changed phrase_counts rows
   ```

4. Follow steps 2-7 from Option 1.

### Running Multiple Backend Instances

For testing distributed behavior:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

Each instance holds its own trie and its own aggregation buffer, and the instances stay in step through Postgres: every write to `phrase_counts` (a flush, an admin add, delete, filter or restore) sets `changed_at`, and each instance re-reads the changed rows every `TRIE_SYNC_INTERVAL_MS` (default 5000) and applies their counts and filter state to its trie. A Redis pub/sub message after each write makes the others sync at once, so admin changes show up on every instance within milliseconds; with Redis down they catch up on the next poll. An instance started later loads the current state at startup. Rows deleted outright (re-running `seed.sql`, which TRUNCATEs `phrase_counts`) leave nothing to poll, so every minute each instance also compares its phrase count with the live rows and reloads its trie when it holds phrases the database no longer has. There is still no load balancer in front of them, and a count change can take up to the 60 s Redis cache TTL to show in a list that was already cached.

## API Endpoints

### Suggestions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/suggestions?q=<prefix>` | GET | Get autocomplete suggestions |
| `/api/v1/suggestions/log` | POST | Log a completed search |
| `/api/v1/suggestions/trending` | GET | Get trending queries |
| `/api/v1/suggestions/popular` | GET | Get most popular queries |
| `/api/v1/suggestions/history?userId=<id>` | GET | Get user's search history |

### Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/analytics/summary` | GET | Get analytics summary |
| `/api/v1/analytics/queries` | GET | Get recent queries |
| `/api/v1/analytics/top-phrases` | GET | Get top phrases |
| `/api/v1/analytics/hourly` | GET | Get hourly query volume |

### Admin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/admin/status` | GET | Get system status |
| `/api/v1/admin/trie/stats` | GET | Get trie statistics |
| `/api/v1/admin/trie/rebuild` | POST | Rebuild trie from database |
| `/api/v1/admin/phrases` | POST | Add a phrase, or raise an existing one's count (never lowers it; 409 if the phrase is filtered) |
| `/api/v1/admin/phrases/:phrase` | DELETE | Remove a phrase from suggestions (kept in `phrase_counts` with `is_filtered = true`) |
| `/api/v1/admin/filter` | POST | Filter a phrase (blocks searches for it and removes it from suggestions) |
| `/api/v1/admin/filter/:phrase` | DELETE | Remove a filter and restore the phrase to suggestions |
| `/api/v1/admin/filtered` | GET | List filtered phrases |
| `/api/v1/admin/cache/clear` | POST | Clear suggestion cache |

Behavior notes:

- A `q` longer than 200 characters returns an empty list, and a `/log` body `query` over 200 characters gets 400; `limit`/`offset` are clamped and fall back to defaults when invalid. At most 10 suggestions come back, since that is what each trie node stores.
- `POST /suggestions/log` always answers 200 with `accepted: true|false` (plus `reason` such as `low_quality` or `inappropriate`); only accepted queries are counted and added to the user's history. It is not deduplicated, so a retried log counts twice.
- Admin mutations are deduplicated only when the client sends an `X-Idempotency-Key` header (the admin UI sends a fresh one per action): a retry with the same key replays the first response, an in-flight duplicate gets 409. Without the header a request always runs.
- Suggestion responses include `meta.cached` (base list came from Redis) and `meta.degraded` (circuit-breaker fallback, sent with `Cache-Control: no-store`). Personalized requests (`userId` present) get `private, no-cache` plus a weak ETag; anonymous ones get `public, max-age=60, stale-while-revalidate=300`.
- Analytics endpoints are sent with `private, no-cache`; errors and `/log` responses are never cached.
- `/health/ready` returns 503 until the trie has been loaded from Postgres, and whenever Redis or Postgres is unreachable. With Redis down, suggestions are still served from the trie (personal and trending signals drop to 0).
- Rate limits are fixed windows per client IP: suggestions 20/s, `/log` 5/s, admin 30/min, 1000/min overall (`/health*` and `/metrics` are not counted).

## Example Usage

### Get Suggestions

```bash
curl "http://localhost:3000/api/v1/suggestions?q=java&limit=2"
```

Response (freshly seeded data, anonymous request; `lastUpdated` is epoch ms of `phrase_counts.last_updated`):
```json
{
  "prefix": "java",
  "suggestions": [
    {
      "phrase": "java",
      "count": 45000,
      "lastUpdated": 1791043470365,
      "score": 0.405,
      "scores": { "popularity": 0.517, "recency": 1.0, "personal": 0, "trending": 0, "match": 1.0 }
    },
    {
      "phrase": "javascript",
      "count": 50000,
      "lastUpdated": 1791043470365,
      "score": 0.395,
      "scores": { "popularity": 0.522, "recency": 1.0, "personal": 0, "trending": 0, "match": 0.88 }
    }
  ],
  "meta": {
    "count": 2,
    "responseTimeMs": 4,
    "cached": false,
    "degraded": false
  }
}
```

`java` outranks the more popular `javascript` because match quality rewards a prefix that covers more of the phrase.

### Log a Search

```bash
curl -X POST "http://localhost:3000/api/v1/suggestions/log" \
  -H "Content-Type: application/json" \
  -d '{"query": "javascript tutorial"}'
```

Response: `{"success":true,"accepted":true,"message":"Query logged successfully"}`. A rejected query (for example `asdfghjkl`) still gets 200, with `"accepted":false,"reason":"low_quality","message":"Query not counted"`.

## Implementation Details

### Trie Data Structure

The trie stores pre-computed top-k suggestions at each node, ordered by count, enabling O(prefix length) lookups:

```
root                         [google, youtube, facebook, ...]   (global top-10)
└── j
    └── a
        └── v
            └── a            [javascript, java, javascript tutorial, ...]
                ├── s        [javascript, javascript tutorial, ...]
                └── (space)  [java vs javascript, java spring boot]
```

Ranking then re-orders each list per request (see below).

### Ranking Algorithm

Final score = weighted sum of:
- Popularity (30%): log10(count + 1) / 9
- Recency (15%): exp(-hours since `phrase_counts.last_updated` / 168), a half-life of about 116 hours
- Personalization (25%): 0.7 × exp(-days since the user last searched it / 30) + 0.3 × min(times searched / 10, 1)
- Trending (20%): min(score in `trending_queries` / 1000, 1)
- Match quality (10%): 0.8-1.0 for a prefix match (higher when the prefix covers more of the phrase), 0.7 at a word boundary, 0.4 for a substring

Fuzzy matches lose 0.2 per edit. The weights are constants, not configuration.

### Aggregation Pipeline

1. Completed search logged (`POST /log`) -> quality and blocklist checks, buffer incremented, one `query_logs` row
2. Every 30 seconds -> Upsert buffered counts to `phrase_counts`, then update the trie with the stored totals (filtered or admin-removed phrases stay out)
3. Sliding window counters (5-minute windows) -> Real-time trending
4. Every 30 seconds -> `trending_queries` recomputed from the last 12 windows weighted 0.9^age (that weighting is the decay), excluding blocked phrases

## Development

### Backend Commands

```bash
npm run dev          # Start with hot reload
npm run seed         # Seed sample data
npm run dev:server1  # Run on port 3001
```

### Frontend Commands

```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run type-check   # TypeScript check
npm run lint         # ESLint
```

## Architecture Documentation

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## References & Inspiration

- [How We Built Prefixy](https://engineering.fb.com/2019/05/23/data-infrastructure/prefixy/) - Facebook's typeahead system serving billions of queries
- [Trie Data Structure](https://en.wikipedia.org/wiki/Trie) - Fundamental data structure for prefix matching
- [Autocomplete at Scale](https://www.youtube.com/watch?v=us0qySiUsGU) - Google Tech Talk on building autocomplete systems
- [Design Autocomplete System](https://www.educative.io/courses/grokking-the-system-design-interview/mE2XkgGRnmp) - System design walkthrough for typeahead
- [Elasticsearch Suggesters](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html) - Elasticsearch's built-in autocomplete functionality
- [Ternary Search Trees](https://www.cs.princeton.edu/~rs/strings/paper.pdf) - Memory-efficient alternative to tries for prefix matching
- [Prefix Hash Tree](https://people.eecs.berkeley.edu/~sylvia/papers/pht.pdf) - Distributed data structure for prefix queries at scale
- [LinkedIn Typeahead](https://engineering.linkedin.com/blog/2017/08/powering-typeahead-on-linkedin-with-new-indices) - How LinkedIn powers typeahead search with specialized indices
