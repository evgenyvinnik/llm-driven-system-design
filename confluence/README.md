# Confluence Wiki/Knowledge Base

A full-stack implementation of a wiki/knowledge base system inspired by Atlassian Confluence. Features space-based organization, hierarchical page trees, version history with diffs, full-text search, macro system, threaded comments, and content approval workflows.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,706 |
| Source Files | 82 |
| .ts | 3,128 |
| .tsx | 1,967 |
| .md | 1,884 |
| .sql | 251 |
| .json | 163 |


## Features

- **Spaces**: Organize content into team/project spaces with key identifiers
- **Page Trees**: Hierarchical page structure with parent-child relationships
- **Rich Text Editor**: ContentEditable-based editor with formatting toolbar
- **Version History**: Full version tracking with line-by-line diff comparison
- **Full-Text Search**: Elasticsearch-powered search with highlighted results and PostgreSQL fallback
- **Macro System**: Info, Warning, Note, Code, and Table of Contents macros
- **Threaded Comments**: Comment on pages with reply threading and resolve/unresolve
- **Content Approval**: Request, approve, or reject page changes
- **Page Labels**: Tag pages with labels for categorization
- **Templates**: Create pages from predefined templates

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 |
| Cache/Sessions | Valkey (Redis-compatible) |
| Search | Elasticsearch 8.11 |
| Message Queue | RabbitMQ |
| Monitoring | Prometheus (prom-client), Pino logging |

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker Desktop

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure
docker-compose up -d

# Backend setup
cd backend
npm install
npm run db:migrate

# Seed demo data
PGPASSWORD=confluence123 psql -h localhost -U confluence -d confluence -f db-seed/seed.sql

# Start backend
npm run dev

# In a new terminal - start search worker (optional)
npm run dev:worker

# Frontend setup (new terminal)
cd frontend
npm install
npm run dev
```

### Option B: Native Installation (No Docker)

```bash
# PostgreSQL
brew install postgresql@16
brew services start postgresql@16
createdb confluence
psql confluence -c "CREATE USER confluence WITH PASSWORD 'confluence123';"
psql confluence -c "GRANT ALL PRIVILEGES ON DATABASE confluence TO confluence;"

# Valkey (Redis-compatible)
brew install valkey
brew services start valkey

# Elasticsearch
brew install elasticsearch
brew services start elasticsearch

# RabbitMQ (optional, for search indexing)
brew install rabbitmq
brew services start rabbitmq
```

### Access

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001 |
| Elasticsearch | http://localhost:9200 |
| RabbitMQ Management | http://localhost:15672 |
| Health Check | http://localhost:3001/api/health |
| Metrics | http://localhost:3001/api/metrics |

### Demo Accounts

| Username | Password | Role |
|----------|----------|------|
| alice | password123 | Admin |
| bob | password123 | User |

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Spaces
- `GET /api/v1/spaces` - List all spaces
- `GET /api/v1/spaces/:key` - Get space by key
- `POST /api/v1/spaces` - Create space
- `PUT /api/v1/spaces/:key` - Update space
- `DELETE /api/v1/spaces/:key` - Delete space
- `GET /api/v1/spaces/:key/members` - Get space members
- `POST /api/v1/spaces/:key/members` - Add member

### Pages
- `GET /api/v1/pages/recent` - Recent pages
- `GET /api/v1/pages/space/:spaceKey/tree` - Page tree
- `GET /api/v1/pages/space/:spaceKey/slug/:slug` - Get page by slug
- `GET /api/v1/pages/:id` - Get page by ID
- `POST /api/v1/pages` - Create page
- `PUT /api/v1/pages/:id` - Update page
- `DELETE /api/v1/pages/:id` - Delete page
- `POST /api/v1/pages/:id/move` - Move page in tree
- `POST /api/v1/pages/:id/labels` - Add label
- `DELETE /api/v1/pages/:id/labels/:label` - Remove label

### Versions
- `GET /api/v1/versions/:pageId` - Version history
- `GET /api/v1/versions/:pageId/diff?from=1&to=2` - Diff between versions
- `POST /api/v1/versions/:pageId/restore` - Restore version

### Search
- `GET /api/v1/search?q=query&space=KEY` - Search pages

### Comments
- `GET /api/v1/comments/page/:pageId` - Get comments
- `POST /api/v1/comments/page/:pageId` - Add comment
- `PUT /api/v1/comments/:id` - Update comment
- `DELETE /api/v1/comments/:id` - Delete comment
- `POST /api/v1/comments/:id/resolve` - Toggle resolve

### Templates
- `GET /api/v1/templates` - List templates
- `POST /api/v1/templates` - Create template
- `DELETE /api/v1/templates/:id` - Delete template

### Approvals
- `GET /api/v1/approvals/pending` - Pending approvals
- `GET /api/v1/approvals/page/:pageId` - Page approvals
- `POST /api/v1/approvals/request` - Request approval
- `POST /api/v1/approvals/:id/review` - Review (approve/reject)

## Project Structure

```
confluence/
├── docker-compose.yml
├── architecture.md
├── CLAUDE.md
├── README.md
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── db-seed/
│   │   └── seed.sql
│   └── src/
│       ├── app.ts              # Express app
│       ├── app.test.ts         # Backend tests
│       ├── index.ts            # Server entry point
│       ├── config/
│       ├── middleware/
│       │   └── auth.ts
│       ├── routes/
│       │   ├── auth.ts
│       │   ├── spaces.ts
│       │   ├── pages.ts
│       │   ├── versions.ts
│       │   ├── search.ts
│       │   ├── comments.ts
│       │   ├── templates.ts
│       │   └── approvals.ts
│       ├── services/
│       │   ├── db.ts
│       │   ├── redis.ts
│       │   ├── elasticsearch.ts
│       │   ├── queue.ts
│       │   ├── logger.ts
│       │   ├── metrics.ts
│       │   ├── circuitBreaker.ts
│       │   ├── rateLimiter.ts
│       │   ├── pageService.ts
│       │   ├── versionService.ts
│       │   ├── searchService.ts
│       │   ├── macroService.ts
│       │   └── approvalService.ts
│       ├── workers/
│       │   └── search-indexer.ts
│       └── db/
│           ├── init.sql
│           └── migrate.ts
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── index.css
        ├── types.ts
        ├── services/api.ts
        ├── stores/
        ├── routes/
        └── components/
```

## Running Tests

```bash
cd backend
npm test
```

## Environment Variables

```bash
# Backend
PORT=3001
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_USER=confluence
DB_PASSWORD=confluence123
DB_NAME=confluence
REDIS_HOST=localhost
REDIS_PORT=6379
ES_NODE=http://localhost:9200
RABBITMQ_URL=amqp://confluence:confluence123@localhost:5672
SESSION_SECRET=confluence-dev-secret-change-in-production
```
