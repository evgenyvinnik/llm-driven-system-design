# Pinterest - Image Pinning Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 7,487 |
| Source Files | 73 |
| .ts | 3,547 |
| .tsx | 1,609 |
| .md | 1,532 |
| .sql | 293 |
| .json | 162 |


## Setup

### Prerequisites
- Node.js >= 20.0.0
- Docker and Docker Compose (for infrastructure services)

### Infrastructure

#### Option A: Docker Compose (Recommended)
```bash
docker-compose up -d
```

This starts:
- **PostgreSQL 16** on port 5432 (user: pinterest, password: pinterest123, database: pinterest)
- **Valkey 7** (Redis-compatible) on port 6379
- **RabbitMQ 3** on ports 5672 (AMQP) and 15672 (Management UI)
- **MinIO** on ports 9000 (API) and 9001 (Console) with `pinterest-images` bucket auto-created

#### Option B: Native Installation (No Docker)
```bash
# PostgreSQL
brew install postgresql@16
brew services start postgresql@16
createdb pinterest
psql pinterest -c "CREATE USER pinterest WITH PASSWORD 'pinterest123';"
psql pinterest -c "GRANT ALL PRIVILEGES ON DATABASE pinterest TO pinterest;"

# Valkey/Redis
brew install valkey
brew services start valkey

# RabbitMQ
brew install rabbitmq
brew services start rabbitmq

# MinIO
brew install minio
minio server ~/minio-data --console-address ":9001"
# Then create bucket: mc alias set local http://localhost:9000 minioadmin minioadmin && mc mb local/pinterest-images
```

### Backend

```bash
cd backend
npm install
npm run db:migrate

# Optional: seed demo data
PGPASSWORD=pinterest123 psql -h localhost -U pinterest -d pinterest -f db-seed/seed.sql

# Start API server
npm run dev

# Start image processing worker (separate terminal)
npm run dev:worker
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Visit http://localhost:5173 to access the application.

### Demo Credentials
After seeding:
- **alice** / password123
- **bob** / password123

## Architecture

See [architecture.md](./architecture.md) for the full system design document.

## Available Scripts

### Backend
| Command | Description |
|---------|-------------|
| `npm run dev` | Start API server with hot reload (port 3001) |
| `npm run dev:worker` | Start image processing worker |
| `npm run dev:server1` | Start on port 3001 |
| `npm run dev:server2` | Start on port 3002 |
| `npm run dev:server3` | Start on port 3003 |
| `npm run db:migrate` | Run database migrations |
| `npm run test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run format` | Run Prettier |

### Frontend
| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (port 5173) |
| `npm run build` | Build for production |
| `npm run lint` | Run ESLint |
| `npm run format` | Run Prettier |

## Environment Variables

```bash
# Backend defaults (no .env file needed for local dev)
DATABASE_URL=postgresql://pinterest:pinterest123@localhost:5432/pinterest
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://pinterest:pinterest123@localhost:5672
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=pinterest-images
SESSION_SECRET=pinterest-dev-secret-change-in-production
```

## Key Features
- Masonry grid layout with variable-height virtualization
- Image upload with async processing (thumbnails, aspect ratio, dominant color)
- Save-based engagement model (boards and saves, not likes)
- Personalized feed from followed users + popular pins
- Full-text search for pins, users, and boards
- Session-based authentication with Redis/Valkey
