# Pinterest - Image Pinning Platform - Architecture

## System Overview

Pinterest is a visual discovery platform where users save images (Pins) to organized collections (Boards). The core interaction model is save-based rather than like-based: users curate content into themed boards, creating a network of visual inspiration. Key technical challenges include masonry layout with variable-height virtualization, async image processing pipelines, and save-based engagement ranking.

**Learning Goals:**
- Masonry layout algorithm with variable-height virtualization
- Image processing pipeline (dimensions, aspect ratio, dominant color extraction)
- Save-based engagement model (boards) vs. like-based engagement
- Visual content feed generation and ranking

---

## Requirements

### Functional Requirements

1. Users can upload images as Pins with title, description, and destination link
2. Users organize Pins into Boards (curated collections)
3. Users can save any Pin to their own Boards
4. Users follow other users to see their Pins in a personalized feed
5. Masonry grid layout adapts to variable-height images without layout shift
6. Full-text search across pins, users, and boards
7. Pin detail view with comments

### Non-Functional Requirements (Production Scale)

- Support 450M monthly active users, 100M DAU
- Handle 5B+ Pins stored
- Image processing latency < 30s from upload to published
- Feed generation p99 < 200ms
- 99.95% uptime
- Support images up to 20MB upload size

---

## Capacity Estimation

### Production Scale

- **Users**: 450M MAU, 100M DAU
- **Pins**: 5B total, 2M new pins/day (~23 pins/sec)
- **Saves**: 10x pins created = 20M saves/day (~230/sec)
- **Image storage**: Average 2MB per image * 5B = ~10 PB (originals + thumbnails)
- **Feed reads**: 100M DAU * 10 feed views/day = 1B feed requests/day (~11,500 QPS)
- **Image processing**: 23 pins/sec requiring dimension extraction, color analysis, thumbnail generation

### Local Development Scale

- 2-5 concurrent users, ~10 pins, 3-6 boards per user
- Single PostgreSQL instance, single RabbitMQ queue
- MinIO for S3-compatible object storage
- Valkey for session and feed cache

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                    (Web / Mobile / Progressive Web App)                   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │    CDN (Images)    │
                     │  CloudFront / BOS  │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │   API Gateway /    │
                     │   Load Balancer    │
                     └─────────┬─────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
┌─────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│  Pin Service     │ │  Board Service  │ │  Feed Service   │
│  (Upload, CRUD)  │ │  (Collections)  │ │  (Ranking)      │
└─────────┬────────┘ └────────┬────────┘ └────────┬────────┘
          │                    │                    │
          │         ┌──────────┴──────────┐         │
          │         │                     │         │
┌─────────▼─────────▼───┐  ┌─────────────▼─────────▼───┐
│     PostgreSQL         │  │        Valkey/Redis        │
│  (Users, Pins, Boards, │  │  (Sessions, Feed Cache,   │
│   Follows, Saves)      │  │   Rate Limiting)          │
└────────────────────────┘  └───────────────────────────┘
          │
┌─────────▼─────────┐     ┌──────────────────────┐
│   Message Queue   │────▶│  Image Worker(s)     │
│   (RabbitMQ)      │     │  - Extract dimensions │
└───────────────────┘     │  - Aspect ratio       │
                          │  - Dominant color      │
                          │  - Thumbnail gen       │
                          └──────────┬─────────────┘
                                     │
                          ┌──────────▼─────────────┐
                          │   Object Storage       │
                          │   (S3 / MinIO)         │
                          │   - Originals          │
                          │   - Thumbnails         │
                          └────────────────────────┘
```

At production scale, the architecture would add:
- **CDN** (CloudFront) in front of S3 for global image distribution
- **Elasticsearch** for full-text search with visual similarity
- **ML pipeline** for pin recommendations, visual similarity search, and categorization
- **Multiple worker pools** scaled independently based on upload volume
- **Sharded PostgreSQL** with read replicas for feed queries

---

## Core Components

### 1. Image Processing Pipeline

**Challenge**: Users upload raw images of varying sizes and formats. The platform needs dimensions, aspect ratio, dominant color (for placeholder), and optimized thumbnails before images appear in the grid.

**Pipeline flow**:

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌──────────────┐
│  Client   │────▶│  API      │────▶│  MinIO   │────▶│  RabbitMQ    │
│  Upload   │     │  Server   │     │ Original │     │  Job Queue   │
└──────────┘     └───────────┘     └──────────┘     └──────┬───────┘
                                                           │
                                                    ┌──────▼───────┐
                                                    │ Image Worker  │
                                                    │              │
                                                    │ 1. Download  │
                                                    │ 2. Metadata  │
                                                    │ 3. Aspect    │
                                                    │ 4. Color     │
                                                    │ 5. Thumbnail │
                                                    │ 6. Upload    │
                                                    │ 7. Update DB │
                                                    └──────────────┘
```

**Worker processing steps**:
1. **Download original** from MinIO
2. **Extract metadata** via `sharp.metadata()`: width, height, format
3. **Calculate aspect_ratio** = `height / width`
4. **Extract dominant color** via `sharp.stats()` -> RGB -> hex string
5. **Generate thumbnail** at 300px width, WebP format, 80% quality
6. **Upload thumbnail** to MinIO under `thumbnails/{pinId}/thumb.webp`
7. **Update pin record**: set `image_width`, `image_height`, `aspect_ratio`, `dominant_color`, `status='published'`

**Why async processing**: Synchronous image processing in the upload request would block for 2-10 seconds depending on image size. At 23 uploads/sec, this consumes 23 worker threads permanently. Async processing via RabbitMQ decouples upload latency from processing latency, returns immediately with `status: 'processing'`, and enables independent scaling of workers.

**Retry semantics**: If a worker crashes mid-processing, the RabbitMQ message is not acknowledged. RabbitMQ redelivers to another worker. Each processing step is idempotent: uploading the thumbnail overwrites the same MinIO key, and the database UPDATE sets absolute values (not increments). Failed images after exhausting retries get `status='failed'` and route to a dead letter queue.

### 2. Masonry Layout Algorithm

**Challenge**: Pinterest's signature layout places variable-height items into columns, finding the shortest column for each new item. With hundreds of pins, rendering all DOM nodes is prohibitively expensive.

**Algorithm (useMasonryLayout hook)**:

```
Input: pins[] with aspect_ratio, columnCount, columnWidth
Output: items[] with {pin, column, top, height}

columnHeights = [0, 0, 0, 0, ...]  // Track height of each column

for each pin:
    shortestColumn = findMin(columnHeights)
    imageHeight = columnWidth * pin.aspect_ratio
    totalHeight = imageHeight + PIN_PADDING

    item = {
        pin,
        column: shortestColumn,
        top: columnHeights[shortestColumn],
        height: totalHeight
    }

    columnHeights[shortestColumn] += totalHeight + GAP
```

**Why aspect_ratio = height / width**: The formula `columnWidth * aspectRatio` gives the pixel height directly with one multiplication. No division at render time. This design decision permeates the entire system: the image worker extracts aspect_ratio during processing, the database stores it as a float, the API returns it with pin data, and the frontend consumes it without transformation.

**Responsive column count**:

| Viewport | Columns | Column Width |
|----------|---------|--------------|
| < 500px | 2 | ~230px |
| 500-768px | 3 | ~230px |
| 768-1024px | 4 | ~236px |
| 1024-1280px | 5 | ~236px |
| > 1280px | 6 | ~236px |

**Virtualization strategy**: Items use absolute positioning (not CSS columns) with pre-calculated `top` and `left` values. This enables scroll-based virtualization: only items whose `top` falls within `[scrollTop - overscan, scrollTop + viewportHeight + overscan]` are rendered. A `ResizeObserver` watches container width to recalculate column count dynamically.

**Why not CSS columns?** CSS `column-count` reflows items top-to-bottom within columns, then left-to-right across columns. This produces a reading order that does not match chronological or relevance order. Absolute positioning with JavaScript assignment places items in relevance order while minimizing column height differences.

### 3. Save-Based Engagement Model

Pinterest's core mechanic is saving, not liking. This creates fundamentally different user behavior and data modeling:

| Aspect | Save-Based (Pinterest) | Like-Based (Instagram) |
|--------|----------------------|----------------------|
| User intent | Collect for future reference | Express approval |
| Content lifecycle | Long-lived, revisited | Ephemeral, scroll past |
| Data model | pin_saves with board reference | Simple likes table |
| Ranking signal | save_count (high intent) | like_count (low friction) |
| Organization | User-created boards | No organization |

**Implications for the data model**: There is no `likes` table. Instead, `pin_saves` links a pin to a user and a board. The same pin can appear in multiple boards (many-to-many via `board_pins`). `save_count` on pins indicates popularity because saving requires deliberate curation, making it a stronger engagement signal than a tap-to-like.

### 4. Feed Generation (Pull Model)

**Chosen**: Pull model with 60-second cache TTL.

The feed query combines pins from followed users with popular discover pins:

```sql
-- Personalized feed: pins from followed users
SELECT pins.* FROM pins
JOIN follows ON pins.user_id = follows.following_id
WHERE follows.follower_id = $1 AND pins.status = 'published'
ORDER BY pins.created_at DESC
LIMIT 20

UNION ALL

-- Discover feed: popular pins not from followed users
SELECT pins.* FROM pins
WHERE pins.status = 'published' AND pins.save_count > threshold
ORDER BY pins.save_count DESC
LIMIT 10
```

**Why pull model for Pinterest**: Most Pinterest users follow a moderate number of accounts (median ~100). The pull query operates on a predictable dataset. Cache TTL of 60 seconds avoids repeated expensive queries while ensuring new pins appear within a minute. Cache is explicitly invalidated on follow/unfollow.

**Why not fanout-on-write**: Pinterest's browsing pattern is exploration-oriented, not real-time. Users do not expect instant delivery of new pins. Fanout would create write amplification when popular creators post, consuming resources for a latency improvement users do not perceive.

---

## Database Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url TEXT,
    bio TEXT,
    follower_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pins (core entity)
CREATE TABLE pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255),
    description TEXT,
    image_url TEXT NOT NULL,
    image_width INT,           -- Extracted by worker
    image_height INT,          -- Extracted by worker
    aspect_ratio FLOAT,        -- height/width, critical for masonry
    dominant_color VARCHAR(7), -- Hex color for placeholder (#RRGGBB)
    link_url TEXT,             -- Destination URL
    status VARCHAR(20) DEFAULT 'processing',  -- processing -> published | failed
    save_count INT DEFAULT 0,
    comment_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Boards (curated collections)
CREATE TABLE boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    cover_pin_id UUID REFERENCES pins(id) ON DELETE SET NULL,
    is_private BOOLEAN DEFAULT false,
    pin_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- Board Pins (many-to-many)
CREATE TABLE board_pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    position INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(board_id, pin_id)
);

-- Pin Saves (user saves pin to board)
CREATE TABLE pin_saves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pin_id, user_id, board_id)
);

-- Social graph (follows)
CREATE TABLE follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id),
    CHECK(follower_id != following_id)
);

-- Pin Comments
CREATE TABLE pin_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id UUID NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_comment_id UUID REFERENCES pin_comments(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Index Strategy

| Table | Index | Purpose |
|-------|-------|---------|
| `pins` | `(user_id, created_at DESC)` | User's pins feed |
| `pins` | `(status, created_at DESC)` | Published pins listing |
| `pins` | `(save_count DESC)` | Popular pins ranking |
| `board_pins` | `(board_id, position)` | Board pin ordering |
| `follows` | `(follower_id)`, `(following_id)` | Social graph lookups |
| `pin_saves` | `(pin_id)`, `(user_id)`, `(board_id)` | Save existence checks |
| `pin_comments` | `(pin_id, created_at DESC)` | Comment listing |

---

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login with credentials |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/auth/me` | Get current user |

### Pins

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/pins` | Create pin (multipart upload) |
| GET | `/api/v1/pins/:pinId` | Get pin details with comments |
| DELETE | `/api/v1/pins/:pinId` | Delete own pin |
| POST | `/api/v1/pins/:pinId/save` | Save pin to board |
| DELETE | `/api/v1/pins/:pinId/save` | Unsave pin from board |
| GET | `/api/v1/pins/:pinId/comments` | Get pin comments |
| POST | `/api/v1/pins/:pinId/comments` | Add comment |

### Boards

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/boards` | Create board |
| GET | `/api/v1/boards/:boardId` | Get board details |
| PUT | `/api/v1/boards/:boardId` | Update board |
| DELETE | `/api/v1/boards/:boardId` | Delete board |
| GET | `/api/v1/boards/:boardId/pins` | Get board's pins |

### Feed

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/feed` | Personalized feed (auth required) |
| GET | `/api/v1/feed/discover` | Discover/explore feed (public) |

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/users/:username` | Get user profile |
| GET | `/api/v1/users/:username/pins` | Get user's pins |
| GET | `/api/v1/users/:username/boards` | Get user's boards |
| POST | `/api/v1/users/:userId/follow` | Follow user |
| DELETE | `/api/v1/users/:userId/follow` | Unfollow user |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/search/pins?q=` | Search pins |
| GET | `/api/v1/search/users?q=` | Search users |
| GET | `/api/v1/search/boards?q=` | Search boards |

---

## Key Design Decisions

### 1. Storing Dominant Color in Database

**Chosen**: Extract and store hex color during image processing.
**Alternative**: Compute client-side with canvas.

Server-side extraction during the image processing pipeline ensures consistent results across all clients and devices. The color is available immediately when pin data loads (before the image itself), enabling smooth placeholder rendering. Only 7 bytes per pin (`#RRGGBB`). Client-side canvas extraction would require downloading the full image before computing the color, defeating the purpose of having a placeholder.

### 2. WebP Thumbnails

**Chosen**: WebP at 80% quality for all thumbnails.
**Alternative**: JPEG at 85% quality.

WebP provides 25-35% better compression at equivalent visual quality. Since thumbnails are the most-loaded assets (every pin in the grid loads a thumbnail), this directly reduces bandwidth. At 1B feed requests/day with 20 pins per request, thumbnail bandwidth dominates network costs. The 25% saving translates to significant infrastructure cost reduction.

### 3. Save-Based vs Like-Based Engagement

**Chosen**: Save-based with board reference.
**Alternative**: Like-based (simple toggle).

Pinterest's value proposition is curation, not reaction. A save requires selecting a board, which signals intentional content organization. This produces a stronger engagement signal for ranking (save_count) and creates a richer data model (users' boards reveal interests for recommendation). Like-based engagement would be simpler to implement but would lose the organizational structure that makes Pinterest unique.

### 4. Pull Model for Feed

**Chosen**: Pull model (compute on read) with 60-second cache.
**Alternative**: Push model (fanout on write).

Pinterest users browse casually, checking the platform a few times per day. They do not expect real-time delivery of new pins. The pull model computes the feed from a simple UNION query (followed users' pins + popular pins), caches for 60 seconds, and avoids write amplification entirely. A popular creator with 10M followers posting a pin would trigger 10M fanout writes in the push model. In the pull model, this is a non-event.

**What we give up**: Up to 60 seconds of staleness in the feed. For a browsing-oriented platform where content has long shelf life (pins are revisited months later), this is imperceptible.

---

## Consistency and Idempotency

### Idempotent Pin Saves

The `pin_saves` table enforces `UNIQUE(pin_id, user_id, board_id)`. Save operations use `INSERT ... ON CONFLICT DO NOTHING`. The `save_count` and `pin_count` counters increment conditionally (only when the insert actually succeeds). Repeated save requests are no-ops at the database level.

For unsave operations, the DELETE is naturally idempotent (deleting a non-existent row is a no-op). Counter decrements are tied to the number of rows actually deleted.

### Retry Semantics for Image Processing

Each step within the worker is idempotent: uploading the thumbnail to MinIO overwrites the same object key, and the database UPDATE sets fields to absolute values. The pin's status transitions from `processing` to `published` (or `failed`), with guards checking current status before updating.

### Pin Creation Idempotency

Pin creation uses a client-generated idempotency key (UUID) in the `X-Idempotency-Key` header. The server stores this key in Valkey with a 24-hour TTL alongside the created pin ID. Duplicate requests return the original pin ID and 200 status instead of creating duplicates.

### Feed Consistency

Feed is derived from current database state at read time, not maintained as a separate materialized view. Each feed request either hits the cache (consistent snapshot) or queries the database (latest state). Cache invalidation on follow/unfollow ensures high-impact actions are reflected immediately.

---

## Security / Auth

- **Session-based auth** with Valkey-backed sessions (`connect-redis`, cookie: `connect.sid`)
- **bcryptjs** password hashing
- **Rate limiting** (`express-rate-limit` + `rate-limit-redis`): 10 pins/min, 5 login attempts/min, 30 follows/min
- **CORS**: Restricted to frontend origin
- **File upload validation**: Whitelist MIME types (JPEG, PNG, WebP, GIF), 20MB max
- **Input sanitization**: Parameterized SQL queries prevent injection
- **CSRF protection**: SameSite=Lax cookies

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | Request latency by method/route/status |
| `http_requests_total` | Counter | Request count by method/route/status |
| `pins_created_total` | Counter | Pin creation rate |
| `pin_saves_total` | Counter | Save action rate |
| `image_processing_duration_seconds` | Histogram | Worker processing time |
| `image_processing_errors_total` | Counter | Worker error count |
| `feed_generation_duration_seconds` | Histogram | Feed query time |
| `feed_cache_hits_total` / `feed_cache_misses_total` | Counter | Cache effectiveness |

### Health Checks

- `GET /api/health` - Overall health with timestamp
- `GET /api/health/live` - Liveness probe
- `GET /metrics` - Prometheus scrape endpoint

### Structured Logging

Pino logger with JSON output (`pino-http` for request logging), including service name, environment context, and request correlation.

---

## Failure Handling

- **Circuit breaker** (Opossum) wraps external service calls (MinIO, RabbitMQ) with 50% error threshold, 30-second reset timeout. Prevents cascade failures when infrastructure services are degraded
- **Dead letter queue** for failed image processing jobs. After exhausting retries, messages route to DLQ for manual inspection
- **Graceful degradation**: If Valkey is down, session creation fails but existing cached data still serves. Pins still upload but processing may be delayed
- **Idempotent saves**: `ON CONFLICT DO NOTHING` prevents duplicate board_pins entries regardless of retry count
- **Image processing failure**: Pins get `status='failed'` with default `dominant_color='#cccccc'` and `aspect_ratio=1`. Can be reprocessed by re-enqueueing

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless (sessions in Valkey), scale behind load balancer
2. **Image workers**: Independent consumers, scale by adding more worker instances. At peak upload rates, spin up additional workers
3. **Database reads**: Add read replicas for feed queries and search
4. **Feed optimization**: Introduce hybrid push/pull model for accounts with >10K followers
5. **Image serving**: CDN in front of S3 for global distribution. Edge caching reduces origin traffic by 90%+
6. **Search**: Move from PostgreSQL ILIKE to Elasticsearch for full-text search with visual similarity
7. **Caching**: Distributed Valkey Cluster for session and feed caching

### Sharding Strategy (Future)

- **Pins table**: Shard by `user_id` hash (user's pins are co-located)
- **Board_pins**: Shard by `board_id` (board contents are co-located)
- **Follows**: Shard by `follower_id` (outgoing follows co-located for feed generation)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Engagement model | Save-based | Like-based | Matches Pinterest's curation UX, stronger signal |
| Feed strategy | Pull + cache | Push (fanout) | Simpler, sufficient for moderate follow counts |
| Image metadata | Server-side extraction | Client-side canvas | Consistent, available before image loads |
| Thumbnail format | WebP | JPEG | 25-35% smaller at equivalent quality |
| Session storage | Valkey + cookie | JWT | Immediate revocation, simpler state management |
| Masonry layout | Absolute positioning | CSS columns | Enables virtualization and correct item order |
| Search | PostgreSQL ILIKE | Elasticsearch | Simpler for learning; would migrate for production |
| Queue | RabbitMQ | Kafka | Simpler setup, job semantics fit image processing |

---

## Implementation Notes

### Local Architecture

```
┌───────────────────┐     ┌───────────────────────────┐
│   React Frontend  │────▶│   Express API Server      │
│   localhost:5173   │     │   localhost:3000           │
│                   │     │                           │
│  MasonryGrid      │     │  Routes:                  │
│  useMasonryLayout │     │  /api/v1/auth/*           │
│  PinCard          │     │  /api/v1/pins/*           │
│  SaveToBoard      │     │  /api/v1/boards/*         │
│  BoardGrid        │     │  /api/v1/feed/*           │
│  SearchBar        │     │  /api/v1/users/*          │
│  CreatePin        │     │  /api/v1/search/*         │
└───────────────────┘     │                           │
                          │  /api/health, /metrics    │
                          └──┬────┬────┬────┬─────────┘
                             │    │    │    │
              ┌──────────────▼┐ ┌─▼────▼──┐ │
              │ PostgreSQL    │ │ Valkey   │ │
              │ :5432         │ │ :6379    │ │
              │ pinterest/    │ │ sessions │ │
              │ pinterest123  │ │ feed     │ │
              └───────────────┘ │ rate lim │ │
                                └──────────┘ │
                    ┌────────────────────────▼┐
                    │     RabbitMQ            │
                    │     :5672 (AMQP)        │
                    │     :15672 (Mgmt UI)    │
                    │     image_processing    │
                    │     pinterest/          │
                    │     pinterest123        │
                    └────────────┬────────────┘
                                │
              ┌─────────────────▼─────────────┐
              │     Image Worker              │
              │     npm run dev:worker        │
              │     (Sharp + MinIO client)    │
              └─────────────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │     MinIO               │
                    │     :9000 (API)         │
                    │     :9001 (Console)     │
                    │     minioadmin/         │
                    │     minioadmin          │
                    │     bucket:             │
                    │     pinterest-images    │
                    └─────────────────────────┘
```

### Production-Grade Patterns Implemented

1. **Async image processing** (`src/workers/image-worker.ts`): Separate worker process consumes from RabbitMQ, downloads originals from MinIO, extracts dimensions and dominant color via Sharp, generates 300px WebP thumbnails, uploads to MinIO, and updates the pin record. Pins start with `status: 'processing'` and transition to `published` or `failed`.

2. **Circuit breaker** (`src/services/circuitBreaker.ts`): Opossum wraps external service calls (MinIO, RabbitMQ). Opens after 50% error rate across 5 requests, resets after 30 seconds. Logs state transitions (open/halfOpen/close) via Pino.

3. **Prometheus metrics** (`src/services/metrics.ts`): HTTP request duration/count, business events (pins created, saves), image processing duration/errors, feed cache hits/misses. Default Node.js metrics included.

4. **Structured logging** (`src/services/logger.ts`): Pino with JSON output and `pino-http` for request-scoped logging. Consistent structured fields across API server and image worker.

5. **Rate limiting** (`src/services/rateLimiter.ts`): `express-rate-limit` with Redis backend (`rate-limit-redis`) for distributed rate limiting. Per-endpoint limits prevent abuse of expensive operations.

6. **Health checks** (`src/index.ts`): Liveness endpoint and Prometheus metrics endpoint. PostgreSQL and Valkey connectivity checked.

7. **Masonry layout** (`frontend/src/hooks/useMasonryLayout.ts`): Column-height tracking with shortest-column assignment. Pre-calculated heights from `aspect_ratio` stored in the database. Responsive column count via container width observation.

8. **Dominant color placeholders** (`frontend/src/components/PinCard.tsx`): Each pin card renders a colored background from `dominant_color` before the image loads, preventing layout shift and providing visual continuity.

9. **Feed caching** (`src/services/feedService.ts`): Pull-based feed with Valkey cache. Personalized feed (followed users' pins) and discover feed (popular pins). Cache invalidated on follow/unfollow.

10. **Idempotent saves** (`src/routes/pins.ts`): `ON CONFLICT DO NOTHING` for saves. Counter updates conditional on actual row insertion.

### What Was Simplified

| Production Design | Local Implementation |
|-------------------|---------------------|
| S3 + CloudFront CDN | MinIO (S3-compatible, local storage) |
| Sharded PostgreSQL + read replicas | Single PostgreSQL instance |
| Elasticsearch for search | PostgreSQL ILIKE queries |
| OAuth/SSO | Session-based auth with bcrypt |
| ML-based recommendations | Simple save_count ranking |
| Distributed worker pool | Single worker process |
| picsum.photos URLs in seed data | Simulates already-processed images |

### What Was Omitted

- CDN for image distribution
- Multi-region deployment
- Kubernetes orchestration
- ML-based pin recommendations
- Visual similarity search (image embeddings)
- Pin categorization and tagging
- Notification system (email, push)
- A/B testing framework
- Image moderation / NSFW detection
- Pinterest Lens (visual search from camera)
- Rich pins (recipe, product, article metadata)

---

## Frontend Architecture

### Component Hierarchy

```
__root (RootLayout)
├── Header                          # Fixed top bar with logo, search, auth controls
├── Outlet (route-specific content)
│   ├── / (HomePage)                # Masonry grid feed with search overlay
│   │   ├── MasonryGrid             # Virtualized masonry layout container
│   │   │   └── PinCard[]           # Individual pin with dominant color placeholder
│   │   └── SaveToBoard (modal)     # Board selection modal for saving pins
│   ├── /pin/$pinId                 # Pin detail with full image + comments
│   ├── /create                     # Pin creation with file upload
│   ├── /profile/$username          # User profile with Created/Saved tabs
│   │   ├── MasonryGrid             # User's pins in masonry layout
│   │   └── BoardGrid               # User's boards in a standard grid
│   │       └── BoardCard[]         # Board thumbnail with pin count
│   ├── /board/$boardId             # Board detail with pins in masonry
│   ├── /login                      # Login form
│   └── /register                   # Registration form
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`): Manages authentication state without persistence middleware. Stores `user`, `isLoading`, and `error`. The `checkAuth` action is called on app mount to validate the session cookie. Unlike other projects in this repository that use `persist`, this store does not cache the user in localStorage. Every page load validates against the server, which is simpler but means a brief loading spinner on every cold start.

**`usePinStore`** (`stores/pinStore.ts`): Manages the feed state with cursor-based pagination. Stores `feedPins` (array of loaded pins), `feedCursor` (opaque cursor string for the next page), `feedLoading`, and `feedError`. Provides two loading actions: `loadFeed` (personalized, from followed users) and `loadDiscoverFeed` (popular pins, for unauthenticated users). Both actions append to the existing `feedPins` array unless `reset=true` is passed. A guard prevents concurrent loads (`if (state.feedLoading) return`) and stops loading when the cursor is exhausted. The `clearFeed` action resets the store when the user logs in/out or when switching between search and feed modes.

This two-store architecture (auth + feed) is the minimum needed: auth state is global, and feed state must persist across the MasonryGrid's re-renders during scroll.

### Routing

TanStack Router with file-based routing. The root layout renders a fixed `Header` with `pt-[64px]` padding on the main content area to prevent overlap.

| File | URL Pattern | Purpose |
|------|-------------|---------|
| `routes/index.tsx` | `/` | Home feed (masonry grid) or search results via `?q=` |
| `routes/pin.$pinId.tsx` | `/pin/:pinId` | Pin detail with comments |
| `routes/create.tsx` | `/create` | Pin creation with file upload |
| `routes/profile.$username.tsx` | `/profile/:username` | User profile (pins + boards) |
| `routes/board.$boardId.tsx` | `/board/:boardId` | Board detail with pins |
| `routes/login.tsx` / `routes/register.tsx` | `/login`, `/register` | Authentication |

Search is handled inline on the home page via the `?q=` search parameter. When `q` is present and at least 2 characters, the home page switches from feed mode to search mode, displaying search results in the same MasonryGrid.

### Data Fetching

The API client (`services/api.ts`) exports individual async functions (not a namespace object) for each endpoint. Each function is fully typed with request and response types. The client handles FormData for image uploads by conditionally omitting the `Content-Type` header (letting the browser set the multipart boundary). All requests include `credentials: 'include'` for session cookies.

Feed data flows through the `usePinStore` rather than being managed locally in the route. This is necessary because the masonry grid performs infinite scroll, and the accumulated pin array must persist across scroll-triggered re-renders. The store's `loadFeed` action appends new pins to the existing array rather than replacing it.

Pin detail, board detail, and profile data are fetched locally within their respective route components using `useEffect` + `useState`, since these pages do not need cross-component state sharing.

### Virtualization

The `MasonryGrid` component combines two techniques: the custom `useMasonryLayout` hook for column assignment and `@tanstack/react-virtual` for scroll-based DOM management.

**`useMasonryLayout` hook** (`hooks/useMasonryLayout.ts`): Takes an array of pins, a column count, and a column width. For each pin, it finds the shortest column, calculates the pin's pixel height from `columnWidth * pin.aspectRatio`, and records the pin's column index and absolute `top` position. The output is an array of `MasonryItem` objects with pre-calculated positions and a `totalHeight` for the container. The hook is memoized with `useMemo` on `[pins, columnCount, columnWidth]` to avoid recalculation on unrelated re-renders.

**Responsive columns**: A `ResizeObserver` watches the container width and recalculates the column count based on a minimum column width of 236px. This produces 2 columns on phones, scaling up to 6 columns on wide screens. The column width is computed dynamically: `(containerWidth - GAP * (columnCount - 1)) / columnCount`.

**Infinite scroll**: A scroll event listener on the parent element checks if the user is within 500px of the bottom. If so, it calls `onLoadMore` to trigger the next page fetch from the `usePinStore`.

**Absolute positioning over CSS columns**: Items are placed using `position: absolute` with computed `left` and `top` values. This gives the layout algorithm full control over item placement order. CSS `column-count` would reflow items top-to-bottom within columns (reading order mismatches relevance order), and CSS Grid cannot produce variable-height masonry without JavaScript assistance.

### Key UI Patterns

**Dominant color placeholders**: The `PinCard` component sets the image container's `backgroundColor` to `pin.dominantColor || '#e8e8e8'`. The image loads with `opacity: 0` and transitions to `opacity: 1` via a CSS transition once the `onLoad` event fires. This creates a smooth fade-in effect where the colored placeholder is visible until the actual image downloads, eliminating layout shift and the jarring grey-to-image flash.

**Aspect ratio preservation**: Each pin card uses `paddingBottom: ${aspectRatio * 100}%` on a relative container, with the image positioned `absolute inset-0`. This CSS technique ensures the container has the correct height before the image loads, preventing layout reflow. The `aspectRatio` value (height/width) is computed server-side during image processing and stored in the database.

**Save-to-board modal**: The `SaveToBoard` component is a modal overlay that lazy-loads the user's boards on open. Users select an existing board or create a new one inline. Board creation auto-saves the pin to the newly created board, reducing the interaction to a single flow. The modal uses `onClick: e.stopPropagation()` on the dialog content to prevent closing when clicking inside the form.

**Feed mode switching**: The home page supports three modes: personalized feed (logged-in), discover feed (logged-out), and search results (when `?q=` is present). The `usePinStore` provides separate actions for each feed type, and the route component switches between them based on auth state and URL parameters.

---

## Deep Pattern Explanations

### Circuit Breaker

A circuit breaker is a fault-tolerance pattern that prevents an application from repeatedly calling a failing external service. The concept is borrowed from electrical engineering: when current exceeds a threshold, the circuit breaker trips, stopping the flow to prevent damage. In software, when an external service (MinIO, RabbitMQ) starts returning errors, the circuit breaker "opens" and immediately rejects subsequent calls without attempting them. This prevents cascading failures where one slow or failing service causes all threads/connections in the calling service to block.

The implementation (`src/services/circuitBreaker.ts`) uses the Opossum library. A circuit breaker wraps a function call (e.g., uploading to MinIO). It tracks the success/failure ratio of recent calls. When failures exceed 50% across the last 5 attempts, the circuit opens. In the open state, all calls fail immediately (in <1ms) without contacting the external service. After a reset timeout (30 seconds), the circuit enters a "half-open" state where it allows a single test request through. If that request succeeds, the circuit closes and normal operation resumes. If it fails, the circuit reopens for another 30 seconds.

**Why not just retry?** Retrying a failing service adds load to an already-overloaded system. If MinIO is responding slowly due to disk I/O saturation, sending more requests makes the problem worse. The circuit breaker removes load from the failing service, giving it time to recover. Without a circuit breaker, the image upload endpoint would hang for the connection timeout (30 seconds) on every request, exhausting the Express connection pool and making the entire API unresponsive.

State transitions are logged via Pino so operations teams can see when circuits open and close. In a production environment, circuit breaker state would also be exposed as a Prometheus gauge for alerting.

### Structured Logging

Structured logging means emitting log messages as machine-parseable JSON objects rather than free-form text. A traditional log line like `"Image processing failed for pin abc-123"` is readable by humans but difficult for machines to filter, aggregate, or alert on. A structured log for the same event: `{"level":"error","msg":"image.processing.failed","pinId":"abc-123","error":"ENOENT: file not found","duration":1234,"service":"image-worker","timestamp":"2024-01-15T10:30:00Z"}`.

The implementation uses Pino (`src/services/logger.ts`) with `pino-http` for automatic request logging. Pino is chosen over alternatives (Winston, Bunyan) because it is the fastest Node.js logger, achieving performance through deferred serialization and direct stream writing.

Both the API server and the image worker use the same logger configuration, ensuring consistent structured fields across processes. This is important because the image processing pipeline spans two processes: the API server enqueues the job, and the worker processes it. Without consistent structured logging, correlating a failed image upload across both processes requires manual timestamp matching.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements from your application at regular intervals. Your application exposes a `/metrics` endpoint that Prometheus periodically scrapes (typically every 15 seconds). Prometheus stores these timestamped values, enabling queries over time windows.

The four metric types serve different purposes:
- **Counter** (e.g., `pins_created_total`): Only goes up. Rates are calculated by Prometheus: `rate(pins_created_total[5m])` gives pins created per second.
- **Histogram** (e.g., `image_processing_duration_seconds`): Records value distributions in pre-defined buckets. Enables percentile queries: `histogram_quantile(0.99, ...)`.
- **Gauge** (e.g., current queue depth): Can go up or down, representing instantaneous state.

The implementation (`src/services/metrics.ts`) tracks HTTP request latency/count, business events (pins created, saves), and image processing performance (duration, errors). The image processing duration histogram is particularly valuable: it reveals whether the Sharp image processing step, MinIO upload, or database update is the bottleneck.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. The implementation uses `express-rate-limit` with a Redis backend (`rate-limit-redis`) for distributed rate limiting across multiple API server instances.

Different endpoints have different limits because they have different costs:
- Pin creation (10/min): Each creation triggers a file upload to MinIO and a RabbitMQ message, both of which consume infrastructure resources.
- Login attempts (5/min): Prevents credential stuffing (automated password guessing).
- Follow actions (30/min): Prevents follow/unfollow spam.

The Redis backend is essential for distributed rate limiting. If rate limits were stored in-memory (the default), each API server instance would have its own counter. A user could hit 10 requests on server A, then 10 more on server B, effectively doubling their allowed rate. With Redis, all instances share the same counter.

### Health Checks

Health checks are HTTP endpoints that report whether the application can serve requests. The implementation provides two endpoints:

- **`GET /api/health`**: Returns overall health status with a timestamp. Checks PostgreSQL and Valkey connectivity.
- **`GET /api/health/live`**: Lightweight liveness probe that returns 200 if the process is running.

In a production deployment, Kubernetes uses the liveness probe to detect hung processes (the event loop is blocked, the process has deadlocked). If liveness fails, Kubernetes kills and restarts the container. The liveness probe intentionally does not check external dependencies because a MinIO outage should not trigger a restart of all API servers.

### Idempotency

An idempotent operation produces the same result no matter how many times it is executed. This is critical because network failures make it impossible to distinguish "the request never reached the server" from "the request succeeded but the response was lost." In both cases, the client retries.

The Pinterest implementation uses three idempotency mechanisms:

1. **Database constraints**: `pin_saves` has `UNIQUE(pin_id, user_id, board_id)`. Save operations use `INSERT ... ON CONFLICT DO NOTHING`. A duplicate save is silently ignored.
2. **Client-generated idempotency keys**: Pin creation accepts an `X-Idempotency-Key` header (UUID). The server stores this key in Valkey with a 24-hour TTL. If a duplicate request arrives with the same key, the server returns the original response without creating a second pin. This prevents duplicate uploads from network retries or double-clicks.
3. **Worker idempotency**: Each step in the image processing worker is idempotent. Uploading a thumbnail to MinIO overwrites the same object key. Updating the database sets absolute values (`status='published'`, `aspect_ratio=0.75`), not increments. If a worker crashes and RabbitMQ redelivers the message to another worker, the second processing produces identical results.
