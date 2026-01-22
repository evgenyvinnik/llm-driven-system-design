# YouTube - Video Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement

"I'll be designing a fullstack video hosting and streaming platform like YouTube. This is a comprehensive challenge that requires tight integration between frontend and backend: chunked uploads with real-time progress, HLS streaming with adaptive bitrate, transcoding status notifications, and synchronized engagement features. I'll focus on the end-to-end data flow, shared type contracts, and how frontend and backend coordinate for each major feature. Let me start by scoping the problem."

---

## 1. Requirements Clarification (3-4 minutes)

### End-to-End User Flows

1. **Video Upload and Processing**
   - Chunked upload with progress tracking
   - Backend transcoding pipeline
   - Real-time status updates to frontend
   - Metadata form with validation

2. **Video Playback**
   - HLS manifest delivery
   - Adaptive bitrate streaming
   - Watch progress sync (resume playback)
   - View count recording

3. **Engagement Features**
   - Like/dislike with counter sync
   - Comments with threading
   - Subscribe with notification preferences

4. **Discovery and Recommendations**
   - Personalized home feed
   - Search with filtering
   - Trending algorithm

### Integration Requirements

- **Type Safety**: Shared types between frontend and backend
- **Real-time Updates**: SSE/WebSocket for transcoding status
- **Optimistic UI**: Immediate feedback with rollback on error
- **Validation**: Zod schemas shared across stack

---

## 2. System Architecture Overview (5-6 minutes)

### Fullstack Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    FRONTEND (React)                                      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   Routes                          Components                    State & Services         │
│   ┌──────────────────┐            ┌─────────────────┐          ┌──────────────────┐     │
│   │ / (Home)         │            │ VideoPlayer     │──────────│ playerStore      │     │
│   │ /watch/:id       │            │   └─ HLS.js     │          │ (Zustand)        │     │
│   │ /upload          │            │ UploadProgress  │──────────│ uploadStore      │     │
│   │ /channel/:handle │            │ CommentSection  │          │ authStore        │     │
│   │ /search          │            │ LikeDislikeBar  │          └────────┬─────────┘     │
│   └────────┬─────────┘            └────────┬────────┘                   │               │
│            │                               │                            │               │
│            └───────────────────────────────┴────────────────────────────┘               │
│                                            │                                             │
│                                     ┌──────▼──────┐                                      │
│                                     │ API Service │                                      │
│                                     │ (fetch/SSE) │                                      │
│                                     └──────┬──────┘                                      │
└────────────────────────────────────────────┼────────────────────────────────────────────┘
                                             │ HTTP + SSE
                         ┌───────────────────┴───────────────────┐
                         │                                       │
┌────────────────────────▼───────────────────────────────────────▼────────────────────────┐
│                                    BACKEND (Node.js)                                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   API Gateway (Express)              Services                   Workers                  │
│   ┌──────────────────┐              ┌─────────────────┐        ┌─────────────────┐      │
│   │ /api/v1/uploads  │──────────────│ UploadService   │        │ TranscodeWorker │      │
│   │ /api/v1/videos   │──────────────│ VideoService    │◄──────►│ (RabbitMQ)      │      │
│   │ /api/v1/comments │──────────────│ CommentService  │        └────────┬────────┘      │
│   │ /api/v1/channels │──────────────│ ChannelService  │                 │               │
│   │ /api/v1/auth     │──────────────│ AuthService     │                 │               │
│   │ /api/v1/sse      │──────────────│ SSEService      │◄────────────────┘               │
│   └────────┬─────────┘              └────────┬────────┘                                  │
│            │                                 │                                           │
│            └─────────────────────────────────┘                                           │
│                           │                                                              │
│           ┌───────────────┼───────────────┬───────────────┐                             │
│           │               │               │               │                             │
│   ┌───────▼─────┐ ┌───────▼─────┐ ┌──────▼──────┐ ┌──────▼──────┐                      │
│   │ PostgreSQL  │ │    Redis    │ │    MinIO    │ │  RabbitMQ   │                      │
│   │ (metadata)  │ │ (cache/sess)│ │ (videos)    │ │  (queue)    │                      │
│   └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘                      │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                  SHARED (packages/shared)                                │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│   types/           schemas/           constants/         utils/                          │
│   ├─ video.ts      ├─ upload.ts       ├─ limits.ts       ├─ formatters.ts               │
│   ├─ user.ts       ├─ video.ts        ├─ mimeTypes.ts    └─ validators.ts               │
│   ├─ comment.ts    └─ comment.ts      └─ resolutions.ts                                  │
│   └─ api.ts                                                                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Monorepo Structure

```
youtube/
├── packages/
│   └── shared/                    # Shared types and validation
│       ├── src/
│       │   ├── types/             # TypeScript interfaces
│       │   ├── schemas/           # Zod validation schemas
│       │   ├── constants/         # Shared constants
│       │   └── utils/             # Shared utilities
│       ├── package.json
│       └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── routes/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── store/
│   │   └── services/
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── api/
│   │   ├── services/
│   │   ├── workers/
│   │   └── shared/
│   └── package.json
└── package.json                   # Workspace root
```

---

## 3. Shared Types and Validation (5-6 minutes)

### Core Type Definitions

```typescript
// packages/shared/src/types/video.ts
export type VideoStatus = 'uploading' | 'processing' | 'ready' | 'failed' | 'blocked';
export type VideoVisibility = 'public' | 'unlisted' | 'private';
export type VideoResolution = '1080p' | '720p' | '480p' | '360p';

export interface Video {
  id: string;                      // 11-char YouTube-style ID
  channelId: string;
  title: string;
  description: string | null;
  durationSeconds: number | null;
  status: VideoStatus;
  visibility: VideoVisibility;
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  categories: string[];
  tags: string[];
  thumbnailUrl: string | null;
  publishedAt: string | null;      // ISO date string
  createdAt: string;
}

export interface VideoWithChannel extends Video {
  channel: {
    id: string;
    name: string;
    handle: string;
    avatarUrl: string | null;
    subscriberCount: number;
  };
}

export interface VideoResolutionInfo {
  videoId: string;
  resolution: VideoResolution;
  manifestUrl: string;
  bitrate: number;
  width: number;
  height: number;
}

// packages/shared/src/types/upload.ts
export interface UploadSession {
  id: string;
  filename: string;
  fileSize: number;
  totalChunks: number;
  uploadedChunks: number;
  status: 'active' | 'completed' | 'expired' | 'cancelled';
  chunkSize: number;
  expiresAt: string;
}

export interface UploadInitRequest {
  filename: string;
  fileSize: number;
  mimeType: string;
}

export interface UploadInitResponse {
  uploadId: string;
  totalChunks: number;
  chunkSize: number;
  expiresAt: string;
}

export interface UploadCompleteRequest {
  title: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  visibility?: VideoVisibility;
}

export interface UploadCompleteResponse {
  videoId: string;
  status: VideoStatus;
}

// packages/shared/src/types/api.ts
export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
  meta: ApiMeta | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiMeta {
  page?: number;
  perPage?: number;
  total?: number;
  hasMore?: boolean;
}

export interface PaginationParams {
  page?: number;
  perPage?: number;
}

// SSE Events
export type SSEEventType =
  | 'transcode.started'
  | 'transcode.progress'
  | 'transcode.completed'
  | 'transcode.failed';

export interface TranscodeProgressEvent {
  type: 'transcode.progress';
  videoId: string;
  resolution: VideoResolution;
  progress: number;       // 0-100
}

export interface TranscodeCompletedEvent {
  type: 'transcode.completed';
  videoId: string;
  resolutions: VideoResolutionInfo[];
  thumbnailUrl: string;
  durationSeconds: number;
}
```

### Zod Validation Schemas

```typescript
// packages/shared/src/schemas/upload.ts
import { z } from 'zod';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE, MAX_TITLE_LENGTH } from '../constants/limits';

export const uploadInitSchema = z.object({
  filename: z.string()
    .min(1, 'Filename is required')
    .max(255, 'Filename too long'),
  fileSize: z.number()
    .positive('File size must be positive')
    .max(MAX_FILE_SIZE, `File size exceeds ${MAX_FILE_SIZE / 1e9}GB limit`),
  mimeType: z.enum(ALLOWED_MIME_TYPES as [string, ...string[]], {
    errorMap: () => ({ message: 'Unsupported video format' })
  })
});

export const uploadCompleteSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(MAX_TITLE_LENGTH, `Title must be under ${MAX_TITLE_LENGTH} characters`),
  description: z.string()
    .max(5000, 'Description must be under 5000 characters')
    .optional(),
  tags: z.array(z.string().max(50))
    .max(30, 'Maximum 30 tags allowed')
    .optional(),
  categories: z.array(z.string())
    .max(5, 'Maximum 5 categories allowed')
    .optional(),
  visibility: z.enum(['public', 'unlisted', 'private'])
    .default('public')
});

export type UploadInitInput = z.infer<typeof uploadInitSchema>;
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;

// packages/shared/src/schemas/video.ts
export const videoUpdateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  categories: z.array(z.string()).max(5).optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional()
});

// packages/shared/src/schemas/comment.ts
export const commentCreateSchema = z.object({
  text: z.string()
    .min(1, 'Comment cannot be empty')
    .max(10000, 'Comment must be under 10000 characters'),
  parentId: z.string().uuid().optional()
});

export const commentUpdateSchema = z.object({
  text: z.string()
    .min(1, 'Comment cannot be empty')
    .max(10000, 'Comment must be under 10000 characters')
});
```

### Shared Constants

```typescript
// packages/shared/src/constants/limits.ts
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;  // 5GB
export const CHUNK_SIZE = 5 * 1024 * 1024;            // 5MB
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_CONCURRENT_CHUNKS = 3;
export const UPLOAD_EXPIRY_HOURS = 24;

// packages/shared/src/constants/mimeTypes.ts
export const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska'
] as const;

// packages/shared/src/constants/resolutions.ts
export const VIDEO_RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080, bitrate: 5000000 },
  '720p':  { width: 1280, height: 720,  bitrate: 2500000 },
  '480p':  { width: 854,  height: 480,  bitrate: 1000000 },
  '360p':  { width: 640,  height: 360,  bitrate: 500000 }
} as const;
```

---

## 4. Deep Dive: Chunked Upload Flow (10-12 minutes)

### Backend Upload Service

```typescript
// backend/src/services/uploadService.ts
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { uploadInitSchema, uploadCompleteSchema, UploadInitInput, UploadCompleteInput } from '@youtube/shared';
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { queue } from '../shared/queue';
import { generateUploadId, generateVideoId } from '../utils/ids';

export class UploadService {
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY!,
        secretAccessKey: process.env.MINIO_SECRET_KEY!
      },
      forcePathStyle: true
    });
  }

  async initializeUpload(userId: string, input: UploadInitInput): Promise<UploadSession> {
    // Validate input
    const validated = uploadInitSchema.parse(input);

    const uploadId = generateUploadId();
    const totalChunks = Math.ceil(validated.fileSize / CHUNK_SIZE);
    const s3Key = `${uploadId}/${validated.filename}`;

    // Initialize S3 multipart upload
    const s3Upload = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: 'raw-videos',
      Key: s3Key,
      ContentType: validated.mimeType
    }));

    // Store session in database
    const result = await pool.query(`
      INSERT INTO upload_sessions
        (id, user_id, filename, file_size, content_type, total_chunks, minio_upload_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      uploadId,
      userId,
      validated.filename,
      validated.fileSize,
      validated.mimeType,
      totalChunks,
      s3Upload.UploadId
    ]);

    // Initialize Redis tracking for chunk ETags
    await redis.hset(`upload:${uploadId}`, {
      s3Key,
      s3UploadId: s3Upload.UploadId,
      completedChunks: 0
    });

    return {
      id: uploadId,
      filename: validated.filename,
      fileSize: validated.fileSize,
      totalChunks,
      uploadedChunks: 0,
      status: 'active',
      chunkSize: CHUNK_SIZE,
      expiresAt: result.rows[0].expires_at.toISOString()
    };
  }

  async uploadChunk(
    uploadId: string,
    chunkNumber: number,
    data: Buffer
  ): Promise<{ etag: string }> {
    // Validate session exists and is active
    const session = await this.getSession(uploadId);
    if (!session || session.status !== 'active') {
      throw new NotFoundError('Upload session not found or expired');
    }

    // Get S3 upload info from Redis
    const uploadInfo = await redis.hgetall(`upload:${uploadId}`);
    if (!uploadInfo.s3Key) {
      throw new NotFoundError('Upload session corrupted');
    }

    // Upload part to S3
    const result = await this.s3.send(new UploadPartCommand({
      Bucket: 'raw-videos',
      Key: uploadInfo.s3Key,
      UploadId: uploadInfo.s3UploadId,
      PartNumber: chunkNumber + 1, // S3 parts are 1-indexed
      Body: data
    }));

    // Track chunk completion
    await redis.multi()
      .hset(`upload:${uploadId}:parts`, chunkNumber.toString(), result.ETag)
      .hincrby(`upload:${uploadId}`, 'completedChunks', 1)
      .exec();

    return { etag: result.ETag! };
  }

  async completeUpload(
    userId: string,
    uploadId: string,
    input: UploadCompleteInput
  ): Promise<{ videoId: string; status: VideoStatus }> {
    const validated = uploadCompleteSchema.parse(input);

    // Validate session
    const session = await this.getSession(uploadId);
    if (!session || session.status !== 'active') {
      throw new NotFoundError('Upload session not found');
    }

    // Verify all chunks uploaded
    const uploadInfo = await redis.hgetall(`upload:${uploadId}`);
    const completedChunks = parseInt(uploadInfo.completedChunks || '0');

    if (completedChunks !== session.total_chunks) {
      throw new ValidationError(
        `Missing chunks: ${completedChunks}/${session.total_chunks} uploaded`
      );
    }

    // Get chunk ETags and complete S3 multipart
    const parts = await redis.hgetall(`upload:${uploadId}:parts`);
    const sortedParts = Object.entries(parts)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([partNumber, etag]) => ({
        PartNumber: parseInt(partNumber) + 1,
        ETag: etag
      }));

    await this.s3.send(new CompleteMultipartUploadCommand({
      Bucket: 'raw-videos',
      Key: uploadInfo.s3Key,
      UploadId: uploadInfo.s3UploadId,
      MultipartUpload: { Parts: sortedParts }
    }));

    // Create video record
    const videoId = generateVideoId();

    await pool.query('BEGIN');
    try {
      await pool.query(`
        INSERT INTO videos
          (id, channel_id, title, description, tags, categories, visibility, status, raw_video_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)
      `, [
        videoId,
        userId,
        validated.title,
        validated.description || null,
        validated.tags || [],
        validated.categories || [],
        validated.visibility,
        uploadInfo.s3Key
      ]);

      await pool.query(`
        UPDATE upload_sessions SET status = 'completed' WHERE id = $1
      `, [uploadId]);

      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

    // Queue transcoding job
    await queue.publish('transcode.jobs', {
      jobId: generateJobId(),
      videoId,
      sourceKey: uploadInfo.s3Key,
      resolutions: ['1080p', '720p', '480p', '360p'],
      userId,
      createdAt: new Date().toISOString()
    });

    // Cleanup Redis
    await redis.del(`upload:${uploadId}`, `upload:${uploadId}:parts`);

    return { videoId, status: 'processing' };
  }

  private async getSession(uploadId: string): Promise<UploadSessionRow | null> {
    const result = await pool.query(
      'SELECT * FROM upload_sessions WHERE id = $1',
      [uploadId]
    );
    return result.rows[0] || null;
  }
}
```

### Frontend Upload Hook and Component

```typescript
// frontend/src/hooks/useChunkedUpload.ts
import { useState, useCallback, useRef } from 'react';
import {
  UploadInitRequest,
  UploadCompleteRequest,
  CHUNK_SIZE,
  MAX_CONCURRENT_CHUNKS
} from '@youtube/shared';
import { uploadApi } from '@/services/uploadApi';

export interface UploadProgress {
  status: 'idle' | 'initializing' | 'uploading' | 'completing' | 'done' | 'error';
  uploadedChunks: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
  percentComplete: number;
  videoId?: string;
  error?: string;
}

export function useChunkedUpload() {
  const [progress, setProgress] = useState<UploadProgress>({
    status: 'idle',
    uploadedChunks: 0,
    totalChunks: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    percentComplete: 0
  });

  const abortRef = useRef<AbortController | null>(null);

  const uploadFile = useCallback(async (
    file: File,
    metadata: UploadCompleteRequest
  ): Promise<string> => {
    abortRef.current = new AbortController();

    try {
      // Step 1: Initialize upload
      setProgress(p => ({ ...p, status: 'initializing', totalBytes: file.size }));

      const initRequest: UploadInitRequest = {
        filename: file.name,
        fileSize: file.size,
        mimeType: file.type
      };

      const session = await uploadApi.initializeUpload(initRequest);

      setProgress(p => ({
        ...p,
        status: 'uploading',
        totalChunks: session.totalChunks
      }));

      // Step 2: Upload chunks with concurrency control
      const chunks: { index: number; blob: Blob }[] = [];
      for (let i = 0; i < session.totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        chunks.push({ index: i, blob: file.slice(start, end) });
      }

      let uploadedChunks = 0;
      let uploadedBytes = 0;

      // Process chunks with concurrency pool
      const uploadChunk = async (chunk: { index: number; blob: Blob }) => {
        if (abortRef.current?.signal.aborted) {
          throw new Error('Upload cancelled');
        }

        await uploadApi.uploadChunk(
          session.id,
          chunk.index,
          chunk.blob,
          abortRef.current?.signal
        );

        uploadedChunks++;
        uploadedBytes += chunk.blob.size;

        setProgress(p => ({
          ...p,
          uploadedChunks,
          uploadedBytes,
          percentComplete: Math.round((uploadedBytes / file.size) * 100)
        }));
      };

      // Parallel upload with concurrency limit
      const pool: Promise<void>[] = [];
      for (const chunk of chunks) {
        const promise = uploadChunk(chunk).finally(() => {
          pool.splice(pool.indexOf(promise), 1);
        });
        pool.push(promise);

        if (pool.length >= MAX_CONCURRENT_CHUNKS) {
          await Promise.race(pool);
        }
      }
      await Promise.all(pool);

      // Step 3: Complete upload
      setProgress(p => ({ ...p, status: 'completing' }));

      const result = await uploadApi.completeUpload(session.id, metadata);

      setProgress(p => ({
        ...p,
        status: 'done',
        percentComplete: 100,
        videoId: result.videoId
      }));

      return result.videoId;

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      setProgress(p => ({
        ...p,
        status: 'error',
        error: message
      }));
      throw error;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setProgress(p => ({ ...p, status: 'idle' }));
  }, []);

  return { progress, uploadFile, cancel };
}
```

### Backend API Routes

```typescript
// backend/src/api/uploads.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { UploadService } from '../services/uploadService';

const router = Router();
const uploadService = new UploadService();

// Initialize upload
router.post('/init',
  requireAuth,
  rateLimit({ max: 5, windowMs: 60000 }),
  async (req, res, next) => {
    try {
      const session = await uploadService.initializeUpload(
        req.session.userId,
        req.body
      );
      res.json({ data: session, error: null, meta: null });
    } catch (error) {
      next(error);
    }
  }
);

// Upload chunk
router.put('/:uploadId/chunks/:chunkNumber',
  requireAuth,
  rateLimit({ max: 100, windowMs: 60000 }),
  async (req, res, next) => {
    try {
      const { uploadId, chunkNumber } = req.params;
      const result = await uploadService.uploadChunk(
        uploadId,
        parseInt(chunkNumber),
        req.body // Raw buffer from body-parser
      );
      res.json({ data: result, error: null, meta: null });
    } catch (error) {
      next(error);
    }
  }
);

// Complete upload
router.post('/:uploadId/complete',
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await uploadService.completeUpload(
        req.session.userId,
        req.params.uploadId,
        req.body
      );
      res.json({ data: result, error: null, meta: null });
    } catch (error) {
      next(error);
    }
  }
);

export { router as uploadRoutes };
```

---

## 5. Deep Dive: Video Playback Integration (8-10 minutes)

### Backend Streaming Service

```typescript
// backend/src/services/streamingService.ts
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { VideoWithChannel, VideoResolutionInfo } from '@youtube/shared';

export class StreamingService {
  async getVideoForPlayback(videoId: string, userId?: string): Promise<{
    video: VideoWithChannel;
    resolutions: VideoResolutionInfo[];
    resumePosition?: number;
  }> {
    // Check cache first
    const cached = await redis.get(`video:${videoId}`);
    if (cached) {
      const video = JSON.parse(cached);

      // Get resume position if user is logged in
      let resumePosition: number | undefined;
      if (userId) {
        resumePosition = await this.getResumePosition(userId, videoId);
      }

      const resolutions = await this.getResolutions(videoId);
      return { video, resolutions, resumePosition };
    }

    // Fetch from database
    const result = await pool.query(`
      SELECT
        v.*,
        json_build_object(
          'id', u.id,
          'name', u.channel_name,
          'handle', u.username,
          'avatarUrl', u.avatar_url,
          'subscriberCount', u.subscriber_count
        ) as channel
      FROM videos v
      JOIN users u ON u.id = v.channel_id
      WHERE v.id = $1
        AND v.status = 'ready'
    `, [videoId]);

    if (result.rows.length === 0) {
      throw new NotFoundError('Video not found');
    }

    const video = this.mapVideoRow(result.rows[0]);

    // Cache for 5 minutes
    await redis.setex(`video:${videoId}`, 300, JSON.stringify(video));

    // Get resolutions and resume position
    const resolutions = await this.getResolutions(videoId);
    let resumePosition: number | undefined;
    if (userId) {
      resumePosition = await this.getResumePosition(userId, videoId);
    }

    return { video, resolutions, resumePosition };
  }

  private async getResolutions(videoId: string): Promise<VideoResolutionInfo[]> {
    const cached = await redis.get(`resolutions:${videoId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await pool.query(`
      SELECT video_id, resolution, manifest_url, bitrate, width, height
      FROM video_resolutions
      WHERE video_id = $1
      ORDER BY bitrate DESC
    `, [videoId]);

    const resolutions = result.rows.map(row => ({
      videoId: row.video_id,
      resolution: row.resolution,
      manifestUrl: row.manifest_url,
      bitrate: row.bitrate,
      width: row.width,
      height: row.height
    }));

    // Cache for 1 hour
    await redis.setex(`resolutions:${videoId}`, 3600, JSON.stringify(resolutions));

    return resolutions;
  }

  private async getResumePosition(userId: string, videoId: string): Promise<number | undefined> {
    const result = await pool.query(`
      SELECT last_position_seconds
      FROM watch_history
      WHERE user_id = $1 AND video_id = $2
      ORDER BY watched_at DESC
      LIMIT 1
    `, [userId, videoId]);

    return result.rows[0]?.last_position_seconds;
  }

  async recordView(videoId: string, userId?: string): Promise<void> {
    // Increment view counter in Redis
    await redis.incr(`views:pending:${videoId}`);

    // Log to watch history if user is logged in
    if (userId) {
      await pool.query(`
        INSERT INTO watch_history (user_id, video_id, watched_at)
        VALUES ($1, $2, NOW())
      `, [userId, videoId]);
    }
  }

  async updateWatchProgress(
    userId: string,
    videoId: string,
    position: number,
    duration: number
  ): Promise<void> {
    const watchPercentage = (position / duration) * 100;

    await pool.query(`
      INSERT INTO watch_history (user_id, video_id, last_position_seconds, watch_duration_seconds, watch_percentage)
      VALUES ($1, $2, $3, $3, $4)
      ON CONFLICT (user_id, video_id)
      DO UPDATE SET
        last_position_seconds = $3,
        watch_duration_seconds = GREATEST(watch_history.watch_duration_seconds, $3),
        watch_percentage = GREATEST(watch_history.watch_percentage, $4),
        watched_at = NOW()
    `, [userId, videoId, position, watchPercentage]);
  }

  private mapVideoRow(row: any): VideoWithChannel {
    return {
      id: row.id,
      channelId: row.channel_id,
      title: row.title,
      description: row.description,
      durationSeconds: row.duration_seconds,
      status: row.status,
      visibility: row.visibility,
      viewCount: parseInt(row.view_count),
      likeCount: parseInt(row.like_count),
      dislikeCount: parseInt(row.dislike_count),
      commentCount: parseInt(row.comment_count),
      categories: row.categories,
      tags: row.tags,
      thumbnailUrl: row.thumbnail_url,
      publishedAt: row.published_at?.toISOString() || null,
      createdAt: row.created_at.toISOString(),
      channel: row.channel
    };
  }
}
```

### Frontend Watch Page

```tsx
// frontend/src/routes/watch.$videoId.tsx
import { useParams } from '@tanstack/react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { VideoWithChannel, VideoResolutionInfo } from '@youtube/shared';
import { videoApi } from '@/services/videoApi';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { VideoInfo } from '@/components/video/VideoInfo';
import { CommentSection } from '@/components/engagement/CommentSection';
import { RecommendationSidebar } from '@/components/video/RecommendationSidebar';
import { useAuthStore } from '@/store/authStore';

export function WatchPage() {
  const { videoId } = useParams({ from: '/watch/$videoId' });
  const { user } = useAuthStore();
  const lastProgressRef = useRef(0);
  const progressIntervalRef = useRef<NodeJS.Timeout>();

  // Fetch video data
  const { data, isLoading, error } = useQuery({
    queryKey: ['video', videoId],
    queryFn: () => videoApi.getVideoForPlayback(videoId)
  });

  // Record view mutation
  const recordViewMutation = useMutation({
    mutationFn: () => videoApi.recordView(videoId)
  });

  // Update progress mutation
  const updateProgressMutation = useMutation({
    mutationFn: (position: number) =>
      videoApi.updateProgress(videoId, position, data?.video.durationSeconds || 0)
  });

  // Record view on mount
  useEffect(() => {
    recordViewMutation.mutate();
  }, [videoId]);

  // Handle progress updates
  const handleProgress = useCallback((position: number) => {
    lastProgressRef.current = position;
  }, []);

  // Sync progress every 30 seconds
  useEffect(() => {
    if (!user) return;

    progressIntervalRef.current = setInterval(() => {
      if (lastProgressRef.current > 0) {
        updateProgressMutation.mutate(lastProgressRef.current);
      }
    }, 30000);

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      // Final progress sync on unmount
      if (lastProgressRef.current > 0) {
        updateProgressMutation.mutate(lastProgressRef.current);
      }
    };
  }, [user]);

  if (isLoading) {
    return <WatchPageSkeleton />;
  }

  if (error || !data) {
    return <VideoNotFound />;
  }

  const { video, resolutions, resumePosition } = data;
  const masterManifestUrl = `/api/v1/videos/${videoId}/manifest`;

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-6 max-w-[1800px] mx-auto">
      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Video player */}
        <div className="aspect-video bg-black rounded-xl overflow-hidden">
          <VideoPlayer
            videoId={videoId}
            manifestUrl={masterManifestUrl}
            thumbnailUrl={video.thumbnailUrl || ''}
            duration={video.durationSeconds || 0}
            startPosition={resumePosition}
            onProgress={handleProgress}
          />
        </div>

        {/* Video info */}
        <VideoInfo
          video={video}
          className="mt-4"
        />

        {/* Comments */}
        <CommentSection
          videoId={videoId}
          commentCount={video.commentCount}
          className="mt-6"
        />
      </div>

      {/* Recommendations sidebar */}
      <aside className="w-full lg:w-[400px] flex-shrink-0">
        <RecommendationSidebar
          currentVideoId={videoId}
          categories={video.categories}
        />
      </aside>
    </div>
  );
}
```

### HLS Player Integration

```tsx
// frontend/src/components/player/VideoPlayer.tsx
import Hls from 'hls.js';
import { useEffect, useRef, useState, useCallback } from 'react';
import { VideoResolution } from '@youtube/shared';

interface VideoPlayerProps {
  videoId: string;
  manifestUrl: string;
  thumbnailUrl: string;
  duration: number;
  startPosition?: number;
  onProgress?: (position: number) => void;
}

export function VideoPlayer({
  videoId,
  manifestUrl,
  thumbnailUrl,
  duration,
  startPosition = 0,
  onProgress
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [qualityLevels, setQualityLevels] = useState<{
    index: number;
    label: string;
    height: number;
  }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);

  // Initialize HLS.js
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Native HLS support (Safari)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifestUrl;
      video.currentTime = startPosition;
      return;
    }

    // HLS.js for other browsers
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        startLevel: -1, // Auto quality
        capLevelToPlayerSize: true,
        startPosition: startPosition
      });

      hls.attachMedia(video);
      hls.loadSource(manifestUrl);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const levels = data.levels.map((level, index) => ({
          index,
          label: `${level.height}p`,
          height: level.height
        }));
        setQualityLevels([
          { index: -1, label: 'Auto', height: 0 },
          ...levels.sort((a, b) => b.height - a.height)
        ]);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
          }
        }
      });

      hlsRef.current = hls;
    }

    return () => {
      hlsRef.current?.destroy();
    };
  }, [manifestUrl, startPosition]);

  // Track playback progress
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      onProgress?.(video.currentTime);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [onProgress]);

  const handleQualityChange = useCallback((levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
      setCurrentQuality(levelIndex);
    }
  }, []);

  return (
    <div className="relative w-full h-full bg-black group">
      <video
        ref={videoRef}
        className="w-full h-full"
        poster={thumbnailUrl}
        playsInline
      />

      <PlayerControls
        video={videoRef.current}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        qualityLevels={qualityLevels}
        currentQuality={currentQuality}
        onQualityChange={handleQualityChange}
      />
    </div>
  );
}
```

---

## 6. Deep Dive: SSE for Transcoding Status (6-8 minutes)

### Backend SSE Service

```typescript
// backend/src/services/sseService.ts
import { Response } from 'express';
import { TranscodeProgressEvent, TranscodeCompletedEvent, SSEEventType } from '@youtube/shared';

interface SSEClient {
  id: string;
  userId: string;
  res: Response;
  videoIds: Set<string>;
}

class SSEService {
  private clients = new Map<string, SSEClient>();

  addClient(clientId: string, userId: string, res: Response): void {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    this.clients.set(clientId, {
      id: clientId,
      userId,
      res,
      videoIds: new Set()
    });

    // Handle client disconnect
    res.on('close', () => {
      this.clients.delete(clientId);
    });

    // Keep-alive ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (this.clients.has(clientId)) {
        res.write(': ping\n\n');
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  }

  subscribeToVideo(clientId: string, videoId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.videoIds.add(videoId);
    }
  }

  unsubscribeFromVideo(clientId: string, videoId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.videoIds.delete(videoId);
    }
  }

  sendToVideo(videoId: string, event: TranscodeProgressEvent | TranscodeCompletedEvent): void {
    for (const client of this.clients.values()) {
      if (client.videoIds.has(videoId)) {
        client.res.write(`event: ${event.type}\n`);
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  }

  sendToUser(userId: string, event: { type: string; data: unknown }): void {
    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        client.res.write(`event: ${event.type}\n`);
        client.res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
    }
  }
}

export const sseService = new SSEService();

// backend/src/api/sse.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { sseService } from '../services/sseService';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.get('/events', requireAuth, (req, res) => {
  const clientId = uuidv4();
  sseService.addClient(clientId, req.session.userId, res);
});

router.post('/subscribe/:videoId', requireAuth, (req, res) => {
  const { videoId } = req.params;
  const { clientId } = req.body;
  sseService.subscribeToVideo(clientId, videoId);
  res.json({ success: true });
});

export { router as sseRoutes };
```

### Transcode Worker Integration

```typescript
// backend/src/workers/transcodeWorker.ts
import { sseService } from '../services/sseService';
import { TranscodeProgressEvent, TranscodeCompletedEvent } from '@youtube/shared';

async function processTranscodeJob(job: TranscodeJob): Promise<void> {
  const { videoId, sourceKey, resolutions } = job;

  // Notify start
  sseService.sendToVideo(videoId, {
    type: 'transcode.started',
    videoId,
    resolutions
  });

  const completedResolutions: VideoResolutionInfo[] = [];

  for (const resolution of resolutions) {
    try {
      // Transcode with progress reporting
      await transcodeResolution(sourceKey, resolution, (progress) => {
        sseService.sendToVideo(videoId, {
          type: 'transcode.progress',
          videoId,
          resolution,
          progress
        } as TranscodeProgressEvent);
      });

      // Record completion
      const resInfo = await saveResolution(videoId, resolution);
      completedResolutions.push(resInfo);

    } catch (error) {
      sseService.sendToVideo(videoId, {
        type: 'transcode.failed',
        videoId,
        resolution,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // Generate thumbnails
  const thumbnailUrl = await generateThumbnails(sourceKey, videoId);

  // Update video record
  const video = await updateVideoComplete(videoId, completedResolutions, thumbnailUrl);

  // Notify completion
  sseService.sendToVideo(videoId, {
    type: 'transcode.completed',
    videoId,
    resolutions: completedResolutions,
    thumbnailUrl,
    durationSeconds: video.durationSeconds
  } as TranscodeCompletedEvent);
}
```

### Frontend SSE Hook

```typescript
// frontend/src/hooks/useTranscodeStatus.ts
import { useEffect, useRef, useCallback, useState } from 'react';
import { TranscodeProgressEvent, TranscodeCompletedEvent } from '@youtube/shared';

type TranscodeEvent = TranscodeProgressEvent | TranscodeCompletedEvent;

interface UseTranscodeStatusOptions {
  videoId: string;
  onProgress?: (event: TranscodeProgressEvent) => void;
  onCompleted?: (event: TranscodeCompletedEvent) => void;
  onFailed?: (error: string) => void;
}

export function useTranscodeStatus({
  videoId,
  onProgress,
  onCompleted,
  onFailed
}: UseTranscodeStatusOptions) {
  const [status, setStatus] = useState<'pending' | 'transcoding' | 'completed' | 'failed'>('pending');
  const [progress, setProgress] = useState<Record<string, number>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const clientIdRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    const eventSource = new EventSource('/api/v1/sse/events', {
      withCredentials: true
    });

    eventSource.onopen = () => {
      console.log('SSE connected');
    };

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      clientIdRef.current = data.clientId;

      // Subscribe to video updates
      fetch(`/api/v1/sse/subscribe/${videoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: data.clientId }),
        credentials: 'include'
      });
    });

    eventSource.addEventListener('transcode.started', () => {
      setStatus('transcoding');
    });

    eventSource.addEventListener('transcode.progress', (e) => {
      const event: TranscodeProgressEvent = JSON.parse(e.data);
      setProgress(prev => ({
        ...prev,
        [event.resolution]: event.progress
      }));
      onProgress?.(event);
    });

    eventSource.addEventListener('transcode.completed', (e) => {
      const event: TranscodeCompletedEvent = JSON.parse(e.data);
      setStatus('completed');
      onCompleted?.(event);
      eventSource.close();
    });

    eventSource.addEventListener('transcode.failed', (e) => {
      const data = JSON.parse(e.data);
      setStatus('failed');
      onFailed?.(data.error);
      eventSource.close();
    });

    eventSource.onerror = () => {
      // Reconnect after 5 seconds
      setTimeout(connect, 5000);
    };

    eventSourceRef.current = eventSource;
  }, [videoId, onProgress, onCompleted, onFailed]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  return { status, progress };
}
```

---

## 7. Error Handling Across Stack (4-5 minutes)

### Shared Error Types

```typescript
// packages/shared/src/types/errors.ts
export enum ErrorCode {
  // Validation
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',

  // Auth
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // Resources
  NOT_FOUND = 'NOT_FOUND',
  VIDEO_NOT_FOUND = 'VIDEO_NOT_FOUND',
  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',

  // Upload
  UPLOAD_EXPIRED = 'UPLOAD_EXPIRED',
  UPLOAD_INCOMPLETE = 'UPLOAD_INCOMPLETE',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',

  // Rate limiting
  RATE_LIMITED = 'RATE_LIMITED',

  // Server
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}

export interface AppError {
  code: ErrorCode;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
}
```

### Backend Error Handler

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ErrorCode, AppError } from '@youtube/shared';

export class ApiError extends Error implements AppError {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, message, 404, details);
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('Error:', err);

  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      data: null,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: {
          issues: err.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message
          }))
        }
      },
      meta: null
    });
  }

  // Known API errors
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      data: null,
      error: {
        code: err.code,
        message: err.message,
        details: err.details
      },
      meta: null
    });
  }

  // Unknown errors
  return res.status(500).json({
    data: null,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred'
    },
    meta: null
  });
}
```

### Frontend Error Handling

```typescript
// frontend/src/services/api.ts
import { ApiResponse, ErrorCode } from '@youtube/shared';

class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`/api/v1${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const data: ApiResponse<T> = await response.json();

  if (data.error) {
    // Handle session expiration
    if (data.error.code === ErrorCode.SESSION_EXPIRED) {
      window.location.href = '/login';
    }

    throw new ApiError(
      data.error.code as ErrorCode,
      data.error.message,
      data.error.details
    );
  }

  return data.data as T;
}

// frontend/src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';
import { ErrorCode } from '@youtube/shared';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <ErrorIcon className="w-16 h-16 text-yt-text-secondary mb-4" />
          <h2 className="text-xl font-medium mb-2">Something went wrong</h2>
          <p className="text-yt-text-secondary mb-4">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-yt-red text-white rounded-full"
          >
            Refresh page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## 8. Trade-offs and Alternatives (3-4 minutes)

### Shared Package Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Monorepo with shared package | Single source of truth | Build complexity | **Chosen** |
| Duplicate types | Simple setup | Drift risk | Never |
| OpenAPI codegen | Auto-sync | Extra tooling | Good for larger teams |

### Real-time Updates

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| SSE | Simple, auto-reconnect | Unidirectional | **Chosen** for transcoding |
| WebSocket | Bidirectional | More complex | Overkill here |
| Polling | Simplest | Wasteful, laggy | Fallback only |

### Validation Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Zod (shared) | Runtime + types | Bundle size | **Chosen** |
| io-ts | Functional | Steeper learning | Good alternative |
| Manual validation | No dependencies | Error-prone | Never |

---

## 9. Summary

The YouTube fullstack architecture focuses on:

1. **Shared Type Package**: Single source of truth for TypeScript types, Zod schemas, and constants used across frontend and backend

2. **Chunked Upload Pipeline**: Frontend hook with concurrent chunk uploads, backend S3 multipart handling, and real-time progress tracking

3. **HLS Video Integration**: Backend manifest delivery coordinated with frontend HLS.js player, including resume position sync via watch history

4. **SSE for Transcoding Status**: Server-Sent Events push transcoding progress from workers to frontend with automatic reconnection

5. **Unified Error Handling**: Shared error codes with backend middleware and frontend error boundaries for consistent user experience

6. **Optimistic UI Patterns**: Frontend immediately updates UI for engagement actions (like, subscribe) with rollback on API failure

The integration ensures type safety across the stack, real-time feedback for long-running operations, and graceful error handling that maintains a responsive user experience.
