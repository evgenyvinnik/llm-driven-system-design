# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A crowdsourced data labeling platform where users draw shapes through a game interface, administrators manage datasets and training, and implementors test trained models for inference. Three microservices power the backend: Collection (port 3001), Admin (port 3002), and Inference (port 3003).

## Common Commands

### Backend

```bash
cd backend
npm install
npm run db:seed-admin          # Seed admin user (admin@scaleai.local / admin123)
npm run dev                    # Run all services (collection, admin, inference)
npm run dev:collection         # Collection service only (port 3001)
npm run dev:admin              # Admin service only (port 3002)
npm run dev:inference          # Inference service only (port 3003)
npm run test                   # Run tests once
npm run test:watch             # Run tests in watch mode
npm run test -- src/collection/app.test.ts  # Run single test file
npm run lint                   # ESLint
npm run format                 # Prettier
```

### Frontend

```bash
cd frontend
npm install
npm run dev                    # Start dev server (port 5173)
npm run build                  # Build (runs tsc first)
npm run lint                   # ESLint
npm run type-check             # TypeScript check (tsc --noEmit)
```

### Infrastructure

```bash
docker-compose up -d           # Start PostgreSQL, Redis, MinIO, RabbitMQ
docker-compose down            # Stop services
docker-compose down -v         # Stop and remove volumes
```

### Training Worker (Python)

```bash
cd training
pip install -r requirements.txt
python worker.py               # Consumes jobs from RabbitMQ
```

## Architecture

### Backend Microservices

Three Express services under `backend/src/`:

- **collection/** - Drawing submission API for end users. Saves stroke data to MinIO, metadata to PostgreSQL.
- **admin/** - Dashboard API with session-based auth. Manages drawings, triggers training jobs via RabbitMQ.
- **inference/** - Model loading and classification API for implementors.

### Shared Modules

All services import from `backend/src/shared/`:

| Module | Purpose |
|--------|---------|
| `db.ts` | PostgreSQL pool + `withTransaction()` helper |
| `cache.ts` | Redis client + cache helpers with key patterns |
| `storage.ts` | MinIO client for object storage |
| `queue.ts` | RabbitMQ connection for training jobs |
| `auth.ts` | Session middleware for admin routes |
| `circuitBreaker.ts` | Resilience patterns for external services |
| `retry.ts` | Retry with exponential backoff |
| `metrics.ts` | Prometheus metrics collection |
| `healthCheck.ts` | Liveness/readiness endpoints |

### Database

Schema in `backend/src/db/init.sql`. Key tables: `users`, `shapes`, `drawings`, `admin_users`, `training_jobs`, `models`.

### Frontend Routes

Hash-based routing in `frontend/src/App.tsx`:
- `/` - Drawing game (PostItCanvas component)
- `#admin` - Admin dashboard (login required)
- `#implement` - Model tester portal

## Key Conventions

### ESM Imports

Backend uses ES modules. Always use `.js` extension in TypeScript imports:
```typescript
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
```

### Testing Pattern

Tests mock shared modules before importing the app:
```typescript
vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn() },
}))
vi.mock('../shared/storage.js', () => ({
  uploadDrawing: vi.fn().mockResolvedValue('path/to/file'),
}))

import { app } from './app.js'
```

### Drawing Data Format

Drawings stored as JSON stroke data (not images) in MinIO:
```json
{
  "shape": "circle",
  "canvas": { "width": 400, "height": 400 },
  "strokes": [{ "points": [...], "color": "#000000", "width": 3 }],
  "duration_ms": 2500,
  "device": "mouse"
}
```

## Environment Variables

Defaults work for local development with Docker Compose:

```
DB_HOST=localhost DB_PORT=5432 DB_NAME=scaleai DB_USER=scaleai DB_PASSWORD=scaleai123
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost MINIO_PORT=9000 MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=minioadmin
RABBITMQ_URL=amqp://scaleai:scaleai123@localhost:5672
```

## Design Decisions

- **Stroke data over images**: Preserves temporal/pressure info, converts to images at training time
- **Batch submission**: REST on completion rather than WebSocket streaming for simplicity
- **PyTorch for training**: Worker processes jobs from RabbitMQ, saves models to MinIO
- **Session-based admin auth**: Redis-backed sessions, avoids JWT complexity

## Iteration & Repair Log

- **2026-08-07 — the platform demonstrated nothing, though everything was built.** Implementation was verified against this file and matches it: three services start together via `concurrently` (collection/admin/inference), stroke data really does go to MinIO, and `training/worker.py` exists as documented. The problem was entirely that nothing had ever been submitted:
  1. **The seed created shapes and an admin user and nothing else** — no drawings. The game read "0 total", the admin dashboard had no data to label, filter or flag, and there were no training jobs. Added `db/seed-drawings.ts` (chained into `db:seed`), which generates real stroke geometry per shape, uploads it to MinIO through the project's own `uploadDrawing`, and inserts the matching rows. A drawing is *two* things — a Postgres row and a JSON object at `stroke_data_path` — so a SQL fixture can only ever write half of one, and the half it writes fails the moment an admin opens it.
  2. The corpus is deliberately **imbalanced** (line 14, heart 6) with a few low-quality flagged samples, because a uniformly clean, evenly distributed dataset is exactly what a labeling platform's dashboard exists to detect the absence of.
  3. **The screenshot config had `auth: false`**, so `#admin` only ever captured the login form and the dashboard behind it was never seen. Enabled admin auth (`admin@scaleai.local` / `admin123`); the login inputs gained `name`/`autoComplete` attributes, which they lacked.
- **Screenshots:** 3 (one of which was a login form) → 5, including the Drawings tab rendering actual hand-drawn strokes fetched from MinIO — which is what proves the object-storage half of the pipeline works, not just the metadata rows.
- **Known and honest:** "Active Model: None". No model exists locally because producing one means running the PyTorch worker against RabbitMQ; the completed training job is seeded, its output artifact is not. The Test Model page therefore has nothing to infer with.
