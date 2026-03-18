# Gallery - Architecture

## System Overview

A production-scale image gallery service supporting billions of images with multiple layout paradigms, real-time uploads, and global delivery. The learning focus is on image storage pipelines, responsive layouts, CDN distribution, and frontend rendering performance.

**Learning Goals:**
- Design image storage and processing pipelines at scale
- Implement performant gallery layouts (slideshow, masonry, tiles)
- Handle responsive image delivery with appropriate sizing
- Build keyboard-accessible, mobile-responsive UI components

---

## Requirements

### Functional Requirements

1. **Browse**: View images in three layout modes (slideshow, masonry, tiles)
2. **Upload**: Users upload images with automatic resizing and format conversion
3. **Lightbox**: Full-screen image viewing with keyboard navigation
4. **Search**: Find images by metadata, tags, and visual similarity
5. **Organize**: Albums, favorites, and tag management
6. **Share**: Public/private sharing with link generation

### Non-Functional Requirements

- **Scale**: 10B+ images, 100M daily active users
- **Latency**: p99 < 200ms for gallery page load (above-the-fold)
- **Availability**: 99.9% for reads, 99.5% for uploads
- **Storage**: Efficient multi-resolution storage with WebP/AVIF conversion
- **Bandwidth**: Serve appropriate image sizes per device (responsive images)
- **Accessibility**: Full keyboard navigation, screen reader support, ARIA labels

---

## Capacity Estimation

| Metric | Value |
|--------|-------|
| Total images | 10B |
| Daily uploads | 50M |
| Daily views | 5B |
| Average original image size | 5 MB |
| Resized variants per image | 5 (thumbnail, small, medium, large, original) |
| Total raw storage | 50 PB (originals) + 25 PB (variants) |
| CDN egress/day | ~2 PB |
| Read QPS (peak) | 500K |
| Write QPS (peak) | 5K |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│          Browser │ Mobile App │ Embedded Widget                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CDN                                     │
│        (Resized images, thumbnails, WebP/AVIF variants)         │
│        CloudFront + 300 edge locations                          │
│        Cache-Control: public, max-age=31536000, immutable       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Load Balancer                   │
│               Rate limiting, auth, routing                      │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Gallery Service│    │Upload Service │    │Search Service │
│               │    │               │    │               │
│ - Browse      │    │ - Receive     │    │ - Tag search  │
│ - Albums      │    │ - Validate    │    │ - Metadata    │
│ - Favorites   │    │ - Queue       │    │ - Visual sim  │
└───────────────┘    └───────────────┘    └───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Image Processing Pipeline                     │
│     ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│     │ Resize   │───▶│ Convert  │───▶│ Optimize │              │
│     │ (5 sizes)│    │(WebP,AVIF)│   │(quality) │              │
│     └──────────┘    └──────────┘    └──────────┘              │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┬──────────────┬──────────────┬────────────────────┐
│  PostgreSQL  │    Redis     │Elasticsearch │   Object Storage   │
│  (metadata,  │  (cache,     │  (search,    │   (S3: originals   │
│   albums,    │   sessions,  │   tags)      │    + variants)     │
│   users)     │   rate limit)│              │                    │
└──────────────┴──────────────┴──────────────┴────────────────────┘
```

---

## Core Components

### 1. Image Storage Pipeline

Uploaded images go through a multi-stage processing pipeline:

1. **Receive** -- Upload service accepts the original file, validates format (JPEG, PNG, HEIC, WebP) and size (<50 MB), generates a unique content-addressed key (SHA-256 hash of content)
2. **Store original** -- Write original to S3 with content-addressed key (enables deduplication)
3. **Queue for processing** -- Publish message to image processing queue
4. **Resize** -- Generate 5 size variants:
   - Thumbnail: 80x60 (gallery grid)
   - Small: 300x300 (tiles view)
   - Medium: 800x600 (masonry view)
   - Large: 1920x1080 (lightbox/slideshow)
   - Original: preserved as-is
5. **Convert** -- Generate WebP and AVIF variants for each size (60-70% smaller than JPEG)
6. **Optimize** -- Apply perceptual quality optimization (target SSIM > 0.95)
7. **Update metadata** -- Write image record to PostgreSQL with all variant URLs
8. **CDN invalidation** -- Push variants to CDN edge locations

### 2. Gallery Layouts

Three layout paradigms serve different browsing needs:

**Slideshow View:**
- Full-screen single image display with left/right navigation
- Thumbnail strip for quick jumping
- Auto-play with configurable interval (3-10 seconds)
- Keyboard: arrows for navigation, space for play/pause, escape to exit
- Preloads adjacent images for instant transitions

**Masonry Grid View:**
- Pinterest-style variable-height columns using CSS `columns` property
- Column count responsive to viewport (1 on mobile, 2-4 on desktop)
- `break-inside: avoid` prevents image splitting across columns
- Lazy loading with native `loading="lazy"` attribute
- Column-first ordering (acceptable trade-off: simpler than JS-computed row-first masonry)

**Tiles Grid View:**
- Uniform square grid using CSS Grid with `aspect-ratio: 1`
- Responsive column count via `repeat(auto-fill, minmax(200px, 1fr))`
- Images cropped with `object-fit: cover`
- Hover effect with scale transform for interactivity

### 3. Responsive Image Delivery

Serving the right image size per context minimizes bandwidth:

| Context | Resolution | Format Priority |
|---------|-----------|-----------------|
| Thumbnail strip | 80x60 | WebP > JPEG |
| Tiles grid | 300x300 | WebP > JPEG |
| Masonry grid | 400xVariable | WebP > JPEG |
| Slideshow main | 1200x675 | AVIF > WebP > JPEG |
| Lightbox full | 1920x1080 | AVIF > WebP > JPEG |

The frontend uses `<picture>` elements with `<source>` tags for format negotiation, and `srcset` with `sizes` for resolution selection. The CDN caches each variant independently.

### 4. Search and Discovery

- **Tag search**: Elasticsearch index on image tags, titles, descriptions
- **Visual similarity**: Feature vectors extracted by a CNN (ResNet-50), stored in a vector database for approximate nearest neighbor search
- **Temporal browsing**: Images organized by date with efficient range queries

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  storage_quota_bytes BIGINT DEFAULT 10737418240, -- 10 GB
  storage_used_bytes BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Images
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  content_hash VARCHAR(64) NOT NULL, -- SHA-256 for dedup
  original_filename VARCHAR(500),
  mime_type VARCHAR(50) NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes BIGINT NOT NULL,
  title VARCHAR(200),
  description TEXT,
  tags TEXT[],
  exif_data JSONB,
  variants JSONB NOT NULL, -- { "thumbnail": "url", "small": "url", ... }
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_images_user ON images(user_id, created_at DESC);
CREATE INDEX idx_images_tags ON images USING GIN(tags);
CREATE INDEX idx_images_public ON images(is_public, created_at DESC) WHERE is_public = TRUE;

-- Albums
CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  cover_image_id UUID REFERENCES images(id),
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Album-Image junction
CREATE TABLE album_images (
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  image_id UUID REFERENCES images(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (album_id, image_id)
);

-- Favorites
CREATE TABLE favorites (
  user_id UUID REFERENCES users(id),
  image_id UUID REFERENCES images(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, image_id)
);
```

---

## API Design

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/images?page=&limit=&tags=` | List images (paginated) |
| GET | `/api/v1/images/:id` | Get image metadata + variant URLs |
| POST | `/api/v1/images` | Upload image (multipart) |
| DELETE | `/api/v1/images/:id` | Delete image and variants |
| GET | `/api/v1/albums` | List user albums |
| POST | `/api/v1/albums` | Create album |
| GET | `/api/v1/albums/:id/images` | Images in album |
| POST | `/api/v1/albums/:id/images` | Add image to album |
| GET | `/api/v1/search?q=&tags=` | Search images |
| POST | `/api/v1/favorites/:imageId` | Toggle favorite |

---

## Key Design Decisions

### 1. CSS Columns for Masonry vs. JavaScript Layout

**Chosen**: CSS `columns` property.

JavaScript-based masonry (e.g., react-masonry-css, Packery) computes item positions manually, leading to layout recalculation on every resize and scroll. CSS `columns` is browser-native, requires zero JavaScript computation, and handles responsive column counts with a single `columns: 4 300px` declaration. The trade-off is column-first ordering (images flow top-to-bottom within columns rather than left-to-right across rows), which means chronological ordering is not perfectly left-to-right. For a gallery where browsing order is less critical than visual density, this is acceptable.

### 2. Content-Addressed Storage vs. Sequential IDs

**Chosen**: SHA-256 content hash as the storage key.

When the same image is uploaded multiple times (common in social/gallery apps), content-addressed storage automatically deduplicates at the object storage level. Two users uploading the same photo produce the same hash and share the same storage. The trade-off is an extra hash computation on upload (~10ms for a 5 MB image), and the need to handle reference counting for deletion (cannot delete an object if other users reference it).

### 3. Multi-Format Delivery (AVIF > WebP > JPEG) vs. Single Format

**Chosen**: Serve multiple formats with `<picture>` negotiation.

AVIF provides ~50% size reduction over JPEG; WebP provides ~30%. For a gallery serving 5B views/day, this translates to petabytes of saved bandwidth per month. The trade-off is 3x storage per image (JPEG + WebP + AVIF for each size) and processing pipeline complexity. Storage cost (~$0.023/GB/month on S3) is far lower than bandwidth cost (~$0.085/GB for CDN egress), making this trade-off strongly favorable.

---

## Consistency and Idempotency

| Operation | Model | Rationale |
|-----------|-------|-----------|
| Image upload | Idempotent via content hash | Re-uploading same image returns existing record |
| Album operations | Strong consistency | User sees changes immediately |
| Image deletion | Eventual (soft-delete) | Variants cleaned up asynchronously |
| Tag updates | Read-your-writes | Search index updates within ~5s |
| View counts | Eventual | Approximate counts acceptable |

---

## Observability

- **Metrics**: Upload latency, processing pipeline duration, CDN hit ratio, storage utilization
- **Logging**: Structured JSON logs for upload pipeline, processing errors, CDN misses
- **Health checks**: Object storage connectivity, processing queue depth, database health
- **Alerting**: Processing queue backlog > 10K, CDN hit ratio < 95%, storage quota exceeded

---

## Failure Handling

| Component | Failure | Strategy |
|-----------|---------|----------|
| Upload service | Crash during processing | Queue guarantees retry; content-addressed storage means re-processing is idempotent |
| Object storage | S3 region outage | Cross-region replication; serve from secondary region |
| Processing pipeline | Worker crash | Dead letter queue for failed jobs; manual retry |
| CDN | Edge cache miss | Origin shield (intermediate cache) reduces origin load |
| Database | Connection exhaustion | Connection pooling, circuit breaker, read replicas |

---

## Scalability Considerations

### What Breaks First

1. **Storage** -- 50M uploads/day at 5 MB = 250 TB/day. S3 scales horizontally; cost is the constraint (~$5.75M/month for 75 PB).
2. **Processing pipeline** -- 50M images x 5 sizes x 3 formats = 750M processing jobs/day. Horizontally scale workers with auto-scaling groups.
3. **CDN bandwidth** -- 5B views x 400 KB average = 2 PB/day egress. Multi-CDN strategy (CloudFront + Akamai) for cost optimization and redundancy.

### Horizontal Scaling

- **Gallery service**: Stateless, scale behind load balancer
- **Upload service**: Scale workers independently from API servers
- **Processing pipeline**: Auto-scaling worker fleet consuming from SQS/Kafka
- **Database**: Read replicas for gallery reads; write primary for uploads

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Masonry layout | CSS `columns` | JS masonry (Packery) | Zero JS computation, browser-native responsiveness |
| Storage keys | Content-addressed (SHA-256) | Sequential UUID | Automatic deduplication saves storage at scale |
| Image formats | AVIF + WebP + JPEG | JPEG only | Bandwidth savings (50-70%) far outweigh storage cost |
| Image service | Dedicated processing pipeline | On-the-fly resize | Predictable latency, CDN-cacheable, no resize thundering herd |
| State management | Zustand | React Context / Redux | Minimal boilerplate for simple gallery state |

---

## Implementation Notes

This project is a **frontend-only implementation** demonstrating gallery layout patterns. There is no backend service, database, or image processing pipeline.

### Local Architecture

```
┌────────────────────────────────────────────────────┐
│              Browser (localhost:5173)                │
│    Vite Dev Server + React 19 + TanStack Router     │
│    Zustand + Tailwind CSS                           │
├────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ GalleryTabs  │  │  Store   │  │  Lightbox    │ │
│  │ (tab switch) │  │ (Zustand)│  │  (modal)     │ │
│  └──────────────┘  └──────────┘  └──────────────┘ │
│         │                                           │
│  ┌──────┴──────────────┬──────────────┐            │
│  │                     │              │            │
│  ▼                     ▼              ▼            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │Slideshow │  │Masonry   │  │Tiles     │        │
│  │View      │  │Grid      │  │Grid      │        │
│  └──────────┘  └──────────┘  └──────────┘        │
│         │                                           │
│         ▼                                           │
│  ┌──────────────────────────────────────────────┐  │
│  │           picsum.photos (external)            │  │
│  │  https://picsum.photos/id/{id}/{w}/{h}       │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
└────────────────────────────────────────────────────┘
```

### What Is Actually Implemented

| Component | File | Description |
|-----------|------|-------------|
| Tab navigation | `frontend/src/components/gallery/GalleryTabs.tsx` | Switches between three layout views |
| Slideshow | `frontend/src/components/gallery/Slideshow.tsx` | Full-width image display with navigation arrows, thumbnail strip, auto-play |
| Masonry grid | `frontend/src/components/gallery/MasonryGrid.tsx` | CSS `columns` layout with variable-height images |
| Tiles grid | `frontend/src/components/gallery/TilesGrid.tsx` | CSS Grid with uniform square tiles, hover effects |
| Lightbox | `frontend/src/components/gallery/Lightbox.tsx` | Full-screen overlay with keyboard navigation (arrows, escape) |
| Gallery store | `frontend/src/stores/galleryStore.ts` | Zustand store for active tab, lightbox state, slideshow index |
| Image URLs | `frontend/src/utils/picsum.ts` | Helper for generating picsum.photos URLs at various sizes |
| Icons | `frontend/src/components/icons/index.tsx` | SVG icon components (arrows, play/pause, grid) |
| Routing | `frontend/src/routes/index.tsx`, `__root.tsx` | TanStack Router file-based routing |

### Simplifications vs. Production

| Area | Production | Local Implementation |
|------|-----------|---------------------|
| Image source | S3 + CDN with multi-format variants | picsum.photos placeholder service |
| Image IDs | Database-backed with content hashing | Hardcoded list of 50 IDs (10-59) |
| Layout engine | CSS `columns` (same) | CSS `columns` (same) |
| State management | Server state + client cache (React Query) | Zustand client-only store |
| Auth/users | User accounts with storage quotas | None |
| Upload | Multi-stage processing pipeline | None |
| Search | Elasticsearch with tags | None |
| Backend | Node.js + Express + PostgreSQL | None (frontend only) |
| Lazy loading | Intersection Observer + skeleton loaders | Native `loading="lazy"` attribute |
| Responsive images | `<picture>` with `srcset` and format negotiation | Fixed-size URLs from picsum.photos |

### What Was Omitted

- Backend API and database
- Image upload and processing pipeline
- User authentication and albums
- Search and tag management
- Favorites and sharing
- Multi-format image delivery (WebP/AVIF)
- CDN integration
- Infinite scroll / pagination
- Image metadata display (EXIF, author)
- Mobile gesture support (swipe, pinch-to-zoom)

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (root layout)
└── index.tsx (Home - single-page application)
    ├── GalleryTabs (tab bar: Slideshow / Masonry / Tiles)
    ├── Slideshow (full-width image display)
    │   └── (main image, navigation arrows, thumbnail strip, play/pause, auto-advance)
    ├── MasonryGrid (CSS columns layout)
    │   └── (variable-height images in column-first order, click to open lightbox)
    ├── TilesGrid (CSS Grid uniform squares)
    │   └── (square-cropped images with hover scale, click to open lightbox)
    ├── Lightbox (full-screen overlay)
    │   └── (large image, left/right arrows, close button, keyboard navigation)
    └── icons/ (SVG icon components: arrows, play/pause, grid icons)
```

This is a frontend-only project with no backend. All components are in `components/gallery/` with a flat, gallery-focused organization.

### Zustand Store

**`useGalleryStore`** (`stores/galleryStore.ts`) -- Single store managing all UI state:

- **`activeTab`**: Which layout view is displayed (`'Slideshow' | 'Masonry' | 'Tiles'`). Defaults to `'Tiles'`. Switching tabs is instant (no data fetch, no animation delay).
- **`lightboxImage`**: The image ID currently displayed in the lightbox overlay, or `null` when closed. Set by clicking any image in Masonry or Tiles views.
- **`slideshowIndex`**: Current position in the slideshow (0-based index into the image array). Used by the Slideshow component for navigation and auto-play.
- **`totalImages`**: Fixed at 50 (hardcoded list of picsum.photos IDs 10-59). Used by `nextSlide()` and `prevSlide()` for wraparound arithmetic.
- **Actions**:
  - `setActiveTab(tab)` -- switch layout view
  - `openLightbox(imageId)` / `closeLightbox()` -- control lightbox visibility
  - `setSlideshowIndex(index)` / `nextSlide()` / `prevSlide()` -- slideshow navigation with modular wraparound (index wraps from 49 back to 0 and vice versa)

### Routing

TanStack Router with file-based routing. This project uses a single route:

| Route | File | Description |
|-------|------|-------------|
| `/` | `routes/index.tsx` | Gallery with tab switching between Slideshow, Masonry, and Tiles |

The root layout (`__root.tsx`) provides the page shell. All view switching happens via Zustand state (`activeTab`), not via routing, enabling instant transitions without URL changes.

### Data Fetching

**There is no data fetching.** This project loads images directly from `picsum.photos` using `<img>` tags with constructed URLs. The `utils/picsum.ts` helper generates URLs in the format `https://picsum.photos/id/{id}/{width}/{height}` for each image at the appropriate size for the current layout context.

Images are loaded by the browser's native image loading mechanism. The Masonry and Tiles views use `loading="lazy"` for deferred loading of off-screen images. The Slideshow preloads adjacent images by rendering them in the DOM (hidden) so transitions are instant.

### Key UI Patterns

- **CSS-native layouts with zero JavaScript computation**: Masonry uses CSS `columns` with `break-inside: avoid`. Tiles uses CSS Grid with `repeat(auto-fill, minmax(200px, 1fr))` and `aspect-ratio: 1`. No layout libraries, no position calculations, no resize observers.
- **Keyboard-accessible lightbox**: The Lightbox component listens for `ArrowLeft`, `ArrowRight`, and `Escape` keydown events on the document. This enables navigation without mouse interaction, meeting basic accessibility requirements.
- **Auto-play slideshow**: The Slideshow component uses `setInterval` with a configurable delay (default 3 seconds) to auto-advance. The play/pause button toggles the interval. Navigation arrows and thumbnail clicks override auto-play position.
- **Responsive column count**: The Masonry grid and Tiles grid automatically adjust column count based on viewport width using CSS breakpoints and `auto-fill`, requiring no JavaScript media query handling.
- **Hardcoded image list**: Image IDs 10-59 are hardcoded to avoid broken/missing picsum.photos IDs. This provides a consistent, predictable experience without error handling for 404 images.

---

## Deep Pattern Explanations

This project is a frontend-only implementation and does not include backend infrastructure patterns like Redis caching, circuit breakers, or Prometheus metrics. The patterns below are the ones relevant to this project's scope. Backend patterns are described at the production-scale level in the architecture sections above and would apply if this project were extended with a backend.

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether an application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing traffic and restarting failed instances.

**How it works**: A health check endpoint (typically `GET /health`) performs a quick diagnostic of the system's ability to serve requests. A **liveness check** simply confirms the process is running (return 200 if the server can respond to HTTP). A **readiness check** verifies that critical dependencies are available (database responds to a ping, Redis returns PONG, the search index is reachable). If any dependency is down, the readiness check returns 503, and the load balancer stops sending traffic to that instance until it recovers.

**Why it matters at production scale**: For a production image gallery serving billions of views, health checks would verify that the object storage (S3) is reachable, the image processing pipeline is running, and the database for metadata is healthy. Without health checks, a server whose S3 connection is broken would serve 500 errors for every image request while the load balancer continues routing traffic to it. Health checks enable self-healing: the load balancer removes broken instances, and the orchestrator restarts them.

**Not applicable locally**: This frontend-only project has no backend server, so there are no health check endpoints to implement.

### Structured Logging

**What it is**: Structured logging produces log entries as machine-parseable JSON objects rather than human-readable text strings. Each log entry is a flat or nested JSON object with consistent field names (level, timestamp, message, request ID, duration, status code), enabling automated parsing, filtering, indexing, and alerting by log aggregation systems like Elasticsearch, Datadog, or CloudWatch.

**How it works**: Instead of writing `console.log('Image upload completed in 250ms for user abc')`, structured logging produces `{"level":"info","event":"upload_complete","userId":"abc","durationMs":250,"imageId":"img-123","format":"webp"}`. The logging library (typically Pino for Node.js) handles serialization, timestamp formatting, and log level filtering. In development, a pretty-printer makes logs human-readable. In production, raw JSON is emitted for machine consumption.

**Why it matters at production scale**: A production gallery processing 50M uploads per day generates enormous log volume. When a user reports that their upload failed, operators need to find the relevant log entry among billions. Structured logs enable queries like "show all upload failures for user X in the EU region in the last hour" in seconds. Request IDs (correlation IDs) link related log entries across the upload service, processing pipeline, and storage service, enabling end-to-end tracing of a single upload through the entire system.

**Not applicable locally**: This frontend-only project uses `console.log` for development debugging. A production backend would use Pino for structured JSON logging.

### Prometheus Metrics

**What it is**: Prometheus is a monitoring system that collects numerical time-series data from applications. Applications expose a `/metrics` HTTP endpoint that Prometheus scrapes periodically. Four metric types are available: Counter (monotonically increasing, e.g., total requests), Gauge (can go up or down, e.g., active connections), Histogram (distribution of values in buckets, e.g., request latency), and Summary (pre-computed quantiles).

**How it works**: At application startup, metric objects are created (e.g., a Histogram named `image_processing_duration_seconds`). During request processing, observations are recorded: `histogram.observe(0.25)` records a 250ms processing time. Prometheus scrapes the `/metrics` endpoint every 15-30 seconds and stores the time-series data. Grafana dashboards visualize trends, and alerting rules trigger notifications when metrics cross thresholds (e.g., CDN cache hit rate drops below 95%).

**Why it matters at production scale**: For a production gallery, the critical metrics would be upload latency, processing pipeline throughput (images per second), CDN cache hit ratio, storage utilization, and error rates. If the processing pipeline throughput drops, the queue of unprocessed uploads grows, and users see "processing" states for minutes instead of seconds. Metrics detect this degradation long before users report it.

**Not applicable locally**: This frontend-only project does not expose metrics. A production backend would use `prom-client` for request latency, image processing duration, storage utilization, and CDN hit rate metrics.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects services from abuse (intentional or accidental) by rejecting excess requests with HTTP 429 (Too Many Requests) responses before they consume server resources.

**How it works**: The server maintains a counter for each client (identified by IP address, API key, or user ID). When a request arrives, the counter is checked against the configured limit. If below the limit, the request proceeds. If above, the request is rejected with a 429 response and a `Retry-After` header indicating when the client can retry. Common algorithms include fixed window (reset counter every N seconds), sliding window (rolling counter), and token bucket (constant refill rate with burst allowance).

**Why it matters at production scale**: For a production gallery, rate limiting would protect the upload endpoint (preventing a single user from consuming all processing capacity), the search endpoint (preventing scraping of the entire image catalog), and the download endpoint (preventing bandwidth abuse). Without rate limiting on uploads, a single user could upload thousands of images per minute, filling the processing pipeline queue and delaying uploads for all other users.

**Not applicable locally**: This frontend-only project makes no API requests. A production backend would apply rate limiting to upload, search, and API endpoints.

### Running Locally

```bash
cd frontend && npm install && npm run dev

# Open http://localhost:5173
# Switch between Slideshow / Masonry / Tiles tabs
# Click any image to open lightbox
# Keyboard: arrows to navigate, Escape to close
```
