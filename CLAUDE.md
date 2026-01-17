# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a **system design learning repository** where each subdirectory represents an independent system design challenge (Bitly, Discord, Uber, etc.). Each project folder contains design documentation (`architecture.md`, `claude.md`, `README.md`) and may eventually contain implementation code.

## Project Structure

```
llm-driven-system-design/
├── CLAUDE.md              # This file - Claude Code instructions
├── README.md              # Repository overview and project index
├── <project>/             # Each system design challenge
│   ├── README.md          # Setup instructions and implementation guide
│   ├── architecture.md    # System design documentation and trade-offs
│   └── claude.md          # LLM collaboration notes and iteration history
```

## Common Commands

When a project has implementation code:

```bash
# Frontend (Vite + React + TypeScript)
npm run dev              # Start dev server
npm run build            # Build for production
npm run lint             # Run ESLint
npm run format           # Run Prettier
npm run type-check       # TypeScript type checking

# Backend (Node.js + Express)
npm run dev              # Start with hot reload
npm run dev:server1      # Run on port 3001 (for distributed testing)
npm run dev:server2      # Run on port 3002
npm run dev:server3      # Run on port 3003

# Infrastructure
docker-compose up -d     # Start PostgreSQL, Redis/Valkey, etc.
```

## Technology Stack Defaults

Use these unless there's a compelling reason to deviate (document justification if deviating):

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Databases:** PostgreSQL (relational), CouchDB (document), Valkey/Redis (cache), Cassandra (wide-column)
- **Message Queues:** RabbitMQ, Kafka
- **Search:** Elasticsearch/OpenSearch
- **Monitoring:** Prometheus + Grafana

## Key Principles

1. **All projects must run locally** - Design for 2-5 service instances on different ports
2. **Keep auth simple** - Session-based auth with Redis, avoid OAuth complexity
3. **Both user personas** - Implement end-user AND admin interfaces when applicable
4. **Justify deviations** - If using Go instead of Node.js, explain why with benchmarks

## Frontend Project Setup

When creating a new frontend for a project:

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install zustand @tanstack/react-router
npm install -D @tanstack/router-vite-plugin tailwindcss postcss autoprefixer vite-plugin-pwa
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier
npx tailwindcss init -p
```

Standard frontend structure:
```
frontend/
├── src/
│   ├── components/      # Reusable UI components
│   ├── routes/          # Tanstack Router routes
│   ├── stores/          # Zustand stores
│   ├── services/        # API clients
│   ├── hooks/           # Custom React hooks
│   ├── types/           # TypeScript definitions
│   └── utils/           # Helper functions
```

## Authentication Pattern

Use simple session-based auth for learning projects:

```typescript
// Session stored in Redis/Valkey
// Cookie-based token exchange
// Role field in users table: 'user' | 'admin'
```

Avoid OAuth, JWT rotation, MFA for learning projects unless specifically studying those topics.

---

# Collaborating with Claude on System Design

This section provides guidelines for effectively using Claude to learn system design through hands-on implementation.

## Philosophy

LLMs are collaborators, not replacements for critical thinking. Use Claude to:
- Explore multiple architectural approaches quickly
- Generate boilerplate so you focus on design decisions
- Explain trade-offs and suggest alternatives
- Debug and optimize implementations

**You should remain the architect.**

## Effective Prompting Patterns

### Always Request Comparative Analysis
```
For this caching layer, compare: Valkey, Redis, in-memory Map, PostgreSQL with indexes.
For each: performance, memory efficiency, persistence, operational complexity, failure modes.
```

### Demand Justification for Every Decision
```
Why PostgreSQL over CouchDB here? What features are we leveraging?
At what scale would we reconsider this choice?
```

### Request Incremental Implementation
```
Let's implement in phases:
1. Simple in-memory version
2. Add database persistence
3. Add caching
4. Add analytics
```

### Insist on Implementation Details
```
Let's implement consistent hashing:
1. Explain with concrete example
2. Show actual hash function code
3. Implement ring data structure
4. Handle node addition/removal
5. Write tests proving even distribution
```

## Anti-Patterns to Avoid

- **Too vague:** "Design Twitter" → Better: "Design Twitter's timeline service, focusing on efficient feed fetching at scale"
- **Accepting without question:** Always ask "why this over alternatives?"
- **Asking for everything at once:** Start with core features, add complexity incrementally
- **Ignoring scalability:** Design for horizontal scaling from the start

## Project Workflow

### Phase 1: Requirements & Design
1. Clarify functional requirements
2. Estimate scale (users, requests, data)
3. Identify key challenges and user personas
4. Sketch high-level architecture
5. Choose technologies (justify deviations from defaults)

### Phase 2: Core Implementation
1. Implement authentication if needed
2. Build core end-user functionality
3. Add persistence layer
4. Write basic tests

### Phase 3: Admin Interface (if applicable)
1. Dashboard with system metrics
2. Admin-specific operations (moderation, config)
3. Role-based access control

### Phase 4: Scale & Optimize
1. Add caching layer
2. Implement load balancing
3. Add monitoring/logging
4. Load test and identify bottlenecks

## Design for Multiple Personas

Real systems serve multiple user types:

**End-User Interface:**
- Primary features (create, read, interact)
- Personalization, real-time updates
- Performance-critical (< 100ms)

**Admin Interface:**
- System health monitoring
- User/content moderation
- Configuration management
- Analytics and reporting

Route structure:
```
/                    → End-user interface
/admin               → Admin dashboard
/api/v1/urls         → Public API
/api/v1/admin/stats  → Admin API
```

## Local Development Philosophy

All projects should be executable locally with ability to simulate distributed systems:

```bash
# Run 3 API server instances
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# Load balancer
npm run dev:lb       # Port 3000

# Infrastructure via Docker
docker-compose up -d
```

Keep resource requirements reasonable (< 8GB RAM for most projects).

## Learning Reflection Questions

After each project:
1. What was the hardest design decision? Why?
2. What would break first under load? How to fix it?
3. What did you over-engineer? What could be simpler?
4. What did you under-engineer? What would cause production issues?
5. What would you do differently next time?
