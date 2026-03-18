# Design Spotlight - Architecture

## System Overview

Spotlight is a universal search system with on-device indexing and intelligent suggestions. It provides a single entry point for finding files, apps, contacts, messages, and web results while offering proactive recommendations based on usage patterns. Core challenges involve real-time indexing, content extraction from diverse file formats, multi-source result fusion, and privacy-preserving search.

**Learning Goals:**
- Build incremental indexing systems
- Design multi-source search ranking
- Implement content extraction pipelines
- Handle on-device ML for suggestions

---

## Requirements

### Functional Requirements

1. **Search**: Find files, apps, contacts, messages across multiple data sources
2. **Index**: Real-time content indexing with incremental updates
3. **Suggest**: Proactive app and content suggestions based on usage patterns
4. **Calculate**: Math expressions, unit conversions, definitions
5. **Web**: Fall back to web search when local results are insufficient

### Non-Functional Requirements

- **Latency**: < 100ms p95 for local search results, < 250ms p99 including provider queries
- **Privacy**: All indexing and search happens on-device; no query logs leave the device
- **Efficiency**: < 5% CPU during background indexing; idle-time processing preferred
- **Storage**: Index size < 10% of original content size
- **Availability**: 99.5% uptime for the search service (local server)

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Indexed files per device | 500K - 2M |
| Distinct tokens in index | ~5M |
| Index size (inverted index + metadata) | 500MB - 2GB |
| Apps registered | 200-500 |
| Contacts | 1K - 10K |
| Queries per user per day | 50-100 |
| Suggestion refreshes per day | ~100 (triggered by context changes) |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Seeded files | ~100 |
| Seeded apps | ~20 |
| Seeded contacts | ~30 |
| Concurrent users | 1-3 |
| PostgreSQL storage | < 50MB |
| Elasticsearch index | < 100MB |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Spotlight UI                                │
│            (Search bar, Results list, Previews, Suggestions)        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          CDN / Edge Cache                            │
│                  (Static assets, suggestion prefetch)                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         API Gateway                                  │
│              (Rate limiting, Auth, Request routing)                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Search Service  │ │ Indexing Service  │ │Suggestion Service│
│                  │ │                   │ │                  │
│ - Query parsing  │ │ - File watcher    │ │ - Usage patterns │
│ - Multi-source   │ │ - Content extract │ │ - Time-based     │
│   fusion         │ │ - Incremental     │ │ - Proactive      │
│ - Ranking        │ │   updates         │ │   recommendations│
└────────┬─────────┘ └────────┬──────────┘ └────────┬─────────┘
         │                    │                      │
         └────────────────────┼──────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│ Elasticsearch│    │   PostgreSQL     │    │ Redis/Valkey │
│              │    │                  │    │              │
│ - Full-text  │    │ - File metadata  │    │ - Sessions   │
│   search     │    │ - Apps, contacts │    │ - Rate limits│
│ - Fuzzy match│    │ - Usage patterns │    │ - Idempotency│
│ - Multi-index│    │ - Audit log      │    │ - Cache      │
└──────────────┘    └──────────────────┘    └──────────────┘
```

---

## Core Components

### 1. Search Service

The search service parses incoming queries, routes them to appropriate sources, and merges results with unified ranking.

**Query Types:**
- **Text search**: Standard keyword matching across files, apps, contacts
- **Math expressions**: Detected via regex, evaluated locally (e.g., `2+2`, `15% of 200`)
- **Unit conversions**: Pattern-matched `{value} {unit} to {unit}` (e.g., `10 km to miles`)
- **Web fallback**: When local results are insufficient (< 3 results), add web search option

**Multi-Source Fusion:**
1. Parse query to determine type (text, math, conversion, date filter)
2. If special query, return instant answer with score 100
3. Otherwise, query all sources in parallel with per-source timeouts
4. Merge results, deduplicate by path/id, rank by combined score
5. Append web search fallback if local results are sparse

**Ranking Algorithm:**

```
finalScore = nameMatchScore * 10
           + prefixBonus * 5        (if name starts with query token)
           + recencyBoost * (5 - daysSinceModified * 0.1)
           + typeBoost              (app: 3, contact: 2, message: 2, file: 1)
```

### 2. Indexing Service

The indexing service watches the filesystem for changes and maintains a search index via content extraction and tokenization.

**Incremental Indexing Strategy:**
1. File watcher detects create/modify/delete events
2. Content hash comparison to skip unchanged files
3. Pluggable extractors by file type (text, PDF, images with OCR)
4. Tokenization and inverted index update
5. Batch updates to Elasticsearch for full-text search capability

**Content Extraction Pipeline:**
- Text files: Direct tokenization
- Documents (PDF, DOCX): Apache Tika-style extraction
- Images: Metadata extraction (EXIF), optional OCR
- Applications: Bundle ID, name, category, icon path
- Contacts: Name, email, phone, company

### 3. Suggestion Service

Proactive suggestions based on user behavior patterns, similar to Siri Suggestions.

**Suggestion Signals:**
- **Time-of-day patterns**: Track app launches by hour and day-of-week via `app_usage_patterns` table
- **Frequency**: Most-used apps and contacts surface first
- **Recency**: Recently accessed files and URLs
- **Context**: Location-based suggestions (production only)

**Scoring:**

```
suggestionScore = hourlyUsage * 0.6 + dayOfWeekUsage * 0.4
```

Apps with score > 0.1 are surfaced, top 4 per category, top 8 total.

### 4. Query Parser

Detects special query types before hitting the search index:

| Pattern | Type | Example |
|---------|------|---------|
| `^[\d\s+\-*/().%^]+$` | Math expression | `15 * 3 + 7` |
| `{number} {unit} to {unit}` | Unit conversion | `100 USD to EUR` |
| `photos from {date}` | Date filter | `photos from last week` |
| Everything else | Text search | `project report` |

---

## Database Schema

### PostgreSQL Schema

```sql
-- Indexed files table
CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',
  content_hash TEXT,
  metadata JSONB DEFAULT '{}',
  size BIGINT,
  modified_at TIMESTAMP WITH TIME ZONE,
  indexed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_files_name ON indexed_files(name);
CREATE INDEX IF NOT EXISTS idx_files_type ON indexed_files(type);
CREATE INDEX IF NOT EXISTS idx_files_modified ON indexed_files(modified_at DESC);

-- Applications table
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  bundle_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  icon_path TEXT,
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_name ON applications(name);
CREATE INDEX IF NOT EXISTS idx_apps_bundle ON applications(bundle_id);

-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- App usage patterns for suggestions
CREATE TABLE IF NOT EXISTS app_usage_patterns (
  bundle_id TEXT,
  hour INTEGER CHECK (hour >= 0 AND hour < 24),
  day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week < 7),
  count INTEGER DEFAULT 0,
  last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (bundle_id, hour, day_of_week)
);

-- Recent activity for suggestions
CREATE TABLE IF NOT EXISTS recent_activity (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_time ON recent_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON recent_activity(type);

-- Web bookmarks/history
CREATE TABLE IF NOT EXISTS web_items (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  favicon_url TEXT,
  visited_count INTEGER DEFAULT 1,
  last_visited TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_web_title ON web_items(title);
CREATE INDEX IF NOT EXISTS idx_web_visited ON web_items(last_visited DESC);
```

### Elasticsearch Indices

| Index | Document Fields | Purpose |
|-------|----------------|---------|
| `spotlight-files` | path, name, content, type, metadata, modified_at | File content search |
| `spotlight-apps` | bundle_id, name, category, keywords | Application search |
| `spotlight-contacts` | name, email, phone, company | Contact search |
| `spotlight-web` | url, title, description | Web history search |

---

## API Design

### Search Endpoints

```
GET  /api/search?q={query}&types={types}&limit={limit}  → Multi-source search
GET  /api/search/files?q={query}                         → File-only search
GET  /api/search/apps?q={query}                          → App-only search
GET  /api/search/contacts?q={query}                      → Contact-only search
```

### Indexing Endpoints

```
POST /api/index/files          → Index a file (body: { path, content, metadata })
POST /api/index/files/bulk     → Bulk index files
POST /api/index/reindex        → Trigger full re-index (admin)
```

### Suggestion Endpoints

```
GET  /api/suggestions           → Get proactive suggestions for current context
POST /api/suggestions/record    → Record an app launch or item access
```

### Operations Endpoints

```
GET  /health                    → Component health check (Postgres, ES, Redis)
GET  /health/ready              → Readiness probe (all dependencies connected)
GET  /alive                     → Liveness probe (process running)
GET  /metrics                   → Prometheus metrics
```

---

## Key Design Decisions

### 1. On-Device Indexing vs Cloud Search

**Decision**: All indexing and primary search happens locally.

**Why it works for Spotlight**: Privacy is a core product requirement. Users search personal files, messages, and contacts. Sending queries to a cloud service would violate user expectations and create regulatory complications (GDPR, data residency). Local indexing also provides sub-100ms latency without network round-trips.

**Why cloud search fails here**: Cloud search engines (Algolia, Elasticsearch as SaaS) require uploading all user content. For a personal search tool, this means syncing potentially hundreds of thousands of files to a remote server. The bandwidth cost, privacy risk, and latency penalty outweigh the scalability benefits. Cloud search makes sense for shared content (e-commerce catalogs, documentation sites) but not for personal device search.

**What we give up**: No cross-device search (each device has its own index), no collaborative search ranking (cannot learn from other users' queries), and index size is bounded by local storage. At production scale, Apple solves cross-device with iCloud sync of metadata (not content), preserving the privacy guarantee.

### 2. Elasticsearch + PostgreSQL Dual Storage

**Decision**: Use Elasticsearch for full-text search and PostgreSQL for metadata, usage patterns, and relational data.

**Why this combination**: Elasticsearch excels at fuzzy matching, relevance scoring, and multi-index queries. PostgreSQL provides ACID guarantees for usage pattern tracking, audit logging, and relational queries (e.g., "contacts in company X"). Using one for both would mean either losing Elasticsearch's text analysis or PostgreSQL's transactional guarantees.

**Alternative considered**: SQLite FTS5 for everything. Simpler deployment, no external dependencies, genuinely on-device. However, SQLite FTS5 lacks multi-index search, pluggable analyzers, and the fuzzy matching that Elasticsearch provides out of the box. For a learning project exploring search internals, Elasticsearch teaches more about production search architecture.

**Trade-off**: Operational complexity. Two data stores must stay in sync. Circuit breakers protect against Elasticsearch failures while PostgreSQL remains the source of truth.

### 3. Multi-Source Fusion with Graceful Degradation

**Decision**: Query all sources in parallel with per-source timeouts, return partial results if any source fails.

**Why this works**: The search bar must always return results quickly. A failing contacts provider should not block file search results. By treating provider queries as best-effort and the local index as the critical path, the system degrades gracefully: users always see file results, and provider results are added when available.

**Why strict consistency fails here**: Waiting for all sources to respond before showing results would mean the slowest provider determines the user experience. With 5+ data sources, the probability of at least one being slow is high. Eventual consistency (showing partial results that fill in) matches user expectations for a search bar.

**What we give up**: Result counts may fluctuate as slow providers respond. A file that exists in both PostgreSQL and Elasticsearch might appear twice briefly before deduplication. These are acceptable for a search UI where results update as the user types.

---

## Consistency and Idempotency

### Write Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| File indexing (PG + ES) | Eventual | ES may lag behind PG; circuit breaker skips ES when down |
| Usage pattern recording | Strong (PG) | UPSERT with conflict resolution ensures accurate counts |
| Suggestion generation | Eventual | Reads from usage patterns; slightly stale data is acceptable |
| Audit logging | Strong (PG) | Security events must not be lost |

### Idempotency

Index operations use content-hash-based idempotency: if a file's `content_hash` has not changed, the re-index is skipped. For API-level idempotency, the `Idempotency-Key` header is checked against a Redis cache (24-hour TTL). Repeated requests with the same key return the cached result without re-executing the operation.

This is critical for safe index rebuilds: running a full re-index multiple times produces the same result because each file is compared by hash, and the UPSERT in PostgreSQL is idempotent.

---

## Security / Auth

### Authentication

Session-based authentication with Redis/Valkey for session storage. Sessions expire after 24 hours, refreshed on activity.

### Authorization (RBAC)

| Operation | User | Admin |
|-----------|------|-------|
| Search local index | Yes | Yes |
| View own usage patterns | Yes | Yes |
| Query app providers | Yes | Yes |
| Re-index own directories | Yes | Yes |
| View all users' patterns | No | Yes |
| Force full re-index | No | Yes |
| Manage content extractors | No | Yes |
| View system metrics | No | Yes |

### Rate Limiting

Token bucket algorithm implemented in Redis:

| Endpoint Category | Burst | Sustained | Window |
|-------------------|-------|-----------|--------|
| Search | 100 | 10/sec | 10s |
| Suggestions | 30 | 5/sec | 10s |
| Index operations | 50 | 1/sec | 60s |
| Bulk operations | 5 | 1/min | 60s |

Rate-limited responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.

---

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `spotlight_http_request_duration_seconds` | Histogram | method, route, status_code | Request latency SLI |
| `spotlight_search_latency_seconds` | Histogram | source (local, provider, cloud) | Per-source search performance |
| `spotlight_search_result_count` | Histogram | - | Result quality monitoring |
| `spotlight_indexed_files_total` | Counter | type, status | Indexing throughput |
| `spotlight_indexing_queue_size` | Gauge | - | Backlog monitoring |
| `spotlight_provider_latency_seconds` | Histogram | provider | Provider health |
| `spotlight_provider_errors_total` | Counter | provider, error_type | Provider reliability |
| `spotlight_rate_limit_hits_total` | Counter | endpoint | Abuse detection |
| `spotlight_circuit_breaker_state` | Gauge | circuit | ES health visibility |

### Structured Logging (Pino)

JSON-formatted logs with service context, request IDs, and correlation. Log categories:

| Category | Level | Retention | Purpose |
|----------|-------|-----------|---------|
| Search queries | INFO | 7 days | Performance analysis |
| Indexing events | INFO | 3 days | Debug file watching |
| Auth events | INFO | 30 days | Security audit |
| Provider errors | WARN | 14 days | Provider health |
| System errors | ERROR | 30 days | Incident response |

### Health Checks

- `/health` - Component-level health (PostgreSQL, Elasticsearch, Redis) with latency measurements
- `/health/ready` - Readiness probe for load balancer (all dependencies connected)
- `/alive` - Liveness probe (process running, uptime)

Each health response includes circuit breaker states, idempotency store stats, and memory usage.

### SLI Targets

| SLI | Target | Measurement |
|-----|--------|-------------|
| Search latency p95 | < 100ms | `histogram_quantile(0.95, spotlight_search_latency_seconds)` |
| Search latency p99 | < 250ms | `histogram_quantile(0.99, spotlight_search_latency_seconds)` |
| Search availability | 99.5% | `1 - rate(5xx) / rate(total)` |
| Indexing queue depth | < 1000 | `spotlight_indexing_queue_size` |
| Provider success rate | > 95% | `1 - rate(errors) / rate(requests)` |

---

## Failure Handling

### Circuit Breakers

Per-index-type circuit breakers using the Opossum library protect against Elasticsearch failures:

- **Threshold**: Open after 30% failure rate within a 10-second window
- **Timeout**: 5 seconds per operation (prevents thread starvation)
- **Recovery**: Half-open after 30 seconds, allowing test requests
- **Isolation**: Separate breakers for files, apps, contacts, web indices

When a breaker opens, PostgreSQL writes still succeed (durable primary storage), and Elasticsearch updates are skipped. The idempotency layer ensures retry safety when the breaker closes.

### Retry Strategy

Exponential backoff with jitter for transient failures:
- Base delay: 100ms, max delay: 5s, max attempts: 3
- Retryable errors: `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, 5xx responses
- Non-retryable: 400, 401, 403, 404

### Graceful Degradation

The search service is designed to return partial results rather than fail entirely:

1. **Local index** (critical path): Always queried, results returned even if all providers fail
2. **Provider queries** (best-effort): Each wrapped in a circuit breaker; failures return empty arrays
3. **Timeout fence**: If providers do not respond within 3 seconds, partial results are returned
4. **Web fallback**: Always available as a last resort when fewer than 3 local results are found

---

## Scalability Considerations

### Horizontal Scaling

1. **Search service**: Stateless, scale behind load balancer. Each instance connects to shared Elasticsearch and PostgreSQL
2. **Elasticsearch**: Add nodes to the cluster for index sharding and replica distribution
3. **PostgreSQL**: Read replicas for search metadata queries; primary for writes (usage patterns, indexing)
4. **Redis**: Redis Cluster for session and cache sharding across nodes

### Index Scaling

- **Index sharding**: Elasticsearch automatically shards indices; configure shard count based on data volume
- **Index lifecycle**: Older indices can be merged, force-merged, or archived to cold storage
- **Content extraction**: CPU-intensive; scale extraction workers independently from search servers

### Bottleneck Analysis

| Component | Breaks at | Solution |
|-----------|-----------|----------|
| Elasticsearch query latency | ~1M documents per shard | Add shards, optimize mappings |
| PostgreSQL connections | ~100 concurrent | Connection pooling (PgBouncer) |
| Indexing throughput | ~1000 files/sec | Batch writes, dedicated indexing workers |
| Redis memory | ~1GB session data | TTL management, eviction policies |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Indexing location | On-device | Cloud | Privacy requirement, offline capability |
| Text search engine | Elasticsearch | SQLite FTS5 | Multi-index, fuzzy matching, analyzers |
| Metadata storage | PostgreSQL | SQLite | ACID, JSONB, relational queries |
| Session storage | Redis + cookies | JWT | Immediate revocation, simpler invalidation |
| Ranking approach | Multi-signal fusion | Pure text relevance | Apps and contacts need non-text signals |
| Indexing strategy | Incremental (file watcher) | Full periodic re-index | Lower CPU, real-time updates |
| Provider failures | Graceful degradation | Strict consistency | Search bar must always respond quickly |

---

## Frontend Architecture

### Component Hierarchy

```
App.tsx (root)
├── Background pattern               ← Radial gradient dot pattern (decorative)
├── Landing page content
│   ├── Search icon + "Spotlight Search" heading
│   ├── Open button (Cmd+K hint)     ← Calls openSpotlight() from store
│   ├── FeatureCard (x3)             ← Multi-source search, calculations, suggestions
│   └── ExampleSearch (x6)           ← Clickable query examples that open modal
├── SpotlightModal                   ← The main search overlay
│   ├── SearchInput                  ← Text input with magnifying glass icon
│   ├── SearchResults                ← Grouped result list (files, apps, contacts, etc.)
│   │   └── SearchResultItem (xN)   ← Individual result with icon, name, type badge
│   ├── Suggestions                  ← Proactive app/contact suggestions when query is empty
│   └── Footer                       ← Keyboard shortcut hints (tab, arrows, return)
└── (hooks)
    ├── useKeyboardShortcut          ← Registers Cmd+K / Ctrl+K global listener
    └── useDebounce                  ← Debounces search query input
```

### Zustand Store

The frontend uses a single Zustand store:

**`useSpotlightStore`** (`stores/spotlightStore.ts`) manages all Spotlight UI state in one flat store. It combines modal visibility, search state, keyboard navigation, and proactive suggestions.

- **Modal state**: `isOpen` boolean with `openSpotlight()` (also triggers `loadSuggestions()`), `closeSpotlight()` (also calls `clear()`), and `toggleSpotlight()` actions.
- **Search state**: `query` string, `results` array of `SearchResult` objects, `isLoading` flag, and `error` string. The `setQuery` action is the primary entry point -- it updates the query and immediately triggers `performSearch()` if the query is non-empty, or clears results if empty.
- **Keyboard selection**: `selectedIndex` integer with `selectNext()` and `selectPrevious()` actions that clamp to valid bounds. The selected index applies to either results (when query is non-empty) or suggestions (when query is empty).
- **Suggestions**: `suggestions` array of `Suggestion` objects loaded on modal open via `loadSuggestions()`, which calls `getProactiveSuggestions()` from the API.
- **Result execution**: `executeResult()` handles different result types: apps record a launch event, web results open in a new tab, calculations copy the result to clipboard. After execution, the modal closes.

### Routing

This project has no URL-based routing. The application is a single landing page with a modal overlay. The `SpotlightModal` component is rendered conditionally based on `useSpotlightStore.isOpen`. The modal is opened by clicking the "Open" button, pressing Cmd+K (Mac) or Ctrl+K (Windows/Linux), or clicking example search queries on the landing page. There are no page transitions or URL changes.

### Data Fetching

All API communication flows through standalone functions in `services/api.ts` (not a class or object -- just exported async functions). The API base is `/api` with no versioning prefix.

- **`search(query, types?)`**: Calls `GET /api/search?q={query}&types={types}`, returns `SearchResponse` with results array.
- **`getSuggestions(prefix)`**: Calls `GET /api/search/suggest?q={prefix}`, returns autocomplete suggestions.
- **`getProactiveSuggestions()`**: Calls `GET /api/suggestions`, returns time-of-day-based app/content suggestions.
- **`recordActivity(type, itemId, itemName, metadata?)`**: Calls `POST /api/suggestions/activity`, records usage for suggestion training.
- **`recordAppLaunch(bundleId)`**: Calls `POST /api/suggestions/app-launch`, records app usage pattern by hour/day.

Search is triggered reactively: when the user types, `setQuery` in the store calls `performSearch`, which calls `search()`. There is no debounce at the store level, but the `useDebounce` hook is available for components to throttle rapid input.

### Key UI Patterns

**Modal-first interaction**: The entire search experience lives inside `SpotlightModal`, a full-screen overlay positioned at 15% from the top of the viewport. Clicking the backdrop or pressing Escape closes it. The modal disables body scrolling while open and includes ARIA attributes (`role="dialog"`, `aria-modal="true"`) for accessibility.

**Keyboard-driven navigation**: The `useKeyboardShortcut` hook registers a global keydown listener for Cmd+K / Ctrl+K to toggle the modal. Inside the modal, arrow keys and Tab navigate the result list via `selectNext()` and `selectPrevious()` store actions. Enter executes the selected result. Escape closes the modal. This mimics macOS Spotlight behavior.

**Dual-mode display**: When the query is empty, the modal shows proactive suggestions (recently used apps, time-of-day recommendations). When the query has text, suggestions are replaced by search results. The `selectedIndex` store property applies to whichever list is currently visible.

**Result type differentiation**: `SearchResultItem` renders different icons and badges based on result type (file, app, contact, web, calculation, conversion). App results show the app icon, contact results show email, calculation results show the computed value. This type-aware rendering uses the `Icons` component which maps type strings to SVG icons.

**Example queries on landing page**: The `ExampleSearch` component renders clickable query previews ("Safari", "2+2*3", "100 km to miles") that open the modal and pre-fill the search query after a 100ms delay (allowing the modal animation to complete before setting the query).

**Custom CSS theme**: The Spotlight modal uses a custom color palette (`spotlight-bg`, `spotlight-border`, `spotlight-text-tertiary`, `spotlight-hover`) defined in Tailwind config, separate from the landing page's dark gradient theme. This creates the frosted-glass macOS Spotlight aesthetic.

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project from first principles. Each pattern solves a specific operational problem that emerges at scale.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing downstream service from dragging down the entire application. The name comes from electrical circuit breakers that trip to prevent a short circuit from causing a fire.

The pattern works through three states. In the **closed** state (normal operation), all requests pass through to the downstream service. The circuit breaker silently tracks the success/failure ratio of recent calls. When the failure rate crosses a threshold (configured at 30% within a 10-second window in this project via Opossum), the breaker transitions to the **open** state. In the open state, all requests fail immediately -- the application does not even attempt to call the downstream service. This is the key benefit: instead of every search request waiting 5 seconds for an Elasticsearch timeout (which would make the search bar feel frozen), requests fail in 0 milliseconds and the system can fall back to PostgreSQL-only results. After a 30-second cooldown, the breaker enters the **half-open** state, allowing test requests through. If those succeed, the breaker closes; if they fail, it reopens.

This project implements per-index circuit breakers, meaning the files index, apps index, contacts index, and web index each have their own independent breaker. If the contacts index is corrupted, only contact search degrades -- file and app search continue working normally. This isolation is critical for the multi-source fusion design: the search service returns partial results from healthy sources rather than failing entirely.

**File**: `backend/src/shared/circuitBreaker.ts`

### Structured Logging

Structured logging means writing log entries as machine-parseable data (typically JSON) rather than free-form text strings. Traditional logs look like `"Search for 'meeting notes' returned 5 results in 45ms"` -- a human can read this, but extracting the query, result count, or latency programmatically requires fragile regex parsing. Structured logs look like `{"event":"search","query":"meeting notes","resultCount":5,"durationMs":45,"sources":["files","apps"]}` -- every field is a named key-value pair that log aggregation tools can index, search, and alert on.

This project uses Pino, a high-performance Node.js logging library that outputs JSON in production and pretty-printed text in development. Log categories are defined with different retention periods: search queries (7 days) for performance analysis, indexing events (3 days) for debugging file watcher issues, auth events (30 days) for security audit, provider errors (14 days) for provider health tracking, and system errors (30 days) for incident response. At production scale, these retention policies would be enforced by the log aggregation system (Elasticsearch index lifecycle management or CloudWatch log groups).

**File**: `backend/src/shared/logger.ts`

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements (metrics) from applications at regular intervals. The application exposes an HTTP endpoint (`/metrics`) that returns current metric values in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the data, enabling dashboards (Grafana) and alerting rules.

There are four main metric types. **Counters** only go up (total requests served, total files indexed). **Gauges** go up and down (current indexing queue size, active connections). **Histograms** track the distribution of values (search latency buckets for computing p50/p90/p99). **Summaries** compute quantiles on the client side.

This project defines nine specific metrics: HTTP request duration histogram (the primary SLI), per-source search latency histogram (for identifying slow providers), search result count histogram (for result quality monitoring), indexed files counter, indexing queue size gauge, provider latency histogram, provider error counter, rate limit hit counter, and circuit breaker state gauge. SLI targets are defined: search p95 < 100ms, search p99 < 250ms, availability > 99.5%, indexing queue depth < 1000, provider success rate > 95%. These targets would trigger alerts when breached at production scale.

**File**: `backend/src/shared/metrics.ts`

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window, protecting the server from abuse, accidental loops, and denial-of-service attacks. Without rate limiting, a single misbehaving client could consume all server resources and deny service to legitimate users.

This project implements a **token bucket** algorithm in Redis with four endpoint tiers: search (100 burst, 10/sec sustained), suggestions (30 burst, 5/sec sustained), index operations (50 burst, 1/sec sustained), and bulk operations (5 burst, 1/min sustained). The token bucket algorithm works by maintaining a "bucket" of tokens that refills at a steady rate. Each request consumes one token. When the bucket is empty, requests are rejected. The bucket has a maximum capacity (the burst limit), allowing short bursts of traffic while enforcing a sustained rate.

Token bucket is preferred over sliding window for this use case because search is inherently bursty -- a user types a query and the frontend fires several search requests in quick succession as the debounce triggers. The burst allowance accommodates this without penalizing the user. Rate-limited responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers so clients can self-throttle before hitting the limit.

**File**: `backend/src/shared/rateLimiter.ts`

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This is critical in distributed systems where network failures cause retries: if a client sends a `POST /api/index/files` request and the network drops the response, the client will retry, potentially indexing the same file twice.

This project implements idempotency at two levels. At the data level, file indexing uses content-hash-based deduplication: if a file's `content_hash` has not changed since the last index, the re-index is skipped entirely. The `indexed_files` table uses `path` as the primary key, so UPSERT operations naturally produce the same result regardless of how many times they execute. At the API level, the `Idempotency-Key` header is checked against a Redis cache with a 24-hour TTL. Repeated requests with the same key return the cached response without re-executing the operation.

This dual-layer idempotency is critical for safe index rebuilds: running a full re-index (which may process hundreds of thousands of files) multiple times produces identical results because each file is compared by hash, and the PostgreSQL UPSERTs and Elasticsearch document updates are individually idempotent.

**File**: `backend/src/shared/idempotency.ts`

### Health Checks

A health check is an HTTP endpoint that reports whether the application is functioning correctly. Load balancers, container orchestrators (Kubernetes), and monitoring systems call this endpoint periodically to determine if an instance should receive traffic.

This project implements three health check variants. The `/health` endpoint performs component-level checks against PostgreSQL (test query), Elasticsearch (cluster health), and Redis (ping), returning latency measurements for each. The `/health/ready` endpoint is a readiness probe that confirms all dependencies are connected -- the load balancer uses this to know when a newly started instance is ready to receive traffic. The `/alive` endpoint is a liveness probe that confirms the process is running and returns uptime -- container orchestrators use this to detect deadlocks (a process that is running but not responding).

Each health response includes circuit breaker states, idempotency store statistics, and memory usage. This comprehensive health payload helps operators quickly diagnose issues during incidents: if `/health` shows Elasticsearch latency at 5 seconds and the circuit breaker for the files index is open, the operator knows exactly what is failing and why search results may be partial.

**File**: `backend/src/index.ts`

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache hit, the cached value is returned immediately (sub-millisecond latency). On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it to the caller.

In this project, Redis serves multiple roles: session storage (24-hour TTL), idempotency key cache (24-hour TTL), rate limit token buckets, and general query caching. The search service does not cache individual search results (because queries are highly variable), but the suggestion service could cache proactive suggestions since they change infrequently (based on time-of-day patterns that shift slowly).

Cache invalidation is simpler in this project than in typical CRUD applications because the primary data flow is write-heavy indexing followed by read-heavy searching. Elasticsearch handles its own indexing/caching internally, so the Redis cache-aside pattern is primarily used for PostgreSQL metadata queries (usage patterns, recent activity, contact lookups) where the same data is requested repeatedly within short time windows.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of granting individual permissions to each user, you define roles and assign permission sets to each role.

This project implements a two-tier RBAC model: **user** and **admin**. Regular users can search the local index, view their own usage patterns, and query app providers. Admin users can additionally view all users' patterns, force a full re-index, manage content extractors, and view system metrics. The RBAC table in the Security section maps each operation to the roles that can perform it.

The key design consideration for Spotlight's RBAC is that most operations are read-only searches that any authenticated user should be able to perform. The admin role exists primarily for operational tasks (re-indexing, metrics access) that could cause performance impact if triggered by regular users. A full re-index, for example, is CPU-intensive and could degrade search latency for all users if triggered frequently. Restricting it to admin prevents accidental or malicious performance degradation.

At production scale, RBAC for a search system might also include content-level permissions (can this user see files in this directory?), which would require integrating with the operating system's file permission model rather than implementing custom RBAC tables.

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌─────────────────────────────────────────────┐
│           React Frontend (:5173)            │
│  Vite + TypeScript + Tailwind CSS           │
│  SpotlightModal, SearchResults, Suggestions │
└──────────────────────┬──────────────────────┘
                       │ HTTP (fetch)
                       ▼
┌─────────────────────────────────────────────┐
│      Express Backend (:3000 / :3001-3003)   │
│  /api/search, /api/index, /api/suggestions  │
│  /health, /metrics                          │
└───────┬──────────────┬──────────────┬───────┘
        │              │              │
        ▼              ▼              ▼
┌────────────┐  ┌────────────┐  ┌──────────┐
│Elasticsearch│  │ PostgreSQL │  │  Valkey  │
│   (:9200)  │  │  (:5432)   │  │  (:6379) │
│ 4 indices  │  │ 6 tables   │  │ sessions │
└────────────┘  └────────────┘  └──────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Library | File | Purpose |
|---------|---------|------|---------|
| Circuit breakers | Opossum | `backend/src/shared/circuitBreaker.ts` | Per-index ES failure isolation |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | Request latency, search counts, provider health |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with request IDs, audit events |
| Rate limiting | express-rate-limit | `backend/src/shared/rateLimiter.ts` | Token bucket per endpoint category |
| Idempotency | Custom + Redis | `backend/src/shared/idempotency.ts` | Safe retries for index operations |
| Health checks | Custom | `backend/src/index.ts` | Component health, readiness, liveness |
| Query parsing | Custom | `backend/src/services/queryParser.ts` | Math, conversions, web fallback |
| Suggestion engine | Custom | `backend/src/services/suggestions.ts` | Time-of-day app usage patterns |

### Simplifications and Substitutions

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| CDN for static assets | Vite dev server | No need for edge caching locally |
| API Gateway (rate limiting, auth routing) | Express middleware | Single process handles all concerns |
| File system watcher + extraction pipeline | API-driven indexing via seed script | No real filesystem events to watch |
| On-device SQLite for indexing | Elasticsearch (cloud-style) | Learning Elasticsearch architecture |
| OAuth / Apple ID authentication | No auth (open endpoints) | Not studying auth in this project |
| Multi-region replication | Single instance | Local development only |
| Kafka for indexing events | Direct Elasticsearch writes | No async pipeline needed at this scale |

### What Was Omitted

- **CDN and edge caching**: No static asset optimization
- **Multi-region / multi-device sync**: Single local instance
- **Kubernetes orchestration**: Docker Compose for infrastructure services
- **ML-based ranking**: Rule-based scoring instead of learned models
- **Real file system watcher**: Content indexed via API/seed, not inotify/FSEvents
- **Content extraction (Apache Tika)**: Seed script provides pre-extracted content
- **Location-based suggestions**: No GPS/location signals in local setup
- **A/B testing framework**: Single ranking algorithm, no experimentation
