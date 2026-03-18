# Confluence Wiki/Knowledge Base - Architecture

## System Overview

Confluence is a wiki-based knowledge management platform that enables teams to create, organize, and collaborate on documentation. The system supports hierarchical page organization within spaces, rich-text content with macros, version control with diffing, full-text search, threaded comments, and content approval workflows.

**Learning Goals:**
- Design a wiki data model with hierarchical page trees
- Implement version control with efficient diff computation
- Build full-text search with Elasticsearch and async indexing
- Create a macro expansion system for structured content
- Design an approval workflow for content governance
- Understand space-based access control patterns

## Requirements

### Functional Requirements
1. Users can create and manage **spaces** (organizational containers for pages)
2. Pages are organized in a **hierarchical tree** within each space
3. Pages support **rich-text editing** with macros (info, warning, note, code, toc)
4. Every page edit creates a **version** with full diff capability
5. **Full-text search** across all spaces with filtering and highlighting
6. **Threaded comments** on pages with resolve/unresolve
7. **Content approval workflow** (request, approve, reject)
8. **Labels/tags** for cross-cutting page categorization
9. **Templates** for standardized page creation

### Non-Functional Requirements (Production Scale)
| Metric | Target |
|--------|--------|
| Page load latency (p99) | < 200ms |
| Search latency (p99) | < 500ms |
| Availability | 99.95% |
| Concurrent editors | 10,000+ |
| Total pages | 100M+ |
| Daily page views | 50M+ |

## Capacity Estimation

### Production Scale
- 500K active users, 10K concurrent
- 100M pages across 50K spaces
- Average page size: 50KB HTML, 10KB text
- 1M page edits/day (creating 1M versions)
- 5M search queries/day
- Storage: 100M pages x 50KB = 5TB content + versions

### Local Development Scale
- 2-5 users, 2-3 spaces, 50-100 pages
- Single PostgreSQL, Redis, Elasticsearch, RabbitMQ instances
- All services on localhost with Docker Compose

## High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│   Web Browser   │────▶│   CDN / Edge    │────▶│  Load Balancer  │
│   (React SPA)   │     │  (Static Assets)│     │  (NGINX / ALB)  │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                    ┌────────────────────────────────────┼────────────────────┐
                    │                                    │                    │
           ┌────────▼────────┐   ┌──────────────────┐   │    ┌──────────────▼──────┐
           │                 │   │                  │   │    │                     │
           │   Wiki API      │   │   Wiki API       │   │    │   Wiki API          │
           │   Server        │   │   Server         │   │    │   Server            │
           │                 │   │                  │   │    │                     │
           └──┬──────┬───────┘   └──────────────────┘   │    └─────────────────────┘
              │      │                                  │
              │      │    ┌─────────────────────────────┤
              │      │    │                             │
     ┌────────▼─┐    │  ┌─▼────────┐   ┌─────────────┐│   ┌──────────────┐
     │          │    │  │          │   │             ││   │              │
     │PostgreSQL│    │  │  Valkey  │   │  RabbitMQ   │├──▶│Search Indexer│
     │ (Primary │    │  │ (Cache,  │   │ (page-index ││   │  (Worker)    │
     │  + Read  │    │  │ Sessions,│   │   queue)    ││   │              │
     │ Replicas)│    │  │  Rate    │   │             ││   └──────┬───────┘
     │          │    │  │ Limits)  │   │             ││          │
     └──────────┘    │  └──────────┘   └─────────────┘│   ┌──────▼───────┐
                     │                                │   │              │
                     └────────────────────────────────┘   │Elasticsearch │
                                                          │  (Cluster)   │
                                                          │              │
                                                          └──────────────┘
```

## Core Components

### 1. Wiki Data Model

The core data model revolves around **spaces** containing hierarchical **pages**:

- **Spaces**: Organizational containers with key, name, description, visibility, and a designated homepage
- **Pages**: Wiki content nodes with parent-child hierarchy via `parent_id`, storing content in three formats (JSON for macros, HTML for rendering, plain text for search)
- **Page Versions**: Immutable history records created on every edit, enabling diff between any two versions

**Page tree** is implemented using an adjacency list model (`parent_id` self-reference). Tree operations:
- **Get tree**: Load all pages for a space, build in-memory tree by mapping parent-child relationships
- **Move page**: Update `parent_id` and `position`, reorder siblings
- **Get breadcrumbs**: Recursive CTE walking up the ancestor chain

### 2. Request Flows

**Page View Flow:**
```
Client ──▶ GET /pages/space/:key/slug/:slug
         ──▶ Check Redis cache (page data)
         ──▶ If miss: Query PostgreSQL (page + author + labels)
         ──▶ Build breadcrumbs (recursive CTE)
         ──▶ Cache result (120s TTL)
         ──▶ Return page with metadata
```

**Page Edit Flow:**
```
Client ──▶ PUT /pages/:id (title, contentHtml, contentText)
         ──▶ BEGIN transaction
         ──▶ Increment version number
         ──▶ UPDATE pages table
         ──▶ INSERT page_versions record
         ──▶ COMMIT
         ──▶ Invalidate Redis cache (space tree + page)
         ──▶ Publish to RabbitMQ "page-index" queue
         ──▶ Return updated page
```

**Search Flow:**
```
Client ──▶ GET /search?q=query&space=KEY
         ──▶ Build ES query (multi_match on title^3, content, labels^2)
         ──▶ Apply filters (space, status=published)
         ──▶ Execute search with highlighting
         ──▶ If ES fails: fallback to PostgreSQL ILIKE
         ──▶ Return results with highlighted snippets
```

### 3. Version Control and Diffing

Every page edit creates an immutable version record:

```
Page (version=3) ──┐
                   ├── page_versions (v1) ──┐
                   ├── page_versions (v2) ──┤── diff(v1, v2) = line changes
                   └── page_versions (v3) ──┤── diff(v2, v3) = line changes
                                            └── diff(v1, v3) = full diff
```

Diff computation uses the `diff` library's `diffLines()` function on `content_html`. Each change is classified as added, removed, or unchanged. The frontend renders these as green/red highlighted lines.

### 4. Search Architecture

Asynchronous indexing via RabbitMQ ensures page operations are not blocked by search indexing:

```
Page Create/Update ──▶ RabbitMQ (page-index queue)
                                   │
                      Search Indexer Worker
                                   │
                                   ▼
                      Elasticsearch Index
                      ┌──────────────────┐
                      │ page_id (keyword) │
                      │ space_id (keyword)│
                      │ title (text^3)    │
                      │ content_text      │
                      │ labels (keyword[])│
                      │ status (keyword)  │
                      └──────────────────┘
```

The search indexer worker consumes messages from the `page-index` queue, fetches the page data and labels from PostgreSQL, and indexes the document in Elasticsearch. The `wiki_analyzer` uses standard tokenizer with lowercase, stop word, and snowball (stemming) filters for intelligent matching. Search queries use `multi_match` with field boosting (title x3, labels x2) and `AUTO` fuzziness for typo tolerance.

When Elasticsearch is unavailable, search falls back to PostgreSQL `ILIKE` queries. The fallback produces results without relevance scoring or highlighting but keeps the system functional.

### 5. Macro System

Macros are structured content blocks embedded in pages:

| Macro | Purpose | Visual |
|-------|---------|--------|
| `info` | Informational callout | Blue background, blue border |
| `warning` | Warning callout | Yellow background, orange border |
| `note` | Note callout | Purple background, purple border |
| `code` | Code block | Gray background, monospace font |
| `toc` | Table of contents | Generated from headings |

Macros are stored in `content_json.macros[]` and can be expanded server-side by the macro service or rendered client-side by the MacroRenderer React component.

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  homepage_id UUID,
  is_public BOOLEAN DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(space_id, user_id)
);

CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  content_json JSONB DEFAULT '{}',
  content_html TEXT DEFAULT '',
  content_text TEXT DEFAULT '',
  version INT DEFAULT 1,
  status VARCHAR(20) DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'archived')),
  position INT DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE spaces ADD CONSTRAINT fk_homepage
  FOREIGN KEY (homepage_id) REFERENCES pages(id) ON DELETE SET NULL;

CREATE TABLE page_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  content_json JSONB NOT NULL,
  content_html TEXT NOT NULL,
  content_text TEXT DEFAULT '',
  change_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, version_number)
);

CREATE TABLE page_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, label)
);

CREATE TABLE page_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  parent_id UUID REFERENCES page_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  content_json JSONB NOT NULL,
  is_global BOOLEAN DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE page_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_pages_space ON pages(space_id, parent_id, position);
CREATE INDEX idx_pages_slug ON pages(space_id, slug);
CREATE INDEX idx_page_versions_page ON page_versions(page_id, version_number DESC);
CREATE INDEX idx_page_comments_page ON page_comments(page_id, created_at);
CREATE INDEX idx_page_labels_page ON page_labels(page_id);
CREATE INDEX idx_page_labels_label ON page_labels(label);
CREATE INDEX idx_space_members_space ON space_members(space_id);
CREATE INDEX idx_space_members_user ON space_members(user_id);
CREATE INDEX idx_templates_space ON templates(space_id);
CREATE INDEX idx_page_approvals_page ON page_approvals(page_id, status);
```

Key schema design decisions:

1. **Triple content storage**: `content_json` stores structured content for macro expansion; `content_html` stores rendered HTML for direct rendering; `content_text` stores plain text for search indexing. This denormalization avoids runtime parsing and enables each consumer (editor, renderer, search) to read its optimal format.
2. **Soft status**: Pages have `status` (draft/published/archived) rather than hard deletes, supporting approval workflows and content governance.
3. **Position ordering**: `position` column enables ordered siblings within each parent.
4. **Composite indexes**: `(space_id, parent_id, position)` for efficient tree queries; `(space_id, slug)` for URL resolution.

## API Design

RESTful API under `/api/v1/`. Session-based authentication with Redis-backed sessions.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login, create session |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/auth/me` | Get current user |
| GET | `/api/v1/spaces` | List spaces |
| POST | `/api/v1/spaces` | Create space |
| GET | `/api/v1/spaces/:id` | Get space details |
| PUT | `/api/v1/spaces/:id` | Update space |
| POST | `/api/v1/spaces/:id/members` | Add space member |
| GET | `/api/v1/pages/space/:key/tree` | Get page tree for space |
| POST | `/api/v1/pages` | Create page |
| GET | `/api/v1/pages/:id` | Get page with metadata |
| GET | `/api/v1/pages/space/:key/slug/:slug` | Get page by space key + slug |
| PUT | `/api/v1/pages/:id` | Update page (creates version) |
| DELETE | `/api/v1/pages/:id` | Archive page |
| GET | `/api/v1/pages/:id/versions` | Get version history |
| GET | `/api/v1/pages/:id/versions/:v1/diff/:v2` | Diff two versions |
| GET | `/api/v1/pages/:id/comments` | Get threaded comments |
| POST | `/api/v1/pages/:id/comments` | Add comment |
| POST | `/api/v1/pages/:id/approvals` | Request approval |
| PUT | `/api/v1/approvals/:id` | Approve/reject |
| GET | `/api/v1/search` | Full-text search with filters |
| GET | `/api/v1/templates` | List templates |
| GET | `/api/health` | Health check |
| GET | `/metrics` | Prometheus metrics |

## Key Design Decisions

### Adjacency List vs Nested Sets for Page Tree

| Approach | Reads | Writes | Complexity |
|----------|-------|--------|------------|
| Adjacency List (chosen) | O(n) load + build | O(1) move | Low |
| Nested Sets | O(log n) subtree | O(n) recalculate | Medium |
| Materialized Path | O(1) ancestors | O(n) reparent | Low |

Adjacency list was chosen because wiki trees are typically shallow (3-5 levels deep) and wide. The entire space page set (usually < 1000 pages) fits easily in memory for tree construction. Nested sets would optimize subtree queries at the cost of making every move operation an O(n) recalculation of left/right bounds across the entire tree. For a wiki where pages are moved infrequently but the tree is displayed on every page view, the adjacency list's O(1) move cost matters more than the O(n) tree-load cost -- especially since the tree-load result is cached in Redis with a 120-second TTL.

Materialized path (`/root/parent/child`) is a reasonable alternative for ancestor queries, but reparenting a subtree requires updating the path of every descendant. With shallow trees and PostgreSQL recursive CTEs available, adjacency list provides the best balance.

### HTML Storage vs Block-Based Storage

Chose storing content as HTML strings rather than a block-based model (like Notion):
- **HTML**: Simple to implement, works with contentEditable, easy to render, no custom editor framework required
- **Blocks**: Better for collaborative editing, granular version tracking, structured queries per block

The trade-off is that HTML diffs are noisier than block-level diffs -- a tag attribute change affects the entire line. Production Confluence uses a custom XHTML storage format with macro markup. For a system that prioritizes simplicity of editing and rendering over collaborative editing precision, HTML storage is sufficient. If collaborative editing were added later, migrating to a block model or integrating a CRDT library (like Yjs) would be necessary.

### Elasticsearch vs PostgreSQL Full-Text Search

| Feature | Elasticsearch | PostgreSQL FTS |
|---------|---------------|----------------|
| Relevance scoring | BM25, field boosting | ts_rank (TF-IDF) |
| Fuzzy matching | Built-in AUTO fuzziness | Limited (pg_trgm) |
| Highlighting | Built-in with pre/post tags | Manual with ts_headline |
| Horizontal scaling | Shard across nodes | Read replicas only |
| Operational complexity | High (JVM, cluster mgmt) | Low (built into DB) |

Elasticsearch was chosen because a wiki's primary discovery mechanism is search. Users expect typo-tolerant queries, relevant ranking (title matches above content matches), and highlighted snippets showing where the query matched. PostgreSQL's `tsvector`/`tsquery` can handle basic full-text search, but producing quality highlighted snippets and fuzzy matches requires significant custom code. Elasticsearch delivers these features out of the box.

The cost is operational complexity: Elasticsearch requires its own cluster, monitoring, and index management. The mitigation strategy is the PostgreSQL ILIKE fallback -- if Elasticsearch becomes unavailable, users still get results (without ranking or highlighting) rather than a broken search page.

## Consistency and Idempotency

### Idempotent Page Operations

Page edit operations (PUT `/api/v1/pages/:id`) use PostgreSQL transactions to atomically increment the version counter, update the page row, and insert the version record. The `UNIQUE(page_id, version_number)` constraint on `page_versions` prevents duplicate versions from concurrent or retried requests. If a client retries a failed edit, the transaction either succeeds (creating the next version) or fails at the unique constraint (if the previous attempt actually committed), in which case the client receives the current page state.

After a successful page edit transaction, the server performs two non-transactional side effects: invalidating the Redis cache (pattern-based key deletion) and publishing an indexing message to RabbitMQ. Both operations are idempotent. Cache invalidation is idempotent by nature (deleting a non-existent key is a no-op). The search indexer processes the full page state from PostgreSQL, so receiving duplicate index messages results in the same Elasticsearch document.

### Consistency Guarantees

Page operations use PostgreSQL's default READ COMMITTED isolation within transactions. The version increment and version record insert happen atomically -- readers never see a page with version N+1 without the corresponding `page_versions` record. Cross-page consistency (e.g., moving a page between parents) uses single-row updates since the adjacency list model only requires changing the moved page's `parent_id`.

The search index is eventually consistent with the source of truth (PostgreSQL). There is a window between a page edit committing and the search indexer processing the queue message during which a search query may return stale content. This is acceptable for a wiki where search freshness within a few seconds is sufficient.

## Security / Auth

- **Session-based auth**: Express sessions stored in Valkey with 24-hour TTL
- **Password hashing**: bcrypt with 12 salt rounds
- **Rate limiting**: Redis-backed rate limiter (500 req/15min for API, 20 req/15min for auth)
- **Space membership**: Role-based (admin, member, viewer) per space
- **CORS**: Configured for frontend origin only

## Observability

- **Metrics**: Prometheus metrics via prom-client -- HTTP request duration histogram, request counters by method/route/status, page operation counters by type (create/update/delete/move), search latency histogram
- **Structured logging**: Pino logger with JSON output and request correlation via pino-http
- **Health check**: `GET /api/health` returns service status for load balancer probing
- **Circuit breaker**: Opossum circuit breaker wrapping external service calls (Elasticsearch, RabbitMQ) -- opens after 50% error rate, resets after 30 seconds

## Failure Handling

- **Elasticsearch unavailable**: Search falls back to PostgreSQL ILIKE queries. Results lose relevance scoring and highlighting but remain functional. The circuit breaker prevents repeated slow calls to a down ES cluster.
- **RabbitMQ unavailable**: Page create/update operations succeed normally; the indexing message publish is skipped. Pages are fully usable but will not appear in search until RabbitMQ recovers and pages are re-indexed (eventual consistency).
- **Redis unavailable**: Session validation fails (all requests return 401), and caching degrades gracefully (all requests hit PostgreSQL directly). Rate limiting also stops, creating a temporary denial-of-service risk.
- **Transaction rollbacks**: All multi-step write operations (page create, edit, move) use PostgreSQL transactions with proper rollback on failure. Partial writes never reach the database.

## Scalability Considerations

1. **Read scaling**: Page content cached in Redis (120s TTL); page trees cached per space. At 50M daily page views, the cache absorbs the vast majority of reads, with PostgreSQL handling cache misses.
2. **Write scaling**: Async search indexing via RabbitMQ decouples page writes from Elasticsearch. The API server completes the page edit transaction in ~10ms; the indexer processes asynchronously.
3. **Search scaling**: Elasticsearch supports horizontal sharding across nodes. With 100M pages, sharding by `space_id` keeps related pages co-located while distributing load.
4. **Database scaling**: Read replicas for page queries; connection pooling (max 20 connections per API server). At extreme scale, shard PostgreSQL by `space_id` so each space's pages, versions, comments, and labels reside on the same shard.
5. **Horizontal API scaling**: Stateless API servers behind a load balancer; sessions stored in Redis enable adding/removing API instances without session loss.

At extreme scale (100M+ pages):
- Shard PostgreSQL by `space_id`
- Replace RabbitMQ with Kafka for higher throughput indexing
- Add CDN for static page content and cached rendered pages
- Implement collaborative editing with CRDTs/OT
- Add page-level permissions (beyond space-level)

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Page tree model | Adjacency list | Nested sets | Simpler writes, shallow trees, cached tree loads |
| Content storage | HTML string | Block-based JSON | Simpler editor, direct rendering, no framework dependency |
| Search engine | Elasticsearch | PostgreSQL FTS | Better relevance, highlighting, fuzzy matching |
| Version diffing | Line-level (diff lib) | Block-level | Simple, works with HTML content |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler server-side state |
| Async indexing | RabbitMQ | Sync ES writes | Non-blocking page operations, tolerates ES downtime |
| Rich text editor | contentEditable | Tiptap/ProseMirror | No extra dependency, sufficient for learning |
| Macro rendering | Server + client | Server-only SSR | Interactive macros possible on client side |

## Implementation Notes

### Local Architecture

```
┌─────────────────┐         ┌─────────────────────────────┐
│   React SPA     │────────▶│   Express API Server        │
│   Vite :5173    │  REST   │   :3001 (dev)               │
│                 │◀────────│   :3002, :3003 (optional)   │
└─────────────────┘         └──┬──────┬──────┬──────┬─────┘
                               │      │      │      │
                  ┌────────────┘      │      │      └────────────┐
                  │                   │      │                   │
           ┌──────▼──────┐  ┌────────▼───┐  │    ┌──────────────▼──────┐
           │ PostgreSQL  │  │  Valkey    │  │    │ RabbitMQ            │
           │ :5432       │  │  :6379    │  │    │ :5672 (AMQP)        │
           │             │  │  Sessions │  │    │ :15672 (Management) │
           └─────────────┘  │  Cache    │  │    └──────────┬──────────┘
                            └───────────┘  │               │
                                           │    ┌──────────▼──────────┐
                                    ┌──────▼──┐ │ Search Indexer      │
                                    │ Elastic │ │ Worker (tsx watch)  │
                                    │ Search  │ └─────────────────────┘
                                    │ :9200   │
                                    └─────────┘
```

All infrastructure runs via Docker Compose (`docker-compose.yml`). The API server and search indexer worker run natively with `tsx watch` for hot reload.

### Production-Grade Patterns Implemented

1. **Circuit Breaker** (Opossum): Wraps Elasticsearch and RabbitMQ calls. Opens after 50% error rate, resets after 30s. Prevents cascade failures when external services are down. See `src/services/circuitBreaker.ts`.

2. **Prometheus Metrics** (prom-client): HTTP request duration histogram with method/route/status labels, request counters, page operation counters (create/update/delete/move), and search latency histogram. Exposed at `/metrics`. See `src/services/metrics.ts`.

3. **Structured Logging** (Pino): JSON-formatted logs with request correlation via pino-http. Every log line includes timestamp, level, and request context for log aggregation. See `src/services/logger.ts`.

4. **Rate Limiting**: Redis-backed sliding window rate limiter with separate limits -- 500 requests per 15 minutes for API endpoints, 20 per 15 minutes for auth endpoints. See `src/services/rateLimiter.ts`.

5. **Async Search Indexing**: RabbitMQ-based queue (`page-index`) decouples page operations from Elasticsearch indexing. The search indexer worker (`src/workers/search-indexer.ts`) consumes messages, fetches page data from PostgreSQL, and indexes documents. Failed messages are nacked without requeue.

6. **Transactional Writes**: Page create/update/move operations wrapped in PostgreSQL transactions with proper rollback on failure. Version creation is atomic with page update.

7. **Health Check**: `GET /api/health` endpoint for load balancer probing.

### Simplifications

| Production Feature | Local Substitute | Why |
|--------------------|-----------------|-----|
| CDN for static assets | Vite dev server serves assets directly | No global distribution needed locally |
| Sharded PostgreSQL | Single PostgreSQL instance | < 100 pages, no sharding needed |
| OAuth 2.0 / SAML SSO | Session auth with bcrypt passwords | Simpler, sufficient for learning |
| Tiptap/ProseMirror editor | `contentEditable` + `document.execCommand` | Avoids framework complexity |
| Real-time collaborative editing | Single-user editing only | Would require WebSocket + CRDT |
| Block-level content diffs | HTML line-level diffs via `diff` library | Simpler, works for demonstration |
| Multi-region deployment | Single-machine Docker Compose | No replication needed |
| Elasticsearch cluster | Single ES node (256MB heap) | Single-node mode with security disabled |

### Omitted

- CDN for static assets and cached page content
- Multi-region deployment and data replication
- Real-time collaborative editing (WebSocket + CRDT/OT)
- File/image attachments (would need MinIO/S3)
- PDF/Word export
- SAML/OAuth SSO integration
- Page-level permissions (only space-level implemented)
- Audit logging
- Content replication across data centers
- Kubernetes orchestration
