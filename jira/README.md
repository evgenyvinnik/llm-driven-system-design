# Design Jira - Issue Tracking System

A simplified Jira-like platform demonstrating issue tracking, workflow automation, permission systems, and reporting. This educational project focuses on building a project management system with customizable workflows.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 13,018 |
| Source Files | 88 |
| .ts | 7,788 |
| .tsx | 2,681 |
| .md | 1,566 |
| .sql | 565 |
| .json | 175 |

## Features

### Issue Management
- Create and edit issues with types (bug, story, task, epic, subtask)
- Custom fields support via JSONB storage
- Attachments and comments
- Complete audit trail of all changes

### Workflow Engine
- Customizable status transitions
- Workflow conditions and validators
- Post-function actions (auto-assign, notifications)
- Database-driven workflow configuration

### Project Organization
- Projects with unique keys (e.g., DEMO, PROJ)
- Sprints and backlogs
- Kanban boards
- Labels and components

### Search
- JQL-like query language
- Elasticsearch integration for fast search
- Quick search for issues

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL (primary data), Redis/Valkey (sessions/cache), Elasticsearch (search)
- **Messaging**: RabbitMQ (async search-indexing, notification, and webhook workers)

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for infrastructure services)

## Quick Start

### 1. Start Infrastructure Services

```bash
cd jira
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis (Valkey) on port 6379
- Elasticsearch on port 9200
- RabbitMQ on ports 5672 (AMQP) and 15672 (management UI)

### 2. Set Up Backend

```bash
cd backend
npm install

# Copy environment file
cp .env.example .env

# Run database migrations
npm run db:migrate

# Seed demo data
npm run seed

# Start development server
npm run dev
```

The backend runs on http://localhost:3000

### 3. Set Up Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on http://localhost:5173

### 4. Access the Application

Open http://localhost:5173 in your browser.

**Demo Credentials:**

`npm run seed` (`src/db/seed.ts`) creates:
- Admin: `admin@example.com` / `admin123` (system administrator)
- Users: `john@example.com`, `jane@example.com` / `password123` (Developers in DEMO)

`db-seed/seed.sql` (used by the screenshot tooling) creates the same admin plus `alice@`, `bob@` and `carol@example.com` / `password123`. Permission schemes are enforced, so roles matter: alice is a Developer in DEMO and INFRA, bob a Developer in DEMO and Administrator of INFRA, carol a Viewer in DEMO (read-only).

```bash
PGPASSWORD=jira_password psql -h localhost -U jira -d jira -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

### 5. Run the Tests

```bash
cd backend
npm test        # vitest: rank keys, JQL parser, permissions, transitions, edits, idempotency, RabbitMQ reconnects
```

## Project Structure

```
jira/
├── backend/
│   ├── src/
│   │   ├── config/         # Database, Redis, Elasticsearch config
│   │   ├── controllers/    # (Reserved for future use)
│   │   ├── db/             # Migrations and seeds
│   │   ├── middleware/     # Auth middleware
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   ├── types/          # TypeScript types
│   │   └── index.ts        # Server entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── routes/         # Tanstack Router routes
│   │   ├── services/       # API client
│   │   ├── stores/         # Zustand stores
│   │   ├── types/          # TypeScript types
│   │   └── main.tsx        # App entry point
│   └── package.json
├── docker-compose.yml
└── README.md
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout
- `POST /api/auth/register` - Create account
- `GET /api/auth/me` - Get current user

### Projects
- `GET /api/projects` - List all projects
- `GET /api/projects/:key` - Get project by key
- `GET /api/projects/:key/permissions` - Permissions the current user holds in the project
- `POST /api/projects` - Create project
- `GET /api/projects/:id/sprints` - List sprints
- `POST /api/projects/:id/sprints` - Create sprint
- `GET /api/projects/:id/boards` - List boards

### Issues
- `GET /api/issues/:key` - Get issue by key (`ETag` carries the issue version)
- `POST /api/issues` - Create issue (send `Idempotency-Key` to make retries safe)
- `PATCH /api/issues/:id` - Update fields (send `If-Match: "<version>"`; a stale version gets `412` with the current issue)
- `DELETE /api/issues/:id` - Delete issue
- `GET /api/issues/:id/transitions` - Transitions the current user may run
- `POST /api/issues/:id/transitions/:transitionId` - Execute transition (`403` condition, `409` issue moved, `422` validator with `field`)
- `PUT /api/issues/:id/rank` - Reorder: `{"afterId": 17}` or `{"beforeId": 17}`
- `GET /api/issues/:id/comments` - Get comments
- `POST /api/issues/:id/comments` - Add comment
- `GET /api/issues/:id/history` - Get change history

### Search
- `GET /api/search?jql=...` - Search with JQL
- `GET /api/search/quick?q=...` - Quick text search

### Workflows
- `GET /api/workflows` - List workflows
- `GET /api/workflows/:id` - Get workflow with statuses
- `GET /api/workflows/project/:projectId` - Get project workflow

## JQL Query Language

The system supports a JQL-like query language for searching issues:

```
# Find all bugs in DEMO project
project = DEMO AND type = bug

# Find issues assigned to current user
assignee = currentUser()

# Find high priority issues in progress
priority = high AND status = "In Progress"

# Combine conditions
project = DEMO AND (status = "To Do" OR status = "In Progress")

# Text, empty fields, relative dates, ordering
text ~ "login crash" AND assignee IS EMPTY AND created > -7d ORDER BY priority DESC
```

Supported operators: `=`, `!=`, `~` / `!~` (text match), `IN`, `NOT IN`, `IS [NOT] EMPTY`, `>`, `<`, `>=`, `<=`; `AND` binds tighter than `OR`; `NOT` and parentheses; functions `currentUser()`, `now()`, `startOfDay()`, `endOfDay()`, `startOfWeek()`, `endOfWeek()`. Syntax errors return `400` with a character position; searches only return issues from projects you may view, and answer `503` while Elasticsearch is unavailable.

## Running Multiple Backend Instances

For testing load balancing or distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Native Service Installation (Optional)

If you prefer not to use Docker:

### PostgreSQL
```bash
# macOS
brew install postgresql@16
brew services start postgresql@16
createdb jira
psql jira -c "CREATE USER jira WITH PASSWORD 'jira_password';"
psql jira -c "GRANT ALL PRIVILEGES ON DATABASE jira TO jira;"
```

### Redis
```bash
# macOS
brew install redis
brew services start redis
```

### Elasticsearch
```bash
# macOS
brew tap elastic/tap
brew install elastic/tap/elasticsearch-full
brew services start elasticsearch-full
```

### RabbitMQ
```bash
# macOS
brew install rabbitmq
brew services start rabbitmq
```

Update `.env` file with your local service URLs.

## Key Design Decisions

1. **JSONB for Custom Fields**: Flexible schema without table alterations
2. **Database-Driven Workflows**: Users can customize without code changes
3. **JQL to Elasticsearch**: Powerful user-facing query language
4. **Session-Based Auth**: Simple Redis-backed sessions
5. **Event History Table**: Complete audit trail of changes

See [architecture.md](./architecture.md) for detailed design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.

## References & Inspiration

- [Jira Cloud REST API Documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) - Official Atlassian API reference
- [Workflow Patterns](https://www.workflowpatterns.com/) - Academic research on workflow modeling patterns
- [Atlassian Engineering Blog](https://www.atlassian.com/engineering) - Engineering insights from Atlassian
- [Building Query Languages (ANTLR Tutorial)](https://tomassetti.me/antlr-mega-tutorial/) - Guide to building parsers like JQL
- [State Machines in Production](https://blog.pragmaticengineer.com/state-machines/) - Practical patterns for workflow engines
- [JSONB Performance in PostgreSQL](https://www.postgresql.org/docs/current/datatype-json.html) - PostgreSQL JSON documentation for custom fields
- [Elasticsearch: The Definitive Guide](https://www.elastic.co/guide/en/elasticsearch/guide/current/index.html) - Search engine fundamentals
- [Linear Method](https://linear.app/method) - Modern issue tracking design philosophy from Linear
- [The Art of Agile Development](https://www.jamesshore.com/v2/books/aoad2) - Understanding agile workflows
- [Event Sourcing Pattern](https://martinfowler.com/eaaDev/EventSourcing.html) - Martin Fowler on audit trails and history tracking
