# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a **system design learning repository** where each subdirectory represents an independent system design challenge. Most projects contain only design documentation; some have partial implementations.

## Project Structure

Each project folder follows this pattern:
```
<project>/
├── README.md                  # Setup instructions and implementation guide
├── architecture.md            # System design documentation and trade-offs
├── system-design-answer.md    # Interview-style answer (45-minute format)
└── claude.md                  # LLM collaboration notes and iteration history
```

Some projects (like `scale-ai/frontend`) include actual implementation code.

## Common Commands

When a project has implementation code:

```bash
# Frontend (Vite + React + TypeScript)
cd <project>/frontend
npm run dev              # Start dev server (usually port 5173)
npm run build            # Build for production (runs tsc first)
npm run lint             # Run ESLint
npm run format           # Run Prettier
npm run type-check       # TypeScript type checking (tsc --noEmit)

# Backend (Node.js + Express, when implemented)
cd <project>/backend
npm run dev              # Start all services with hot reload (via concurrently)
npm run dev:collection   # Run individual service (naming varies by project)
npm run dev:admin        # Run admin service
npm run dev:server1      # Run on port 3001 (for distributed testing)
npm run dev:server2      # Run on port 3002
npm run dev:server3      # Run on port 3003

# Database
npm run db:migrate       # Run migrations
npm run db:seed-admin    # Seed admin user (if applicable)

# Testing (vitest)
npm run test             # Run tests once
npm run test:watch       # Run tests in watch mode
npm run test -- src/collection/app.test.ts           # Run single test file
npm run test -- --grep "should return health status" # Run tests matching pattern

# Infrastructure (when docker-compose.yml exists)
docker-compose up -d     # Start PostgreSQL, Redis/Valkey, MinIO, RabbitMQ, etc.
docker-compose down      # Stop services
docker-compose down -v   # Stop and remove volumes
```

## Repository Scripts

```bash
# Count SLOC for entire repository
node scripts/sloc.mjs

# Count SLOC for specific project
node scripts/sloc.mjs scale-ai

# Output as JSON
node scripts/sloc.mjs scale-ai --json

# Output summary for README embedding
node scripts/sloc.mjs scale-ai --summary
```

## Technology Stack Defaults

Use these unless there's a compelling reason to deviate (document justification in the project's claude.md):

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Databases:** PostgreSQL (relational), CouchDB (document), Valkey/Redis (cache), Cassandra (wide-column)
- **Message Queues:** RabbitMQ, Kafka
- **Search:** Elasticsearch/OpenSearch
- **Object Storage:** MinIO (S3-compatible)
- **Monitoring:** Prometheus + Grafana

## Key Design Principles

1. **All projects must run locally** - Design for 2-5 service instances on different ports
2. **Keep auth simple** - Session-based auth with Redis, avoid OAuth/JWT complexity unless studying those topics
3. **Both user personas** - Implement end-user AND admin interfaces when applicable
4. **Justify deviations** - Document why in the project's `claude.md` if straying from defaults

## Backend Architecture Pattern

Implemented projects follow a microservices structure under `src/`:

```
backend/src/
├── <service1>/          # e.g., collection, admin, inference
│   ├── index.ts         # Service entry point (starts Express server)
│   └── app.ts           # Express app definition (exported for testing)
├── <service2>/
├── shared/              # Common modules used across services
│   ├── db.ts            # PostgreSQL connection pool
│   ├── cache.ts         # Redis/Valkey client and helpers
│   ├── storage.ts       # MinIO object storage client
│   └── auth.ts          # Authentication middleware
└── db/
    ├── migrations/      # SQL migration files (001_*.sql, 002_*.sql, ...)
    ├── migrate.ts       # Migration runner
    └── seed-*.ts        # Database seeders
```

Tests use vitest with mocked shared modules. Test files are co-located with source files (`app.test.ts` next to `app.ts`). Mock shared modules before importing the app:

```typescript
// Mock shared modules before import
vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn() },
}))
vi.mock('../shared/storage.js', () => ({
  uploadDrawing: vi.fn().mockResolvedValue('path/to/file'),
}))

// Import after mocking
import { app } from './app.js'
```

## Projects with Implementations

Most projects are design-only. These have working code (check their package.json for available scripts):
- `scale-ai/` - Full-stack data labeling platform (frontend + backend with tests)
- `web-crawler/` - Distributed crawler with frontend dashboard
- `news-aggregator/`, `airtag/`, `uber/`, `price-tracking/`, `google-docs/`, `twitter/`, `youtube-top-k/`, `spotlight/` - Partial implementations

## Creating New Projects

### New Frontend Setup
```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install zustand @tanstack/react-router
npm install -D @tanstack/router-vite-plugin tailwindcss postcss autoprefixer
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier
npx tailwindcss init -p
```

### Standard Route Structure
```
/                    → End-user interface
/admin               → Admin dashboard
/api/v1/*            → Public API
/api/v1/admin/*      → Admin API
```

## Working with Existing Projects

When asked to work on a project:
1. Read the project's `architecture.md` first to understand the design
2. Check `claude.md` for iteration history and key decisions
3. Look at `README.md` for setup instructions
4. If implementation exists, check for `package.json` to find available scripts

## Local Development Philosophy

Projects should support simulating distributed systems locally:
```bash
# Example: Run 3 API server instances behind a load balancer
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run dev:lb       # Port 3000 (load balancer)
```

Keep resource requirements reasonable (< 8GB RAM for most projects).

## Infrastructure Options

**Always provide TWO alternatives** for running infrastructure in project READMEs:

### Option A: Docker Compose (Recommended)
```bash
docker-compose up -d
```
- Fastest setup, one command
- Pre-configured credentials and networking
- Includes helpful commands: `docker-compose down`, `docker-compose down -v`

### Option B: Native Installation (No Docker)
Provide step-by-step instructions for installing each service via Homebrew (macOS):
- PostgreSQL: `brew install postgresql@16`
- Redis/Valkey: `brew install valkey` or `brew install redis`
- MinIO: `brew install minio`
- RabbitMQ: `brew install rabbitmq`

Include commands to:
1. Start the service
2. Create required databases/users/buckets
3. Verify it's running

### Environment Variables
Document all connection strings with sensible defaults:
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost:9000
RABBITMQ_URL=amqp://user:pass@localhost:5672
```

This ensures projects are accessible to developers who prefer not to use Docker.
