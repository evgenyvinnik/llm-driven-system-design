# Design GitHub - Code Hosting Platform

## Overview

A simplified GitHub-like platform demonstrating Git hosting, pull request workflows, code search, and collaborative development features. This educational project focuses on building a collaborative code hosting system with version control features.

## Key Features

### 1. Repository Management
- Create and manage repositories
- Public and private visibility
- Branch management
- Collaborator permissions

### 2. Git Operations
- Push/pull/clone support
- Branch management
- Commit history visualization
- Diff viewing

### 3. Pull Requests
- Create PRs from branches
- Code review with comments
- Merge strategies (merge, squash, rebase)
- Review workflow

### 4. Issues & Discussions
- Create and manage issues
- Labels and assignees
- Discussions with threaded comments
- Upvoting and marking answers

### 5. Code Search
- Full-text code search via Elasticsearch
- Symbol search (functions, classes)
- Cross-repository search
- Language-aware indexing

### 6. User Profiles & Organizations
- User profiles with bio and stats
- Organization management
- Team memberships

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Cache/Sessions:** Redis
- **Search:** Elasticsearch
- **Git:** simple-git library for Git operations

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- Git

### 1. Start Infrastructure

```bash
cd github
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- Elasticsearch on port 9200

### 2. Install Dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 3. Start Development Servers

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

- Backend runs on http://localhost:3000
- Frontend runs on http://localhost:5173

### 4. Seed Demo Data (Optional)

```bash
cd backend
npm run db:seed
```

This creates demo users:
- `johndoe` / `password123`
- `janedoe` / `password123`
- `admin` / `password123` (admin user)

## Project Structure

```
github/
├── docker-compose.yml      # PostgreSQL, Redis, Elasticsearch
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js        # Express server entry point
│       ├── db/
│       │   ├── index.js    # PostgreSQL connection
│       │   ├── redis.js    # Redis connection
│       │   ├── elasticsearch.js  # ES connection
│       │   ├── init.sql    # Database schema
│       │   └── seed.js     # Demo data seeder
│       ├── middleware/
│       │   └── auth.js     # Session-based authentication
│       ├── routes/
│       │   ├── repos.js    # Repository endpoints
│       │   ├── pulls.js    # Pull request endpoints
│       │   ├── issues.js   # Issues endpoints
│       │   ├── discussions.js  # Discussions endpoints
│       │   ├── users.js    # User/org endpoints
│       │   └── search.js   # Search endpoints
│       └── services/
│           ├── git.js      # Git operations
│           └── search.js   # Elasticsearch operations
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── src/
│       ├── main.tsx        # React entry point
│       ├── index.css       # Global styles
│       ├── components/     # Reusable UI components
│       ├── routes/         # Tanstack Router routes
│       ├── stores/         # Zustand stores
│       ├── services/       # API client
│       └── types/          # TypeScript definitions
└── repositories/           # Git bare repositories (created at runtime)
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Repositories
- `GET /api/repos` - List repositories
- `POST /api/repos` - Create repository
- `GET /api/repos/:owner/:repo` - Get repository
- `DELETE /api/repos/:owner/:repo` - Delete repository
- `GET /api/repos/:owner/:repo/tree/:ref` - Get file tree
- `GET /api/repos/:owner/:repo/blob/:ref/:path` - Get file content
- `GET /api/repos/:owner/:repo/commits` - Get commits
- `GET /api/repos/:owner/:repo/branches` - Get branches

### Pull Requests
- `GET /api/:owner/:repo/pulls` - List PRs
- `POST /api/:owner/:repo/pulls` - Create PR
- `GET /api/:owner/:repo/pulls/:number` - Get PR
- `GET /api/:owner/:repo/pulls/:number/diff` - Get PR diff
- `POST /api/:owner/:repo/pulls/:number/merge` - Merge PR
- `POST /api/:owner/:repo/pulls/:number/reviews` - Add review

### Issues
- `GET /api/:owner/:repo/issues` - List issues
- `POST /api/:owner/:repo/issues` - Create issue
- `GET /api/:owner/:repo/issues/:number` - Get issue
- `PATCH /api/:owner/:repo/issues/:number` - Update issue
- `POST /api/:owner/:repo/issues/:number/comments` - Add comment

### Search
- `GET /api/search` - Search repos, issues, users
- `GET /api/search/code` - Search code
- `GET /api/search/symbols` - Search symbols

### Users
- `GET /api/users/:username` - Get user profile
- `GET /api/users/:username/repos` - Get user repos
- `GET /api/users/:username/starred` - Get starred repos

## Running Multiple Backend Instances

For load balancing testing:

```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## Implementation Status

- [x] Repository creation and storage
- [x] Git operations (init, tree, blob, commits)
- [x] Pull request workflow
- [x] Code review system
- [x] Issues and comments
- [x] Discussions
- [x] Code search with Elasticsearch
- [x] User profiles and organizations
- [x] Session-based authentication
- [ ] Branch protection rules
- [ ] CI/CD runner
- [ ] Webhooks delivery

## Key Technical Challenges

1. **Git Storage**: Using bare repositories with simple-git library
2. **Code Search**: Elasticsearch with language-aware tokenization
3. **Diff Computation**: Using git diff between branches
4. **Session Management**: Redis-backed sessions
5. **File Tree**: Lazy loading with efficient tree traversal

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
