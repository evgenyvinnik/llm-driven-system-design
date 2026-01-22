# Image Gallery - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

---

## 1. Requirements Clarification (2 min)

### Functional Requirements
- Display images in three layouts: slideshow, masonry grid, tiles grid
- Image upload with automatic variant generation
- Navigation between images with lightbox view
- Responsive design for all viewports

### Non-Functional Requirements
- Fast initial load (< 3 seconds first contentful paint)
- Image processing completes within 10 seconds
- 99.9% availability for image serving
- CDN-backed delivery for global performance

### Scale Assumptions
- 10,000 galleries, 1M total images
- 100 uploads/minute peak
- 10,000 image views/minute
- Average image size: 5MB original

---

## 2. High-Level Architecture (3 min)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │ Slideshow   │  │  Masonry    │  │   Tiles     │  │ Lightbox  │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘  │
│         │                │                │               │         │
│         └────────────────┴────────────────┴───────────────┘         │
│                                  │                                   │
│                    ┌─────────────┴─────────────┐                    │
│                    │   API Client (TanStack)    │                    │
└────────────────────┼───────────────────────────┼────────────────────┘
                     │                           │
                     ▼                           ▼
              ┌──────────────┐           ┌──────────────┐
              │   CDN Edge   │◄──────────│   S3/MinIO   │
              │   (Images)   │           │   Storage    │
              └──────────────┘           └──────┬───────┘
                                                │
┌───────────────────────────────────────────────┼─────────────────────┐
│                      Backend API                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Express Server                            │   │
│  │   ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │   │
│  │   │ Gallery API  │ │  Image API   │ │  Upload Service    │  │   │
│  │   └──────┬───────┘ └──────┬───────┘ └─────────┬──────────┘  │   │
│  └──────────┼────────────────┼───────────────────┼──────────────┘   │
│             │                │                   │                   │
│             ▼                ▼                   ▼                   │
│     ┌──────────────┐ ┌──────────────┐   ┌──────────────┐           │
│     │  PostgreSQL  │ │    Redis     │   │  RabbitMQ    │           │
│     │  (Metadata)  │ │   (Cache)    │   │   (Queue)    │           │
│     └──────────────┘ └──────────────┘   └──────┬───────┘           │
│                                                 │                    │
│                                    ┌────────────┴────────────┐      │
│                                    │    Image Processor      │      │
│                                    │    (Worker Service)     │      │
│                                    └─────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Dive: Shared Types and Validation (8 min)

### Shared Package Structure

```
┌──────────────────────────────────────┐
│         packages/shared/             │
├──────────────────────────────────────┤
│  src/                                │
│  ├── index.ts                        │
│  ├── schemas/                        │
│  │   ├── gallery.ts                  │
│  │   ├── image.ts                    │
│  │   └── upload.ts                   │
│  └── types/                          │
│      └── api.ts                      │
└──────────────────────────────────────┘
```

### Zod Schemas for Runtime Validation

**Gallery Schema:**

```
┌─────────────────────────────────────────────────────────┐
│                    GallerySchema                         │
├─────────────────────────────────────────────────────────┤
│  id            │ uuid                                   │
│  name          │ string (1-100 chars)                   │
│  description   │ string (max 500, optional)             │
│  coverImageId  │ uuid (nullable)                        │
│  imageCount    │ integer (min 0)                        │
│  visibility    │ enum: public | private | unlisted      │
│  createdAt     │ datetime                               │
│  updatedAt     │ datetime                               │
├─────────────────────────────────────────────────────────┤
│  CreateGallerySchema: pick(name, description, visibility)│
├─────────────────────────────────────────────────────────┤
│  GalleryListResponse:                                    │
│    galleries: Gallery[]                                  │
│    pagination: { cursor: string | null, hasMore: bool }  │
└─────────────────────────────────────────────────────────┘
```

**Image Schema:**

```
┌─────────────────────────────────────────────────────────┐
│                  ImageVariantSchema                      │
├─────────────────────────────────────────────────────────┤
│  size     │ enum: thumbnail | small | medium | large    │
│  width    │ positive integer                            │
│  height   │ positive integer                            │
│  url      │ valid URL                                   │
│  format   │ enum: webp | avif | jpeg                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                     ImageSchema                          │
├─────────────────────────────────────────────────────────┤
│  id          │ uuid                                     │
│  galleryId   │ uuid                                     │
│  filename    │ string                                   │
│  alt         │ string (max 200, optional)               │
│  width       │ positive integer                         │
│  height      │ positive integer                         │
│  aspectRatio │ positive number                          │
│  blurhash    │ string (nullable)                        │
│  variants    │ ImageVariant[]                           │
│  uploadedAt  │ datetime                                 │
├─────────────────────────────────────────────────────────┤
│  ImageListResponse:                                      │
│    images: Image[]                                       │
│    pagination: { page, limit, total, hasMore }          │
└─────────────────────────────────────────────────────────┘
```

**Upload Schema:**

```
┌─────────────────────────────────────────────────────────┐
│                 UploadRequestSchema                      │
├─────────────────────────────────────────────────────────┤
│  filename    │ string                                   │
│  contentType │ regex: image/(jpeg|png|gif|webp|heic)    │
│  size        │ integer (max 50MB)                       │
│  galleryId   │ uuid                                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              PresignedUploadResponse                     │
├─────────────────────────────────────────────────────────┤
│  uploadId    │ uuid                                     │
│  presignedUrl│ valid URL                                │
│  fields      │ Record<string, string>                   │
│  expiresAt   │ datetime                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: API Design with Type Safety (8 min)

### Express Routes with Zod Middleware

**Validation Middleware Flow:**

```
┌──────────┐    ┌─────────────────┐    ┌─────────────┐
│  Request │───▶│ validateBody()  │───▶│  Handler    │
└──────────┘    │ validateQuery() │    └─────────────┘
                └────────┬────────┘
                         │ on error
                         ▼
                ┌─────────────────┐
                │  400 Response   │
                │  { error, path, │
                │    message }    │
                └─────────────────┘
```

"I chose Zod middleware because it validates at runtime AND generates TypeScript types. One schema serves both purposes - less drift between validation and types."

### Gallery Routes

**GET /api/galleries - List with Cursor Pagination:**

```
Request Flow:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Parse Query  │───▶│ Check Cache  │───▶│ Build Query  │
│ cursor,limit │    │ Redis key    │    │ with cursor  │
└──────────────┘    └──────┬───────┘    └──────┬───────┘
                           │ hit              │
                           ▼                  ▼
                    ┌──────────────┐   ┌──────────────┐
                    │ Return JSON  │   │ PostgreSQL   │
                    └──────────────┘   │ ORDER BY     │
                                       │ created,id   │
                                       └──────┬───────┘
                                              │
                                              ▼
                                       ┌──────────────┐
                                       │ Cache 1 min  │
                                       │ Return JSON  │
                                       └──────────────┘
```

**Cursor Pagination Logic:**
- Fetch limit + 1 rows to detect hasMore
- Cursor format: `{createdAt}_{id}` for stable ordering
- Query: `WHERE (created_at, id) < ($1, $2)` for keyset pagination

**POST /api/galleries - Create:**

```
Request Flow:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Validate     │───▶│ INSERT INTO  │───▶│ Invalidate   │
│ CreateSchema │    │ galleries    │    │ cache: *     │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
                                               ▼
                                        ┌──────────────┐
                                        │ 201 Created  │
                                        └──────────────┘
```

### Image Routes

**GET /api/galleries/:galleryId/images - Paginated List:**

```
┌─────────────────────────────────────────────────────────┐
│  Query with JSON Aggregation                             │
├─────────────────────────────────────────────────────────┤
│  SELECT i.*, json_agg(                                   │
│    json_build_object(                                    │
│      'size', v.size,                                     │
│      'width', v.width,                                   │
│      'url', v.url,                                       │
│      'format', v.format                                  │
│    )                                                     │
│  ) as variants                                           │
│  FROM images i                                           │
│  LEFT JOIN image_variants v ON i.id = v.image_id         │
│  WHERE i.gallery_id = $1                                 │
│  GROUP BY i.id                                           │
│  ORDER BY i.uploaded_at DESC                             │
│  LIMIT $2 OFFSET $3                                      │
└─────────────────────────────────────────────────────────┘
```

Private images get signed URLs via getSignedUrl() before response.

---

## 5. Deep Dive: Type-Safe API Client (8 min)

### API Client Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   API Client                             │
├─────────────────────────────────────────────────────────┤
│  api.galleries                                           │
│    ├── list(cursor?, limit) ──▶ GalleryListResponse     │
│    ├── get(id) ──▶ Gallery                              │
│    ├── create(input) ──▶ Gallery                        │
│    └── delete(id) ──▶ void                              │
├─────────────────────────────────────────────────────────┤
│  api.images                                              │
│    ├── list(galleryId, page, limit) ──▶ ImageListResp   │
│    ├── get(galleryId, imageId) ──▶ Image                │
│    └── delete(galleryId, imageId) ──▶ void              │
├─────────────────────────────────────────────────────────┤
│  api.upload                                              │
│    ├── getPresignedUrl(input) ──▶ PresignedResponse     │
│    └── confirm(input) ──▶ Image                         │
└─────────────────────────────────────────────────────────┘
```

**APIError Class:**
- status: HTTP status code
- message: User-friendly error
- details: Validation errors or server context

### TanStack Query Hooks

**useGalleries - Infinite Query:**

```
┌─────────────────────────────────────────────────────────┐
│               useInfiniteQuery                           │
├─────────────────────────────────────────────────────────┤
│  queryKey: ['galleries', limit]                          │
│  queryFn: ({ pageParam }) ──▶ api.galleries.list()      │
│  initialPageParam: undefined                             │
│  getNextPageParam: (lastPage) ──▶                       │
│    lastPage.pagination.hasMore                           │
│      ? lastPage.pagination.cursor                        │
│      : undefined                                         │
└─────────────────────────────────────────────────────────┘
```

**useCreateGallery - Mutation with Invalidation:**

```
┌─────────────────────────────────────────────────────────┐
│                   useMutation                            │
├─────────────────────────────────────────────────────────┤
│  mutationFn: (input) ──▶ api.galleries.create(input)    │
│  onSuccess: () ──▶                                       │
│    queryClient.invalidateQueries(['galleries'])          │
└─────────────────────────────────────────────────────────┘
```

**useUploadImage - Multi-step Mutation:**

```
Upload Flow:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 1. Get       │───▶│ 2. POST to   │───▶│ 3. Confirm   │
│ presigned    │    │ S3 with      │    │ upload via   │
│ URL          │    │ FormData     │    │ API          │
└──────────────┘    └──────────────┘    └──────────────┘
        │                                       │
        │                                       ▼
        │                              ┌──────────────┐
        │                              │ Invalidate:  │
        │                              │ images, gallery│
        └──────────────────────────────┴──────────────┘
```

---

## 6. Deep Dive: Image Processing Pipeline (8 min)

### Upload Flow

```
┌───────────┐    ┌──────────┐    ┌──────────┐    ┌───────────┐
│  Browser  │───▶│  API     │───▶│  S3      │───▶│ RabbitMQ  │
│           │    │ presign  │    │  Upload  │    │  Queue    │
└───────────┘    └──────────┘    └──────────┘    └─────┬─────┘
                                                       │
                      ┌────────────────────────────────┘
                      ▼
              ┌──────────────┐    ┌──────────────┐
              │   Worker     │───▶│  PostgreSQL  │
              │ (Sharp)      │    │  (Metadata)  │
              └──────┬───────┘    └──────────────┘
                     │
                     ▼
              ┌──────────────┐    ┌──────────────┐
              │   S3         │───▶│    CDN       │
              │ (Variants)   │    │   (Cache)    │
              └──────────────┘    └──────────────┘
```

### Worker Service - Image Processing

**Variant Configuration:**

```
┌───────────────────────────────────────────────────┐
│              VARIANTS Configuration                │
├────────────┬────────┬────────┬───────────────────┤
│ Name       │ Width  │ Height │ Fit               │
├────────────┼────────┼────────┼───────────────────┤
│ thumbnail  │ 80     │ 80     │ cover             │
│ small      │ 300    │ 300    │ inside            │
│ medium     │ 800    │ 800    │ inside            │
│ large      │ 1920   │ 1080   │ inside            │
├────────────┴────────┴────────┴───────────────────┤
│ FORMATS: webp, avif                               │
└───────────────────────────────────────────────────┘
```

**Processing Steps:**

```
processImage(job):
┌─────────────────────────────────────────────────────────┐
│ 1. Download original from S3                             │
│    const buffer = await getObject(job.objectKey)        │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Generate blurhash                                     │
│    - Resize to 32x32                                     │
│    - Encode with blurhash library                        │
│    - Component count: 4x4                                │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Generate variants (Sharp)                             │
│    FOR each variant size:                                │
│      FOR each format (webp, avif):                       │
│        - Resize with fit mode                            │
│        - Convert to format (quality: 80)                 │
│        - Upload to S3: {gallery}/{upload}/{size}.{fmt}   │
│        - Track: { size, width, height, format, url }     │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ 4. Database transaction                                  │
│    BEGIN                                                 │
│      INSERT INTO images (id, gallery_id, ...)           │
│      INSERT INTO image_variants (image_id, ...)         │
│      UPDATE galleries SET image_count = count + 1       │
│    COMMIT                                                │
└─────────────────────────────────────────────────────────┘
```

"I chose to process all variants in a single transaction. If any variant fails, we rollback completely rather than leaving partial data. The trade-off is longer processing time, but data consistency is more important for a gallery app."

---

## 7. Deep Dive: Frontend Components with Backend Integration (5 min)

### Gallery View with Data Fetching

**Component Flow:**

```
┌─────────────────────────────────────────────────────────┐
│                   GalleryPage                            │
├─────────────────────────────────────────────────────────┤
│  useParams() ──▶ galleryId                              │
│  useGalleryStore() ──▶ activeTab                        │
│  useGallery(galleryId) ──▶ { data: gallery, isLoading } │
│  useImages(galleryId) ──▶ { data: imagesData, ... }     │
└────────────────────────┬────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │ Loading │    │ NotFound│    │ Content │
    │ Skeleton│    │  Error  │    │  View   │
    └─────────┘    └─────────┘    └────┬────┘
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                   ┌──────────┐ ┌──────────┐ ┌──────────┐
                   │Slideshow │ │ Masonry  │ │  Tiles   │
                   │  View    │ │  View    │ │  View    │
                   └──────────┘ └──────────┘ └──────────┘
```

**Page Layout:**

```
┌─────────────────────────────────────────────────────────┐
│  Header                                                  │
│  ├── h1: gallery.name                                   │
│  ├── p: gallery.description                             │
│  └── span: "{imageCount} images"                        │
├─────────────────────────────────────────────────────────┤
│  GalleryTabs: [Slideshow] [Masonry] [Tiles]             │
├─────────────────────────────────────────────────────────┤
│  Main Content (based on activeTab)                       │
│  └── Lightbox overlay                                   │
└─────────────────────────────────────────────────────────┘
```

### Image Component with Blurhash Placeholder

**GalleryImage Props:**

```
┌─────────────────────────────────────────────────────────┐
│                GalleryImageProps                         │
├─────────────────────────────────────────────────────────┤
│  variants   │ ImageVariant[]                            │
│  alt        │ string                                    │
│  blurhash   │ string | null                             │
│  size       │ 'thumbnail' | 'small' | 'medium' | 'large'│
│  className? │ string                                    │
│  onClick?   │ () => void                                │
└─────────────────────────────────────────────────────────┘
```

**Rendering Strategy:**

```
┌─────────────────────────────────────────────────────────┐
│  1. Select variant for requested size                    │
│     Priority: webp ──▶ avif ──▶ first available         │
├─────────────────────────────────────────────────────────┤
│  2. Generate srcset for responsive loading               │
│     webpVariants.map(v => `${v.url} ${v.width}w`)       │
├─────────────────────────────────────────────────────────┤
│  3. Decode blurhash to canvas data URL                   │
│     - 32x32 canvas                                       │
│     - Convert to base64 data URL                         │
├─────────────────────────────────────────────────────────┤
│  4. Render layers:                                       │
│     ┌────────────────────────────┐                      │
│     │  Blurhash placeholder      │  (hidden when loaded)│
│     ├────────────────────────────┤                      │
│     │  Actual <img>              │  loading="lazy"      │
│     │  srcset + sizes            │  onLoad ──▶ setLoaded│
│     └────────────────────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

**getSizes by variant:**

| Size      | sizes Attribute                    |
|-----------|------------------------------------|
| thumbnail | 80px                               |
| small     | (max-width: 768px) 50vw, 300px     |
| medium    | (max-width: 768px) 100vw, 800px    |
| large     | 100vw                              |

---

## 8. Trade-offs and Decisions

| Decision | Pros | Cons |
|----------|------|------|
| Zod schemas in shared package | Type-safe across stack, runtime validation | Build complexity, package versioning |
| Presigned uploads | No file through API server, scalable | Extra round-trip, S3 dependency |
| Blurhash placeholders | Beautiful loading experience | Extra processing, bandwidth for hash |
| Multiple image formats | Best format per browser | Storage cost, processing time |
| Cursor pagination for galleries | No count query, efficient | Can't jump to page N |
| Offset pagination for images | Simple, supports page numbers | Slow on large offsets |

---

## 9. Summary

### Key Full-Stack Integration Points

1. **Shared Zod schemas** ensure type safety from database to UI
2. **TanStack Query** provides caching, refetching, and optimistic updates
3. **Presigned uploads** scale file handling without API bottleneck
4. **Background workers** process images asynchronously
5. **CDN integration** delivers optimized images globally

### Future Enhancements

- GraphQL for flexible image queries
- Image tagging with full-text search
- Collaborative albums with sharing
- Mobile app with offline sync
- AI-powered image organization
- Video support with HLS streaming
