# Instagram - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. As a full-stack engineer, I'll focus on the end-to-end photo upload flow from client to storage, the integrated feed generation system connecting backend caching with frontend virtualization, story view tracking with real-time updates, and the WebSocket-based direct messaging architecture spanning both client and server."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo Upload** - Client-side preview, upload with progress, backend processing
2. **Feed** - Personalized feed with backend caching and frontend virtualization
3. **Stories** - Upload, view tracking, 24-hour expiration with real-time tray updates
4. **Direct Messaging** - Real-time messaging with WebSocket delivery
5. **Social Graph** - Follow/unfollow with immediate UI feedback

### Non-Functional Requirements

- **Scale**: 500M+ DAU, 100M+ posts/day
- **Latency**: Feed < 200ms, uploads < 500ms acknowledgment
- **Consistency**: Strong for social graph, eventual for feeds
- **Real-time**: Sub-second message delivery, story view updates

### Full-Stack Clarifications

- "How do we communicate processing status to the client?" - Polling with status endpoint, optionally WebSocket for instant updates
- "How do we keep feed fresh across tabs?" - Visibility API to trigger refresh on tab focus
- "What consistency model for likes?" - Optimistic UI with eventual sync

---

## Step 2: System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Feed View    │  │ Story Viewer │  │ Post Creator │  │ DM Interface │    │
│  │ (Virtualized)│  │ (Auto-adv)   │  │ (Upload)     │  │ (WebSocket)  │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      Zustand Stores                                │     │
│  │   feedStore    storyStore    uploadStore    messageStore           │     │
│  └──────────────────────────────────────────────────────────────────┘      │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      API Client / WebSocket                        │     │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Express    │  │  WebSocket   │  │   Image      │  │   Story      │    │
│  │   API        │  │  Gateway     │  │   Worker     │  │   Cleanup    │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
│  ┌──────┴─────────────────┴─────────────────┴─────────────────┴──────┐     │
│  │                      Shared Services                               │     │
│  │   PostgreSQL    Cassandra    Valkey    MinIO    RabbitMQ           │     │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Shared Type Contracts

### Core Domain Types

```typescript
// shared/types.ts - Used by both frontend and backend

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bio: string;
  isPrivate: boolean;
  followerCount: number;
  followingCount: number;
  postCount: number;
}

export interface Post {
  id: string;
  userId: string;
  author: UserPreview;
  caption: string;
  location?: string;
  status: 'processing' | 'published' | 'failed';
  thumbnailUrl: string;
  smallUrl: string;
  mediumUrl: string;
  largeUrl: string;
  likeCount: number;
  commentCount: number;
  isLiked: boolean;
  isSaved: boolean;
  createdAt: string;
}

export interface UserPreview {
  id: string;
  username: string;
  avatarUrl: string;
  hasActiveStory: boolean;
}

export interface Story {
  id: string;
  userId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  expiresAt: string;
  viewCount: number;
  createdAt: string;
}

export interface StoryUser {
  user: UserPreview;
  stories: Story[];
  hasSeen: boolean;
  latestStoryTime: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  contentType: 'text' | 'image' | 'video' | 'heart';
  mediaUrl?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  otherUser: UserPreview;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}
```

### API Response Types

```typescript
// shared/api-types.ts

export interface FeedResponse {
  posts: Post[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface StoryFeedResponse {
  users: StoryUser[];
}

export interface CreatePostResponse {
  postId: string;
  status: 'processing';
}

export interface LikeResponse {
  success: boolean;
  idempotent: boolean;  // true if already liked
  likeCount: number;
}

export interface StoryViewResponse {
  recorded: boolean;  // false if already viewed
}

// WebSocket message types
export type WSMessage =
  | { type: 'new_message'; payload: Message }
  | { type: 'typing'; payload: { conversationId: string; userId: string } }
  | { type: 'read_receipt'; payload: { conversationId: string; messageId: string } }
  | { type: 'story_view'; payload: { storyId: string; viewerId: string } }
  | { type: 'post_ready'; payload: { postId: string; urls: PostUrls } };

export interface PostUrls {
  thumbnailUrl: string;
  smallUrl: string;
  mediumUrl: string;
  largeUrl: string;
}
```

---

## Step 4: End-to-End Photo Upload Flow

### Frontend: CreatePost Component

```tsx
// frontend/src/components/post/CreatePost.tsx
import { useState, useCallback } from 'react';
import { api } from '../../services/api';
import { useFeedStore } from '../../stores/feedStore';
import { useWebSocket } from '../../hooks/useWebSocket';

export function CreatePost({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing'>('idle');

  const { addPost, updatePost } = useFeedStore();
  const { subscribe } = useWebSocket();

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);

    // Generate local preview
    const reader = new FileReader();
    reader.onload = (event) => setPreview(event.target?.result as string);
    reader.readAsDataURL(selectedFile);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!file || !preview) return;

    setStatus('uploading');

    try {
      // Create FormData
      const formData = new FormData();
      formData.append('image', file);
      formData.append('caption', caption);

      // Upload with progress
      const response = await api.createPost(formData, (progress) => {
        setUploadProgress(progress);
      });

      setStatus('processing');

      // Add optimistic post with local preview
      const optimisticPost: Post = {
        id: response.postId,
        status: 'processing',
        caption,
        mediumUrl: preview,  // Use local preview while processing
        likeCount: 0,
        commentCount: 0,
        isLiked: false,
        isSaved: false,
        createdAt: new Date().toISOString(),
        author: getCurrentUser(),
      };
      addPost(optimisticPost);

      // Subscribe to processing completion
      const unsubscribe = subscribe('post_ready', (payload) => {
        if (payload.postId === response.postId) {
          updatePost(response.postId, {
            status: 'published',
            thumbnailUrl: payload.urls.thumbnailUrl,
            smallUrl: payload.urls.smallUrl,
            mediumUrl: payload.urls.mediumUrl,
            largeUrl: payload.urls.largeUrl,
          });
          unsubscribe();
        }
      });

      // Fallback: poll if WebSocket fails
      pollForCompletion(response.postId);

      onClose();
    } catch (error) {
      setStatus('idle');
      // Handle error
    }
  }, [file, preview, caption, addPost, updatePost, subscribe, onClose]);

  // Polling fallback
  async function pollForCompletion(postId: string, attempts = 0) {
    if (attempts > 30) return;  // 30 seconds max

    await sleep(1000);
    const post = await api.getPost(postId);

    if (post.status === 'published') {
      updatePost(postId, post);
    } else if (post.status === 'processing') {
      pollForCompletion(postId, attempts + 1);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg w-full max-w-lg">
        {/* Header */}
        <header className="flex items-center justify-between p-4 border-b">
          <button onClick={onClose}>Cancel</button>
          <h2 className="font-semibold">New Post</h2>
          <button
            onClick={handleSubmit}
            disabled={!file || status !== 'idle'}
            className="text-instagram-blue font-semibold disabled:opacity-50"
          >
            Share
          </button>
        </header>

        {/* Image selection/preview */}
        <div className="p-4">
          {!preview ? (
            <label className="block w-full aspect-square border-2 border-dashed rounded-lg cursor-pointer">
              <input
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
              <div className="flex flex-col items-center justify-center h-full">
                <ImageIcon className="w-12 h-12 text-gray-400" />
                <span>Select a photo</span>
              </div>
            </label>
          ) : (
            <img
              src={preview}
              alt="Preview"
              className="w-full aspect-square object-cover rounded-lg"
            />
          )}

          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Write a caption..."
            className="w-full mt-4 p-3 border rounded-lg"
            rows={3}
          />

          {/* Progress indicator */}
          {status === 'uploading' && (
            <div className="mt-4">
              <div className="h-1 bg-gray-200 rounded-full">
                <div
                  className="h-full bg-instagram-blue rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-center text-sm mt-2">Uploading... {uploadProgress}%</p>
            </div>
          )}

          {status === 'processing' && (
            <p className="text-center text-sm mt-4 text-instagram-text-secondary">
              Processing image...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

### Backend: Upload Controller

```typescript
// backend/src/api/routes/posts.ts
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { pool } from '../../shared/db';
import { minio } from '../../shared/storage';
import { queue } from '../../shared/queue';
import { requireAuth } from '../../middleware/auth';

const router = Router();
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  },
});

router.post('/', requireAuth, upload.single('image'), async (req, res) => {
  const userId = req.session.userId;
  const { caption } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Image is required' });
  }

  const postId = uuid();
  const originalKey = `originals/${new Date().toISOString().slice(0,10)}/${postId}${getExtension(file.mimetype)}`;

  try {
    // 1. Store original in MinIO
    await minio.putObject('instagram-media', originalKey, file.buffer, {
      'Content-Type': file.mimetype,
    });

    // 2. Create post record with processing status
    await pool.query(`
      INSERT INTO posts (id, user_id, caption, status, original_url, created_at)
      VALUES ($1, $2, $3, 'processing', $4, NOW())
    `, [postId, userId, caption, originalKey]);

    // 3. Queue image processing job
    await queue.publish('image-processing', {
      postId,
      userId,
      originalKey,
      traceId: req.traceId,
    });

    // 4. Return immediately
    res.status(202).json({
      postId,
      status: 'processing',
    });
  } catch (error) {
    console.error('Upload failed:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default router;
```

### Backend: Image Processing Worker

```typescript
// backend/src/worker/image.ts
import sharp from 'sharp';
import { minio } from '../shared/storage';
import { pool } from '../shared/db';
import { queue } from '../shared/queue';
import { wsHub } from '../shared/websocket';

const RESOLUTIONS = [
  { name: 'thumbnail', size: 150, quality: 80 },
  { name: 'small', size: 320, quality: 85 },
  { name: 'medium', size: 640, quality: 85 },
  { name: 'large', size: 1080, quality: 90 },
];

interface ProcessingJob {
  postId: string;
  userId: string;
  originalKey: string;
  traceId: string;
}

export async function startImageWorker() {
  await queue.consume('image-processing', async (job: ProcessingJob) => {
    console.log(`Processing post ${job.postId}`);

    try {
      // 1. Fetch original from MinIO
      const stream = await minio.getObject('instagram-media', job.originalKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const originalBuffer = Buffer.concat(chunks);

      // 2. Normalize image (auto-orient, strip EXIF)
      const normalized = await sharp(originalBuffer)
        .rotate()  // Auto-orient based on EXIF
        .toBuffer();

      // 3. Generate all resolutions
      const urls: Record<string, string> = {};

      for (const res of RESOLUTIONS) {
        const processed = await sharp(normalized)
          .resize(res.size, res.size, {
            fit: 'cover',
            position: 'center',
          })
          .webp({ quality: res.quality })
          .toBuffer();

        const key = `processed/${res.name}/${job.postId}.webp`;
        await minio.putObject('instagram-media', key, processed, {
          'Content-Type': 'image/webp',
        });
        urls[`${res.name}_url`] = key;
      }

      // 4. Update post status
      await pool.query(`
        UPDATE posts
        SET status = 'published',
            thumbnail_url = $1,
            small_url = $2,
            medium_url = $3,
            large_url = $4,
            updated_at = NOW()
        WHERE id = $5
      `, [urls.thumbnail_url, urls.small_url, urls.medium_url, urls.large_url, job.postId]);

      // 5. Notify client via WebSocket
      wsHub.sendToUser(job.userId, {
        type: 'post_ready',
        payload: {
          postId: job.postId,
          urls: {
            thumbnailUrl: urls.thumbnail_url,
            smallUrl: urls.small_url,
            mediumUrl: urls.medium_url,
            largeUrl: urls.large_url,
          },
        },
      });

      console.log(`Post ${job.postId} processed successfully`);
    } catch (error) {
      console.error(`Failed to process post ${job.postId}:`, error);

      // Mark as failed
      await pool.query(
        'UPDATE posts SET status = $1 WHERE id = $2',
        ['failed', job.postId]
      );

      throw error;  // Let queue handle retry/DLQ
    }
  });
}
```

---

## Step 5: Feed Generation - Backend Cache to Frontend Virtualization

### Backend: Feed Service

```typescript
// backend/src/api/routes/feed.ts
import { Router } from 'express';
import { pool } from '../../shared/db';
import { redis } from '../../shared/cache';
import { requireAuth } from '../../middleware/auth';
import { createCircuitBreaker } from '../../shared/circuitBreaker';

const router = Router();
const FEED_CACHE_TTL = 60;  // 60 seconds

// Circuit breaker for feed generation
const feedBreaker = createCircuitBreaker(generateFeed, {
  name: 'feed_generation',
  timeout: 5000,
  fallback: () => ({ posts: [], fromFallback: true }),
});

router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  // Check cache
  const cacheKey = `feed:${userId}:${cursor || 'initial'}:${limit}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return res.json({
      ...JSON.parse(cached),
      fromCache: true,
    });
  }

  // Generate feed (with circuit breaker protection)
  const feed = await feedBreaker.fire(userId, cursor, limit);

  // Cache result
  await redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(feed));

  res.json(feed);
});

async function generateFeed(userId: string, cursor: string | undefined, limit: number) {
  // Pull model: query posts from followed users
  const cursorClause = cursor
    ? 'AND p.created_at < $3'
    : '';

  const params = cursor
    ? [userId, limit, new Date(parseInt(cursor))]
    : [userId, limit];

  const result = await pool.query(`
    SELECT
      p.id,
      p.user_id,
      p.caption,
      p.status,
      p.thumbnail_url,
      p.small_url,
      p.medium_url,
      p.large_url,
      p.like_count,
      p.comment_count,
      p.created_at,
      u.username,
      u.avatar_url,
      EXISTS(SELECT 1 FROM stories s WHERE s.user_id = u.id AND s.expires_at > NOW()) as has_active_story,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) as is_liked,
      EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.post_id = p.id AND sp.user_id = $1) as is_saved
    FROM posts p
    JOIN follows f ON f.following_id = p.user_id
    JOIN users u ON u.id = p.user_id
    WHERE f.follower_id = $1
      AND p.status = 'published'
      ${cursorClause}
    ORDER BY p.created_at DESC
    LIMIT $2
  `, params);

  const posts = result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    caption: row.caption,
    status: row.status,
    thumbnailUrl: row.thumbnail_url,
    smallUrl: row.small_url,
    mediumUrl: row.medium_url,
    largeUrl: row.large_url,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    isLiked: row.is_liked,
    isSaved: row.is_saved,
    createdAt: row.created_at.toISOString(),
    author: {
      id: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      hasActiveStory: row.has_active_story,
    },
  }));

  const nextCursor = posts.length === limit
    ? new Date(posts[posts.length - 1].createdAt).getTime().toString()
    : null;

  return {
    posts,
    nextCursor,
    hasMore: posts.length === limit,
  };
}

export default router;
```

### Frontend: Feed Store with Virtualization Integration

```typescript
// frontend/src/stores/feedStore.ts
import { create } from 'zustand';
import { api } from '../services/api';
import type { Post, FeedResponse } from '../types';

interface FeedState {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;

  loadFeed: () => Promise<void>;
  loadMore: () => Promise<void>;
  addPost: (post: Post) => void;
  updatePost: (id: string, updates: Partial<Post>) => void;
  toggleLike: (postId: string) => Promise<void>;
  refreshFeed: () => Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  posts: [],
  cursor: null,
  hasMore: true,
  isLoading: false,
  error: null,

  loadFeed: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });

    try {
      const response = await api.getFeed();
      set({
        posts: response.posts,
        cursor: response.nextCursor,
        hasMore: response.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: 'Failed to load feed',
        isLoading: false,
      });
    }
  },

  loadMore: async () => {
    const { isLoading, hasMore, cursor, posts } = get();
    if (isLoading || !hasMore) return;

    set({ isLoading: true });

    try {
      const response = await api.getFeed(cursor ?? undefined);
      set({
        posts: [...posts, ...response.posts],
        cursor: response.nextCursor,
        hasMore: response.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false });
    }
  },

  addPost: (post) => {
    set((state) => ({ posts: [post, ...state.posts] }));
  },

  updatePost: (id, updates) => {
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    }));
  },

  toggleLike: async (postId) => {
    const post = get().posts.find((p) => p.id === postId);
    if (!post) return;

    const wasLiked = post.isLiked;

    // Optimistic update
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === postId
          ? {
              ...p,
              isLiked: !wasLiked,
              likeCount: wasLiked ? p.likeCount - 1 : p.likeCount + 1,
            }
          : p
      ),
    }));

    try {
      if (wasLiked) {
        await api.unlikePost(postId);
      } else {
        await api.likePost(postId);
      }
    } catch (error) {
      // Rollback on failure
      set((state) => ({
        posts: state.posts.map((p) =>
          p.id === postId
            ? {
                ...p,
                isLiked: wasLiked,
                likeCount: wasLiked ? p.likeCount + 1 : p.likeCount - 1,
              }
            : p
        ),
      }));
    }
  },

  refreshFeed: async () => {
    set({ posts: [], cursor: null, hasMore: true });
    await get().loadFeed();
  },
}));
```

### Frontend: Virtualized Feed Component

```tsx
// frontend/src/routes/index.tsx
import { useEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFeedStore } from '../stores/feedStore';
import { PostCard } from '../components/feed/PostCard';
import { StoryTray } from '../components/stories/StoryTray';

export function HomePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { posts, isLoading, hasMore, loadFeed, loadMore } = useFeedStore();

  // Initial load
  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  // Refresh on tab visibility
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Soft refresh - check for new posts
        loadFeed();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadFeed]);

  // Virtualizer setup
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 600,  // Estimated post height
    overscan: 3,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Infinite scroll trigger
  const handleScroll = useCallback(() => {
    if (!containerRef.current || isLoading || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight - scrollTop - clientHeight < 1000) {
      loadMore();
    }
  }, [isLoading, hasMore, loadMore]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-screen overflow-y-auto"
    >
      {/* Story tray (not virtualized - always visible) */}
      <StoryTray />

      {/* Virtualized feed */}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {items.map((virtualItem) => (
          <div
            key={posts[virtualItem.index].id}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <PostCard post={posts[virtualItem.index]} />
          </div>
        ))}
      </div>

      {isLoading && (
        <div className="flex justify-center py-4">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
```

---

## Step 6: Story View Tracking - Real-Time Updates

### Backend: Story Routes

```typescript
// backend/src/api/routes/stories.ts
import { Router } from 'express';
import { pool } from '../../shared/db';
import { redis } from '../../shared/cache';
import { wsHub } from '../../shared/websocket';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// Get story feed (users with active stories)
router.get('/feed', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  const result = await pool.query(`
    SELECT DISTINCT ON (u.id)
      u.id as user_id,
      u.username,
      u.avatar_url,
      s.id as story_id,
      s.media_url,
      s.created_at,
      s.expires_at,
      s.view_count,
      EXISTS(
        SELECT 1 FROM story_views sv
        WHERE sv.story_id = s.id AND sv.viewer_id = $1
      ) as has_viewed
    FROM follows f
    JOIN users u ON u.id = f.following_id
    JOIN stories s ON s.user_id = u.id AND s.expires_at > NOW()
    WHERE f.follower_id = $1
    ORDER BY u.id, s.created_at DESC
  `, [userId]);

  // Group by user
  const userMap = new Map<string, StoryUser>();

  for (const row of result.rows) {
    if (!userMap.has(row.user_id)) {
      userMap.set(row.user_id, {
        user: {
          id: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url,
        },
        stories: [],
        hasSeen: true,
        latestStoryTime: row.created_at,
      });
    }

    const storyUser = userMap.get(row.user_id)!;
    storyUser.stories.push({
      id: row.story_id,
      mediaUrl: row.media_url,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      viewCount: row.view_count,
      seen: row.has_viewed,
    });

    if (!row.has_viewed) {
      storyUser.hasSeen = false;
    }
  }

  // Sort: unseen first, then by recency
  const users = Array.from(userMap.values()).sort((a, b) => {
    if (a.hasSeen !== b.hasSeen) return a.hasSeen ? 1 : -1;
    return new Date(b.latestStoryTime).getTime() - new Date(a.latestStoryTime).getTime();
  });

  res.json({ users });
});

// Record story view
router.post('/:id/view', requireAuth, async (req, res) => {
  const storyId = req.params.id;
  const viewerId = req.session.userId;

  // Check if already viewed (Redis for speed)
  const viewKey = `story_views:${storyId}`;
  const alreadyViewed = await redis.sismember(viewKey, viewerId);

  if (alreadyViewed) {
    return res.json({ recorded: false });
  }

  // Record view
  await redis.sadd(viewKey, viewerId);
  await redis.incr(`story_view_count:${storyId}`);

  // Persist to PostgreSQL
  await pool.query(`
    INSERT INTO story_views (story_id, viewer_id)
    VALUES ($1, $2)
    ON CONFLICT (story_id, viewer_id) DO NOTHING
  `, [storyId, viewerId]);

  // Get story owner for real-time notification
  const story = await pool.query(
    'SELECT user_id FROM stories WHERE id = $1',
    [storyId]
  );

  if (story.rows[0]) {
    const ownerId = story.rows[0].user_id;

    // Get viewer info
    const viewer = await pool.query(
      'SELECT username, avatar_url FROM users WHERE id = $1',
      [viewerId]
    );

    // Notify story owner via WebSocket
    wsHub.sendToUser(ownerId, {
      type: 'story_view',
      payload: {
        storyId,
        viewerId,
        viewerUsername: viewer.rows[0]?.username,
        viewerAvatarUrl: viewer.rows[0]?.avatar_url,
      },
    });
  }

  res.json({ recorded: true });
});

export default router;
```

### Frontend: Story Store with Real-Time Updates

```typescript
// frontend/src/stores/storyStore.ts
import { create } from 'zustand';
import { api } from '../services/api';
import { wsClient } from '../services/websocket';
import type { StoryUser, Story } from '../types';

interface StoryState {
  storyUsers: StoryUser[];
  isOpen: boolean;
  currentUserIndex: number;
  currentStoryIndex: number;
  newViewers: Map<string, ViewerInfo[]>;  // storyId -> viewers

  loadStories: () => Promise<void>;
  openViewer: (userIndex: number) => void;
  closeViewer: () => void;
  nextStory: () => void;
  prevStory: () => void;
  nextUser: () => void;
  prevUser: () => void;
  markAsSeen: (storyId: string) => Promise<void>;
  subscribeToViews: () => () => void;
}

export const useStoryStore = create<StoryState>((set, get) => ({
  storyUsers: [],
  isOpen: false,
  currentUserIndex: 0,
  currentStoryIndex: 0,
  newViewers: new Map(),

  loadStories: async () => {
    const response = await api.getStoryFeed();
    set({ storyUsers: response.users });
  },

  openViewer: (userIndex) => {
    set({
      isOpen: true,
      currentUserIndex: userIndex,
      currentStoryIndex: 0,
    });
    const story = get().storyUsers[userIndex]?.stories[0];
    if (story) {
      get().markAsSeen(story.id);
    }
  },

  closeViewer: () => set({ isOpen: false }),

  nextStory: () => {
    const { storyUsers, currentUserIndex, currentStoryIndex } = get();
    const user = storyUsers[currentUserIndex];
    if (currentStoryIndex < user.stories.length - 1) {
      const nextIndex = currentStoryIndex + 1;
      set({ currentStoryIndex: nextIndex });
      get().markAsSeen(user.stories[nextIndex].id);
    }
  },

  prevStory: () => {
    const { currentStoryIndex } = get();
    if (currentStoryIndex > 0) {
      set({ currentStoryIndex: currentStoryIndex - 1 });
    }
  },

  nextUser: () => {
    const { storyUsers, currentUserIndex } = get();
    if (currentUserIndex < storyUsers.length - 1) {
      const nextIndex = currentUserIndex + 1;
      set({ currentUserIndex: nextIndex, currentStoryIndex: 0 });
      const story = storyUsers[nextIndex]?.stories[0];
      if (story) {
        get().markAsSeen(story.id);
      }
    }
  },

  prevUser: () => {
    const { storyUsers, currentUserIndex } = get();
    if (currentUserIndex > 0) {
      const prevIndex = currentUserIndex - 1;
      set({
        currentUserIndex: prevIndex,
        currentStoryIndex: storyUsers[prevIndex].stories.length - 1,
      });
    }
  },

  markAsSeen: async (storyId) => {
    // Optimistic update
    set((state) => ({
      storyUsers: state.storyUsers.map((user) => ({
        ...user,
        stories: user.stories.map((s) =>
          s.id === storyId ? { ...s, seen: true } : s
        ),
        hasSeen: user.stories.every((s) =>
          s.id === storyId ? true : s.seen
        ),
      })),
    }));

    // Record on server
    await api.viewStory(storyId);
  },

  // Subscribe to real-time view notifications (for story owners)
  subscribeToViews: () => {
    return wsClient.subscribe('story_view', (payload) => {
      set((state) => {
        const newViewers = new Map(state.newViewers);
        const viewers = newViewers.get(payload.storyId) || [];
        newViewers.set(payload.storyId, [
          ...viewers,
          {
            userId: payload.viewerId,
            username: payload.viewerUsername,
            avatarUrl: payload.viewerAvatarUrl,
          },
        ]);
        return { newViewers };
      });
    });
  },
}));
```

---

## Step 7: WebSocket Architecture

### Backend: WebSocket Hub

```typescript
// backend/src/shared/websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { redis } from './cache';
import type { WSMessage } from '../../shared/types';

interface Connection {
  ws: WebSocket;
  userId: string;
  lastPing: number;
}

class WebSocketHub {
  private connections: Map<string, Connection[]> = new Map();
  private wss: WebSocketServer | null = null;

  initialize(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      // Extract userId from session cookie
      const userId = this.extractUserId(req);
      if (!userId) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      this.addConnection(userId, ws);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(userId, message);
        } catch (e) {
          // Invalid message
        }
      });

      ws.on('close', () => {
        this.removeConnection(userId, ws);
      });

      ws.on('pong', () => {
        const conns = this.connections.get(userId) || [];
        const conn = conns.find((c) => c.ws === ws);
        if (conn) {
          conn.lastPing = Date.now();
        }
      });
    });

    // Heartbeat to detect dead connections
    setInterval(() => {
      this.connections.forEach((conns, userId) => {
        conns.forEach((conn) => {
          if (Date.now() - conn.lastPing > 30000) {
            conn.ws.terminate();
            this.removeConnection(userId, conn.ws);
          } else {
            conn.ws.ping();
          }
        });
      });
    }, 15000);

    // Subscribe to Redis pub/sub for cross-server messaging
    this.subscribeToRedis();
  }

  private addConnection(userId: string, ws: WebSocket) {
    const conns = this.connections.get(userId) || [];
    conns.push({ ws, userId, lastPing: Date.now() });
    this.connections.set(userId, conns);
  }

  private removeConnection(userId: string, ws: WebSocket) {
    const conns = this.connections.get(userId) || [];
    const filtered = conns.filter((c) => c.ws !== ws);
    if (filtered.length === 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, filtered);
    }
  }

  sendToUser(userId: string, message: WSMessage) {
    // Publish to Redis for cross-server delivery
    redis.publish(`user:${userId}:ws`, JSON.stringify(message));
  }

  private async subscribeToRedis() {
    const subscriber = redis.duplicate();
    await subscriber.psubscribe('user:*:ws');

    subscriber.on('pmessage', (pattern, channel, message) => {
      const userId = channel.split(':')[1];
      const conns = this.connections.get(userId) || [];

      for (const conn of conns) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(message);
        }
      }
    });
  }

  private handleMessage(userId: string, message: unknown) {
    // Handle client-to-server messages (e.g., typing indicators)
    if (isTypingMessage(message)) {
      this.handleTyping(userId, message);
    }
  }

  private async handleTyping(userId: string, message: TypingMessage) {
    // Get conversation participants
    const participants = await getConversationParticipants(message.conversationId);

    // Notify other participants
    for (const participantId of participants) {
      if (participantId !== userId) {
        this.sendToUser(participantId, {
          type: 'typing',
          payload: {
            conversationId: message.conversationId,
            userId,
          },
        });
      }
    }
  }
}

export const wsHub = new WebSocketHub();
```

### Frontend: WebSocket Client

```typescript
// frontend/src/services/websocket.ts
import type { WSMessage } from '../types';

type MessageHandler = (payload: unknown) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        this.dispatch(message);
      } catch (e) {
        console.error('Invalid WebSocket message:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.reconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    setTimeout(() => {
      console.log(`Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();
    }, delay);
  }

  private dispatch(message: WSMessage) {
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => handler(message.payload));
    }
  }

  subscribe(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  send(message: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}

export const wsClient = new WebSocketClient();
```

### Frontend: WebSocket Hook

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { wsClient } from '../services/websocket';

export function useWebSocket() {
  const subscriptionsRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    // Connect on mount
    wsClient.connect();

    return () => {
      // Cleanup subscriptions on unmount
      subscriptionsRef.current.forEach((unsub) => unsub());
      subscriptionsRef.current = [];
    };
  }, []);

  const subscribe = useCallback((type: string, handler: (payload: unknown) => void) => {
    const unsubscribe = wsClient.subscribe(type, handler);
    subscriptionsRef.current.push(unsubscribe);
    return unsubscribe;
  }, []);

  const send = useCallback((message: WSMessage) => {
    wsClient.send(message);
  }, []);

  return { subscribe, send };
}
```

---

## Step 8: Direct Messaging - Full Stack

### Backend: DM Routes with Cassandra

```typescript
// backend/src/api/routes/messages.ts
import { Router } from 'express';
import { v1 as uuidv1 } from 'uuid';
import { cassandra } from '../../shared/cassandra';
import { pool } from '../../shared/db';
import { wsHub } from '../../shared/websocket';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// Get conversations
router.get('/conversations', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  const result = await cassandra.execute(
    'SELECT * FROM conversations_by_user WHERE user_id = ? LIMIT 50',
    [userId],
    { prepare: true }
  );

  const conversations = result.rows.map((row) => ({
    id: row.conversation_id,
    otherUser: {
      id: row.other_user_id,
      username: row.other_username,
      avatarUrl: row.other_profile_picture,
    },
    lastMessage: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
  }));

  res.json({ conversations });
});

// Get messages in a conversation
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = req.params.id;
  const cursor = req.query.cursor as string | undefined;

  let query = 'SELECT * FROM messages_by_conversation WHERE conversation_id = ?';
  const params: unknown[] = [conversationId];

  if (cursor) {
    query += ' AND message_id < ?';
    params.push(cursor);
  }

  query += ' LIMIT 50';

  const result = await cassandra.execute(query, params, { prepare: true });

  const messages = result.rows.map((row) => ({
    id: row.message_id.toString(),
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    contentType: row.content_type,
    mediaUrl: row.media_url,
    createdAt: row.created_at,
  }));

  res.json({
    messages,
    nextCursor: messages.length === 50 ? messages[messages.length - 1].id : null,
  });
});

// Send message
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = req.params.id;
  const senderId = req.session.userId;
  const { content, contentType = 'text', mediaUrl } = req.body;

  const messageId = uuidv1();  // TimeUUID for ordering
  const createdAt = new Date();

  // 1. Insert message
  await cassandra.execute(`
    INSERT INTO messages_by_conversation
    (conversation_id, message_id, sender_id, content, content_type, media_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [conversationId, messageId, senderId, content, contentType, mediaUrl, createdAt],
  { prepare: true });

  // 2. Get participants and sender info
  const participants = await getConversationParticipants(conversationId);
  const sender = await pool.query(
    'SELECT username, avatar_url FROM users WHERE id = $1',
    [senderId]
  );

  // 3. Update conversation for all participants
  for (const participantId of participants) {
    const isRecipient = participantId !== senderId;
    const otherUser = isRecipient
      ? sender.rows[0]
      : await getOtherUser(participants, senderId);

    await cassandra.execute(`
      INSERT INTO conversations_by_user
      (user_id, last_message_at, conversation_id, other_user_id, other_username, other_profile_picture, last_message_preview, unread_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      participantId,
      createdAt,
      conversationId,
      otherUser.id,
      otherUser.username,
      otherUser.avatarUrl,
      content.substring(0, 100),
      isRecipient ? 1 : 0,
    ], { prepare: true });

    // 4. Notify via WebSocket
    if (isRecipient) {
      wsHub.sendToUser(participantId, {
        type: 'new_message',
        payload: {
          id: messageId.toString(),
          conversationId,
          senderId,
          senderUsername: sender.rows[0].username,
          content,
          contentType,
          mediaUrl,
          createdAt: createdAt.toISOString(),
        },
      });
    }
  }

  res.json({
    id: messageId.toString(),
    conversationId,
    senderId,
    content,
    contentType,
    createdAt: createdAt.toISOString(),
  });
});

export default router;
```

### Frontend: Message Store with Real-Time

```typescript
// frontend/src/stores/messageStore.ts
import { create } from 'zustand';
import { api } from '../services/api';
import { wsClient } from '../services/websocket';
import type { Conversation, Message } from '../types';

interface MessageState {
  conversations: Conversation[];
  currentConversation: string | null;
  messages: Map<string, Message[]>;
  isTyping: Map<string, boolean>;  // conversationId -> isTyping

  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  sendMessage: (conversationId: string, content: string) => Promise<void>;
  setTyping: (conversationId: string, isTyping: boolean) => void;
  subscribeToMessages: () => () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  conversations: [],
  currentConversation: null,
  messages: new Map(),
  isTyping: new Map(),

  loadConversations: async () => {
    const response = await api.getConversations();
    set({ conversations: response.conversations });
  },

  loadMessages: async (conversationId: string) => {
    const response = await api.getMessages(conversationId);
    set((state) => ({
      messages: new Map(state.messages).set(conversationId, response.messages),
      currentConversation: conversationId,
    }));
  },

  sendMessage: async (conversationId: string, content: string) => {
    // Optimistic update
    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: Message = {
      id: tempId,
      conversationId,
      senderId: getCurrentUserId(),
      content,
      contentType: 'text',
      createdAt: new Date().toISOString(),
    };

    set((state) => {
      const messages = new Map(state.messages);
      const convoMessages = messages.get(conversationId) || [];
      messages.set(conversationId, [...convoMessages, optimisticMessage]);
      return { messages };
    });

    try {
      const response = await api.sendMessage(conversationId, content);

      // Replace temp message with real one
      set((state) => {
        const messages = new Map(state.messages);
        const convoMessages = messages.get(conversationId) || [];
        messages.set(
          conversationId,
          convoMessages.map((m) => (m.id === tempId ? response : m))
        );
        return { messages };
      });
    } catch (error) {
      // Remove optimistic message on failure
      set((state) => {
        const messages = new Map(state.messages);
        const convoMessages = messages.get(conversationId) || [];
        messages.set(
          conversationId,
          convoMessages.filter((m) => m.id !== tempId)
        );
        return { messages };
      });
    }
  },

  setTyping: (conversationId: string, isTyping: boolean) => {
    wsClient.send({
      type: 'typing',
      payload: { conversationId, isTyping },
    });
  },

  subscribeToMessages: () => {
    const unsubMessage = wsClient.subscribe('new_message', (payload: Message) => {
      set((state) => {
        // Add message to conversation
        const messages = new Map(state.messages);
        const convoMessages = messages.get(payload.conversationId) || [];
        messages.set(payload.conversationId, [...convoMessages, payload]);

        // Update conversation preview
        const conversations = state.conversations.map((c) =>
          c.id === payload.conversationId
            ? {
                ...c,
                lastMessage: payload.content,
                lastMessageAt: payload.createdAt,
                unreadCount: c.unreadCount + 1,
              }
            : c
        );

        return { messages, conversations };
      });
    });

    const unsubTyping = wsClient.subscribe('typing', (payload: { conversationId: string; userId: string }) => {
      set((state) => ({
        isTyping: new Map(state.isTyping).set(payload.conversationId, true),
      }));

      // Clear typing indicator after 3 seconds
      setTimeout(() => {
        set((state) => ({
          isTyping: new Map(state.isTyping).set(payload.conversationId, false),
        }));
      }, 3000);
    });

    return () => {
      unsubMessage();
      unsubTyping();
    };
  },
}));
```

---

## Step 9: Cache Invalidation Patterns

### Backend: Feed Cache Invalidation

```typescript
// When user follows/unfollows, invalidate their feed cache
async function onFollowChange(followerId: string) {
  const keys = await redis.keys(`feed:${followerId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// When a post is created, invalidate followers' feeds
async function onPostCreated(authorId: string) {
  const followers = await getFollowerIds(authorId);

  // Batch invalidation
  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.del(`feed:${followerId}:initial:20`);
  }
  await pipeline.exec();
}

// When a post is liked, update the cached post
async function onPostLiked(postId: string, newLikeCount: number) {
  const cachedPost = await redis.get(`post:${postId}`);
  if (cachedPost) {
    const post = JSON.parse(cachedPost);
    post.likeCount = newLikeCount;
    await redis.setex(`post:${postId}`, 3600, JSON.stringify(post));
  }
}
```

### Frontend: Optimistic Updates with Rollback

```typescript
// Pattern for optimistic updates
async function optimisticUpdate<T>(
  optimisticFn: () => void,
  apiCall: () => Promise<T>,
  rollbackFn: () => void,
  onSuccess?: (result: T) => void
) {
  // Apply optimistic update
  optimisticFn();

  try {
    const result = await apiCall();
    onSuccess?.(result);
  } catch (error) {
    // Rollback on failure
    rollbackFn();
    throw error;
  }
}

// Usage
await optimisticUpdate(
  () => setLiked(true),
  () => api.likePost(postId),
  () => setLiked(false)
);
```

---

## Closing Summary

"I've designed Instagram as a full-stack system with focus on:

1. **End-to-End Photo Upload** - Multipart upload with progress, async processing via RabbitMQ worker, WebSocket notification when ready, polling fallback
2. **Integrated Feed System** - Backend caching with 60s TTL, circuit breaker protection, frontend virtualization for 60fps scrolling with infinite scroll
3. **Real-Time Story Views** - Redis-backed deduplication, PostgreSQL persistence, WebSocket notification to story owner
4. **WebSocket Architecture** - Cross-server delivery via Redis pub/sub, reconnection with exponential backoff, typed message contracts

The key insight for full-stack development is maintaining consistency between optimistic frontend updates and eventual backend state - shared type contracts, proper error rollback, and real-time synchronization via WebSocket create a cohesive experience."

---

## Potential Follow-up Questions

1. **How would you handle image uploads on slow connections?**
   - Chunked upload with resume capability
   - Client-side compression before upload
   - Progressive JPEG for faster perceived loading

2. **How would you ensure type safety across frontend and backend?**
   - Shared types package (npm workspace)
   - OpenAPI spec generation from types
   - End-to-end type validation with Zod

3. **How would you handle database migrations with dual databases?**
   - PostgreSQL migrations via standard tools (Knex, Prisma)
   - Cassandra schema changes require careful coordination (add columns, never remove)
   - Feature flags for gradual rollout of schema-dependent features
