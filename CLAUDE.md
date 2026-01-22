# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a **system design learning repository** where each subdirectory represents an independent system design challenge. Most projects have both design documentation and working implementations.

**Node.js Requirement:** >=20.0.0

## Quick Start for Any Project

1. Read the project's `architecture.md` first to understand the design
2. Check `CLAUDE.md` for iteration history and key decisions (primary source of truth for project-specific guidance - captures the "why" behind implementation choices)
3. Look at `README.md` for setup instructions
4. Check `package.json` to find available scripts

## Project Structure

Each project folder typically contains:
```
<project>/
├── README.md                  # Setup instructions and implementation guide
├── architecture.md            # System design documentation and trade-offs
├── system-design-answer.md    # Interview-style answer (45-minute format)
├── CLAUDE.md                  # LLM collaboration notes and iteration history
├── frontend/                  # React + TypeScript frontend (when applicable)
├── backend/                   # Node.js + Express backend (when applicable)
├── training/                  # ML training code (Python, when applicable)
└── docker-compose.yml         # Infrastructure services (PostgreSQL, Redis, etc.)
```

**Note:** Some projects (mdreader, MCPlator, 20forms-20designs) are external personal projects with architecture documentation only - they link to separate repositories for implementation.

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

Scripts run from the repository root:

```bash
# Count SLOC for entire repository
npm run sloc

# Count SLOC for specific project
npm run sloc scale-ai

# Output as JSON
node scripts/sloc.mjs scale-ai --json

# Output summary for README embedding
node scripts/sloc.mjs scale-ai --summary

# Update all project READMEs with SLOC stats
npm run sloc:update

# Add Codex opinion comments to architecture files (appends to codex-opinion.md)
node scripts/add-codex-opinion.mjs

# Generate Playwright smoke tests from screenshot configs
npm run generate-tests              # Generate for all projects
npm run generate-tests bitly        # Generate for specific project

# Run smoke tests (automated UI tests)
npm run test:smoke instagram        # Run smoke tests for specific project
npm run test:smoke:all              # Run smoke tests for all projects

# ESLint/Prettier maintenance (batch operations across projects)
node scripts/add-eslint-configs.mjs # Add ESLint configs to all backends
node scripts/fix-eslint-errors.mjs  # Auto-fix ESLint errors across projects
node scripts/fix-unused-vars.mjs    # Prefix unused variables with underscore
```

### Full Development Workflow

To run a complete project with frontend and backend:

```bash
# Terminal 1: Start infrastructure
cd <project>
docker-compose up -d

# Terminal 2: Run database migrations and start backend
cd <project>/backend
npm run db:migrate
npm run dev

# Terminal 3: Start frontend
cd <project>/frontend
npm run dev
```

For projects requiring seed data (screenshots, demos):
```bash
# After migration, seed the database
PGPASSWORD=password psql -h localhost -U user -d dbname -f backend/db-seed/seed.sql
```

### Screenshot & Smoke Test Automation

The repository includes tooling for visual documentation and automated UI testing using **Playwright** (primary) and **Puppeteer** (legacy/fallback).

**Screenshots** capture frontend UI for documentation. **Smoke tests** are auto-generated from screenshot configs and verify that pages load correctly - use them after making frontend changes to catch regressions.

**Prerequisites:**
- Playwright installed: `npm install playwright` and `npx playwright install`
- Docker Desktop running (for projects with docker-compose.yml)
- Frontend dev server must be running (or use `--start` flag)
- For authenticated pages, backend and database must be running

**Usage:**
```bash
# Take screenshots (frontend must already be running)
npm run screenshots instagram

# Full automated workflow: starts docker, backend, frontend, captures, then stops all
node scripts/screenshots.mjs --start instagram

# Auto-screenshot all configured projects (handles Docker cleanup between projects)
npm run screenshots:all

# Dry run (show what would be captured)
npm run screenshots:dry instagram

# List available configurations
node scripts/screenshots.mjs --list
```

**Note:** When running individual projects manually, only one project can run at a time on the default ports. The `screenshots:all` workflow handles Docker cleanup automatically between projects.

**Adding a new project:**
1. Create `scripts/screenshot-configs/<project>.json`
2. Define screens to capture with selectors and routes
3. Run `node scripts/screenshots.mjs --start <project>`

**Configuration schema:**
```json
{
  "name": "project-name",
  "frontendPort": 5173,
  "auth": {
    "enabled": true,
    "loginUrl": "/login",
    "credentials": { "username": "alice", "password": "password123" },
    "usernameSelector": "input[name='username']",
    "passwordSelector": "input[name='password']",
    "submitSelector": "button[type='submit']"
  },
  "screens": [
    { "name": "01-login", "path": "/login", "skipAuth": true },
    { "name": "02-home", "path": "/", "waitFor": "main" }
  ]
}
```

Screenshots are saved to `<project>/screenshots/` at 2x resolution (retina).

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

## Port Conventions

| Port | Service |
|------|---------|
| 5173 | Frontend (Vite dev server) |
| 3000 | Backend API / Load balancer |
| 3001-3003 | Additional API instances (distributed testing) |
| 5432 | PostgreSQL |
| 6379 | Redis/Valkey |
| 9000 | MinIO |
| 5672/15672 | RabbitMQ (AMQP/Management) |
| 9200 | Elasticsearch |
| 8123 | ClickHouse |
| 9092 | Kafka |

## Frontend Best Practices

### List Virtualization

For feeds and large lists, use `@tanstack/react-virtual` for efficient rendering. This only renders items visible in the viewport, critical for performance with hundreds/thousands of items.

**Projects using virtualization:**
- **TikTok** - Full-screen video feed (`routes/index.tsx`)
- **Instagram** - Post feed with dynamic heights (`routes/index.tsx`)
- **FB News Feed** - Post feed with infinite scroll (`routes/index.tsx`)
- **Twitter** - Tweet timeline (`components/Timeline.tsx`)
- **iCloud** - Photo grid with row-based virtualization (`components/photos/PhotoGrid.tsx`)

**Standard pattern:**
```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 400, // Estimated item height
  overscan: 3, // Extra items to render above/below viewport
  measureElement: (el) => el.getBoundingClientRect().height, // Dynamic heights
});
```

### TanStack Router File-Based Routing

Projects using TanStack Router follow this file structure:
```
frontend/src/routes/
├── __root.tsx      # Root layout with outlet
├── index.tsx       # / route
├── admin.tsx       # /admin route
└── $dynamicParam.tsx  # Dynamic route segment
```

### SVG Icon Organization

Never inline SVG code directly into components. Create separate icon components in `frontend/src/components/icons/` with a barrel export (`index.ts`). Each icon should accept `className` and variant props.

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

### Database Schema and Seed Files

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

**Seed files** (`backend/db-seed/seed.sql`) populate sample data for development. The screenshot automation script automatically runs seeds when setting up for captures.

### Testing

Tests use vitest with mocked shared modules. Each backend has a `vitest.config.ts` at its root. Test files are co-located with source files (`app.test.ts` next to `app.ts`). Mock shared modules before importing the app:

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

All projects use TypeScript with `tsx` for backend development. Check each project's `package.json` for available scripts.

### Python Training Scripts

Some projects include Python-based ML training code in a `training/` directory:

```bash
cd <project>/training
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Run training (typically consumes from RabbitMQ or reads from DB)
python train.py
```

Python dependencies are managed via `requirements.txt` with PyTorch, NumPy, and project-specific libraries.

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

### Default Development Credentials

Most projects use these default credentials in docker-compose.yml:

| Service | Username | Password | Database/Bucket |
|---------|----------|----------|-----------------|
| PostgreSQL | `user` | `password` | Project-specific (e.g., `instagram`, `airbnb`) |
| Redis/Valkey | - | - | (no auth in dev) |
| MinIO | `minioadmin` | `minioadmin` | Project-specific buckets |
| RabbitMQ | `guest` | `guest` | Default vhost |

This ensures projects are accessible to developers who prefer not to use Docker.

## ESM Import Convention

Backend projects use ES modules (`"type": "module"` in package.json). Import handling differs by language:

**TypeScript projects** - Always use `.js` extension in imports (TypeScript compiles to JS):
```typescript
// Correct - use .js extension
import { pool } from '../shared/db.js'
import { cacheGet } from '../shared/cache.js'

// Wrong - TypeScript extension won't work at runtime
import { pool } from '../shared/db.ts'  // ❌
import { pool } from '../shared/db'     // ❌
```

**JavaScript projects** - Use `.js` extension consistently:
```javascript
import { pool } from '../shared/db.js'
import express from 'express'
```
