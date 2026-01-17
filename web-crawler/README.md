# Web Crawler

A distributed web crawling system for indexing the internet with a focus on politeness, scalability, and efficient URL management.

## Features

- **URL Frontier with Priority Queue**: Manages URLs to crawl with three priority levels (high, medium, low)
- **Distributed Workers**: Multiple crawler workers that can run in parallel
- **Politeness**: Respects robots.txt directives and implements per-domain rate limiting
- **Deduplication**: Uses Redis sets for efficient URL deduplication
- **Content Extraction**: Parses HTML to extract links, titles, and metadata
- **Real-time Dashboard**: Monitor crawl progress, view statistics, and manage the crawler
- **Admin Interface**: Add seed URLs, recover stale jobs, and manage system settings

## Architecture

```
                    +------------------+
                    |   Frontend       |
                    |   (Dashboard)    |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   API Server     |
                    |   (Express.js)   |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
+--------v-------+  +--------v-------+  +--------v-------+
| Worker 1       |  | Worker 2       |  | Worker N       |
| - Fetch pages  |  | - Fetch pages  |  | - Fetch pages  |
| - Parse HTML   |  | - Parse HTML   |  | - Parse HTML   |
| - Extract links|  | - Extract links|  | - Extract links|
+----------------+  +----------------+  +----------------+
         |                   |                   |
         +-------------------+-------------------+
                             |
              +-----------------------------+
              |           Data Layer        |
              |  +----------+ +----------+  |
              |  |PostgreSQL| |  Redis   |  |
              |  | Frontier | | Dedup/   |  |
              |  | Metadata | | Cache    |  |
              |  +----------+ +----------+  |
              +-----------------------------+
```

## Tech Stack

- **Frontend**: TypeScript, React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express.js, TypeScript
- **Database**: PostgreSQL (URL frontier, crawled pages metadata)
- **Cache/Dedup**: Redis (visited URLs set, rate limiting, robots.txt cache)
- **Parsing**: Cheerio (HTML parsing)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Quick Start with Docker

The easiest way to run the entire system:

```bash
# Clone and navigate to project
cd web-crawler

# Start all services (PostgreSQL, Redis, API, 3 workers, frontend)
docker-compose up -d

# View logs
docker-compose logs -f

# Access the dashboard
open http://localhost:5173
```

### Local Development Setup

For development, you can run the infrastructure in Docker and the application natively:

#### 1. Start Infrastructure

```bash
# Start PostgreSQL and Redis only
docker-compose -f docker-compose.dev.yml up -d
```

#### 2. Setup Backend

```bash
cd backend

# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Seed initial URLs (optional)
npm run db:seed

# Start API server (port 3001)
npm run dev
```

#### 3. Start Crawler Workers

Open additional terminals to run workers:

```bash
cd backend

# Terminal 2: Start worker 1
npm run dev:worker1

# Terminal 3: Start worker 2
npm run dev:worker2

# Terminal 4: Start worker 3
npm run dev:worker3
```

#### 4. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server (port 5173)
npm run dev
```

#### 5. Access Dashboard

Open http://localhost:5173 in your browser.

### Running Distributed Crawlers

To run multiple crawler instances on different ports/machines:

```bash
# Terminal 1: API server
PORT=3001 npm run dev

# Terminal 2-4: Workers with different IDs
WORKER_ID=1 npm run dev:worker
WORKER_ID=2 npm run dev:worker
WORKER_ID=3 npm run dev:worker
```

For true distributed deployment, configure workers to connect to the same PostgreSQL and Redis instances by setting environment variables:

```bash
export POSTGRES_HOST=your-db-host
export REDIS_HOST=your-redis-host
export WORKER_ID=unique-worker-id
npm run start:worker
```

## API Documentation

### Health Check

```
GET /health
```

Returns the health status of the API and connected services.

### Statistics

```
GET /api/stats
```

Returns comprehensive crawl statistics including:
- Pages crawled/failed
- Bytes downloaded
- Links discovered
- Frontier status
- Active workers
- Recent pages
- Top domains

```
GET /api/stats/timeseries?hours=24
```

Returns time-series data for charts.

### URL Frontier

```
GET /api/frontier/stats
```

Returns frontier statistics (pending, in-progress, completed, failed counts).

```
GET /api/frontier/urls?limit=50&status=pending
```

Returns URLs from the frontier with optional status filter.

```
POST /api/frontier/add
Content-Type: application/json

{
  "urls": ["https://example.com", "https://another.com"],
  "priority": 2
}
```

Adds URLs to the frontier. Priority: 1 (low), 2 (medium), 3 (high).

```
POST /api/frontier/seed
Content-Type: application/json

{
  "urls": ["https://example.com"],
  "priority": 3
}
```

Adds seed URLs with high priority.

```
POST /api/frontier/recover?minutes=10
```

Recovers stale in-progress URLs (useful after worker crashes).

```
DELETE /api/frontier/clear
```

Clears the entire frontier (use with caution).

### Crawled Pages

```
GET /api/pages?limit=50&offset=0&domain=example.com&search=keyword
```

Returns crawled pages with optional filtering.

```
GET /api/pages/:urlHash
```

Returns details for a specific crawled page.

```
GET /api/pages/domain/:domain?limit=50
```

Returns pages for a specific domain.

### Domains

```
GET /api/domains?limit=50&offset=0&sortBy=page_count&order=desc
```

Returns all crawled domains.

```
GET /api/domains/:domain
```

Returns details for a specific domain.

```
GET /api/domains/:domain/robots
```

Returns the cached robots.txt for a domain.

```
POST /api/domains/:domain/refresh-robots
```

Forces a refresh of the robots.txt cache.

```
PUT /api/domains/:domain/settings
Content-Type: application/json

{
  "crawlDelay": 2.0,
  "isAllowed": true
}
```

Updates domain-specific settings.

## Configuration

### Environment Variables

#### Backend/API

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | API server port |
| `NODE_ENV` | `development` | Environment mode |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `webcrawler` | Database name |
| `POSTGRES_USER` | `postgres` | Database user |
| `POSTGRES_PASSWORD` | `postgres` | Database password |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |

#### Crawler Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | `1` | Unique worker identifier |
| `CRAWLER_USER_AGENT` | `WebCrawlerBot/1.0` | User agent string |
| `CRAWLER_DELAY` | `1000` | Default delay between requests (ms) |
| `MAX_CONCURRENT` | `10` | Max concurrent requests per worker |
| `REQUEST_TIMEOUT` | `30000` | Request timeout (ms) |
| `MAX_PAGE_SIZE` | `10485760` | Max page size to download (10MB) |
| `ROBOTS_CACHE_TTL` | `3600` | Robots.txt cache TTL (seconds) |

## Project Structure

```
web-crawler/
├── backend/
│   ├── src/
│   │   ├── config.ts           # Configuration
│   │   ├── server.ts           # API server entry point
│   │   ├── worker.ts           # Crawler worker entry point
│   │   ├── models/
│   │   │   ├── database.ts     # PostgreSQL setup
│   │   │   └── redis.ts        # Redis setup
│   │   ├── routes/
│   │   │   ├── frontier.ts     # Frontier API routes
│   │   │   ├── stats.ts        # Statistics API routes
│   │   │   ├── pages.ts        # Pages API routes
│   │   │   └── domains.ts      # Domains API routes
│   │   ├── services/
│   │   │   ├── frontier.ts     # URL Frontier service
│   │   │   ├── crawler.ts      # Crawler worker service
│   │   │   ├── robots.ts       # Robots.txt service
│   │   │   └── stats.ts        # Statistics service
│   │   ├── utils/
│   │   │   └── url.ts          # URL utilities
│   │   └── scripts/
│   │       ├── migrate.ts      # Database migration
│   │       └── seed.ts         # Seed URLs
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── Dockerfile.worker
├── frontend/
│   ├── src/
│   │   ├── main.tsx            # Entry point
│   │   ├── App.tsx             # Main app component
│   │   ├── router.tsx          # TanStack Router setup
│   │   ├── components/         # Reusable components
│   │   ├── routes/             # Page components
│   │   ├── stores/             # Zustand stores
│   │   ├── services/           # API client
│   │   └── types/              # TypeScript types
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── Dockerfile
│   └── nginx.conf
├── docker-compose.yml          # Full stack deployment
├── docker-compose.dev.yml      # Development (infra only)
├── architecture.md             # System design docs
├── claude.md                   # Development notes
└── README.md                   # This file
```

## Politeness Features

1. **robots.txt Compliance**: Fetches and caches robots.txt for each domain, respects Disallow directives
2. **Crawl-Delay**: Honors the Crawl-delay directive from robots.txt
3. **Per-Domain Rate Limiting**: Uses Redis locks to ensure only one request per domain at a time
4. **User-Agent**: Sends a proper User-Agent string identifying the crawler
5. **Request Timeout**: Limits time spent on slow servers

## Testing

```bash
# Backend
cd backend
npm run lint
npm run type-check

# Frontend
cd frontend
npm run lint
npm run type-check
```

## Future Enhancements

- [ ] Content storage (S3/local filesystem)
- [ ] Near-duplicate detection (SimHash)
- [ ] Distributed work stealing for load balancing
- [ ] Prometheus metrics integration
- [ ] Sitemap.xml parsing
- [ ] JavaScript rendering (Puppeteer integration)
- [ ] API authentication and rate limiting

## License

MIT

## See Also

- [architecture.md](./architecture.md) - System design documentation
- [system-design-answer.md](./system-design-answer.md) - Detailed system design interview answer
- [claude.md](./claude.md) - Development notes and iteration history
