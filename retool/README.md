# Retool - No-Code Internal Tool Builder

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,954 |
| Source Files | 84 |
| .ts | 2,618 |
| .tsx | 2,318 |
| .md | 1,435 |
| .sql | 196 |
| .json | 163 |


## Overview

A simplified Retool clone that lets users visually build internal tools by dragging components onto a canvas, connecting to databases, writing queries, and binding data to UI widgets. This project demonstrates a **meta-problem** in system design: building a tool that builds tools.

## Prerequisites

- Node.js >= 20.0.0
- Docker Desktop (for PostgreSQL, Redis/Valkey, and sample database)

## Quick Start

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL (retool metadata DB) on port 5432
- Redis/Valkey (session store) on port 6379
- Target PostgreSQL (sample e-commerce DB) on port 5433

### 2. Backend Setup

```bash
cd backend
npm install
npm run db:migrate
npm run dev
```

Backend starts on http://localhost:3001

### 3. Seed Data (Optional)

```bash
PGPASSWORD=retool123 psql -h localhost -U retool -d retool -f backend/db-seed/seed.sql
```

Creates demo users (alice/password123, bob/password123), a sample data source, and a Customer Dashboard app.

### 4. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend starts on http://localhost:5173

### 5. Try It Out

1. Open http://localhost:5173
2. Login with `alice` / `password123`
3. Click on "Customer Dashboard" to open the editor
4. In the Query Panel (bottom), select the data source and run the query
5. The Table widget displays data from the sample e-commerce database
6. Drag new components from the left palette onto the canvas
7. Configure component properties in the right panel

## Architecture

Three-pane editor layout:
- **Left**: Component palette (drag to canvas)
- **Center**: Canvas with 12-column grid layout
- **Right**: Property inspector for selected component
- **Bottom**: Query panel with SQL editor and results viewer

Two-database architecture:
- **Retool DB** (port 5432): Stores users, apps, components, queries, data source configs
- **Target DB** (port 5433): Sample e-commerce data that user-built apps query against

## Available Scripts

### Backend

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (port 3001) |
| `npm run dev:server1` | Start on port 3001 |
| `npm run dev:server2` | Start on port 3002 |
| `npm run dev:server3` | Start on port 3003 |
| `npm run build` | Compile TypeScript |
| `npm run test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:migrate` | Run database migrations |

### Frontend

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server (port 5173) |
| `npm run build` | Build for production |
| `npm run type-check` | TypeScript check |

## Native Installation (No Docker)

### PostgreSQL

```bash
brew install postgresql@16
brew services start postgresql@16
createuser retool --createdb
createdb retool --owner=retool
psql -d retool -c "ALTER USER retool PASSWORD 'retool123';"

createuser sample --createdb
createdb sample_db --owner=sample
psql -d sample_db -c "ALTER USER sample PASSWORD 'sample123';"
```

### Redis/Valkey

```bash
brew install valkey
brew services start valkey
```

## Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://retool:retool123@localhost:5432/retool
REDIS_URL=redis://localhost:6379
SESSION_SECRET=retool-dev-secret-change-in-production
PORT=3001

# Target DB (configured as data source through UI)
# Host: localhost, Port: 5433, DB: sample_db, User: sample, Password: sample123
```

## Component Types

| Component | Description |
|-----------|-------------|
| Table | Data table with pagination and search |
| Text Input | Single-line text input |
| Number Input | Numeric input with min/max |
| Button | Action trigger (runs a query) |
| Text | Display text with binding support |
| Select | Dropdown select input |
| Chart | Bar or line chart |
| Form | Form container with submit action |
| Container | Layout grouping container |

## Key Features

- **Drag-and-drop editor** with 12-column grid canvas
- **Live query execution** against connected PostgreSQL databases
- **Binding engine** for `{{ expression }}` data binding
- **Component library** with 9 widget types
- **App versioning** with publish/preview workflow
- **Session-based auth** with Redis session store
- **Prometheus metrics** at `/metrics`
