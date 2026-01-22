# Image Gallery - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

## Opening Statement

"Today I'll design the backend for an image gallery system that supports multiple viewing modes. While this is primarily a frontend-focused application, I'll focus on the backend infrastructure needed for production: image storage and processing, CDN integration, API design for pagination and metadata, and caching strategies to handle large galleries efficiently."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Gallery CRUD** - Create, read, update, delete galleries
2. **Image Upload** - Upload images with automatic resizing
3. **Image Variants** - Generate thumbnails and multiple resolutions
4. **Metadata API** - Serve image metadata (dimensions, alt text, EXIF)
5. **Pagination** - Handle galleries with thousands of images
6. **Ordering** - Support custom ordering, date-based, random shuffle

### Non-Functional Requirements

- **Latency**: < 100ms for metadata API, < 500ms for image delivery (with CDN)
- **Throughput**: Handle 10,000 concurrent gallery viewers
- **Storage**: Efficiently store multiple image variants
- **Availability**: 99.9% uptime for image serving

### Out of Scope

- User authentication (assume authenticated)
- Image editing/cropping
- Comments and social features
- Video support

---

## Step 2: High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                        │
│                    (React + Zustand + CSS Layouts)                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 │ REST API
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API Gateway / CDN                                 │
│                         (CloudFront / Fastly)                               │
└─────────┬─────────────────────────┬─────────────────────────────┬───────────┘
          │ /api/*                  │ /images/*                   │ /uploads
          ▼                         ▼                             ▼
┌─────────────────┐      ┌─────────────────┐           ┌─────────────────┐
│   API Server    │      │  Image Origin   │           │  Upload Handler │
│   (Express)     │      │  (S3 + Resize)  │           │  (Presigned)    │
└────────┬────────┘      └────────┬────────┘           └────────┬────────┘
         │                        │                             │
         ▼                        ▼                             ▼
┌─────────────────┐      ┌─────────────────┐           ┌─────────────────┐
│   PostgreSQL    │      │   S3 / MinIO    │           │   SQS / Redis   │
│   (metadata)    │      │   (images)      │           │   (job queue)   │
└─────────────────┘      └─────────────────┘           └────────┬────────┘
                                                                │
                                                                ▼
                                                       ┌─────────────────┐
                                                       │  Image Worker   │
                                                       │  (Sharp/libvips)│
                                                       └─────────────────┘
```

---

## Step 3: Deep Dive - Image Storage and Processing (10 minutes)

### Database Schema Design

"I'll design the schema to support galleries with multiple images, each having several pre-generated variants for different display contexts."

**Galleries Table:**
- `id` (UUID, primary key)
- `name` (VARCHAR 255)
- `description` (TEXT)
- `owner_id` (UUID, foreign key to users)
- `cover_image_id` (UUID)
- `image_count` (INT, denormalized for performance)
- `visibility` ('public', 'private', 'unlisted')
- `created_at`, `updated_at` (TIMESTAMP)

**Images Table:**
- `id` (UUID, primary key)
- `gallery_id` (UUID, foreign key)
- `original_key` (VARCHAR 500, S3 key)
- `filename`, `mime_type` (VARCHAR)
- `width`, `height` (INT)
- `file_size` (BIGINT)
- `alt_text` (VARCHAR 500)
- `position` (INT, for custom ordering)
- `blurhash` (VARCHAR 100, for placeholder blur)
- `exif_data` (JSONB)
- `processing_status` ('pending', 'processing', 'complete', 'failed')

**Image Variants Table:**
- `id` (UUID, primary key)
- `image_id` (UUID, foreign key)
- `variant_type` ('thumbnail', 'small', 'medium', 'large', 'original')
- `s3_key` (VARCHAR 500)
- `width`, `height` (INT)
- `file_size` (BIGINT)
- `format` ('webp', 'avif', 'jpeg')

**Key Indexes:**
- `idx_galleries_owner` on galleries(owner_id)
- `idx_galleries_visibility` on galleries(visibility) WHERE visibility = 'public'
- `idx_images_gallery` on images(gallery_id, position)
- `idx_variants_unique` on image_variants(image_id, variant_type, format) UNIQUE

### Image Processing Pipeline

"When an image is uploaded, we generate multiple variants asynchronously using a worker process."

**Variant Configuration:**

| Variant | Max Size | Quality | Format |
|---------|----------|---------|--------|
| thumbnail | 80x80 | 70% | webp |
| small | 300x300 | 75% | webp |
| medium | 800x800 | 80% | webp |
| large | 1920x1920 | 85% | webp |
| medium | 800x800 | 65% | avif |
| large | 1920x1920 | 70% | avif |

**Processing Flow:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Original S3    │────▶│  Sharp Worker   │────▶│  Variant S3     │
│  Key Retrieved  │     │  Resize + Convert│     │  Keys Stored    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  BlurHash Gen   │
                        │  Update DB      │
                        └─────────────────┘
```

"The worker fetches the original from S3, generates blurhash for placeholder, creates all variants maintaining aspect ratio, uploads each to S3 with immutable cache headers, and updates the database with variant metadata."

**Key Implementation Details:**
- Thumbnails use 'cover' fit (cropped square)
- Other variants use 'inside' fit (preserve aspect ratio)
- Skip variant generation if original is smaller than target
- S3 key pattern: `galleries/{galleryId}/images/{imageId}/{variant}.{format}`
- Cache-Control: `public, max-age=31536000, immutable`

### Presigned Upload Flow

"Direct browser-to-S3 uploads reduce server load and enable large file uploads."

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│   API       │────▶│   Redis     │────▶│   S3        │
│  Request    │     │  Generate   │     │  Store      │     │  Presigned  │
│  Upload URL │     │  Presigned  │     │  Pending    │     │  URL        │
└─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                   │
┌─────────────┐     ┌─────────────┐     ┌─────────────┐            │
│   Browser   │◀────│   API       │◀────│   Worker    │◀───────────┘
│  Confirm    │     │  Create     │     │  Queue      │   Direct Upload
│  Complete   │     │  Image Rec  │     │  Processing │
└─────────────┘     └─────────────┘     └─────────────┘
```

**Validation Rules:**
- Allowed types: image/jpeg, image/png, image/webp, image/gif
- Max file size: 50MB
- Presigned URL expiry: 1 hour
- Redis stores pending upload metadata with 1 hour TTL

---

## Step 4: Deep Dive - Gallery API with Pagination (10 minutes)

### Pagination Strategy

"I use different pagination strategies for different use cases."

| Use Case | Strategy | Rationale |
|----------|----------|-----------|
| Gallery list | Cursor | Stable for infinite scroll, handles insertions |
| Images in gallery | Offset | Simpler, acceptable for ordered lists |
| Search results | Cursor | Handles changing result sets |

### Gallery List API

**Endpoint:** `GET /api/v1/galleries`

**Cursor Pagination Implementation:**
- Cursor is base64 encoded `{created_at}:{id}`
- Query: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC`
- Fetch `limit + 1` to determine if more pages exist
- Return `nextCursor` and `hasMore` in response

**Response Structure:**

```
┌─────────────────────────────────────────────────────────┐
│ {                                                        │
│   "data": [                                              │
│     { id, name, description, cover_image_id,            │
│       image_count, created_at, updated_at }             │
│   ],                                                     │
│   "pagination": {                                        │
│     "nextCursor": "base64...",                          │
│     "hasMore": true                                      │
│   }                                                      │
│ }                                                        │
└─────────────────────────────────────────────────────────┘
```

### Gallery Images API

**Endpoint:** `GET /api/v1/galleries/:id/images`

**Parameters:**
- `page` (default: 1)
- `limit` (default: 50, max: 100)
- `order` ('position', 'created_at', 'filename')

**Response includes:**
- Image metadata (id, filename, width, height, alt_text, blurhash, position)
- Nested variants array with type, format, dimensions, and URL
- Pagination metadata (page, limit, total, totalPages)

### Image URL Service

"The service generates responsive image URLs with srcSet for different screen densities."

**Output Structure:**

```
┌─────────────────────────────────────────────────────────┐
│ {                                                        │
│   "src": "cdn.example.com/images/medium.webp",          │
│   "srcSet": "url 300w, url 800w, url 1920w",           │
│   "placeholder": "LEHV6nWB2yk8pyo0adR*.7kCMdnj"        │
│ }                                                        │
└─────────────────────────────────────────────────────────┘
```

**Sizes for Layout:**

| Layout | Sizes Attribute |
|--------|-----------------|
| slideshow | 100vw |
| masonry | (max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw |
| tiles | (max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw |

---

## Step 5: Deep Dive - Caching Strategy (5 minutes)

### Multi-Layer Caching

```
┌─────────────────────────────────────────────────────────┐
│                      CDN Edge Cache                      │
│         (Images: immutable, Metadata: 60s)              │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                      Redis Cache                         │
│         (Metadata: 5min, First 3 pages: 2min)           │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                      PostgreSQL                          │
│              (Source of truth)                          │
└─────────────────────────────────────────────────────────┘
```

### Cache Configuration

| Data Type | TTL | Stale-While-Revalidate |
|-----------|-----|------------------------|
| gallery:metadata | 300s | 60s |
| gallery:images | 120s | 30s |
| image:variants | 3600s | - |

### Stale-While-Revalidate Pattern

"I implement SWR in Redis by storing data with both expiry and stale timestamps."

**Cache Entry Structure:**
- `data`: The cached payload
- `expiresAt`: Hard expiry timestamp
- `staleAt`: When to trigger background revalidation

"When data is stale but not expired, return it immediately while adding the key to a revalidation set for background refresh."

### Cache Headers by Content Type

| Content Type | Cache-Control Header |
|--------------|---------------------|
| Static images (immutable variants) | `public, max-age=31536000, immutable` |
| Dynamic metadata (gallery listings) | `public, max-age=60, stale-while-revalidate=30` |
| Private user data | `private, no-cache` |

### Cache Invalidation

"When images are added, removed, or reordered, invalidate gallery-specific cache keys using pattern matching: `gallery:{id}*`"

---

## Step 6: Trade-offs and Decisions (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Pre-generate variants | More storage, but faster serving |
| Blurhash placeholders | Extra processing, but better UX |
| Cursor pagination for galleries | More complex, but stable for large datasets |
| Offset pagination for images | Simpler, acceptable for ordered lists |
| WebP + AVIF dual format | More storage, but smaller payloads |

### Alternatives Considered

**1. On-demand image resizing (Imgix/Cloudinary)**
- Pros: Simpler, less storage
- Cons: Higher per-request cost, latency on first request

**2. Single format (JPEG only)**
- Pros: Simpler processing
- Cons: Larger file sizes, worse quality at same size

**3. No blurhash**
- Pros: Less processing complexity
- Cons: Jarring image load experience, layout shift

---

## Closing Summary

"I've designed the backend for an image gallery system with:

1. **Image Processing Pipeline** - Sharp-based resizing with multiple variants (thumbnail, small, medium, large) in WebP and AVIF formats
2. **Presigned Upload Flow** - Secure direct-to-S3 uploads with server-side confirmation and processing queue
3. **Pagination Strategies** - Cursor pagination for galleries (stable sorting) and offset pagination for images (position-based)
4. **Multi-Layer Caching** - Redis for metadata, CDN for images with appropriate cache headers
5. **Blurhash Placeholders** - Generated during processing for smooth loading experience

The key insight is processing images eagerly on upload to ensure fast delivery, while using CDN caching to minimize origin requests. Happy to dive deeper into any component."

---

## Future Enhancements

1. **Image Deduplication** - Hash-based detection of duplicate uploads
2. **Smart Cropping** - AI-based focal point detection for thumbnails
3. **Background Removal** - On-demand processing for product images
4. **Analytics** - Track view counts and popular galleries
5. **Batch Upload** - ZIP file upload with background extraction
