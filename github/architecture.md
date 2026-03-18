# Design GitHub - Architecture

## System Overview

GitHub is a code hosting platform built on Git. Core challenges involve Git object storage, code search with symbol extraction, collaborative pull request workflows with multiple merge strategies, and reliable webhook delivery.

**Learning Goals:**
- Understand Git internals and storage (objects, pack files, refs)
- Build code search with Elasticsearch and symbol extraction
- Design PR workflows with merge, squash, and rebase strategies
- Implement reliable webhook delivery with retry semantics
- Model repository ownership (user vs. organization)

---

## Requirements

### Functional Requirements

1. **Repositories**: Create, delete, browse files, view commits, manage branches
2. **Pull Requests**: Create, review with inline comments, merge (merge/squash/rebase)
3. **Issues**: Create, assign, label, close, comment
4. **Code Search**: Full-text search across repositories with language filtering and symbol extraction
5. **Discussions**: Threaded conversations per repository with answers
6. **Webhooks**: Configure per-repository webhooks with delivery tracking
7. **Organizations**: Create organizations, manage members, org-owned repositories
8. **Stars & Forks**: Star repositories, fork with source tracking

### Non-Functional Requirements

- **Availability**: 99.99% for Git operations (push, pull, clone)
- **Latency**: < 100ms for API requests, < 500ms for search queries
- **Scale**: 200M repositories, 1B files indexed for search
- **Durability**: Zero data loss for Git objects (critical)
- **Consistency**: Strong consistency for Git refs, eventual consistency for search index

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│     Web UI │ Git CLI │ GitHub CLI │ IDE Extensions               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / CDN                             │
│          (Auth, Rate Limiting, TLS, Static Assets)              │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Git Server   │    │  API Server   │    │Search Service │
│               │    │               │    │               │
│ - SSH/HTTPS   │    │ - REST API    │    │ - Code index  │
│ - Pack files  │    │ - PRs, Issues │    │ - Symbols     │
│ - Refs        │    │ - Discussions │    │ - Language     │
│ - LFS         │    │ - Webhooks    │    │   detection   │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Queue (optional)                      │
│         (Webhook delivery, search indexing, notifications)      │
└─────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Storage Layer                            │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│ Git Storage  │  PostgreSQL  │    Redis     │  Elasticsearch     │
│ (Bare repos) │  - Repos     │  - Sessions  │  - Code search     │
│ - Objects    │  - PRs       │  - Cache     │  - Symbols         │
│ - Pack files │  - Issues    │  - Rate limit│                    │
│ - Refs       │  - Webhooks  │              │                    │
│              │  - Audit logs│              │                    │
└──────────────┴──────────────┴──────────────┴────────────────────┘
```

---

## Core Components

### 1. Git Object Storage

Git repositories are stored as bare repositories on the filesystem. Each repository lives at `/repositories/{owner}/{repo}.git`.

**Git Object Types:**
- **Blob**: File content (compressed with zlib)
- **Tree**: Directory structure (references blobs and other trees)
- **Commit**: Commit metadata + parent pointer + tree pointer
- **Tag**: Annotated tag with signature

**Content-Addressing:** Objects are stored by their SHA-1 hash, enabling natural deduplication. The same file content across different repositories or branches is stored once.

**Pack Files:** Loose objects are periodically packed into pack files with delta compression, reducing storage and improving clone/fetch performance.

### 2. Pull Request Workflow

PRs follow a state machine: `OPEN` --> `REVIEW_REQUIRED` --> `APPROVED` --> `MERGED`, with `CLOSED` reachable from any state.

**Three Merge Strategies:**
- **Merge commit**: Creates a merge commit preserving full branch history
- **Squash merge**: Combines all branch commits into a single commit on base
- **Rebase merge**: Replays branch commits on top of base branch tip

The merge operation is atomic: compute diff, validate no conflicts, execute the git operation, update PR metadata (merged_at, merged_by, additions, deletions, changed_files), and close the PR in a single transaction.

### 3. Code Search

**Indexing Pipeline:**
1. On repository creation or push event, files are extracted from the repository
2. Language detection by file extension
3. Content tokenized with a code-aware analyzer (camel case splitting, identifier extraction)
4. Symbols extracted (function and class declarations via regex patterns)
5. Indexed to Elasticsearch with repo_id, path, content, language, and nested symbols

**Search Features:**
- Full-text code search with highlighting
- Language filter
- Repository scope filter
- Path wildcard filter
- Symbol search (functions, classes)

### 4. Webhook Delivery

Webhooks are configured per-repository with a URL, optional secret, and event filter list. Delivery follows a reliable pattern:

1. Event occurs (push, PR opened, issue created)
2. Find all active webhooks for the repository that subscribe to the event type
3. For each webhook, create a delivery record and attempt HTTP POST
4. Sign the payload with HMAC-SHA256 using the webhook secret
5. On failure, retry with exponential backoff (up to 10 attempts)
6. Log delivery status, response, and latency to the `webhook_deliveries` table

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  bio TEXT,
  avatar_url VARCHAR(500),
  location VARCHAR(255),
  company VARCHAR(255),
  website VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organizations
CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  avatar_url VARCHAR(500),
  website VARCHAR(500),
  location VARCHAR(255),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organization Members
CREATE TABLE organization_members (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',  -- 'owner', 'admin', 'member'
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Repositories
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  org_id INTEGER REFERENCES organizations(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),
  language VARCHAR(50),
  stars_count INTEGER DEFAULT 0,       -- Denormalized counters
  forks_count INTEGER DEFAULT 0,
  watchers_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_user_repo UNIQUE(owner_id, name),
  CONSTRAINT unique_org_repo UNIQUE(org_id, name),
  CONSTRAINT owner_or_org CHECK (
    (owner_id IS NOT NULL AND org_id IS NULL) OR
    (owner_id IS NULL AND org_id IS NOT NULL)
  )
);

CREATE INDEX idx_repos_owner ON repositories(owner_id);
CREATE INDEX idx_repos_org ON repositories(org_id);

-- Collaborators
CREATE TABLE collaborators (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) DEFAULT 'read',  -- 'read', 'triage', 'write', 'maintain', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, user_id)
);

-- Stars
CREATE TABLE stars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, repo_id)
);

-- Forks
CREATE TABLE forks (
  id SERIAL PRIMARY KEY,
  source_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  forked_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  author_id INTEGER REFERENCES users(id),
  assignee_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

CREATE INDEX idx_issues_repo ON issues(repo_id);
CREATE INDEX idx_issues_author ON issues(author_id);

-- Labels
CREATE TABLE labels (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(7) DEFAULT '#1a73e8',
  description TEXT,
  UNIQUE(repo_id, name)
);

-- Issue Labels (junction)
CREATE TABLE issue_labels (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(issue_id, label_id)
);

-- Pull Requests
CREATE TABLE pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',     -- 'open', 'closed', 'merged'
  head_branch VARCHAR(100) NOT NULL,
  head_sha VARCHAR(40),
  base_branch VARCHAR(100) NOT NULL,
  base_sha VARCHAR(40),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  changed_files INTEGER DEFAULT 0,
  is_draft BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

CREATE INDEX idx_prs_repo ON pull_requests(repo_id);
CREATE INDEX idx_prs_author ON pull_requests(author_id);

-- PR Labels (junction)
CREATE TABLE pr_labels (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(pr_id, label_id)
);

-- Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20),                    -- 'approved', 'changes_requested', 'commented', 'pending'
  body TEXT,
  commit_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reviews_pr ON reviews(pr_id);

-- Review Comments (inline code comments)
CREATE TABLE review_comments (
  id SERIAL PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  path VARCHAR(500),
  line INTEGER,
  side VARCHAR(10),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Comments (issues and PRs)
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT issue_or_pr CHECK (
    (issue_id IS NOT NULL AND pr_id IS NULL) OR
    (issue_id IS NULL AND pr_id IS NOT NULL)
  )
);

CREATE INDEX idx_comments_issue ON comments(issue_id);
CREATE INDEX idx_comments_pr ON comments(pr_id);

-- Discussions
CREATE TABLE discussions (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  category VARCHAR(50),
  author_id INTEGER REFERENCES users(id),
  is_answered BOOLEAN DEFAULT FALSE,
  answer_comment_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- Discussion Comments (threaded)
CREATE TABLE discussion_comments (
  id SERIAL PRIMARY KEY,
  discussion_id INTEGER REFERENCES discussions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES discussion_comments(id),
  body TEXT NOT NULL,
  upvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhook Deliveries
CREATE TABLE webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
  event VARCHAR(50),
  payload JSONB,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER,
  attempt INTEGER DEFAULT 1,
  delivered_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  url VARCHAR(500),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

-- Audit Logs
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(64),
  details JSONB DEFAULT '{}',
  outcome VARCHAR(20) DEFAULT 'success'
);

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- Idempotency Keys
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  operation_type VARCHAR(50) NOT NULL,
  resource_id INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
```

---

## API Design

### REST Endpoints

```
POST   /api/auth/register                     Register new user
POST   /api/auth/login                        Login
POST   /api/auth/logout                       Logout
GET    /api/auth/me                           Get current user

GET    /api/repos                             List repositories
POST   /api/repos                             Create repository
GET    /api/repos/:owner/:repo                Get repository details
PATCH  /api/repos/:owner/:repo/settings       Update repo settings
DELETE /api/repos/:owner/:repo                Delete repository

GET    /api/repos/:owner/:repo/tree/:branch   Browse file tree
GET    /api/repos/:owner/:repo/blob/:branch/* View file content
GET    /api/repos/:owner/:repo/branches       List branches
GET    /api/repos/:owner/:repo/commits        List commits

GET    /api/repos/:owner/:repo/collaborators  List collaborators
POST   /api/repos/:owner/:repo/collaborators  Add collaborator
DELETE /api/repos/:owner/:repo/collaborators/:userId  Remove collaborator

GET    /api/:owner/:repo/pulls                List pull requests
POST   /api/:owner/:repo/pulls                Create pull request
GET    /api/:owner/:repo/pulls/:number        Get PR details with diff
POST   /api/:owner/:repo/pulls/:number/merge  Merge PR (strategy param)
POST   /api/:owner/:repo/pulls/:number/reviews  Submit review
POST   /api/:owner/:repo/pulls/:number/comments  Add review comment

GET    /api/:owner/:repo/issues               List issues
POST   /api/:owner/:repo/issues               Create issue
GET    /api/:owner/:repo/issues/:number       Get issue details
PATCH  /api/:owner/:repo/issues/:number       Update issue
POST   /api/:owner/:repo/issues/:number/comments  Add comment

GET    /api/:owner/:repo/discussions          List discussions
POST   /api/:owner/:repo/discussions          Create discussion
POST   /api/:owner/:repo/discussions/:number/comments  Add comment

GET    /api/search                            Search code (query, language, repo)

GET    /api/users/:username                   Get user profile
GET    /api/users/:username/repos             List user repositories
POST   /api/repos/:owner/:repo/star           Star repository
DELETE /api/repos/:owner/:repo/star           Unstar repository
```

---

## Key Design Decisions

### 1. Bare Git Repositories on Filesystem vs. Object Store

**Decision**: Store repositories as bare Git repositories on the local filesystem.

Git operations (diff, merge, log, tree) require the native Git object model. Storing objects in a database or S3 would require reimplementing Git's pack file format, delta compression, and ref management. Using bare repos with `simple-git` and `isomorphic-git` libraries provides full Git functionality. The trade-off is that filesystem storage doesn't scale horizontally -- at GitHub's scale, you'd shard repositories across storage servers with a routing layer. For a learning project, filesystem storage is the pragmatic choice.

### 2. Repository-Scoped Numbering for Issues and PRs

**Decision**: Use `(repo_id, number)` composite unique constraints with application-level counter management.

GitHub uses sequential numbers per repository (issue #1, PR #2, etc.). A global auto-increment would produce non-sequential numbers per repo. The application maintains a counter per repository and increments it atomically when creating issues or PRs. The trade-off is that the counter must be managed carefully to avoid duplicates under concurrent creation -- the `UNIQUE(repo_id, number)` constraint is the safety net.

### 3. XOR Constraint for Repository Ownership

**Decision**: Use a CHECK constraint `(owner_id IS NOT NULL AND org_id IS NULL) OR (owner_id IS NULL AND org_id IS NOT NULL)` on the repositories table.

A repository belongs to either a user or an organization, never both. Modeling this as a single polymorphic `owner_type` column loses foreign key integrity. The XOR constraint with separate `owner_id` and `org_id` columns preserves referential integrity while enforcing the business rule at the database level.

### 4. Denormalized Counters for Stars/Forks/Watchers

**Decision**: Store `stars_count`, `forks_count`, and `watchers_count` directly on the repositories table rather than computing them with COUNT queries.

Repository listing pages display these counts for every visible repository. Computing `COUNT(*)` from junction tables for each repository in a list would be expensive. Denormalized counters are updated atomically when stars/forks are added or removed. The trade-off is potential drift if the application crashes between modifying the junction table and updating the counter -- a periodic reconciliation job can fix this.

### 5. Elasticsearch for Code Search vs. PostgreSQL Full-Text Search

**Decision**: Use Elasticsearch with a custom code analyzer for code search.

Code search requires tokenization that understands programming language constructs: camelCase splitting, identifier extraction, and symbol-level search. PostgreSQL's full-text search uses natural language tokenizers that don't handle code well (e.g., `getUserName` should match a search for "user name"). Elasticsearch's custom analyzer pipeline handles this. The trade-off is eventual consistency -- pushed code takes a moment to become searchable.

---

## Consistency and Idempotency

### Git Ref Consistency

Git refs (branch pointers, tags) require strong consistency. A push that updates `refs/heads/main` must be atomic and fail if the ref has moved since the client's last fetch. This is enforced by Git's compare-and-swap semantics for ref updates.

### Idempotency Keys

PR creation and issue creation accept idempotency keys to prevent duplicates from client retries. Keys are stored in the `idempotency_keys` table with the operation result. A background job cleans up expired keys hourly.

### Audit Logging

Security-sensitive operations (repository deletion, collaborator changes, admin actions) are logged to the `audit_logs` table with user ID, action, resource, IP address, user agent, and request ID. Logs are queryable via admin API endpoints.

---

## Security and Auth

- **Session-based authentication** with Redis-backed session store
- **Session ID** passed via `X-Session-Id` header (7-day TTL)
- **Role-based access**: `user` and `admin` roles
- **Repository permissions**: owner, admin, maintain, write, triage, read (via collaborators table)
- **Private repositories**: only owner, org members, and collaborators can access
- **Audit logging**: security-sensitive operations logged with IP and user agent
- **CORS** restricted to frontend origin

---

## Observability

### Prometheus Metrics

The `/metrics` endpoint exposes comprehensive application metrics:

**HTTP Metrics:**
- `github_http_request_duration_seconds{method, route, status_code}` -- request latency histogram
- `github_http_requests_total{method, route, status_code}` -- request counts
- `github_active_connections{type}` -- active connections by type (http, websocket, git_ssh)

**Git Metrics:**
- `github_git_operation_duration_seconds{operation}` -- git operation latency (push, clone, merge, diff)
- `github_git_operations_total{operation, status}` -- operation counts with success/failure/timeout/rejected
- `github_pushes_total{status}` -- push operations

**Cache Metrics:**
- `github_cache_hits_total{cache_type}` / `github_cache_misses_total{cache_type}` -- cache effectiveness
- `github_cache_operation_duration_seconds{operation}` -- cache operation latency

**Business Metrics:**
- `github_prs_created_total{status}` / `github_prs_merged_total{strategy}` -- PR activity
- `github_issues_created_total{status}` / `github_issues_closed_total` -- issue activity

**Infrastructure Metrics:**
- `github_circuit_breaker_state{service}` -- current state (0=closed, 1=open, 2=half-open)
- `github_circuit_breaker_trips_total{service}` -- trip count
- `github_webhook_deliveries_total{status, event_type}` -- webhook delivery status
- `github_webhook_delivery_duration_seconds{status}` -- delivery latency
- `github_idempotency_duplicates_total{operation}` -- duplicate request detection

### Structured Logging

Pino JSON logger with request correlation. Pretty-print in development, JSON in production. Request logger middleware attaches request context to all downstream log entries.

### Health Checks

- `GET /health` -- checks PostgreSQL, Redis, reports circuit breaker status, uptime, and version
- `GET /health/live` -- liveness probe (server running)
- `GET /health/ready` -- readiness probe (PostgreSQL and Redis reachable)

---

## Failure Handling

### Circuit Breaker Pattern

Circuit breakers (Opossum) protect git operations from cascading failures.

| Setting | Value |
|---------|-------|
| Timeout | 30 seconds (git operations can be slow) |
| Error threshold | 50% of requests |
| Reset timeout | 30 seconds |
| Volume threshold | 5 requests minimum |

Protected operations: clone, branches, commits, tree, diff, merge, push. Each gets its own circuit breaker instance with independent state. Admin endpoints allow viewing and manually resetting circuit breakers.

### Graceful Shutdown

SIGTERM/SIGINT handlers stop accepting new requests, close the HTTP server, drain PostgreSQL connection pool, and close Redis connection before exiting.

### Elasticsearch Optional

If Elasticsearch is unavailable at startup, the server logs a warning and continues. Search endpoints return errors, but all other functionality works.

---

## Scalability Considerations

| Bottleneck | Scaling Strategy |
|------------|-----------------|
| Git storage | Shard repositories across storage servers with consistent hashing |
| API throughput | Horizontal scaling behind load balancer (stateless with Redis sessions) |
| Code search | Elasticsearch cluster with sharding by repository, replicas for reads |
| Database | Read replicas for listing, connection pooling, partition large tables |
| Webhook delivery | Async queue (RabbitMQ/SQS) with dedicated worker pool |
| Large diffs | Streaming diff computation, pagination for 1000+ file changes |
| Clone/Fetch | Pack file caching, partial clone support, bandwidth throttling |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Git storage | Bare repos on filesystem | Database/S3 objects | Native Git operations without reimplementation |
| Code search | Elasticsearch | PostgreSQL FTS | Code-aware tokenization (camelCase, identifiers) |
| Auth | Session + Redis | JWT | Immediate revocation, simpler for server-rendered UI |
| Repo ownership | XOR constraint (owner_id/org_id) | Polymorphic owner_type | Preserves foreign key integrity |
| Issue numbering | Per-repo counter + UNIQUE | Global auto-increment | Matches GitHub's user-facing model |
| Star counts | Denormalized on repos | COUNT query | Avoids N+1 on listing pages |
| Webhook delivery | Inline with retry | Async queue | Simpler for MVP, queue needed at scale |
| Merge strategies | Git CLI via simple-git | Custom merge implementation | Correct behavior, battle-tested |

---

## Implementation Notes

This section documents the actual local setup and maps production concepts to the Docker + Node.js + React implementation.

### Local Architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  Frontend (React 19)     │ :5173  │  Backend (Express)       │ :3000
│  Vite + TanStack Router  │───────▶│  Routes + Services       │
│  Zustand + Tailwind CSS  │        │  Git Operations          │
└──────────────────────────┘        └────────────┬─────────────┘
                                                 │
                                    ┌────────────┼────────────┐
                                    ▼            ▼            ▼
                              ┌──────────┐ ┌──────────┐ ┌──────────┐
                              │ Postgres │ │  Redis   │ │   ES     │
                              │  :5432   │ │  :6379   │ │  :9200   │
                              └──────────┘ └──────────┘ └──────────┘
                                                 │
                                    ┌────────────┘
                                    ▼
                              ┌──────────────────┐
                              │  /repositories/  │
                              │  (bare git repos)│
                              └──────────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Circuit breakers | Opossum wrapping all git operations with per-operation instances | `backend/src/shared/circuitBreaker.ts` |
| Prometheus metrics | 15+ custom metrics (HTTP, git, cache, PR, issue, webhook, circuit breaker) | `backend/src/shared/metrics.ts` |
| Structured logging | Pino JSON logger with request middleware | `backend/src/shared/logger.ts` |
| Audit logging | Security-sensitive operations logged with IP, user agent, request ID | `backend/src/shared/audit.ts` |
| Idempotency | DB-backed idempotency keys with periodic cleanup | `backend/src/shared/idempotency.ts` |
| Cache layer | Redis caching for repo metadata, file trees, PR diffs | `backend/src/shared/cache.ts` |
| Health checks | /health (PG + Redis + circuit breakers), /health/live, /health/ready | `backend/src/index.ts` |
| Metrics middleware | Per-request latency tracking and counting | `backend/src/shared/metrics.ts` |
| Admin endpoints | Circuit breaker status/reset, audit log query | `backend/src/index.ts` |
| Session auth | Redis-backed sessions with X-Session-Id header | `backend/src/middleware/auth.ts` |
| Code search | Elasticsearch with code tokenizer, symbol extraction, language detection | `backend/src/services/search.ts` |
| Git operations | simple-git + isomorphic-git for bare repository management | `backend/src/services/git.ts` |
| Graceful shutdown | SIGTERM/SIGINT handlers with connection draining | `backend/src/index.ts` |

### What Was Simplified or Substituted

| Production Concept | Local Substitute |
|-------------------|-----------------|
| Distributed git storage (DGit/Ceph) | Local filesystem `/repositories/` |
| Git protocol server (SSH + Smart HTTP) | Express routes calling simple-git CLI |
| API Gateway with rate limiting | Single Express server with CORS |
| Microservices (Git, API, Search) | Monolithic Express app with route modules |
| Elasticsearch cluster | Single-node ES 8.12 in Docker |
| Redis Cluster | Single Valkey 7 instance |
| OAuth / GitHub Apps | Session-based auth with bcrypt passwords |
| CDN for static assets | Vite dev server |
| Webhook queue (SQS/RabbitMQ) | Inline webhook delivery |
| Kubernetes | Docker Compose for infrastructure |
| Multi-region / geo-routing | Single machine, localhost |

### What Was Omitted

- SSH protocol support for git push/pull
- Git LFS (Large File Storage)
- Branch protection rules and required status checks
- Conflict detection and resolution UI in PRs
- CI/CD runner (GitHub Actions equivalent)
- Real-time notifications (WebSocket)
- Markdown rendering
- Repository forking (table exists, git fork logic not implemented)
- Webhook secret verification and HMAC signing
- Rate limiting middleware
- Repository templates
- GitHub Pages equivalent
- Dependabot / security scanning
- Code owners (CODEOWNERS file)
- Protected branches

### Frontend Architecture

The frontend uses React 19 + TypeScript + Vite + TanStack Router + Zustand + Tailwind CSS.

Key components:
- `CodeViewer.tsx` -- syntax-highlighted file content viewer
- `DiffViewer.tsx` -- side-by-side diff display for PRs
- `FileTree.tsx` -- repository file browser with directory navigation
- `Header.tsx` -- global navigation with search
- `IssueCard.tsx` -- issue list item
- `RepoCard.tsx` -- repository list card with stats

Routes follow GitHub's URL structure:
- `/:owner/:repo` -- repository overview
- `/:owner/:repo/tree/:branch/*` -- file tree browsing
- `/:owner/:repo/blob/:branch/*` -- file content viewing
- `/:owner/:repo/pulls` -- PR list
- `/:owner/:repo/pull/:number` -- PR detail with diff
- `/:owner/:repo/issues` -- issue list
- `/:owner/:repo/issues/:number` -- issue detail
- `/:owner/:repo/discussions` -- discussions
- `/search` -- code search
- `/new` -- create repository
- `/login`, `/register` -- authentication
