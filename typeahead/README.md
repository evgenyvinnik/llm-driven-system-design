# Design Typeahead - Autocomplete System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,981 |
| Source Files | 37 |
| .js | 1,957 |
| .md | 1,176 |
| .tsx | 1,123 |
| .ts | 488 |
| .json | 96 |

## Overview

A typeahead/autocomplete system demonstrating prefix matching, ranking suggestions, and real-time updates. This educational project focuses on building a low-latency suggestion service used by search engines and applications.

## Key Features

### 1. Prefix Matching
- Trie-based data structure with O(prefix length) lookups
- Pre-computed top-k suggestions at each node
- Character-by-character suggestions

### 2. Ranking System
- Multi-factor scoring: popularity, recency, personalization, trending
- Configurable weight factors
- Real-time trending detection

### 3. Real-Time Updates
- Query log aggregation with buffered writes
- Sliding window counters for trending
- Automatic trie updates

### 4. Caching Layer
- Redis caching with short TTL for freshness
- Automatic cache invalidation on updates

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
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000
   - Health check: http://localhost:3000/health

### Option 2: Native Services

If you prefer to run PostgreSQL and Redis natively:

1. **Install PostgreSQL:**
   ```bash
   # macOS
   brew install postgresql@16
   brew services start postgresql@16

   # Create database
   createdb typeahead
   psql typeahead -f backend/init.sql
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
   export PG_USER=your_user
   export PG_PASSWORD=your_password
   export PG_DATABASE=typeahead
   export REDIS_HOST=localhost
   export REDIS_PORT=6379
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
| `/api/v1/admin/phrases` | POST | Add a phrase |
| `/api/v1/admin/filter` | POST | Filter a phrase |
| `/api/v1/admin/cache/clear` | POST | Clear suggestion cache |

## Example Usage

### Get Suggestions

```bash
curl "http://localhost:3000/api/v1/suggestions?q=java&limit=5"
```

Response:
```json
{
  "prefix": "java",
  "suggestions": [
    { "phrase": "javascript", "count": 50000, "score": 0.85 },
    { "phrase": "javascript tutorial", "count": 35000, "score": 0.78 },
    { "phrase": "java", "count": 45000, "score": 0.75 }
  ],
  "meta": {
    "count": 3,
    "responseTimeMs": 12,
    "cached": false
  }
}
```

### Log a Search

```bash
curl -X POST "http://localhost:3000/api/v1/suggestions/log" \
  -H "Content-Type: application/json" \
  -d '{"query": "javascript tutorial"}'
```

## Implementation Details

### Trie Data Structure

The trie stores pre-computed top-k suggestions at each node, enabling O(prefix length) lookups:

```
root
├── j
│   ├── a
│   │   ├── v
│   │   │   ├── a       [java, java spring, ...]
│   │   │   └── s       [javascript, javascript tutorial, ...]
```

### Ranking Algorithm

Final score = weighted sum of:
- Popularity (30%): log10(count)
- Recency (15%): exponential decay over 1 week
- Personalization (25%): user history match
- Trending (20%): real-time trending boost
- Match quality (10%): prefix match quality

### Aggregation Pipeline

1. Query received -> Buffer incremented
2. Every 30 seconds -> Flush to database + update trie
3. Sliding window counters -> Real-time trending
4. Periodic decay -> Trending score decay

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
