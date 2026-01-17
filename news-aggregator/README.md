# News Aggregator

A content aggregation and curation platform that crawls RSS feeds, deduplicates articles into stories, and provides personalized news feeds.

## Key Features

- **Source Crawling**: Fetches articles from RSS/Atom feeds with rate limiting
- **Deduplication**: Groups similar articles into stories using SimHash fingerprinting
- **Categorization**: Automatic topic extraction and classification
- **Personalization**: Customized feed ranking based on user preferences
- **Search**: Full-text search powered by Elasticsearch
- **Admin Dashboard**: Manage sources, trigger crawls, view statistics

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│     Backend     │────▶│   PostgreSQL    │
│  (React + TS)   │     │   (Express)     │     │   (Articles)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │                        │
                              ▼                        ▼
                        ┌───────────┐           ┌───────────┐
                        │   Redis   │           │Elasticsearch│
                        │  (Cache)  │           │  (Search)  │
                        └───────────┘           └───────────┘
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Installation

1. Clone the repository and navigate to the news-aggregator directory:
   ```bash
   cd news-aggregator
   ```

2. Start the infrastructure services:
   ```bash
   docker-compose up -d
   ```

3. Wait for services to be healthy (especially Elasticsearch, which takes ~30 seconds):
   ```bash
   docker-compose ps
   ```

4. Install backend dependencies and start the server:
   ```bash
   cd backend
   npm install
   npm run dev
   ```

5. In a new terminal, install frontend dependencies and start the dev server:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

6. Access the application:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3000
   - Admin Dashboard: http://localhost:5173/admin (login as admin@newsagg.local / admin123)

### Running Multiple Backend Instances

For testing distributed scenarios:

```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## API Endpoints

### Feed API

```
GET /api/v1/feed                    # Personalized feed
GET /api/v1/feed/topic/:topic       # Topic-specific feed
GET /api/v1/breaking                # Breaking news
GET /api/v1/trending                # Trending stories
GET /api/v1/stories/:id             # Single story with articles
GET /api/v1/search?q=...            # Full-text search
GET /api/v1/topics                  # Available topics
```

### User API

```
POST /api/v1/user/register          # Create account
POST /api/v1/user/login             # Login
POST /api/v1/user/logout            # Logout
GET  /api/v1/user/me                # Current user
GET  /api/v1/user/preferences       # User preferences
PUT  /api/v1/user/preferences       # Update preferences
POST /api/v1/user/reading-history   # Record article read
```

### Admin API

```
GET  /api/v1/admin/stats            # Dashboard statistics
GET  /api/v1/admin/sources          # List all sources
POST /api/v1/admin/sources          # Add new source
PUT  /api/v1/admin/sources/:id      # Update source
DELETE /api/v1/admin/sources/:id    # Delete source
POST /api/v1/admin/sources/:id/crawl # Crawl single source
POST /api/v1/admin/crawl            # Trigger full crawl
```

## Tech Stack

- **Frontend**: TypeScript, React 19, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL (primary data), Redis (cache/sessions), Elasticsearch (search)
- **Deduplication**: SimHash fingerprinting for near-duplicate detection

## Key Design Decisions

### Deduplication with SimHash

Articles about the same story are grouped using SimHash fingerprinting:
- Compute 64-bit fingerprint from title + body text
- Articles with Hamming distance < 3 are considered duplicates
- Grouped into "stories" with multiple source coverage

### Personalized Ranking

Feed ranking uses multiple signals:
- **Relevance** (35%): Topic match with user interests
- **Freshness** (25%): Exponential decay with 6-hour half-life
- **Quality** (20%): Source diversity within story
- **Trending** (10%): Story velocity
- **Diversity penalty**: Avoid topic clusters in feed

### Topic Extraction

Keywords-based classification into categories:
- technology, politics, business, sports, entertainment, science, world, health

## Default Sources

The system comes pre-configured with these sources:
- TechCrunch, The Verge, Ars Technica (technology)
- BBC News, NPR News, The Guardian, Reuters (world)
- ESPN (sports)
- Hacker News, Wired (technology)

## Development

### Project Structure

```
news-aggregator/
├── docker-compose.yml      # PostgreSQL, Redis, Elasticsearch
├── backend/
│   ├── src/
│   │   ├── index.ts        # Express server entry
│   │   ├── db/             # Database connections
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   └── utils/          # SimHash, RSS parsing, topics
│   └── db/init.sql         # Schema and seed data
└── frontend/
    └── src/
        ├── routes/         # Tanstack Router pages
        ├── components/     # React components
        ├── stores/         # Zustand state
        └── services/       # API client
```

### Environment Variables

Backend:
```
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_USER=newsagg
DB_PASSWORD=newsagg_dev
DB_NAME=news_aggregator
REDIS_HOST=localhost
REDIS_PORT=6379
ELASTICSEARCH_URL=http://localhost:9200
FRONTEND_URL=http://localhost:5173
```

## Testing

```bash
# Backend
cd backend
npm run build   # TypeScript compilation

# Frontend
cd frontend
npm run lint    # ESLint
npm run type-check  # TypeScript
npm run build   # Production build
```

## Architecture Documentation

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- [ ] ML-based topic classification (BERT/transformers)
- [ ] Semantic embeddings for better deduplication
- [ ] Push notifications for breaking news
- [ ] Collaborative filtering for recommendations
- [ ] Source credibility scoring
- [ ] Fact-checking integration
