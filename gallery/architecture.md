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

### Running Locally

```bash
cd frontend && npm install && npm run dev

# Open http://localhost:5173
# Switch between Slideshow / Masonry / Tiles tabs
# Click any image to open lightbox
# Keyboard: arrows to navigate, Escape to close
```
