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
packages/
└── shared/
    ├── package.json
    └── src/
        ├── index.ts
        ├── schemas/
        │   ├── gallery.ts
        │   ├── image.ts
        │   └── upload.ts
        └── types/
            └── api.ts
```

### Zod Schemas for Runtime Validation

```typescript
// packages/shared/src/schemas/gallery.ts
import { z } from 'zod';

export const GallerySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  coverImageId: z.string().uuid().nullable(),
  imageCount: z.number().int().min(0),
  visibility: z.enum(['public', 'private', 'unlisted']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Gallery = z.infer<typeof GallerySchema>;

export const CreateGallerySchema = GallerySchema.pick({
  name: true,
  description: true,
  visibility: true,
});

export type CreateGalleryInput = z.infer<typeof CreateGallerySchema>;

export const GalleryListResponseSchema = z.object({
  galleries: z.array(GallerySchema),
  pagination: z.object({
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export type GalleryListResponse = z.infer<typeof GalleryListResponseSchema>;
```

```typescript
// packages/shared/src/schemas/image.ts
import { z } from 'zod';

export const ImageVariantSchema = z.object({
  size: z.enum(['thumbnail', 'small', 'medium', 'large', 'original']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string().url(),
  format: z.enum(['webp', 'avif', 'jpeg']),
});

export type ImageVariant = z.infer<typeof ImageVariantSchema>;

export const ImageSchema = z.object({
  id: z.string().uuid(),
  galleryId: z.string().uuid(),
  filename: z.string(),
  alt: z.string().max(200).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.number().positive(),
  blurhash: z.string().nullable(),
  variants: z.array(ImageVariantSchema),
  uploadedAt: z.string().datetime(),
});

export type Image = z.infer<typeof ImageSchema>;

export const ImageListResponseSchema = z.object({
  images: z.array(ImageSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  }),
});

export type ImageListResponse = z.infer<typeof ImageListResponseSchema>;
```

```typescript
// packages/shared/src/schemas/upload.ts
import { z } from 'zod';

export const UploadRequestSchema = z.object({
  filename: z.string(),
  contentType: z.string().regex(/^image\/(jpeg|png|gif|webp|heic)$/),
  size: z.number().int().positive().max(50 * 1024 * 1024), // 50MB max
  galleryId: z.string().uuid(),
});

export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const PresignedUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  presignedUrl: z.string().url(),
  fields: z.record(z.string()),
  expiresAt: z.string().datetime(),
});

export type PresignedUploadResponse = z.infer<typeof PresignedUploadResponseSchema>;

export const UploadConfirmSchema = z.object({
  uploadId: z.string().uuid(),
  alt: z.string().max(200).optional(),
});

export type UploadConfirmInput = z.infer<typeof UploadConfirmSchema>;
```

---

## 4. Deep Dive: API Design with Type Safety (8 min)

### Express Routes with Zod Middleware

```typescript
// backend/src/api/middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Invalid query parameters',
          details: error.errors,
        });
        return;
      }
      next(error);
    }
  };
}
```

### Gallery Routes

```typescript
// backend/src/api/routes/galleries.ts
import { Router } from 'express';
import { z } from 'zod';
import {
  CreateGallerySchema,
  GallerySchema,
  GalleryListResponseSchema,
} from '@gallery/shared';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { pool } from '../../shared/db.js';
import { cacheGet, cacheSet, cacheDelete } from '../../shared/cache.js';

const router = Router();

const ListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/galleries
router.get(
  '/',
  validateQuery(ListQuerySchema),
  async (req, res) => {
    const { cursor, limit } = req.query as z.infer<typeof ListQuerySchema>;

    // Check cache
    const cacheKey = `galleries:${cursor || 'start'}:${limit}`;
    const cached = await cacheGet<z.infer<typeof GalleryListResponseSchema>>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Build query
    let query = `
      SELECT id, name, description, cover_image_id, image_count,
             visibility, created_at, updated_at
      FROM galleries
      WHERE visibility = 'public'
    `;
    const params: any[] = [];

    if (cursor) {
      const [createdAt, id] = cursor.split('_');
      query += ` AND (created_at, id) < ($1, $2)`;
      params.push(createdAt, id);
    }

    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1); // Fetch one extra to determine hasMore

    const result = await pool.query(query, params);
    const galleries = result.rows.slice(0, limit).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      coverImageId: row.cover_image_id,
      imageCount: row.image_count,
      visibility: row.visibility,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const hasMore = result.rows.length > limit;
    const nextCursor = hasMore
      ? `${galleries[limit - 1].createdAt}_${galleries[limit - 1].id}`
      : null;

    const response: z.infer<typeof GalleryListResponseSchema> = {
      galleries,
      pagination: { cursor: nextCursor, hasMore },
    };

    // Cache for 1 minute
    await cacheSet(cacheKey, response, 60);

    res.json(response);
  }
);

// POST /api/galleries
router.post(
  '/',
  validateBody(CreateGallerySchema),
  async (req, res) => {
    const input = req.body as z.infer<typeof CreateGallerySchema>;

    const result = await pool.query(
      `INSERT INTO galleries (name, description, visibility)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.description, input.visibility]
    );

    const gallery = GallerySchema.parse({
      id: result.rows[0].id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      coverImageId: result.rows[0].cover_image_id,
      imageCount: 0,
      visibility: result.rows[0].visibility,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at,
    });

    // Invalidate cache
    await cacheDelete('galleries:*');

    res.status(201).json(gallery);
  }
);

export default router;
```

### Image Routes

```typescript
// backend/src/api/routes/images.ts
import { Router } from 'express';
import { z } from 'zod';
import { ImageListResponseSchema, ImageSchema } from '@gallery/shared';
import { validateQuery } from '../middleware/validate.js';
import { pool } from '../../shared/db.js';
import { cacheGet, cacheSet } from '../../shared/cache.js';
import { getSignedUrl } from '../../shared/storage.js';

const router = Router();

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/galleries/:galleryId/images
router.get(
  '/:galleryId/images',
  validateQuery(ListQuerySchema),
  async (req, res) => {
    const { galleryId } = req.params;
    const { page, limit } = req.query as z.infer<typeof ListQuerySchema>;

    const offset = (page - 1) * limit;
    const cacheKey = `gallery:${galleryId}:images:${page}:${limit}`;

    // Check cache
    const cached = await cacheGet<z.infer<typeof ImageListResponseSchema>>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM images WHERE gallery_id = $1',
      [galleryId]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get images with variants
    const result = await pool.query(
      `SELECT i.*,
              json_agg(json_build_object(
                'size', v.size,
                'width', v.width,
                'height', v.height,
                'url', v.url,
                'format', v.format
              )) as variants
       FROM images i
       LEFT JOIN image_variants v ON i.id = v.image_id
       WHERE i.gallery_id = $1
       GROUP BY i.id
       ORDER BY i.uploaded_at DESC
       LIMIT $2 OFFSET $3`,
      [galleryId, limit, offset]
    );

    // Sign URLs for private images
    const images = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        galleryId: row.gallery_id,
        filename: row.filename,
        alt: row.alt,
        width: row.width,
        height: row.height,
        aspectRatio: row.aspect_ratio,
        blurhash: row.blurhash,
        variants: await Promise.all(
          row.variants.map(async (v: any) => ({
            ...v,
            url: v.url.startsWith('http')
              ? v.url
              : await getSignedUrl(v.url),
          }))
        ),
        uploadedAt: row.uploaded_at,
      }))
    );

    const response: z.infer<typeof ImageListResponseSchema> = {
      images,
      pagination: {
        page,
        limit,
        total,
        hasMore: offset + images.length < total,
      },
    };

    // Cache for 5 minutes
    await cacheSet(cacheKey, response, 300);

    res.json(response);
  }
);

export default router;
```

---

## 5. Deep Dive: Type-Safe API Client (8 min)

### API Client with TanStack Query

```typescript
// frontend/src/api/client.ts
import {
  Gallery,
  GalleryListResponse,
  CreateGalleryInput,
  Image,
  ImageListResponse,
  PresignedUploadResponse,
  UploadRequest,
  UploadConfirmInput,
} from '@gallery/shared';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new APIError(response.status, error.message || 'Request failed', error);
  }

  return response.json();
}

export const api = {
  galleries: {
    list: (cursor?: string, limit = 20): Promise<GalleryListResponse> =>
      request(`/galleries?${new URLSearchParams({
        ...(cursor && { cursor }),
        limit: String(limit),
      })}`),

    get: (id: string): Promise<Gallery> =>
      request(`/galleries/${id}`),

    create: (input: CreateGalleryInput): Promise<Gallery> =>
      request('/galleries', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    delete: (id: string): Promise<void> =>
      request(`/galleries/${id}`, { method: 'DELETE' }),
  },

  images: {
    list: (galleryId: string, page = 1, limit = 50): Promise<ImageListResponse> =>
      request(`/galleries/${galleryId}/images?${new URLSearchParams({
        page: String(page),
        limit: String(limit),
      })}`),

    get: (galleryId: string, imageId: string): Promise<Image> =>
      request(`/galleries/${galleryId}/images/${imageId}`),

    delete: (galleryId: string, imageId: string): Promise<void> =>
      request(`/galleries/${galleryId}/images/${imageId}`, { method: 'DELETE' }),
  },

  upload: {
    getPresignedUrl: (input: UploadRequest): Promise<PresignedUploadResponse> =>
      request('/upload/presign', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    confirm: (input: UploadConfirmInput): Promise<Image> =>
      request('/upload/confirm', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },
};
```

### TanStack Query Hooks

```typescript
// frontend/src/hooks/useGalleries.ts
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { CreateGalleryInput } from '@gallery/shared';

export function useGalleries(limit = 20) {
  return useInfiniteQuery({
    queryKey: ['galleries', limit],
    queryFn: ({ pageParam }) => api.galleries.list(pageParam, limit),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore ? lastPage.pagination.cursor : undefined,
  });
}

export function useGallery(id: string) {
  return useQuery({
    queryKey: ['gallery', id],
    queryFn: () => api.galleries.get(id),
    enabled: !!id,
  });
}

export function useCreateGallery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateGalleryInput) => api.galleries.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['galleries'] });
    },
  });
}
```

```typescript
// frontend/src/hooks/useImages.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { UploadRequest, UploadConfirmInput } from '@gallery/shared';

export function useImages(galleryId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: ['images', galleryId, page, limit],
    queryFn: () => api.images.list(galleryId, page, limit),
    enabled: !!galleryId,
  });
}

export function useUploadImage(galleryId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      // 1. Get presigned URL
      const uploadRequest: UploadRequest = {
        filename: file.name,
        contentType: file.type,
        size: file.size,
        galleryId,
      };

      const presigned = await api.upload.getPresignedUrl(uploadRequest);

      // 2. Upload to S3
      const formData = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => {
        formData.append(key, value);
      });
      formData.append('file', file);

      await fetch(presigned.presignedUrl, {
        method: 'POST',
        body: formData,
      });

      // 3. Confirm upload
      const confirmInput: UploadConfirmInput = {
        uploadId: presigned.uploadId,
      };

      return api.upload.confirm(confirmInput);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['images', galleryId] });
      queryClient.invalidateQueries({ queryKey: ['gallery', galleryId] });
    },
  });
}
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

### Worker Service

```typescript
// backend/src/worker/processor.ts
import sharp from 'sharp';
import { encode as encodeBlurHash } from 'blurhash';
import { pool } from '../shared/db.js';
import { getObject, putObject } from '../shared/storage.js';
import { consumeQueue } from '../shared/queue.js';

interface ProcessImageJob {
  uploadId: string;
  galleryId: string;
  objectKey: string;
}

const VARIANTS = [
  { name: 'thumbnail', width: 80, height: 80, fit: 'cover' as const },
  { name: 'small', width: 300, height: 300, fit: 'inside' as const },
  { name: 'medium', width: 800, height: 800, fit: 'inside' as const },
  { name: 'large', width: 1920, height: 1080, fit: 'inside' as const },
];

const FORMATS = ['webp', 'avif'] as const;

async function processImage(job: ProcessImageJob) {
  console.log(`Processing image: ${job.uploadId}`);

  // 1. Download original from S3
  const originalBuffer = await getObject(job.objectKey);
  const image = sharp(originalBuffer);
  const metadata = await image.metadata();

  // 2. Generate blurhash from small version
  const blurhashBuffer = await image
    .clone()
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const blurhash = encodeBlurHash(
    new Uint8ClampedArray(blurhashBuffer.data),
    blurhashBuffer.info.width,
    blurhashBuffer.info.height,
    4,
    4
  );

  // 3. Generate variants
  const variants: Array<{
    size: string;
    width: number;
    height: number;
    format: string;
    url: string;
  }> = [];

  for (const variant of VARIANTS) {
    for (const format of FORMATS) {
      const resized = await image
        .clone()
        .resize(variant.width, variant.height, { fit: variant.fit })
        [format]({ quality: 80 })
        .toBuffer({ resolveWithObject: true });

      const variantKey = `${job.galleryId}/${job.uploadId}/${variant.name}.${format}`;
      await putObject(variantKey, resized.data, `image/${format}`);

      variants.push({
        size: variant.name,
        width: resized.info.width,
        height: resized.info.height,
        format,
        url: variantKey,
      });
    }
  }

  // 4. Save to database
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert image record
    const imageResult = await client.query(
      `INSERT INTO images (id, gallery_id, filename, width, height, aspect_ratio, blurhash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        job.uploadId,
        job.galleryId,
        job.objectKey.split('/').pop(),
        metadata.width,
        metadata.height,
        metadata.width! / metadata.height!,
        blurhash,
      ]
    );

    // Insert variants
    for (const variant of variants) {
      await client.query(
        `INSERT INTO image_variants (image_id, size, width, height, format, url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          imageResult.rows[0].id,
          variant.size,
          variant.width,
          variant.height,
          variant.format,
          variant.url,
        ]
      );
    }

    // Update gallery image count
    await client.query(
      `UPDATE galleries SET image_count = image_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [job.galleryId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Completed processing: ${job.uploadId}`);
}

// Start consuming queue
consumeQueue('image-processing', processImage);
```

---

## 7. Deep Dive: Frontend Components with Backend Integration (5 min)

### Gallery View with Data Fetching

```typescript
// frontend/src/routes/gallery.$galleryId.tsx
import { useParams } from '@tanstack/react-router';
import { useGallery } from '../hooks/useGalleries';
import { useImages } from '../hooks/useImages';
import { useGalleryStore } from '../stores/galleryStore';
import { SlideshowView } from '../components/gallery/SlideshowView';
import { MasonryView } from '../components/gallery/MasonryView';
import { TilesView } from '../components/gallery/TilesView';
import { Lightbox } from '../components/gallery/Lightbox';
import { GalleryTabs } from '../components/gallery/GalleryTabs';

export function GalleryPage() {
  const { galleryId } = useParams({ from: '/gallery/$galleryId' });
  const { activeTab } = useGalleryStore();

  // Fetch gallery metadata
  const { data: gallery, isLoading: galleryLoading } = useGallery(galleryId);

  // Fetch images (TODO: implement pagination)
  const { data: imagesData, isLoading: imagesLoading } = useImages(galleryId);

  if (galleryLoading || imagesLoading) {
    return <GallerySkeleton />;
  }

  if (!gallery || !imagesData) {
    return <GalleryNotFound />;
  }

  // Transform API images to store format
  const images = imagesData.images.map((img) => ({
    id: img.id,
    alt: img.alt || `Image ${img.id}`,
    width: img.width,
    height: img.height,
    blurhash: img.blurhash,
    variants: img.variants,
  }));

  return (
    <div className="gallery-page">
      <header className="gallery-header">
        <h1>{gallery.name}</h1>
        {gallery.description && <p>{gallery.description}</p>}
        <span className="image-count">{gallery.imageCount} images</span>
      </header>

      <GalleryTabs />

      <main className="gallery-content">
        {activeTab === 'Slideshow' && <SlideshowView images={images} />}
        {activeTab === 'Masonry' && <MasonryView images={images} />}
        {activeTab === 'Tiles' && <TilesView images={images} />}
      </main>

      <Lightbox images={images} />
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="gallery-skeleton">
      <div className="skeleton-header" />
      <div className="skeleton-tabs" />
      <div className="skeleton-grid">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="skeleton-item" />
        ))}
      </div>
    </div>
  );
}
```

### Image Component with Blurhash Placeholder

```typescript
// frontend/src/components/gallery/GalleryImage.tsx
import { useState, useMemo } from 'react';
import { decode as decodeBlurHash } from 'blurhash';
import { ImageVariant } from '@gallery/shared';

interface GalleryImageProps {
  variants: ImageVariant[];
  alt: string;
  blurhash: string | null;
  size: 'thumbnail' | 'small' | 'medium' | 'large';
  className?: string;
  onClick?: () => void;
}

export function GalleryImage({
  variants,
  alt,
  blurhash,
  size,
  className,
  onClick,
}: GalleryImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);

  // Get variant for requested size, prefer webp
  const variant = useMemo(() => {
    const sizeVariants = variants.filter((v) => v.size === size);
    return (
      sizeVariants.find((v) => v.format === 'webp') ||
      sizeVariants.find((v) => v.format === 'avif') ||
      sizeVariants[0]
    );
  }, [variants, size]);

  // Generate srcset for responsive loading
  const srcSet = useMemo(() => {
    const webpVariants = variants.filter((v) => v.format === 'webp');
    return webpVariants
      .map((v) => `${v.url} ${v.width}w`)
      .join(', ');
  }, [variants]);

  // Decode blurhash to data URL
  const blurhashDataUrl = useMemo(() => {
    if (!blurhash) return null;
    const pixels = decodeBlurHash(blurhash, 32, 32);
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(32, 32);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }, [blurhash]);

  if (!variant) return null;

  return (
    <div className={`gallery-image ${className || ''}`} onClick={onClick}>
      {/* Blurhash placeholder */}
      {blurhashDataUrl && !isLoaded && (
        <img
          src={blurhashDataUrl}
          alt=""
          className="gallery-image__placeholder"
          aria-hidden="true"
        />
      )}

      {/* Actual image */}
      <img
        src={variant.url}
        srcSet={srcSet}
        sizes={getSizes(size)}
        alt={alt}
        loading="lazy"
        className={`gallery-image__img ${isLoaded ? 'loaded' : ''}`}
        onLoad={() => setIsLoaded(true)}
      />
    </div>
  );
}

function getSizes(size: string): string {
  switch (size) {
    case 'thumbnail':
      return '80px';
    case 'small':
      return '(max-width: 768px) 50vw, 300px';
    case 'medium':
      return '(max-width: 768px) 100vw, 800px';
    case 'large':
      return '100vw';
    default:
      return '300px';
  }
}
```

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
