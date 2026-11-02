# Salesforce CRM

A customer relationship management system modeled after Salesforce, featuring accounts, contacts, opportunities pipeline (kanban), leads with conversion, activities, and reporting dashboards.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 8,150 |
| Source Files | 89 |
| .ts | 3,732 |
| .tsx | 2,225 |
| .md | 1,580 |
| .sql | 263 |
| .json | 173 |


## Features

- **Dashboard** - KPI cards (revenue, pipeline, deals, leads) and pipeline bar chart
- **Accounts** - Company management with contacts, opportunities, and activities tabs
- **Contacts** - People associated with accounts
- **Opportunities Pipeline** - Kanban board with drag-drop stage transitions
- **Leads** - Lead capture with conversion workflow (lead -> account + contact + opportunity)
- **Activities** - Log calls, emails, meetings, and notes against any entity
- **Reports** - Pipeline by stage, revenue by month, leads by source (org-wide for admins, own records for reps)
- **Record-level access** - Reps see and change only the records they own; admins see everything

## Tech Stack

- **Frontend:** TypeScript, React 19, Vite, TanStack Router, Zustand, Tailwind CSS, @dnd-kit
- **Backend:** Node.js, Express, PostgreSQL, Redis (Valkey), Pino, prom-client
- **Infrastructure:** Docker Compose

## Quick Start

### Prerequisites
- Node.js >= 20
- Docker Desktop (for PostgreSQL and Redis)

### Setup

#### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure
docker-compose up -d

# Install backend dependencies, run migrations, load demo data
cd backend
npm install
npm run db:migrate
cat db-seed/seed.sql | docker-compose exec -T postgres psql -U salesforce -d salesforce

# Start backend (port 3001)
npm run dev
```

In a separate terminal:

```bash
# Install frontend dependencies and start dev server
cd frontend
npm install
npm run dev
```

#### Option B: Native Installation (No Docker)

**PostgreSQL:**
```bash
brew install postgresql@16
brew services start postgresql@16
createuser -s salesforce
createdb -O salesforce salesforce
psql -d salesforce -c "ALTER USER salesforce WITH PASSWORD 'salesforce123';"
```

**Redis/Valkey:**
```bash
brew install valkey
brew services start valkey
```

Then install dependencies and run migrations as in Option A, and load the demo data with `psql -d salesforce -f backend/db-seed/seed.sql`.

### Access

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001/api |
| Health Check | http://localhost:3001/api/health |
| Metrics | http://localhost:3001/metrics |

### Demo Usage

1. Open http://localhost:5173
2. Sign in as `alice` / `password123` (admin, sees every record) or `bob` / `password123` (sales rep, sees only his own records), or register a new rep
3. Create accounts and contacts, open an account for its contacts / opportunities / activities tabs
4. Create opportunities from the pipeline board and drag them through stages (a rep can't reopen a closed deal; an admin can)
5. Create leads and convert them to accounts + contacts + opportunities
6. Log activities against any entity
7. View reports for pipeline, revenue, and lead analytics

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Backend server port |
| DATABASE_URL | postgresql://salesforce:salesforce123@localhost:5432/salesforce | PostgreSQL connection |
| REDIS_URL | redis://localhost:6379 | Redis/Valkey connection |
| SESSION_SECRET | salesforce-dev-secret-change-in-production | Session encryption key |
| CORS_ORIGIN | http://localhost:5173 | Allowed frontend origin |

## Available Scripts

### Backend

```bash
npm run dev              # Start with hot reload (port 3001)
npm run dev:server1      # Start on port 3001
npm run dev:server2      # Start on port 3002
npm run dev:server3      # Start on port 3003
npm run build            # Compile TypeScript
npm run test             # Run tests
npm run db:migrate       # Run database migrations
npm run lint             # Run ESLint
npm run format           # Run Prettier
```

### Frontend

```bash
npm run dev              # Start Vite dev server
npm run build            # Build for production
npm run lint             # Run ESLint
npm run format           # Run Prettier
npm run type-check       # TypeScript type checking
```

## Project Structure

```
salesforce/
├── architecture.md                    # System design documentation
├── system-design-answer-backend.md    # Backend interview answer
├── system-design-answer-frontend.md   # Frontend interview answer
├── system-design-answer-fullstack.md  # Full-stack interview answer
├── CLAUDE.md                          # Development notes
├── docker-compose.yml                 # PostgreSQL + Valkey
├── backend/
│   ├── src/
│   │   ├── config/index.ts            # App configuration
│   │   ├── db/
│   │   │   ├── init.sql               # Database schema (8 tables)
│   │   │   └── migrate.ts             # Migration runner
│   │   ├── middleware/auth.ts          # requireAuth, requireAdmin
│   │   ├── app.test.ts                 # Route tests (supertest, in-memory sessions)
│   │   ├── routes/
│   │   │   ├── auth.ts                # Register, login, logout
│   │   │   ├── dashboard.ts           # Aggregated KPIs
│   │   │   ├── accounts.ts            # CRUD + related entities
│   │   │   ├── contacts.ts            # CRUD with account association
│   │   │   ├── opportunities.ts       # CRUD + kanban stage update
│   │   │   ├── leads.ts               # CRUD + conversion
│   │   │   ├── activities.ts          # CRUD with polymorphic association
│   │   │   └── reports.ts             # Pipeline, revenue, leads
│   │   ├── services/
│   │   │   ├── accessPolicy.ts        # Record-level access (owner or admin, 404s)
│   │   │   ├── opportunityStages.ts   # Stage state machine + probability mapping
│   │   │   ├── queryParams.ts         # Pagination, search and money validation
│   │   │   ├── db.ts                  # PostgreSQL pool + int8/DATE type parsers
│   │   │   ├── redis.ts               # Redis client
│   │   │   ├── logger.ts              # Pino structured logging
│   │   │   ├── metrics.ts             # Prometheus metrics
│   │   │   ├── circuitBreaker.ts      # Opossum circuit breaker (not yet used)
│   │   │   ├── rateLimiter.ts         # express-rate-limit
│   │   │   ├── dashboardService.ts    # KPI aggregation queries
│   │   │   ├── leadConversionService.ts # Transactional lead conversion
│   │   │   └── reportService.ts       # Report query functions
│   ├── db-seed/seed.sql               # Demo users and CRM data
│   │   ├── app.ts                     # Express app setup
│   │   └── index.ts                   # Server entry point
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── Sidebar.tsx             # Navigation sidebar
    │   │   ├── DashboardMetrics.tsx    # KPI cards
    │   │   ├── PipelineChart.tsx       # Pipeline bar chart
    │   │   ├── KanbanBoard.tsx         # DndContext wrapper
    │   │   ├── KanbanColumn.tsx        # Droppable stage column
    │   │   ├── OpportunityCard.tsx     # Draggable deal card
    │   │   ├── AccountList.tsx         # Account data table
    │   │   ├── AccountDetail.tsx       # Account with tabs
    │   │   ├── ContactList.tsx         # Contact data table
    │   │   ├── LeadList.tsx            # Lead table with convert button
    │   │   ├── ActivityTimeline.tsx    # Chronological activity list
    │   │   ├── ActivityForm.tsx        # Create activity form
    │   │   ├── ReportChart.tsx         # Bar/line chart component
    │   │   ├── EntityForm.tsx          # Reusable create/edit modal
    │   │   ├── ConvertLeadModal.tsx    # Lead conversion modal
    │   │   └── StatusBadge.tsx         # Colored status badges
    │   ├── routes/
    │   │   ├── __root.tsx              # App shell with sidebar
    │   │   ├── index.tsx               # Dashboard
    │   │   ├── login.tsx               # Login page
    │   │   ├── register.tsx            # Registration page
    │   │   ├── accounts.index.tsx      # Account list
    │   │   ├── accounts.$accountId.tsx # Account detail
    │   │   ├── contacts.tsx            # Contact list
    │   │   ├── opportunities.tsx       # Kanban pipeline
    │   │   ├── leads.tsx               # Lead list
    │   │   └── reports.tsx             # Reports page
    │   ├── services/api.ts            # API client functions
    │   ├── stores/
    │   │   ├── authStore.ts           # Auth state (Zustand)
    │   │   └── crmStore.ts            # CRM data state (Zustand)
    │   ├── utils/dates.ts             # Calendar-date formatting
    │   ├── types.ts                   # TypeScript interfaces
    │   ├── index.css                  # Tailwind + custom styles
    │   └── main.tsx                   # App entry point
    ├── package.json
    └── tsconfig.json
```
