# Twitter - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design Twitter, a real-time microblogging platform where users post 280-character tweets that appear in their followers' timelines. The core challenge is the 'fanout problem' - when a user tweets, how do we efficiently notify millions of followers? A celebrity with 50 million followers can't wait 83 minutes for their tweet to propagate.

As a full-stack engineer, I'll focus on how the frontend and backend work together: shared type contracts for type-safe communication, end-to-end tweet creation flow with optimistic updates, hybrid fanout that the client seamlessly merges, and real-time updates that keep timelines fresh."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Tweet**: Post 280-character messages with optional media
- **Follow**: Subscribe to other users' content
- **Timeline**: View chronological feed of followed users
- **Trending**: See popular topics in real-time
- **Engage**: Like, retweet, reply to tweets

### Non-Functional Requirements
- **Latency**: < 200ms for timeline load, instant UI feedback
- **Availability**: 99.99% uptime
- **Scale**: 500M users, 500M tweets/day
- **Consistency**: Eventual consistency with optimistic UI

### Full-Stack Considerations
1. How does the client handle the celebrity/normal user merge transparently?
2. What's the optimistic update strategy for engagement actions?
3. How do we maintain type safety across the API boundary?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│              React + Tanstack Router + Zustand                  │
│         Virtualized Timeline + Optimistic Updates               │
└─────────────────────────────────────────────────────────────────┘
                              │
                    REST API + SSE Events
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Express                        │
│              Shared Types + Validation (Zod)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Tweet Service │    │ Timeline Svc  │    │ Social Graph  │
│               │    │               │    │               │
│ - Create tweet│    │ - Build feed  │    │ - Follow/unf  │
│ - Idempotency │    │ - Hybrid merge│    │ - Followers   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │    Redis/Valkey                               │
│   - Users       │    - Timeline cache (lists)                   │
│   - Tweets      │    - Social graph cache                       │
│   - Follows     │    - Trend counters                           │
└─────────────────┴───────────────────────────────────────────────┘
```

## Deep Dive: Shared Type System (6 minutes)

Type safety across the API boundary prevents integration bugs and enables confident refactoring.

### Shared Types Package

```typescript
// shared/types/tweet.ts
export interface Tweet {
  id: string;
  authorId: string;
  content: string;
  mediaUrls: string[];
  hashtags: string[];
  mentions: string[];
  replyTo: string | null;
  retweetOf: string | null;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  createdAt: string;

  // Denormalized for client convenience
  author: UserSummary;

  // Viewer-specific state
  viewerHasLiked: boolean;
  viewerHasRetweeted: boolean;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isCelebrity: boolean;
  isVerified: boolean;
}

export interface TimelineResponse {
  tweets: Tweet[];
  cursor: string | null;
  hasMore: boolean;
}

export interface CreateTweetRequest {
  content: string;
  mediaUrls?: string[];
  replyTo?: string;
}

export interface CreateTweetResponse {
  tweet: Tweet;
}
```

### Zod Validation (Both Sides)

```typescript
// shared/validation/tweet.ts
import { z } from 'zod';

export const createTweetSchema = z.object({
  content: z.string()
    .min(1, 'Tweet cannot be empty')
    .max(280, 'Tweet cannot exceed 280 characters'),
  mediaUrls: z.array(z.string().url()).max(4).optional(),
  replyTo: z.string().optional(),
});

export type CreateTweetInput = z.infer<typeof createTweetSchema>;

// Backend uses for request validation
// Frontend uses for form validation before submit
```

### API Client with Type Safety

```typescript
// frontend/src/services/api.ts
import type {
  Tweet,
  TimelineResponse,
  CreateTweetRequest,
  CreateTweetResponse
} from '@twitter/shared-types';
import { v4 as uuid } from 'uuid';

const API_BASE = '/api';

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(response.status, error.message || 'Request failed');
  }

  return response.json();
}

export const tweetApi = {
  getHomeTimeline(cursor?: string): Promise<TimelineResponse> {
    const params = cursor ? `?cursor=${cursor}` : '';
    return request(`/timeline/home${params}`);
  },

  createTweet(data: CreateTweetRequest): Promise<CreateTweetResponse> {
    const idempotencyKey = uuid();
    return request('/tweets', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(data),
    });
  },

  likeTweet(tweetId: string): Promise<{ success: boolean }> {
    return request(`/tweets/${tweetId}/like`, { method: 'POST' });
  },

  unlikeTweet(tweetId: string): Promise<{ success: boolean }> {
    return request(`/tweets/${tweetId}/like`, { method: 'DELETE' });
  },
};
```

## Deep Dive: End-to-End Tweet Creation Flow (8 minutes)

This flow demonstrates how frontend and backend collaborate with optimistic updates and idempotency.

### Frontend: Optimistic Tweet Creation

```typescript
// frontend/src/stores/timelineStore.ts
import { create } from 'zustand';
import type { Tweet, CreateTweetRequest } from '@twitter/shared-types';
import { tweetApi } from '../services/api';

interface TimelineState {
  tweets: Tweet[];
  pendingTweets: Map<string, PendingTweet>;
  createTweet: (request: CreateTweetRequest) => Promise<void>;
}

interface PendingTweet {
  tempId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'failed';
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  tweets: [],
  pendingTweets: new Map(),

  async createTweet(request: CreateTweetRequest) {
    const tempId = `temp-${Date.now()}`;
    const currentUser = useAuthStore.getState().user!;

    // 1. Optimistic update - show immediately
    const pendingTweet: PendingTweet = {
      tempId,
      content: request.content,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    set(state => ({
      pendingTweets: new Map(state.pendingTweets).set(tempId, pendingTweet),
    }));

    try {
      // 2. Send to server with idempotency key
      const { tweet } = await tweetApi.createTweet(request);

      // 3. Replace pending with real tweet
      set(state => {
        const newPending = new Map(state.pendingTweets);
        newPending.delete(tempId);
        return {
          tweets: [tweet, ...state.tweets],
          pendingTweets: newPending,
        };
      });
    } catch (error) {
      // 4. Mark as failed, allow retry
      set(state => {
        const newPending = new Map(state.pendingTweets);
        const pending = newPending.get(tempId);
        if (pending) {
          newPending.set(tempId, { ...pending, status: 'failed' });
        }
        return { pendingTweets: newPending };
      });
      throw error;
    }
  },
}));
```

### Backend: Tweet Creation with Idempotency

```typescript
// backend/src/routes/tweets.ts
import express from 'express';
import { z } from 'zod';
import { createTweetSchema } from '@twitter/shared-types';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { fanoutTweet } from '../services/fanout.js';
import { recordHashtags } from '../services/trends.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const userId = req.session.userId;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  // 1. Check idempotency
  if (idempotencyKey) {
    const cacheKey = `idempotency:tweet:${userId}:${idempotencyKey}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }
  }

  // 2. Validate request
  const validation = createTweetSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validation.error.flatten(),
    });
  }

  const { content, mediaUrls, replyTo } = validation.data;

  // 3. Extract hashtags and mentions
  const hashtags = extractHashtags(content);
  const mentions = await extractMentions(content);

  // 4. Insert tweet
  const result = await pool.query(`
    INSERT INTO tweets (author_id, content, media_urls, hashtags, mentions, reply_to)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [userId, content, mediaUrls || [], hashtags, mentions, replyTo || null]);

  const tweet = result.rows[0];

  // 5. Get author info for response
  const author = await getUser(userId);

  // 6. Build response
  const response = {
    tweet: {
      ...formatTweet(tweet),
      author: formatUserSummary(author),
      viewerHasLiked: false,
      viewerHasRetweeted: false,
    },
  };

  // 7. Cache idempotency response
  if (idempotencyKey) {
    const cacheKey = `idempotency:tweet:${userId}:${idempotencyKey}`;
    await redis.setex(cacheKey, 86400, JSON.stringify(response));
  }

  // 8. Trigger fanout (async, don't block response)
  fanoutTweet(tweet.id, userId, author.is_celebrity).catch(err => {
    console.error('Fanout failed:', err);
  });

  // 9. Record hashtags for trends
  if (hashtags.length > 0) {
    recordHashtags(hashtags).catch(err => {
      console.error('Trend recording failed:', err);
    });
  }

  res.status(201).json(response);
});

function extractHashtags(content: string): string[] {
  const matches = content.match(/#\w+/g) || [];
  return matches.map(tag => tag.slice(1).toLowerCase());
}

async function extractMentions(content: string): Promise<string[]> {
  const matches = content.match(/@\w+/g) || [];
  const usernames = matches.map(m => m.slice(1));

  if (usernames.length === 0) return [];

  const result = await pool.query(
    'SELECT id FROM users WHERE username = ANY($1)',
    [usernames]
  );

  return result.rows.map(r => r.id);
}

export default router;
```

### Compose Tweet Component

```tsx
// frontend/src/components/ComposeTweet.tsx
import { useState, useCallback, useMemo } from 'react';
import { useTimelineStore } from '../stores/timelineStore';
import { useAuthStore } from '../stores/authStore';
import { createTweetSchema } from '@twitter/shared-types';

const MAX_LENGTH = 280;

export function ComposeTweet() {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createTweet = useTimelineStore(state => state.createTweet);
  const user = useAuthStore(state => state.user);

  const remainingChars = MAX_LENGTH - content.length;
  const isOverLimit = remainingChars < 0;
  const isEmpty = content.trim().length === 0;

  // Client-side validation using shared schema
  const validationResult = useMemo(() => {
    if (isEmpty) return { valid: false, error: null };
    return createTweetSchema.safeParse({ content });
  }, [content, isEmpty]);

  const handleSubmit = useCallback(async () => {
    if (!validationResult.success || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await createTweet({ content });
      setContent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post tweet');
    } finally {
      setIsSubmitting(false);
    }
  }, [content, createTweet, validationResult, isSubmitting]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="border-b border-twitter-lightGray p-4">
      <div className="flex gap-3">
        <img
          src={user?.avatarUrl || '/default-avatar.png'}
          alt={user?.displayName}
          className="w-12 h-12 rounded-full"
        />

        <div className="flex-1">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What's happening?"
            className="w-full resize-none border-none outline-none text-xl"
            rows={3}
            maxLength={MAX_LENGTH + 20} // Allow typing over to show error
            aria-label="Tweet content"
            aria-describedby="char-count"
          />

          {error && (
            <p className="text-red-500 text-sm mt-2" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between mt-3 pt-3 border-t border-twitter-lightGray">
            <div className="flex gap-2">
              <button
                type="button"
                className="p-2 text-twitter-blue hover:bg-twitter-blue/10 rounded-full"
                aria-label="Add media"
              >
                <ImageIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <CharacterCounter
                current={content.length}
                max={MAX_LENGTH}
                id="char-count"
              />

              <button
                onClick={handleSubmit}
                disabled={isEmpty || isOverLimit || isSubmitting}
                className="bg-twitter-blue text-white font-bold px-4 py-2 rounded-full
                         hover:bg-twitter-darkBlue disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
              >
                {isSubmitting ? 'Posting...' : 'Tweet'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CharacterCounter({ current, max, id }: {
  current: number;
  max: number;
  id: string;
}) {
  const remaining = max - current;
  const percentage = (current / max) * 100;

  let color = 'text-twitter-gray';
  if (remaining <= 20 && remaining > 0) color = 'text-yellow-500';
  if (remaining <= 0) color = 'text-red-500';

  return (
    <div id={id} className="flex items-center gap-2">
      <svg className="w-6 h-6" viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="#EFF3F4"
          strokeWidth="2"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke={remaining <= 0 ? '#F4212E' : remaining <= 20 ? '#FFD400' : '#1DA1F2'}
          strokeWidth="2"
          strokeDasharray={`${Math.min(percentage, 100) * 0.628} 100`}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
        />
      </svg>
      {remaining <= 20 && (
        <span className={color}>{remaining}</span>
      )}
    </div>
  );
}
```

## Deep Dive: Timeline Merge Strategy (7 minutes)

The hybrid fanout requires the backend to merge cached and celebrity tweets seamlessly.

### Backend: Timeline Building

```typescript
// backend/src/routes/timeline.ts
import express from 'express';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import type { TimelineResponse, Tweet } from '@twitter/shared-types';

const router = express.Router();

router.get('/home', async (req, res) => {
  const userId = req.session.userId;
  const cursor = req.query.cursor as string | undefined;
  const limit = 20;

  // 1. Get cached timeline (pushed tweets from normal users)
  const cacheKey = `timeline:${userId}`;
  let cachedIds: string[];

  if (cursor) {
    // Find cursor position in cache
    const allIds = await redis.lrange(cacheKey, 0, -1);
    const cursorIndex = allIds.indexOf(cursor);
    cachedIds = cursorIndex >= 0
      ? allIds.slice(cursorIndex + 1, cursorIndex + 1 + limit)
      : [];
  } else {
    cachedIds = await redis.lrange(cacheKey, 0, limit - 1);
  }

  // 2. Get followed celebrities
  const following = await getFollowingWithCelebrity(userId);
  const celebrityIds = following
    .filter(f => f.is_celebrity)
    .map(f => f.following_id);

  // 3. Fetch tweets in parallel
  const [cachedTweets, celebrityTweets] = await Promise.all([
    cachedIds.length > 0 ? getTweetsWithDetails(cachedIds, userId) : [],
    celebrityIds.length > 0 ? getCelebrityTweets(celebrityIds, userId, cursor) : [],
  ]);

  // 4. Merge and sort by creation time
  const allTweets = [...cachedTweets, ...celebrityTweets];
  allTweets.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // 5. Deduplicate (in case of race conditions)
  const seen = new Set<string>();
  const uniqueTweets = allTweets.filter(tweet => {
    if (seen.has(tweet.id)) return false;
    seen.add(tweet.id);
    return true;
  });

  // 6. Slice to limit
  const tweets = uniqueTweets.slice(0, limit);
  const nextCursor = tweets.length === limit ? tweets[tweets.length - 1].id : null;

  const response: TimelineResponse = {
    tweets,
    cursor: nextCursor,
    hasMore: nextCursor !== null,
  };

  res.json(response);
});

async function getTweetsWithDetails(
  tweetIds: string[],
  viewerId: string
): Promise<Tweet[]> {
  const result = await pool.query(`
    SELECT
      t.*,
      u.username as author_username,
      u.display_name as author_display_name,
      u.avatar_url as author_avatar_url,
      u.is_celebrity as author_is_celebrity,
      EXISTS(SELECT 1 FROM likes WHERE user_id = $2 AND tweet_id = t.id) as viewer_has_liked,
      EXISTS(SELECT 1 FROM retweets WHERE user_id = $2 AND tweet_id = t.id) as viewer_has_retweeted
    FROM tweets t
    JOIN users u ON t.author_id = u.id
    WHERE t.id = ANY($1) AND t.deleted_at IS NULL
    ORDER BY t.created_at DESC
  `, [tweetIds, viewerId]);

  return result.rows.map(formatTweetWithAuthor);
}

async function getCelebrityTweets(
  celebrityIds: string[],
  viewerId: string,
  cursor?: string
): Promise<Tweet[]> {
  let query = `
    SELECT
      t.*,
      u.username as author_username,
      u.display_name as author_display_name,
      u.avatar_url as author_avatar_url,
      u.is_celebrity as author_is_celebrity,
      EXISTS(SELECT 1 FROM likes WHERE user_id = $2 AND tweet_id = t.id) as viewer_has_liked,
      EXISTS(SELECT 1 FROM retweets WHERE user_id = $2 AND tweet_id = t.id) as viewer_has_retweeted
    FROM tweets t
    JOIN users u ON t.author_id = u.id
    WHERE t.author_id = ANY($1)
      AND t.deleted_at IS NULL
      AND t.created_at > NOW() - INTERVAL '24 hours'
  `;

  const params: any[] = [celebrityIds, viewerId];

  if (cursor) {
    query += ` AND t.id < $3`;
    params.push(cursor);
  }

  query += ` ORDER BY t.created_at DESC LIMIT 50`;

  const result = await pool.query(query, params);
  return result.rows.map(formatTweetWithAuthor);
}

function formatTweetWithAuthor(row: any): Tweet {
  return {
    id: row.id.toString(),
    authorId: row.author_id.toString(),
    content: row.content,
    mediaUrls: row.media_urls || [],
    hashtags: row.hashtags || [],
    mentions: row.mentions || [],
    replyTo: row.reply_to?.toString() || null,
    retweetOf: row.retweet_of?.toString() || null,
    likeCount: row.like_count,
    retweetCount: row.retweet_count,
    replyCount: row.reply_count,
    createdAt: row.created_at.toISOString(),
    author: {
      id: row.author_id.toString(),
      username: row.author_username,
      displayName: row.author_display_name,
      avatarUrl: row.author_avatar_url,
      isCelebrity: row.author_is_celebrity,
      isVerified: false, // Could add this field
    },
    viewerHasLiked: row.viewer_has_liked,
    viewerHasRetweeted: row.viewer_has_retweeted,
  };
}

export default router;
```

### Frontend: Virtualized Timeline with Infinite Scroll

```tsx
// frontend/src/components/Timeline.tsx
import { useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Tweet } from '@twitter/shared-types';
import { TweetCard } from './TweetCard';
import { useTimelineStore } from '../stores/timelineStore';

interface TimelineProps {
  tweets: Tweet[];
  pendingTweets: Map<string, PendingTweet>;
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

export function Timeline({
  tweets,
  pendingTweets,
  isLoading,
  hasMore,
  onLoadMore
}: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Combine pending and confirmed tweets
  const allItems = [
    ...Array.from(pendingTweets.values()).map(p => ({ type: 'pending' as const, data: p })),
    ...tweets.map(t => ({ type: 'tweet' as const, data: t })),
  ];

  const virtualizer = useVirtualizer({
    count: allItems.length + (hasMore ? 1 : 0), // +1 for load more trigger
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 5,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  const items = virtualizer.getVirtualItems();

  // Infinite scroll: load more when reaching the end
  useEffect(() => {
    const lastItem = items[items.length - 1];
    if (!lastItem) return;

    if (lastItem.index >= allItems.length - 1 && hasMore && !isLoading) {
      onLoadMore();
    }
  }, [items, allItems.length, hasMore, isLoading, onLoadMore]);

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      role="feed"
      aria-busy={isLoading}
      aria-label="Tweet timeline"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map(virtualRow => {
          const item = allItems[virtualRow.index];

          // Load more indicator at the end
          if (!item) {
            return (
              <div
                key="load-more"
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="flex justify-center py-4"
              >
                {isLoading ? (
                  <LoadingSpinner />
                ) : (
                  <button
                    onClick={onLoadMore}
                    className="text-twitter-blue hover:underline"
                  >
                    Load more
                  </button>
                )}
              </div>
            );
          }

          return (
            <div
              key={item.type === 'pending' ? item.data.tempId : item.data.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {item.type === 'pending' ? (
                <PendingTweetCard tweet={item.data} />
              ) : (
                <TweetCard tweet={item.data} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PendingTweetCard({ tweet }: { tweet: PendingTweet }) {
  return (
    <div className="border-b border-twitter-lightGray p-4 opacity-60">
      <div className="flex gap-3">
        <div className="w-12 h-12 rounded-full bg-gray-200 animate-pulse" />
        <div className="flex-1">
          <p className="text-twitter-black">{tweet.content}</p>
          {tweet.status === 'failed' && (
            <p className="text-red-500 text-sm mt-2">
              Failed to post. <button className="underline">Retry</button>
            </p>
          )}
          {tweet.status === 'pending' && (
            <p className="text-twitter-gray text-sm mt-2">Posting...</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

## Deep Dive: Engagement Actions (5 minutes)

Like and retweet actions demonstrate optimistic updates with rollback on failure.

### Frontend: Optimistic Like

```typescript
// frontend/src/stores/timelineStore.ts (continued)
async toggleLike(tweetId: string) {
  const tweet = get().tweets.find(t => t.id === tweetId);
  if (!tweet) return;

  const wasLiked = tweet.viewerHasLiked;

  // Optimistic update
  set(state => ({
    tweets: state.tweets.map(t =>
      t.id === tweetId
        ? {
            ...t,
            viewerHasLiked: !wasLiked,
            likeCount: wasLiked ? t.likeCount - 1 : t.likeCount + 1,
          }
        : t
    ),
  }));

  try {
    if (wasLiked) {
      await tweetApi.unlikeTweet(tweetId);
    } else {
      await tweetApi.likeTweet(tweetId);
    }
  } catch (error) {
    // Rollback on failure
    set(state => ({
      tweets: state.tweets.map(t =>
        t.id === tweetId
          ? {
              ...t,
              viewerHasLiked: wasLiked,
              likeCount: wasLiked ? t.likeCount : t.likeCount - 1,
            }
          : t
      ),
    }));
    throw error;
  }
},
```

### Backend: Like with Idempotency

```typescript
// backend/src/routes/tweets.ts (continued)
router.post('/:id/like', async (req, res) => {
  const userId = req.session.userId;
  const tweetId = req.params.id;

  try {
    // Upsert - idempotent by design (primary key constraint)
    await pool.query(`
      INSERT INTO likes (user_id, tweet_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, tweet_id) DO NOTHING
    `, [userId, tweetId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Like failed:', error);
    res.status(500).json({ error: 'Failed to like tweet' });
  }
});

router.delete('/:id/like', async (req, res) => {
  const userId = req.session.userId;
  const tweetId = req.params.id;

  await pool.query(
    'DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2',
    [userId, tweetId]
  );

  res.json({ success: true });
});
```

### TweetCard with Actions

```tsx
// frontend/src/components/TweetCard.tsx
import { memo, useCallback } from 'react';
import type { Tweet } from '@twitter/shared-types';
import { useTimelineStore } from '../stores/timelineStore';
import { formatRelativeTime } from '../utils/date';
import { parseContent } from '../utils/content';

export const TweetCard = memo(function TweetCard({ tweet }: { tweet: Tweet }) {
  const toggleLike = useTimelineStore(state => state.toggleLike);
  const toggleRetweet = useTimelineStore(state => state.toggleRetweet);

  const handleLike = useCallback(() => {
    toggleLike(tweet.id);
  }, [tweet.id, toggleLike]);

  const handleRetweet = useCallback(() => {
    toggleRetweet(tweet.id);
  }, [tweet.id, toggleRetweet]);

  return (
    <article
      className="border-b border-twitter-lightGray p-4 hover:bg-twitter-extraLightGray transition-colors"
      aria-label={`Tweet by ${tweet.author.displayName}`}
    >
      <div className="flex gap-3">
        <img
          src={tweet.author.avatarUrl || '/default-avatar.png'}
          alt=""
          className="w-12 h-12 rounded-full"
        />

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-1 text-sm">
            <span className="font-bold text-twitter-black truncate">
              {tweet.author.displayName}
            </span>
            <span className="text-twitter-gray">@{tweet.author.username}</span>
            <span className="text-twitter-gray">.</span>
            <time
              dateTime={tweet.createdAt}
              className="text-twitter-gray"
            >
              {formatRelativeTime(tweet.createdAt)}
            </time>
          </div>

          {/* Content with parsed hashtags/mentions */}
          <p className="text-twitter-black mt-1 whitespace-pre-wrap">
            {parseContent(tweet.content)}
          </p>

          {/* Actions */}
          <div className="flex justify-between mt-3 max-w-md">
            <ActionButton
              icon={<ReplyIcon />}
              count={tweet.replyCount}
              label="Reply"
              onClick={() => {}}
              color="blue"
            />

            <ActionButton
              icon={<RetweetIcon />}
              count={tweet.retweetCount}
              label={tweet.viewerHasRetweeted ? 'Undo retweet' : 'Retweet'}
              onClick={handleRetweet}
              active={tweet.viewerHasRetweeted}
              color="green"
            />

            <ActionButton
              icon={tweet.viewerHasLiked ? <HeartFilledIcon /> : <HeartIcon />}
              count={tweet.likeCount}
              label={tweet.viewerHasLiked ? 'Unlike' : 'Like'}
              onClick={handleLike}
              active={tweet.viewerHasLiked}
              color="pink"
            />

            <ActionButton
              icon={<ShareIcon />}
              label="Share"
              onClick={() => {}}
              color="blue"
            />
          </div>
        </div>
      </div>
    </article>
  );
});

interface ActionButtonProps {
  icon: React.ReactNode;
  count?: number;
  label: string;
  onClick: () => void;
  active?: boolean;
  color: 'blue' | 'green' | 'pink';
}

function ActionButton({ icon, count, label, onClick, active, color }: ActionButtonProps) {
  const colorClasses = {
    blue: 'hover:text-twitter-blue hover:bg-twitter-blue/10',
    green: active
      ? 'text-twitter-retweet'
      : 'hover:text-twitter-retweet hover:bg-twitter-retweet/10',
    pink: active
      ? 'text-twitter-like'
      : 'hover:text-twitter-like hover:bg-twitter-like/10',
  };

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 p-2 rounded-full text-twitter-gray
                  transition-colors ${colorClasses[color]}`}
      aria-label={label}
    >
      <span className="w-5 h-5">{icon}</span>
      {count !== undefined && count > 0 && (
        <span className="text-sm">{formatCount(count)}</span>
      )}
    </button>
  );
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
```

## Error Handling Strategy (4 minutes)

### API Error Handling

```typescript
// shared/types/errors.ts
export interface ApiErrorResponse {
  error: string;
  code: string;
  details?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static fromResponse(status: number, body: ApiErrorResponse): ApiError {
    return new ApiError(status, body.code, body.error, body.details);
  }
}

// frontend/src/services/api.ts
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: 'Request failed',
      code: 'UNKNOWN'
    }));
    throw ApiError.fromResponse(response.status, body);
  }

  return response.json();
}
```

### Backend Error Middleware

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('Error:', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
  });

  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.flatten().fieldErrors,
    });
  }

  // Database constraint violations
  if (err.message.includes('duplicate key')) {
    return res.status(409).json({
      error: 'Resource already exists',
      code: 'DUPLICATE',
    });
  }

  // Foreign key violations
  if (err.message.includes('foreign key')) {
    return res.status(404).json({
      error: 'Referenced resource not found',
      code: 'NOT_FOUND',
    });
  }

  // Default server error
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
```

### Frontend Error Boundary

```tsx
// frontend/src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('React error boundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 text-center">
          <h2 className="text-xl font-bold text-twitter-black">
            Something went wrong
          </h2>
          <p className="text-twitter-gray mt-2">
            Please refresh the page or try again later.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 bg-twitter-blue text-white px-4 py-2 rounded-full"
          >
            Refresh
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

## Database Schema with Triggers (3 minutes)

```sql
-- Key tables for full-stack context
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],
  mentions INTEGER[],
  reply_to BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  retweet_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  deleted_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Trigger: Auto-update celebrity status
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET follower_count = follower_count + 1,
                     is_celebrity = (follower_count + 1 >= 10000)
    WHERE id = NEW.following_id;
    UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET follower_count = follower_count - 1,
                     is_celebrity = (follower_count - 1 >= 10000)
    WHERE id = OLD.following_id;
    UPDATE users SET following_count = following_count - 1 WHERE id = OLD.follower_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_follow_counts
AFTER INSERT OR DELETE ON follows
FOR EACH ROW EXECUTE FUNCTION update_follow_counts();

-- Trigger: Auto-update like counts
CREATE OR REPLACE FUNCTION update_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET like_count = like_count + 1 WHERE id = NEW.tweet_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET like_count = like_count - 1 WHERE id = OLD.tweet_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_like_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW EXECUTE FUNCTION update_like_count();
```

## Trade-offs and Alternatives (3 minutes)

### 1. Shared Types Package vs. Code Generation

**Chose: Shared TypeScript types**
- Pro: Simple, no build step for types
- Pro: Full control over type definitions
- Con: Manual sync between frontend/backend
- Alternative: OpenAPI/GraphQL codegen (more automation, more complexity)

### 2. Optimistic Updates vs. Server Confirmation

**Chose: Optimistic with rollback**
- Pro: Instant UI feedback
- Pro: Better perceived performance
- Con: Complexity in rollback handling
- Alternative: Wait for server (simpler, feels slower)

### 3. REST vs. GraphQL

**Chose: REST with typed responses**
- Pro: Simpler caching
- Pro: Better match for Twitter's data patterns
- Con: Multiple requests for related data
- Alternative: GraphQL (flexible queries, overfetching prevention)

### 4. Zod vs. io-ts/Yup

**Chose: Zod for validation**
- Pro: Great TypeScript inference
- Pro: Single definition for validation + types
- Con: Bundle size
- Alternative: io-ts (more functional), Yup (more established)

## Closing Summary (1 minute)

"Twitter's full-stack architecture solves the fanout problem through coordinated frontend and backend design:

1. **Shared type contracts** - TypeScript interfaces and Zod schemas ensure type safety across the API boundary, preventing integration bugs and enabling confident refactoring.

2. **Optimistic updates with idempotency** - The frontend immediately updates UI state for all user actions, while the backend uses idempotency keys to safely handle retries without duplicates.

3. **Transparent timeline merging** - The hybrid fanout (push for normal users, pull for celebrities) is completely hidden from the frontend. The API returns a unified, sorted timeline that the client simply renders.

4. **Virtualized rendering** - The timeline uses @tanstack/react-virtual to efficiently render thousands of tweets, only creating DOM nodes for visible items.

The main trade-off is development complexity vs. user experience. We chose optimistic updates and complex merging because users expect instant feedback and seamless timelines. Future improvements would include real-time SSE for new tweets and GraphQL for more flexible data fetching."
