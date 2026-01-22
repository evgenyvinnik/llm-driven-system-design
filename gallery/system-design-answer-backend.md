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

### Image Storage Schema

```sql
-- Galleries
CREATE TABLE galleries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  cover_image_id UUID,
  image_count INT DEFAULT 0,
  visibility VARCHAR(20) DEFAULT 'public' CHECK (visibility IN ('public', 'private', 'unlisted')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_galleries_owner ON galleries(owner_id);
CREATE INDEX idx_galleries_visibility ON galleries(visibility) WHERE visibility = 'public';

-- Images
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id UUID REFERENCES galleries(id) ON DELETE CASCADE,
  original_key VARCHAR(500) NOT NULL,  -- S3 key for original
  filename VARCHAR(255),
  mime_type VARCHAR(50) NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  file_size BIGINT NOT NULL,
  alt_text VARCHAR(500),
  position INT NOT NULL,  -- For custom ordering
  blurhash VARCHAR(100),  -- For placeholder blur
  exif_data JSONB,
  processing_status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_images_gallery ON images(gallery_id, position);
CREATE INDEX idx_images_processing ON images(processing_status) WHERE processing_status != 'complete';

-- Image variants (different sizes)
CREATE TABLE image_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID REFERENCES images(id) ON DELETE CASCADE,
  variant_type VARCHAR(20) NOT NULL,  -- 'thumbnail', 'small', 'medium', 'large', 'original'
  s3_key VARCHAR(500) NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  file_size BIGINT NOT NULL,
  format VARCHAR(10) NOT NULL  -- 'webp', 'avif', 'jpeg'
);

CREATE UNIQUE INDEX idx_variants_unique ON image_variants(image_id, variant_type, format);
```

### Image Processing Pipeline

```typescript
// services/imageProcessor.ts
import sharp from 'sharp';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { pool } from '../shared/db';
import { encode as encodeBlurHash } from 'blurhash';

interface VariantConfig {
  name: string;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  format: 'webp' | 'avif' | 'jpeg';
}

const VARIANT_CONFIGS: VariantConfig[] = [
  { name: 'thumbnail', maxWidth: 80, maxHeight: 80, quality: 70, format: 'webp' },
  { name: 'small', maxWidth: 300, maxHeight: 300, quality: 75, format: 'webp' },
  { name: 'medium', maxWidth: 800, maxHeight: 800, quality: 80, format: 'webp' },
  { name: 'large', maxWidth: 1920, maxHeight: 1920, quality: 85, format: 'webp' },
  // AVIF for modern browsers
  { name: 'medium', maxWidth: 800, maxHeight: 800, quality: 65, format: 'avif' },
  { name: 'large', maxWidth: 1920, maxHeight: 1920, quality: 70, format: 'avif' },
];

export class ImageProcessor {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.s3 = new S3Client({ region: process.env.AWS_REGION });
    this.bucket = process.env.S3_BUCKET!;
  }

  async processImage(imageId: string): Promise<void> {
    const client = await pool.connect();

    try {
      // Mark as processing
      await client.query(
        `UPDATE images SET processing_status = 'processing' WHERE id = $1`,
        [imageId]
      );

      // Fetch original from S3
      const imageRow = await client.query(
        'SELECT original_key, gallery_id FROM images WHERE id = $1',
        [imageId]
      );

      if (imageRow.rows.length === 0) {
        throw new Error('Image not found');
      }

      const { original_key, gallery_id } = imageRow.rows[0];

      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: original_key })
      );

      const originalBuffer = await this.streamToBuffer(response.Body);
      const metadata = await sharp(originalBuffer).metadata();

      // Update original dimensions
      await client.query(
        `UPDATE images SET width = $1, height = $2 WHERE id = $3`,
        [metadata.width, metadata.height, imageId]
      );

      // Generate blurhash for placeholder
      const blurhash = await this.generateBlurHash(originalBuffer);
      await client.query(
        `UPDATE images SET blurhash = $1 WHERE id = $2`,
        [blurhash, imageId]
      );

      // Generate all variants
      for (const config of VARIANT_CONFIGS) {
        await this.generateVariant(
          client,
          imageId,
          gallery_id,
          originalBuffer,
          metadata,
          config
        );
      }

      // Mark as complete
      await client.query(
        `UPDATE images SET processing_status = 'complete' WHERE id = $1`,
        [imageId]
      );

      // Update gallery image count
      await client.query(
        `UPDATE galleries
         SET image_count = (SELECT COUNT(*) FROM images WHERE gallery_id = $1)
         WHERE id = $1`,
        [gallery_id]
      );
    } catch (error) {
      await client.query(
        `UPDATE images SET processing_status = 'failed' WHERE id = $1`,
        [imageId]
      );
      throw error;
    } finally {
      client.release();
    }
  }

  private async generateVariant(
    client: PoolClient,
    imageId: string,
    galleryId: string,
    buffer: Buffer,
    metadata: sharp.Metadata,
    config: VariantConfig
  ): Promise<void> {
    // Calculate dimensions maintaining aspect ratio
    const aspectRatio = metadata.width! / metadata.height!;
    let width = config.maxWidth;
    let height = Math.round(width / aspectRatio);

    if (height > config.maxHeight) {
      height = config.maxHeight;
      width = Math.round(height * aspectRatio);
    }

    // Skip if original is smaller
    if (metadata.width! <= width && metadata.height! <= height && config.name !== 'thumbnail') {
      return;
    }

    let pipeline = sharp(buffer).resize(width, height, {
      fit: config.name === 'thumbnail' ? 'cover' : 'inside',
      withoutEnlargement: true,
    });

    // Apply format-specific settings
    switch (config.format) {
      case 'webp':
        pipeline = pipeline.webp({ quality: config.quality });
        break;
      case 'avif':
        pipeline = pipeline.avif({ quality: config.quality });
        break;
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality: config.quality, progressive: true });
        break;
    }

    const outputBuffer = await pipeline.toBuffer();
    const outputMetadata = await sharp(outputBuffer).metadata();

    // S3 key pattern: galleries/{galleryId}/images/{imageId}/{variant}.{format}
    const s3Key = `galleries/${galleryId}/images/${imageId}/${config.name}.${config.format}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: outputBuffer,
        ContentType: `image/${config.format}`,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    // Save variant record
    await client.query(
      `INSERT INTO image_variants (image_id, variant_type, s3_key, width, height, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (image_id, variant_type, format) DO UPDATE SET
         s3_key = EXCLUDED.s3_key,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         file_size = EXCLUDED.file_size`,
      [imageId, config.name, s3Key, outputMetadata.width, outputMetadata.height, outputBuffer.length, config.format]
    );
  }

  private async generateBlurHash(buffer: Buffer): Promise<string> {
    const { data, info } = await sharp(buffer)
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return encodeBlurHash(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      4,
      3
    );
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
```

### Image Upload with Presigned URLs

```typescript
// services/uploadService.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { redis } from '../shared/redis';

interface UploadRequest {
  galleryId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

interface PresignedUpload {
  uploadUrl: string;
  imageId: string;
  expiresIn: number;
}

export class UploadService {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.s3 = new S3Client({ region: process.env.AWS_REGION });
    this.bucket = process.env.S3_BUCKET!;
  }

  async createPresignedUpload(req: UploadRequest): Promise<PresignedUpload> {
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(req.mimeType)) {
      throw new Error('Invalid file type');
    }

    // Validate file size (max 50MB)
    if (req.fileSize > 50 * 1024 * 1024) {
      throw new Error('File too large');
    }

    const imageId = randomUUID();
    const extension = req.filename.split('.').pop() || 'jpg';
    const s3Key = `galleries/${req.galleryId}/originals/${imageId}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ContentType: req.mimeType,
      ContentLength: req.fileSize,
      Metadata: {
        'original-filename': req.filename,
        'gallery-id': req.galleryId,
        'image-id': imageId,
      },
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 });

    // Store pending upload in Redis for validation
    await redis.set(
      `upload:${imageId}`,
      JSON.stringify({
        galleryId: req.galleryId,
        s3Key,
        filename: req.filename,
        mimeType: req.mimeType,
      }),
      'EX',
      3600
    );

    return {
      uploadUrl,
      imageId,
      expiresIn: 3600,
    };
  }

  async confirmUpload(imageId: string): Promise<void> {
    const pending = await redis.get(`upload:${imageId}`);
    if (!pending) {
      throw new Error('Upload not found or expired');
    }

    const { galleryId, s3Key, filename, mimeType } = JSON.parse(pending);

    // Get next position in gallery
    const positionResult = await pool.query(
      'SELECT COALESCE(MAX(position), 0) + 1 as next FROM images WHERE gallery_id = $1',
      [galleryId]
    );
    const position = positionResult.rows[0].next;

    // Create image record
    await pool.query(
      `INSERT INTO images (id, gallery_id, original_key, filename, mime_type, width, height, file_size, position)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6)`,
      [imageId, galleryId, s3Key, filename, mimeType, position]
    );

    // Clean up Redis
    await redis.del(`upload:${imageId}`);

    // Queue for processing
    await redis.lpush('image:processing:queue', imageId);
  }
}
```

---

## Step 4: Deep Dive - Gallery API with Pagination (10 minutes)

### Gallery Routes

```typescript
// routes/galleries.ts
import { Router, Request, Response } from 'express';
import { pool } from '../shared/db';
import { redis } from '../shared/redis';

const router = Router();

// List galleries with cursor pagination
router.get('/', async (req: Request, res: Response) => {
  const { cursor, limit = '20' } = req.query;
  const pageSize = Math.min(parseInt(limit as string, 10), 100);

  let query = `
    SELECT id, name, description, cover_image_id, image_count, created_at, updated_at
    FROM galleries
    WHERE visibility = 'public'
  `;
  const params: unknown[] = [];

  if (cursor) {
    // Cursor is base64 encoded: {created_at}:{id}
    const [createdAt, lastId] = Buffer.from(cursor as string, 'base64')
      .toString()
      .split(':');
    query += ` AND (created_at, id) < ($1, $2)`;
    params.push(createdAt, lastId);
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
  params.push(pageSize + 1); // Fetch one extra to check for next page

  const result = await pool.query(query, params);
  const galleries = result.rows.slice(0, pageSize);
  const hasMore = result.rows.length > pageSize;

  let nextCursor: string | null = null;
  if (hasMore && galleries.length > 0) {
    const last = galleries[galleries.length - 1];
    nextCursor = Buffer.from(`${last.created_at.toISOString()}:${last.id}`).toString('base64');
  }

  res.json({
    data: galleries,
    pagination: {
      nextCursor,
      hasMore,
    },
  });
});

// Get gallery with images
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  // Check cache
  const cached = await redis.get(`gallery:${id}`);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const galleryResult = await pool.query(
    `SELECT id, name, description, image_count, created_at, updated_at
     FROM galleries WHERE id = $1 AND visibility IN ('public', 'unlisted')`,
    [id]
  );

  if (galleryResult.rows.length === 0) {
    return res.status(404).json({ error: 'Gallery not found' });
  }

  const response = {
    data: galleryResult.rows[0],
  };

  // Cache for 5 minutes
  await redis.set(`gallery:${id}`, JSON.stringify(response), 'EX', 300);

  res.json(response);
});

// Get gallery images with offset pagination
router.get('/:id/images', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { page = '1', limit = '50', order = 'position' } = req.query;

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const pageSize = Math.min(parseInt(limit as string, 10), 100);
  const offset = (pageNum - 1) * pageSize;

  // Validate order field
  const allowedOrders = ['position', 'created_at', 'filename'];
  const orderField = allowedOrders.includes(order as string) ? order : 'position';

  // Check cache for first page
  const cacheKey = `gallery:${id}:images:${orderField}:${pageNum}:${pageSize}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const imagesResult = await pool.query(
    `SELECT i.id, i.filename, i.width, i.height, i.alt_text, i.blurhash, i.position,
            (SELECT json_agg(json_build_object(
              'type', v.variant_type,
              'format', v.format,
              'width', v.width,
              'height', v.height,
              'url', '/images/' || v.s3_key
            )) FROM image_variants v WHERE v.image_id = i.id) as variants
     FROM images i
     WHERE i.gallery_id = $1 AND i.processing_status = 'complete'
     ORDER BY ${orderField} ASC
     LIMIT $2 OFFSET $3`,
    [id, pageSize, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM images WHERE gallery_id = $1 AND processing_status = 'complete'`,
    [id]
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const response = {
    data: imagesResult.rows,
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };

  // Cache first 3 pages for 2 minutes
  if (pageNum <= 3) {
    await redis.set(cacheKey, JSON.stringify(response), 'EX', 120);
  }

  res.json(response);
});

export default router;
```

### Image URL Generation Service

```typescript
// services/imageUrlService.ts
import { pool } from '../shared/db';

interface ImageUrl {
  src: string;
  srcSet: string;
  placeholder?: string;
}

interface ImageUrlOptions {
  variant?: 'thumbnail' | 'small' | 'medium' | 'large';
  format?: 'webp' | 'avif' | 'jpeg';
}

export class ImageUrlService {
  private cdnBase: string;

  constructor() {
    this.cdnBase = process.env.CDN_URL || '';
  }

  async getImageUrls(imageId: string, options: ImageUrlOptions = {}): Promise<ImageUrl> {
    const variant = options.variant || 'medium';
    const preferredFormat = options.format || 'webp';

    const result = await pool.query(
      `SELECT v.s3_key, v.variant_type, v.format, v.width,
              i.blurhash
       FROM image_variants v
       JOIN images i ON i.id = v.image_id
       WHERE v.image_id = $1`,
      [imageId]
    );

    if (result.rows.length === 0) {
      throw new Error('Image not found');
    }

    const variants = result.rows;
    const blurhash = variants[0]?.blurhash;

    // Find best match for requested variant
    const exact = variants.find(
      v => v.variant_type === variant && v.format === preferredFormat
    );
    const fallback = variants.find(
      v => v.variant_type === variant && v.format === 'webp'
    );
    const any = variants.find(v => v.variant_type === variant);

    const selectedVariant = exact || fallback || any;
    if (!selectedVariant) {
      throw new Error('Variant not found');
    }

    // Build srcSet for responsive images
    const srcSetParts: string[] = [];
    for (const v of variants) {
      if (v.format === preferredFormat || v.format === 'webp') {
        const url = `${this.cdnBase}/images/${v.s3_key}`;
        srcSetParts.push(`${url} ${v.width}w`);
      }
    }

    return {
      src: `${this.cdnBase}/images/${selectedVariant.s3_key}`,
      srcSet: srcSetParts.join(', '),
      placeholder: blurhash,
    };
  }

  // Generate sizes attribute based on layout
  getSizesForLayout(layout: 'slideshow' | 'masonry' | 'tiles'): string {
    switch (layout) {
      case 'slideshow':
        return '100vw';
      case 'masonry':
        return '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw';
      case 'tiles':
        return '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw';
    }
  }
}
```

---

## Step 5: Deep Dive - Caching Strategy (5 minutes)

### Multi-Layer Caching

```typescript
// services/cacheService.ts
import { redis } from '../shared/redis';

interface CacheConfig {
  ttl: number;
  staleWhileRevalidate?: number;
}

const CACHE_CONFIGS: Record<string, CacheConfig> = {
  'gallery:metadata': { ttl: 300, staleWhileRevalidate: 60 },
  'gallery:images': { ttl: 120, staleWhileRevalidate: 30 },
  'image:variants': { ttl: 3600 },  // Long cache, rarely changes
};

export class CacheService {
  async get<T>(key: string): Promise<T | null> {
    const cached = await redis.get(key);
    if (!cached) return null;

    const { data, expiresAt, staleAt } = JSON.parse(cached);

    // If stale but not expired, return stale and trigger revalidation
    if (staleAt && Date.now() > staleAt && Date.now() < expiresAt) {
      // Return stale data but mark for revalidation
      await redis.sadd('cache:revalidate', key);
      return data;
    }

    return data;
  }

  async set<T>(key: string, data: T, configKey: string): Promise<void> {
    const config = CACHE_CONFIGS[configKey] || { ttl: 60 };

    const expiresAt = Date.now() + config.ttl * 1000;
    const staleAt = config.staleWhileRevalidate
      ? Date.now() + (config.ttl - config.staleWhileRevalidate) * 1000
      : null;

    await redis.set(
      key,
      JSON.stringify({ data, expiresAt, staleAt }),
      'EX',
      config.ttl
    );
  }

  async invalidate(pattern: string): Promise<void> {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  // Invalidate gallery cache when images change
  async invalidateGallery(galleryId: string): Promise<void> {
    await this.invalidate(`gallery:${galleryId}*`);
  }
}
```

### CDN Cache Headers

```typescript
// middleware/cacheHeaders.ts
import { Request, Response, NextFunction } from 'express';

export function setCacheHeaders(
  cacheType: 'static' | 'dynamic' | 'private'
) {
  return (req: Request, res: Response, next: NextFunction) => {
    switch (cacheType) {
      case 'static':
        // Images that never change (immutable variants)
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        break;
      case 'dynamic':
        // Gallery listings, metadata
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
        break;
      case 'private':
        // User-specific data
        res.set('Cache-Control', 'private, no-cache');
        break;
    }
    next();
  };
}
```

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

1. **On-demand image resizing (Imgix/Cloudinary)**
   - Simpler, less storage
   - Higher per-request cost, latency

2. **Single format (JPEG only)**
   - Simpler processing
   - Larger file sizes, worse quality

3. **No blurhash**
   - Less processing
   - Jarring image load experience

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
