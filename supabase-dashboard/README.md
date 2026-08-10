# Supabase Dashboard

A BaaS (Backend-as-a-Service) management dashboard inspired by Supabase Studio. Features dynamic schema introspection, an SQL editor, and auth user management, built on a two-database architecture where a metadata database tracks projects while dynamically connecting to target databases for introspection and query execution.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,524 |
| Source Files | 80 |
| .ts | 2,688 |
| .tsx | 1,893 |
| .md | 1,440 |
| .sql | 170 |
| .json | 160 |


## Features

- **Project Management** - Create and manage database projects with connection settings
- **Table Editor** - Browse and introspect table schemas from target databases via `information_schema`
- **Table Data Browser** - Spreadsheet-like row viewer with pagination, sorting, inline editing, and insert/delete
- **SQL Editor** - Execute arbitrary SQL against target databases, save and reuse queries
- **DDL Generator** - Create, alter, and drop tables through structured UI forms
- **Auth User Management** - Simulated Supabase authentication user CRUD
- **Connection Testing** - Verify target database connectivity with live status indicators

## Architecture

Two-database model separating concerns:

1. **Metadata DB** (port 5432) - Stores dashboard users, projects, saved queries, auth users
2. **Target DB** (port 5433) - Sample e-commerce database for introspection and querying

See [architecture.md](./architecture.md) for the full system design.

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- Docker Desktop (for PostgreSQL and Valkey)

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure (2x PostgreSQL + Valkey)
docker-compose up -d

# Install and run backend
cd backend
npm install
npm run db:migrate
npm run dev

# In another terminal, install and run frontend
cd frontend
npm install
npm run dev
```

### Option B: Native Installation

```bash
# PostgreSQL (metadata)
brew install postgresql@16
createuser supabase --createdb
createdb supabase_meta -O supabase
psql -c "ALTER USER supabase PASSWORD 'supabase123'"

# PostgreSQL (target - run on different port)
# Use initdb to create a second cluster on port 5433
initdb -D /usr/local/var/postgres-target
pg_ctl -D /usr/local/var/postgres-target -o "-p 5433" start
createuser -p 5433 sample --createdb
createdb -p 5433 sample_db -O sample
psql -p 5433 -c "ALTER USER sample PASSWORD 'sample123'"

# Valkey
brew install valkey
brew services start valkey

# Run migrations and seed
cd backend
npm install
npm run db:migrate
psql -h localhost -p 5433 -U sample -d sample_db -f src/db/sample-db-init.sql

# Start backend
npm run dev

# Start frontend (another terminal)
cd frontend
npm install
npm run dev
```

### Access

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001
- **Health Check**: http://localhost:3001/api/health
- **Metrics**: http://localhost:3001/metrics

### Default Credentials

Register a new account on first use. No default admin is seeded.

| Service | Username | Password | Database |
|---------|----------|----------|----------|
| Metadata PostgreSQL | supabase | supabase123 | supabase_meta |
| Target PostgreSQL | sample | sample123 | sample_db |
| Valkey/Redis | - | - | (no auth) |

## Development

```bash
# Backend
cd backend
npm run dev              # Start with hot reload
npm run db:migrate       # Run migrations
npm run test             # Run tests
npm run lint             # ESLint
npm run format           # Prettier

# Frontend
cd frontend
npm run dev              # Vite dev server
npm run build            # Production build
npm run type-check       # TypeScript check
npm run lint             # ESLint
npm run format           # Prettier
```

## Environment Variables

```bash
# Backend (.env)
DATABASE_URL=postgresql://supabase:supabase123@localhost:5432/supabase_meta
TARGET_DATABASE_URL=postgresql://sample:sample123@localhost:5433/sample_db
REDIS_URL=redis://localhost:6379
SESSION_SECRET=supabase-dev-secret-change-in-production
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

## Tech Stack

- **Frontend**: TypeScript, React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript
- **Databases**: PostgreSQL 16 (x2), Valkey (Redis-compatible)
- **Observability**: Prometheus (prom-client), Pino structured logging
- **Resilience**: Opossum circuit breakers, express-rate-limit
