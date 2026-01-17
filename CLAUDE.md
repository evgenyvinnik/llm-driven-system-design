# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a **system design learning repository** where each subdirectory represents an independent system design challenge. Most projects have both design documentation and working implementations.

## Project Structure

Each project folder typically contains:
```
<project>/
├── README.md                  # Setup instructions and implementation guide
├── architecture.md            # System design documentation and trade-offs
├── system-design-answer.md    # Interview-style answer (45-minute format)
├── claude.md                  # LLM collaboration notes and iteration history
├── frontend/                  # React + TypeScript frontend (when applicable)
├── backend/                   # Node.js + Express backend (when applicable)
└── docker-compose.yml         # Infrastructure services (PostgreSQL, Redis, etc.)
```

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
npm run dev:worker       # Run background worker (if applicable)
npm run dev:worker1      # Run multiple workers for parallel processing
npm run dev:worker2

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

# Update all project READMEs with SLOC stats
node scripts/update-readme-sloc.mjs
```

## Technology Stack Defaults

Use these unless there's a compelling reason to deviate (document justification in the project's claude.md):

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Databases:** PostgreSQL (relational), Cassandra (wide-column, time-series), ClickHouse (OLAP analytics), Valkey/Redis (cache)
- **Message Queues:** RabbitMQ, Kafka
- **Search:** Elasticsearch/OpenSearch
- **Object Storage:** MinIO (S3-compatible)
- **Monitoring:** Prometheus + Grafana

## Key Design Principles

1. **All projects must run locally** - Design for 2-5 service instances on different ports
2. **Keep auth simple** - Session-based auth with Redis, avoid OAuth/JWT complexity unless studying those topics
3. **Both user personas** - Implement end-user AND admin interfaces when applicable
4. **Justify deviations** - Document why in the project's `claude.md` if straying from defaults

## Frontend Best Practices

### SVG Icon Organization

**Never inline SVG code directly into components.** Instead, create separate icon components:

```
frontend/src/components/icons/
├── index.ts              # Barrel export for all icons
├── HeartIcon.tsx         # Individual icon component
├── HomeIcon.tsx
├── SearchIcon.tsx
├── ShareIcon.tsx
└── ...
```

**Why this matters:**
- **Readability**: Component code stays focused on logic, not SVG paths
- **Reusability**: Icons can be imported anywhere without duplication
- **Maintainability**: Update an icon in one place, changes everywhere
- **Bundle optimization**: Tree-shaking can exclude unused icons

**Example icon component:**
```tsx
// src/components/icons/HeartIcon.tsx
interface HeartIconProps {
  className?: string;
  filled?: boolean;
}

export function HeartIcon({ className = "w-6 h-6", filled = false }: HeartIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  );
}
```

**Usage in components:**
```tsx
// Clean, readable component code
import { HeartIcon, ShareIcon, CommentIcon } from '@/components/icons';

function PostActions() {
  return (
    <div className="flex gap-4">
      <button><HeartIcon filled={isLiked} className="w-5 h-5 text-red-500" /></button>
      <button><CommentIcon /></button>
      <button><ShareIcon /></button>
    </div>
  );
}
```

### Other Frontend Guidelines

- **Component size**: If a component exceeds ~150 lines, consider splitting it
- **Tailwind classes**: Use `@apply` in CSS for frequently repeated class combinations
- **State management**: Prefer Zustand for global state, React state for local UI state
- **API calls**: Centralize in a `services/` or `api/` directory

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
│   ├── queue.ts         # RabbitMQ client
│   └── auth.ts          # Authentication middleware
└── db/
    ├── init.sql         # Database schema (consolidated)
    ├── migrate.ts       # Migration runner
    └── seed-*.ts        # Database seeders
```

### Database Schema Files

SQL schemas are stored as `init.sql` files (not numbered migrations). Common locations:

| Location | Examples |
|----------|----------|
| `backend/src/db/init.sql` | scale-ai, discord, calendly, twitter |
| `backend/db/init.sql` | instagram, airbnb, youtube, doordash |
| `backend/init.sql` | slack (embedded in migrate.ts), dropbox, whatsapp |
| `backend/scripts/init.sql` | google-search, shopify |

For projects using multiple databases:
- **Cassandra**: `backend/db/cassandra-init.cql` (e.g., instagram DMs)
- **ClickHouse**: `backend/db/clickhouse-init.sql` (e.g., ad-click-aggregator)

The `npm run db:migrate` command runs `migrate.ts` which executes `init.sql` against the database.

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

## Database Selection Guide

Choose the appropriate database based on access patterns:

| Database | Use Case | Example Projects |
|----------|----------|------------------|
| **PostgreSQL** | ACID transactions, complex queries, relational data | Most projects (users, orders, metadata) |
| **Cassandra** | High-write throughput, time-ordered data, partition-based access | `instagram` (DMs with TimeUUID ordering) |
| **ClickHouse** | Real-time analytics, aggregations, OLAP workloads | `ad-click-aggregator` (metrics with materialized views) |
| **Redis/Valkey** | Caching, sessions, pub/sub, rate limiting | All projects (session store, cache layer) |
| **Elasticsearch** | Full-text search, relevance scoring | `fb-post-search` (social content search) |

## Technology Reference

See [TECHNOLOGIES.md](./TECHNOLOGIES.md) for a comprehensive guide to all technologies used across projects, including alternatives and trade-offs. Consult this when choosing technologies for new projects or understanding existing implementations.

## Implementation Notes

Projects have both frontend and backend implementations following the standard `frontend/` + `backend/` structure. Some backends use TypeScript (`scale-ai`, `web-crawler`, `ad-click-aggregator`) with `tsx`, while others use plain JavaScript (`instagram`, `uber`) with `node --watch`. Check each project's `package.json` for available scripts.

**Project-level claude.md files:** Many projects have their own LLM collaboration notes with project-specific decisions and iteration history. Always check for these when working on a specific project.

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

## ESM Import Convention

Backend projects use ES modules (`"type": "module"` in package.json). Always use `.js` extension in imports, even for TypeScript files:

```typescript
// Correct - use .js extension
import { pool } from '../shared/db.js'
import { cacheGet } from '../shared/cache.js'

// Wrong - TypeScript extension won't work at runtime
import { pool } from '../shared/db.ts'  // ❌
import { pool } from '../shared/db'     // ❌
```
