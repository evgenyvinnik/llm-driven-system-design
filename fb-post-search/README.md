# Facebook Post Search

A privacy-aware search engine for social media posts with personalized ranking and real-time indexing.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 5,388 |
| Source Files | 54 |
| .ts | 2,827 |
| .tsx | 1,387 |
| .md | 935 |
| .json | 135 |
| .yml | 52 |

## Overview

This project implements a Facebook-like post search system that demonstrates:

- **Full-text search** with Elasticsearch
- **Privacy-aware filtering** - users only see posts they have permission to view
- **Personalized ranking** - prioritizes posts from friends and engaged content
- **Real-time indexing** - new posts are immediately searchable
- **Typeahead suggestions** - autocomplete as users type
- **Admin dashboard** - system monitoring and management

## Key Features

- Full-text search with fuzzy matching and highlighting
- Privacy filtering using visibility fingerprints
- Social graph-based result boosting
- Search suggestions and trending searches
- Search history tracking
- Admin dashboard with system stats

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + Elasticsearch + Redis)
- [x] API endpoints
- [x] Frontend search interface
- [x] Admin dashboard
- [ ] Performance optimization
- [ ] Comprehensive testing

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL 16
- **Search Engine:** Elasticsearch 8.11
- **Cache:** Redis 7
- **Infrastructure:** Docker Compose

## Getting Started

### Prerequisites

- Node.js 18+ (v20 recommended)
- Docker and Docker Compose
- npm or yarn

### Quick Start

1. **Clone and navigate to the project:**

```bash
cd fb-post-search
```

2. **Start infrastructure services:**

```bash
docker-compose up -d
```

Wait for services to be healthy:
```bash
docker-compose ps
```

3. **Set up the backend:**

```bash
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

4. **Set up the frontend (in a new terminal):**

```bash
cd frontend
npm install
npm run dev
```

5. **Access the application:**

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api/v1
- Elasticsearch: http://localhost:9200

### Sample Login Credentials

| Role  | Username | Password     |
|-------|----------|--------------|
| User  | alice    | password123  |
| User  | bob      | password123  |
| Admin | admin    | admin123     |

## Project Structure

```
fb-post-search/
├── backend/
│   ├── src/
│   │   ├── config/          # Database, Elasticsearch, Redis config
│   │   ├── controllers/     # Route handlers
│   │   ├── middleware/      # Auth middleware
│   │   ├── routes/          # API routes
│   │   ├── services/        # Business logic
│   │   │   ├── authService.ts      # Authentication
│   │   │   ├── indexingService.ts  # Elasticsearch indexing
│   │   │   ├── postService.ts      # Post CRUD
│   │   │   ├── searchService.ts    # Search with privacy
│   │   │   └── visibilityService.ts # Privacy filtering
│   │   ├── types/           # TypeScript types
│   │   └── scripts/         # Migration and seed scripts
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── routes/          # TanStack Router routes
│   │   ├── services/        # API client
│   │   ├── stores/          # Zustand stores
│   │   └── types/           # TypeScript types
│   └── package.json
├── docker-compose.yml
├── architecture.md
├── system-design-answer.md
└── CLAUDE.md
```

## API Endpoints

### Authentication

| Method | Endpoint           | Description              |
|--------|-------------------|--------------------------|
| POST   | /api/v1/auth/login    | Login with credentials   |
| POST   | /api/v1/auth/register | Create new account       |
| POST   | /api/v1/auth/logout   | End session              |
| GET    | /api/v1/auth/me       | Get current user         |

### Search

| Method | Endpoint                   | Description              |
|--------|---------------------------|--------------------------|
| POST   | /api/v1/search            | Search posts             |
| GET    | /api/v1/search/suggestions | Get typeahead suggestions |
| GET    | /api/v1/search/trending   | Get trending searches    |
| GET    | /api/v1/search/recent     | Get user's recent searches |
| DELETE | /api/v1/search/history    | Clear search history     |

### Posts

| Method | Endpoint                | Description              |
|--------|------------------------|--------------------------|
| POST   | /api/v1/posts          | Create new post          |
| GET    | /api/v1/posts/feed     | Get user's feed          |
| GET    | /api/v1/posts/:id      | Get post by ID           |
| PUT    | /api/v1/posts/:id      | Update post              |
| DELETE | /api/v1/posts/:id      | Delete post              |
| POST   | /api/v1/posts/:id/like | Like a post              |

### Admin

| Method | Endpoint                    | Description              |
|--------|----------------------------|--------------------------|
| GET    | /api/v1/admin/stats        | Get system statistics    |
| GET    | /api/v1/admin/users        | List all users           |
| GET    | /api/v1/admin/posts        | List all posts           |
| GET    | /api/v1/admin/search-history | View search history     |
| POST   | /api/v1/admin/reindex      | Reindex all posts        |
| GET    | /api/v1/admin/health       | Health check             |

## Search Request Example

```json
POST /api/v1/search
{
  "query": "birthday party",
  "filters": {
    "date_range": {
      "start": "2024-01-01",
      "end": "2024-12-31"
    },
    "post_type": ["text", "photo"],
    "visibility": ["public", "friends"]
  },
  "pagination": {
    "limit": 20,
    "cursor": null
  }
}
```

## Privacy Model

Posts have visibility settings:

- **public** - Anyone can see
- **friends** - Only the author's friends can see
- **friends_of_friends** - Friends and their friends can see
- **private** - Only the author can see

The search engine uses visibility fingerprints to efficiently filter results at query time, ensuring users only see posts they have permission to view.

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Development Commands

### Backend

```bash
npm run dev          # Start dev server with hot reload
npm run build        # Build for production
npm run db:migrate   # Run database migrations
npm run db:seed      # Seed database with sample data
npm run lint         # Run ESLint
npm run format       # Format with Prettier
```

### Frontend

```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run preview      # Preview production build
npm run type-check   # TypeScript type checking
npm run lint         # Run ESLint
```

## Architecture

See [architecture.md](./architecture.md) for the system design overview and [system-design-answer.md](./system-design-answer.md) for the complete system design interview answer.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and iteration history.

## Future Enhancements

- [ ] Two-tier indexing (hot/cold)
- [ ] Bloom filters for visibility sets
- [ ] ML-based ranking model
- [ ] Real-time WebSocket updates
- [ ] Comment search
- [ ] Multi-language support
- [ ] Load testing and benchmarks

## References & Inspiration

- [Unicorn: A System for Searching the Social Graph](https://research.facebook.com/publications/unicorn-a-system-for-searching-the-social-graph/) - Facebook's research paper on social graph search
- [Under the Hood: Indexing and Ranking in Graph Search](https://engineering.fb.com/2013/02/20/core-infra/under-the-hood-indexing-and-ranking-in-graph-search/) - Facebook's approach to privacy-aware search
- [Typeahead Search at Facebook](https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/) - Real-time search suggestions implementation
- [Elasticsearch: The Definitive Guide](https://www.elastic.co/guide/en/elasticsearch/guide/current/index.html) - Comprehensive guide for full-text search
- [Privacy in Social Search](https://research.facebook.com/publications/privacy-social-search/) - Research on balancing privacy and search relevance
- [BM25 Ranking Algorithm](https://www.elastic.co/blog/practical-bm25-part-2-the-bm25-algorithm-and-its-variables) - Understanding the default Elasticsearch ranking
- [Facebook's TAO](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/) - Graph data store enabling efficient social queries
