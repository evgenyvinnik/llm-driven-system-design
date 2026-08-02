# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Table of Contents

- [Repository Overview](#repository-overview)
- [Quick Start for Any Project](#quick-start-for-any-project)
- [Project Structure](#project-structure)
  - [Writing Architecture Documents](#writing-architecture-documents)
  - [Writing System Design Answers](#writing-system-design-answers)
  - [Explaining Trade-offs in Depth](#explaining-trade-offs-in-depth)
- [Common Commands](#common-commands)
- [Repository Scripts](#repository-scripts)
- [CI/CD](#cicd)
- [Technology Stack Defaults](#technology-stack-defaults)
- [Key Design Principles](#key-design-principles)
- [Port Conventions](#port-conventions)
- [Frontend Best Practices](#frontend-best-practices)
- [Backend Architecture Pattern](#backend-architecture-pattern)
- [Database Selection Guide](#database-selection-guide)
- [Creating New Projects](#creating-new-projects)
- [Local Development Philosophy](#local-development-philosophy)
- [Infrastructure Options](#infrastructure-options)
- [ESM Import Convention](#esm-import-convention)

## Repository Overview

This is a **system design learning repository** where each subdirectory represents an independent system design challenge. Most projects have both design documentation and working implementations.

**Node.js Requirement:** >=20.0.0

## Quick Start for Any Project

1. Read the project's `architecture.md` first to understand the design
2. Check `AGENTS.md` for iteration history and key decisions (primary source of truth for project-specific guidance - captures the "why" behind implementation choices)
3. Look at `README.md` for setup instructions
4. Check `package.json` to find available scripts

## Project Structure

Each project folder typically contains:
```
<project>/
├── README.md                  # Setup instructions and implementation guide
├── architecture.md            # System design documentation and trade-offs
├── system-design-answer-frontend.md   # Frontend-focused interview answer
├── system-design-answer-backend.md    # Backend-focused interview answer
├── system-design-answer-fullstack.md  # Full-stack interview answer
├── AGENTS.md                  # LLM collaboration notes and iteration history
├── frontend/                  # React + TypeScript frontend (when applicable)
├── backend/                   # Node.js + Express backend (when applicable)
├── training/                  # ML training code (Python, when applicable)
└── docker-compose.yml         # Infrastructure services (PostgreSQL, Redis, etc.)
```

**Documentation file purposes:**
- `architecture.md`: Dual-layer design document — production-scale architecture (the ideal) with diagrams, schemas, and trade-off analysis, plus local implementation notes (the actual) mapping to Docker + Node.js + React
- `system-design-answer-{frontend,backend,fullstack}.md`: Concise 45-minute interview answers using ASCII diagrams (no code blocks), trade-off tables, and first-person rationale. Each variant is tailored to a specific interview focus.
- `AGENTS.md`: Captures iteration history and the "why" behind key decisions

### Writing Architecture Documents

The `architecture.md` files serve a dual purpose: documenting the **production-scale design** (how this system would work at millions of users) and the **local implementation** (what we actually built with Docker + Node.js + Express + React). These two layers should be explicit, not interleaved.

**Recommended section structure:**

| Section | Scope | Purpose |
|---------|-------|---------|
| System Overview | Production | One-paragraph description + learning goals |
| Requirements | Production | Functional requirements + NFR targets at production scale (99.99% uptime, p99 < 50ms) |
| Capacity Estimation | Both | Optional. Production-scale estimates first; optional "Local Development Scale" subsection for component sizing. ~46% of projects include this |
| High-Level Architecture | Production | Box diagram showing the ideal architecture (CDN, API Gateway, microservices) |
| Core Components / Request Flows | Both | Component responsibilities and data flow at production scale, noting local simplifications inline |
| Database Schema | Both | Full SQL schemas with indexes and constraints — production-ready but run locally |
| API Design | Both | Endpoint listing with request/response examples |
| Key Design Decisions | Production | Trade-off analysis for major architectural choices |
| Consistency and Idempotency | Both | Idempotency keys, retry semantics, exactly-once guarantees |
| Security / Auth | Both | Authentication, authorization, rate limiting |
| Observability | Both | Prometheus metrics, structured logging, health checks |
| Failure Handling | Both | Circuit breakers, retry strategies, graceful degradation |
| Scalability Considerations | Production | Horizontal scaling path, sharding strategy, read replicas |
| Trade-offs Summary | Production | Summary table (see format below) |
| Implementation Notes | **Local** | Maps production design to local Docker + Node.js setup |

**Section naming**: Use the names above. The codebase has inconsistencies — older projects use "Data Model" (use "Database Schema" instead), "Monitoring and Observability" (use "Observability"), and "Trade-offs and Alternatives" (use "Trade-offs Summary"). New projects should use the standardized names above.

**Architecture diagrams**: Show the production-ideal architecture (CDN, API Gateway, separate microservices, message queues). Use Unicode box-drawing characters (`┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼ ▼ ▲ ─▶`), not ASCII `+--+`. About 84% of existing projects use Unicode; the remainder are legacy. Don't put `localhost:3001` in the main architecture diagram — local port mappings belong in the README or Implementation Notes.

**Requirements**: Write non-functional requirements at production scale. This demonstrates system design knowledge. Local-scale numbers (10 concurrent users, <1 RPS) belong in Capacity Estimation under a "Local Development Scale" subsection.

**Code in architecture docs**: Use code blocks to illustrate design patterns and algorithms (idempotency flow, ranking algorithm, caching strategy, ledger entries). Full SQL schemas are appropriate. For implementation patterns (circuit breakers, metrics, structured logging), show the pattern with a brief code snippet and reference the actual file path — don't duplicate large blocks from source code.

**Trade-offs summary table**: Use a consistent 4-column format. Keep entries to one line each. Detailed reasoning belongs in the Key Design Decisions section above it.

```
| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Analytics queue | RabbitMQ | Kafka | Easier setup, sufficient for scale |
```

**Implementation Notes** (final section): This is where the production-to-local mapping lives. Document three things:
1. **Production-grade patterns actually implemented** — idempotency, circuit breakers (Opossum), Prometheus metrics (prom-client), structured logging (Pino), health checks, rate limiting. Explain *why* each pattern matters at scale, show a brief code snippet, and reference the file path in `src/shared/`.
2. **What was simplified or substituted** — MinIO for S3, simulated data for real feeds, single PostgreSQL for sharded cluster, session auth for OAuth/JWT.
3. **What was omitted** — CDN, multi-region, Kubernetes, sharding, ML pipelines.

**Boundary with project AGENTS.md**: `architecture.md` describes *what* the system is and *why* each design choice was made. The project's `AGENTS.md` captures *iteration history* — development phases, what was tried, what changed, open questions, and learnings. Don't duplicate design decisions across both files.

### Writing System Design Answers

The `system-design-answer-{frontend,backend,fullstack}.md` files simulate a realistic 45–60 minute system design interview. Each file should read as if you are explaining the system out loud — architectural thinking, trade-off reasoning, and decision justification. Not a reference document.

**Target length**: 350–550 lines. A person needs to be able to walk through the entire answer in ~40–50 minutes. Files over 600 lines are too long to cover. Files under 300 are too shallow.

**Three variants**, each with a different emphasis:
- **`-frontend`**: UI architecture, state management, rendering strategy, client-server interaction, offline/optimistic patterns. Lighter on backend infrastructure.
- **`-backend`**: Service architecture, data model (described as prose/tables, NOT SQL DDL), API design, scaling, failure handling. Lighter on UI.
- **`-fullstack`**: Balanced coverage of both, less depth in each. Best for generalist interviews.

#### Absolutely No Code

This is the most frequently violated rule.

**Do NOT include:**
- Language-tagged code blocks (` ```typescript `, ` ```sql `, ` ```javascript `, ` ```json `, ` ```tsx `, etc.)
- `CREATE TABLE` statements — describe schemas as prose tables instead
- Class/function implementations — describe algorithms as numbered steps or prose
- Config snippets (nginx, YAML, Prometheus queries)
- Directory tree structures

**What to use instead:**

Instead of a SQL schema:
```
| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), email (unique), password_hash | email | Partitioned by region at scale |
| orders | id, user_id (FK), status, total_cents | (user_id, created_at) | Status: pending → confirmed → shipped |
```

Instead of a TypeScript implementation:
> "The matching algorithm scores each candidate driver by combining inverse ETA (weighted 0.6) with driver rating (weighted 0.4). We query all available drivers within a 5km radius using Redis GEORADIUS, score them, and offer the ride to the top candidate with a 15-second acceptance timeout. If declined, we move to the next candidate."

Instead of an API implementation:
```
POST /api/v1/rides/request    → Creates ride, triggers matching
GET  /api/v1/rides/:id        → Returns ride status + driver location
POST /api/v1/rides/:id/cancel → Cancels if status is 'requested' or 'matched'
```

**DO include:**
- ASCII box diagrams using Unicode: `┌ ─ ┐ │ └ ┘ ├ ┤ ┴ ┬ ┼ ──▶`
- Trade-off tables with ✅ Chosen / ❌ Alternative format
- Emoji section headers (## 🏗️ Architecture, ## 💾 Data Model)
- Quoted first-person rationale explaining decisions
- High-level component interactions and data flow
- API endpoint tables (method, path, purpose — no request/response JSON bodies)
- Deep dives (2–3 per answer) on the hardest problems with trade-off analysis
- Scalability discussion: what breaks first, how to scale it

**Unlabeled code blocks** (bare ` ``` `) are acceptable ONLY for ASCII diagrams and API endpoint listings. Never for actual code.

**Example trade-off table:**
```
| Approach | Pros | Cons |
|----------|------|------|
| ✅ WebSocket | Real-time, bidirectional | Connection overhead |
| ❌ Polling | Simple | Latency, server load |
```

**Example ASCII diagram:**
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│   API GW    │────▶│   Service   │
└─────────────┘     └─────────────┘     └─────────────┘
```

The goal is demonstrating architectural judgment, not proving you can write code.

### Explaining Trade-offs in Depth

Every system design answer must include **2-3 deep trade-off discussions**. Shallow "X is faster, Y is slower" comparisons don't demonstrate understanding. Each trade-off should explain *why* one approach works for this specific problem while another fails.

**Structure for each trade-off:**

1. **State the decision clearly** - What choice did you make?
2. **Explain why the chosen approach works** - Connect to specific requirements
3. **Explain why the alternative fails** - Not just "worse" but *how* it breaks
4. **Acknowledge what you're giving up** - Every choice has costs

**Bad trade-off explanation (too shallow):**
> "We chose WebSockets over polling because WebSockets are faster and more efficient."

**Good trade-off explanation (demonstrates judgment):**
> "We chose WebSockets over HTTP polling because our chat application requires sub-100ms message delivery. Polling at 1-second intervals means average latency of 500ms—users perceive this as laggy and lose trust in message ordering. Polling at 100ms intervals would create 600 requests/minute per user, overwhelming our API servers at 100K concurrent users. WebSockets maintain a single persistent connection, enabling instant message push with minimal overhead. The trade-off is connection management complexity—we now need heartbeat mechanisms to detect stale connections and graceful reconnection logic when users switch networks. For a messaging product where perceived responsiveness directly impacts retention, this operational complexity is justified."

**Trade-off categories to address:**

| Category | Example Questions |
|----------|-------------------|
| **Consistency vs Availability** | What happens during network partitions? Can we show stale data? |
| **Latency vs Throughput** | Do we optimize for individual request speed or batch efficiency? |
| **Complexity vs Correctness** | Is eventual consistency acceptable, or do we need distributed transactions? |
| **Cost vs Performance** | Can we cache aggressively, or is real-time accuracy critical? |
| **Developer Experience vs Runtime Efficiency** | SQL vs NoSQL for this access pattern? |

**Example trade-off for an e-commerce inventory system:**

> "We chose optimistic locking with version numbers over pessimistic row locks for inventory updates. With 10,000 concurrent flash sale buyers, pessimistic locks would serialize access to a single row—creating a bottleneck where buyers queue for seconds watching 'Processing' spinners. Optimistic locking lets all 10,000 `SELECT` queries proceed in parallel, and only fails at `UPDATE` time when the version has changed. The retry cost (re-reading and re-attempting) is lower than the waiting cost of locking, and failed retries can immediately show 'Sold Out' rather than hanging. The trade-off: we must handle retry storms. If 1,000 buyers retry simultaneously, we could overwhelm the database. We mitigate this with exponential backoff and a reservation queue that guarantees ordering—but this adds 200 lines of coordination code that wouldn't exist with simple locks."

**Common mistakes:**

1. **Listing features instead of trade-offs** - "Redis is fast, supports pub/sub, and has TTL" isn't a trade-off analysis
2. **Missing the 'why it fails' half** - Saying "we chose X" without explaining what's wrong with Y
3. **Generic statements** - "This doesn't scale" without explaining the specific bottleneck
4. **Ignoring operational costs** - Every distributed system has monitoring, debugging, and deployment overhead

**Where to place trade-off discussions:**

- **🔧 Deep Dive sections** - 1 major trade-off per deep dive topic
- **⚖️ Trade-offs Summary table** - Brief version, linking to detailed discussion above
- **Inline with architecture decisions** - When introducing a component, explain why not the alternative

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

# Project health checks (triage)
npm run triage instagram           # Triage a specific project (Docker, migrate, seed, test)
npm run triage:all                  # Triage all projects
npm run triage:report               # Generate triage report

# ESLint/Prettier maintenance (batch operations across projects)
node scripts/add-eslint-configs.mjs # Add ESLint configs to all backends
node scripts/add-eslint-deps.mjs    # Add ESLint/Prettier dependencies to all backends
node scripts/add-eslint-prettier.mjs # Add ESLint + Prettier setup to projects
node scripts/update-eslint-configs.mjs # Update existing ESLint configs across projects
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

## CI/CD

There is intentionally **no CI build/test workflow**. A previous GitHub Actions
workflow ran Playwright smoke tests on every PR, but smoke tests require the full
Docker stack (PostgreSQL, Redis, etc.) running — which the CI runner did not
provide — and `npm ci` breaks whenever a project's `package-lock.json` drifts
from its `package.json`. The result was a workflow that failed on essentially
every PR without signalling a real defect.

Verification is done locally instead:

- **Build/typecheck**: `npm run build` / `npm run type-check` in each `frontend`/`backend`
- **Runtime**: `npm run triage <project>` or `node scripts/screenshots.mjs --start <project>`
  bring up Docker, migrate, seed, and exercise the app end to end (login + page render)
- **Smoke tests**: `npm run test:smoke <project>` after the stack is up

If CI is reintroduced later, keep it to what a runner can actually do without
Docker services — a per-project `tsc --noEmit` and `vite build` matrix — rather
than full integration smoke tests.

## Technology Stack Defaults

Use these unless there's a compelling reason to deviate (document justification in the project's AGENTS.md):

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
4. **Justify deviations** - Document why in the project's `AGENTS.md` if straying from defaults

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


## Screenshot harness seeding race (2026-07-14)

Root cause of "login shows Invalid credentials / page shows Log in" on large-schema projects (airbnb was the reported case, but it affected any project whose schema loads via the docker-entrypoint-initdb.d mount): Postgres accepts local-socket connections *while* initdb.d scripts are still creating tables, so `pg_isready` returns ready too early. The harness seeded before the `users` table existed; because `psql` without `ON_ERROR_STOP` exits 0 on SQL errors, the failed INSERT was silent and reported as "Database seeded" — leaving zero users, so login failed.

Fixed in `scripts/screenshots.mjs`: for projects without a `db:migrate` step, wait until `information_schema.tables` in the public schema is non-empty before seeding; run the seed with `-v ON_ERROR_STOP=1`; raise retries to 5 with 2s backoff. Verified airbnb messages now render the seeded Carol Davis conversation.
