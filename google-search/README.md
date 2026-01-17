# Design Google Search - Web Search Engine

## Overview

A simplified Google Search-like platform demonstrating web crawling, indexing, ranking algorithms, and query processing at scale. This educational project focuses on building a distributed search engine with relevance-based ranking.

## Key Features

### 1. Web Crawling
- URL frontier management with priority queuing
- Politeness policies (rate limiting per host)
- robots.txt parsing and compliance
- Duplicate content detection
- Incremental recrawling support

### 2. Indexing Pipeline
- Document parsing and content extraction
- Tokenization with stopword removal and stemming
- Inverted index construction in Elasticsearch
- TF-IDF and BM25 scoring

### 3. Query Processing
- Query parsing (phrases, exclusions, site filters)
- Autocomplete suggestions
- Spell correction
- Result caching with Redis

### 4. Ranking System
- PageRank algorithm implementation
- Multi-signal ranking (text relevance + PageRank + freshness)
- Snippet generation with keyword highlighting

### 5. Admin Dashboard
- System statistics and monitoring
- Crawler control (seed URLs, start/stop)
- Index management
- PageRank calculation trigger

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + TanStack Router + Tailwind CSS
- **Backend**: Node.js + Express
- **Search**: Elasticsearch 8.x
- **Database**: PostgreSQL 16
- **Cache**: Redis 7

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure Services

```bash
cd google-search
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200

Wait for all services to be healthy:
```bash
docker-compose ps
```

### 2. Set Up Backend

```bash
cd backend
cp .env.example .env
npm install
```

### 3. Seed Sample Data

```bash
npm run seed
```

This populates the database with sample documents for testing.

### 4. Start Backend Server

```bash
npm run dev
```

Backend runs on http://localhost:3001

### 5. Set Up Frontend

```bash
cd ../frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

### 6. Open the Application

- **Search**: http://localhost:5173
- **Admin Dashboard**: http://localhost:5173/admin
- **API Health**: http://localhost:3001/health

## Running Multiple Backend Instances

For testing load balancing and distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## API Endpoints

### Search API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search?q={query}` | GET | Search for documents |
| `/api/search/autocomplete?q={prefix}` | GET | Get autocomplete suggestions |
| `/api/search/popular` | GET | Get popular searches |
| `/api/search/related?q={query}` | GET | Get related searches |

### Admin API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/stats` | GET | Get system statistics |
| `/api/admin/crawl/seed` | POST | Add seed URLs |
| `/api/admin/crawl/start` | POST | Start the crawler |
| `/api/admin/index/build` | POST | Build search index |
| `/api/admin/pagerank/calculate` | POST | Calculate PageRank |

## Project Structure

```
google-search/
├── docker-compose.yml      # Infrastructure services
├── backend/
│   ├── package.json
│   ├── src/
│   │   ├── index.js        # Express server entry
│   │   ├── config/         # Configuration
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   │   ├── crawler.js  # Web crawler
│   │   │   ├── indexer.js  # Index builder
│   │   │   ├── pagerank.js # PageRank calculator
│   │   │   └── search.js   # Query processor
│   │   ├── models/         # Database connections
│   │   └── utils/          # Helpers
│   └── scripts/
│       ├── init.sql        # Database schema
│       └── seed.js         # Sample data
├── frontend/
│   ├── package.json
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── routes/         # Page routes
│   │   ├── stores/         # Zustand stores
│   │   ├── services/       # API clients
│   │   └── hooks/          # Custom hooks
│   └── public/
├── architecture.md         # System design documentation
└── CLAUDE.md              # Development notes
```

## How It Works

### Crawling Process

1. Seed URLs are added to the frontier (priority queue)
2. Crawler fetches pages respecting robots.txt and politeness delays
3. HTML is parsed to extract title, content, and links
4. New URLs are added to the frontier
5. Documents are stored in PostgreSQL

### Indexing Process

1. Documents are tokenized (with stopword removal and stemming)
2. Content is indexed in Elasticsearch with custom analyzers
3. TF-IDF scores are computed automatically by Elasticsearch

### PageRank Calculation

1. Link graph is built from crawled links
2. Iterative PageRank algorithm runs until convergence
3. Scores are stored in PostgreSQL and Elasticsearch

### Search Query Flow

1. Query is parsed (phrases, exclusions, filters)
2. Cache is checked for recent identical queries
3. Elasticsearch query combines text matching + PageRank boosting
4. Results are ranked and snippets are generated
5. Response is cached and returned

## Development

### Running Tests

```bash
# Backend
cd backend
npm test

# Frontend
cd frontend
npm run type-check
npm run lint
```

### Environment Variables

Backend environment variables (`.env`):

```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgres://searchuser:searchpass@localhost:5432/searchdb
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200
CRAWLER_USER_AGENT=SearchBot/1.0 (Educational)
CRAWLER_DELAY_MS=1000
```

## Implementation Status

- [x] Initial architecture design
- [x] Web crawler with URL frontier
- [x] Index construction with Elasticsearch
- [x] Query processing and search API
- [x] PageRank implementation
- [x] Result ranking (multi-signal)
- [x] Autocomplete suggestions
- [x] Admin dashboard
- [ ] Spell correction (basic implementation)
- [ ] Distributed crawling
- [ ] Real-time indexing

## Key Technical Challenges

1. **Scale**: Indexing billions of pages efficiently
2. **Freshness**: Keeping index up-to-date with web changes
3. **Relevance**: Ranking quality results above spam
4. **Latency**: Sub-200ms query response times
5. **Crawl Efficiency**: Maximizing coverage with limited resources

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## License

Educational project - MIT License
