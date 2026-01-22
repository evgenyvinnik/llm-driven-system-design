# Reddit - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing Reddit, a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. As a fullstack engineer, I'll focus on the end-to-end flow from voting to score display, the API contract for nested comments, session-based authentication, and coordinating background workers with the frontend. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Subreddits** - Create communities with custom rules
2. **Posts** - Submit text, link, or media posts
3. **Comments** - Nested threaded discussions
4. **Voting** - Upvote/downvote posts and comments
5. **Ranking** - Sort by hot, new, top, controversial
6. **User Profiles** - Display karma, post/comment history

### Non-Functional Requirements

- **Availability** - 99.9% uptime
- **Latency** - < 100ms for feed loading
- **Scale** - Millions of posts, billions of votes
- **Consistency** - Eventual consistency for vote counts (5-30s delay)

### Fullstack-Specific Considerations

- API design that serves frontend efficiently
- Optimistic updates with server reconciliation
- Session management across browser and server
- Background job coordination with real-time display

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│                    React + Tanstack Router                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Zustand    │  │  API Layer  │  │  Optimistic Updates     │ │
│  │  Store      │  │  (fetch)    │  │  (vote, comment)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                              │
│                    Node.js + Express                            │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  Session Middleware  │  Auth  │  Rate Limiting  │  CORS  │ │
│   └──────────────────────────────────────────────────────────┘ │
│                              │                                  │
│   ┌──────────────────────────┼────────────────────────────┐    │
│   │     /api/r/:subreddit    │    /api/posts/:id          │    │
│   │     /api/vote            │    /api/comments           │    │
│   │     /api/auth/*          │    /api/users/:username    │    │
│   └──────────────────────────┴────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │    Valkey     │    │   Workers     │
│  - All data   │    │  - Sessions   │    │  - Vote agg   │
│  - Source of  │    │  - Vote cache │    │  - Ranking    │
│    truth      │    │  - Hot scores │    │  - Karma      │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Request Flow Overview

```
User clicks upvote
        │
        ▼
┌──────────────────┐
│ Optimistic UI    │ ← Immediate score +1 in Zustand
│ Update           │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ POST /api/vote   │ ← Async request to server
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Insert to votes  │ ← No contention, just insert
│ table            │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Return success   │ ← Confirm optimistic update
└────────┬─────────┘
         │
    (background)
         │
         ▼
┌──────────────────┐
│ Aggregation      │ ← Every 5-30 seconds
│ worker runs      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Posts.score      │ ← Denormalized count updated
│ updated          │
└──────────────────┘
```

---

## 3. Deep Dive: API Contract Design (8 minutes)

### Feed Endpoint

```typescript
// GET /api/r/:subreddit/:sort
// Query: ?page=0&limit=25&time=day (for top sort)

interface FeedResponse {
  posts: Post[];
  hasMore: boolean;
  nextPage: number | null;
}

interface Post {
  id: number;
  subredditId: number;
  subredditName: string;
  authorId: number | null;
  authorName: string | null; // null = "[deleted]"
  title: string;
  content: string | null;
  url: string | null;
  thumbnail: string | null;
  score: number;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string; // ISO 8601
  userVote: 1 | -1 | 0; // Current user's vote
}
```

### Post Detail with Comments

```typescript
// GET /api/posts/:id?sort=best

interface PostDetailResponse {
  post: Post;
  comments: Comment[];
}

interface Comment {
  id: number;
  postId: number;
  parentId: number | null;
  path: string; // "1.a2b.c3d" - materialized path
  depth: number;
  authorId: number | null;
  authorName: string | null;
  content: string;
  score: number;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  userVote: 1 | -1 | 0;
}
```

### Vote Endpoint

```typescript
// POST /api/vote
interface VoteRequest {
  type: 'post' | 'comment';
  id: number;
  direction: 1 | -1 | 0; // 0 = remove vote
}

interface VoteResponse {
  success: boolean;
  newScore: number; // Server's current score (may differ from optimistic)
}
```

### Comment Creation

```typescript
// POST /api/posts/:postId/comments
interface CreateCommentRequest {
  parentId: number | null;
  content: string;
}

interface CreateCommentResponse {
  comment: Comment;
}
```

---

## 4. Deep Dive: End-to-End Voting Flow (10 minutes)

### Frontend: Optimistic Update

```tsx
// store/voteStore.ts
interface VoteStore {
  votes: Map<string, { direction: 1 | -1 | 0; score: number }>;
  vote: (type: 'post' | 'comment', id: number, direction: 1 | -1 | 0) => Promise<void>;
}

export const useVoteStore = create<VoteStore>((set, get) => ({
  votes: new Map(),

  vote: async (type, id, newDirection) => {
    const key = `${type}:${id}`;
    const current = get().votes.get(key);
    const oldDirection = current?.direction || 0;
    const oldScore = current?.score || 0;

    // Calculate optimistic new score
    const scoreDelta = newDirection - oldDirection;
    const optimisticScore = oldScore + scoreDelta;

    // Optimistic update
    set((state) => {
      const votes = new Map(state.votes);
      votes.set(key, { direction: newDirection, score: optimisticScore });
      return { votes };
    });

    try {
      const response = await api.post<VoteResponse>('/vote', {
        type,
        id,
        direction: newDirection
      });

      // Reconcile with server score if different
      if (response.data.newScore !== optimisticScore) {
        set((state) => {
          const votes = new Map(state.votes);
          votes.set(key, { direction: newDirection, score: response.data.newScore });
          return { votes };
        });
      }
    } catch (error) {
      // Rollback on failure
      set((state) => {
        const votes = new Map(state.votes);
        if (current) {
          votes.set(key, current);
        } else {
          votes.delete(key);
        }
        return { votes };
      });
      throw error;
    }
  }
}));
```

### Backend: Vote Handler

```typescript
// routes/vote.ts
import { Router } from 'express';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { requireAuth } from '../shared/auth.js';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  const { type, id, direction } = req.body;
  const userId = req.session.userId;

  // Validate direction
  if (![1, -1, 0].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }

  const column = type === 'post' ? 'post_id' : 'comment_id';
  const targetTable = type === 'post' ? 'posts' : 'comments';

  try {
    if (direction === 0) {
      // Remove vote
      await pool.query(
        `DELETE FROM votes WHERE user_id = $1 AND ${column} = $2`,
        [userId, id]
      );
    } else {
      // Upsert vote
      await pool.query(`
        INSERT INTO votes (user_id, ${column}, direction)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, ${column})
        DO UPDATE SET direction = $3, created_at = NOW()
      `, [userId, id, direction]);
    }

    // Update cache for immediate feedback
    const cacheKey = `${type}:${id}:score`;
    await redis.incr(cacheKey); // Rough approximation

    // Get current score (from cache or DB)
    let newScore: number;
    const cached = await redis.get(cacheKey);

    if (cached) {
      newScore = parseInt(cached);
    } else {
      const result = await pool.query(
        `SELECT score FROM ${targetTable} WHERE id = $1`,
        [id]
      );
      newScore = result.rows[0]?.score || 0;
    }

    res.json({ success: true, newScore });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ error: 'Failed to process vote' });
  }
});

export default router;
```

### Background Worker: Vote Aggregation

```typescript
// workers/voteAggregator.ts
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';

async function aggregateVotes(): Promise<void> {
  console.log('Starting vote aggregation...');

  // Find posts with recent votes
  const recentPosts = await pool.query(`
    SELECT DISTINCT post_id
    FROM votes
    WHERE post_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '5 minutes'
  `);

  for (const { post_id } of recentPosts.rows) {
    // Aggregate votes
    const votes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction = 1) as upvotes,
        COUNT(*) FILTER (WHERE direction = -1) as downvotes
      FROM votes
      WHERE post_id = $1
    `, [post_id]);

    const { upvotes, downvotes } = votes.rows[0];
    const score = parseInt(upvotes) - parseInt(downvotes);

    // Update post
    await pool.query(`
      UPDATE posts
      SET upvotes = $1, downvotes = $2, score = $3
      WHERE id = $4
    `, [upvotes, downvotes, score, post_id]);

    // Update cache
    await redis.set(`post:${post_id}:score`, score.toString(), 'EX', 300);
  }

  // Same for comments
  const recentComments = await pool.query(`
    SELECT DISTINCT comment_id
    FROM votes
    WHERE comment_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '5 minutes'
  `);

  for (const { comment_id } of recentComments.rows) {
    const votes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction = 1) as upvotes,
        COUNT(*) FILTER (WHERE direction = -1) as downvotes
      FROM votes
      WHERE comment_id = $1
    `, [comment_id]);

    const { upvotes, downvotes } = votes.rows[0];
    const score = parseInt(upvotes) - parseInt(downvotes);

    await pool.query(`
      UPDATE comments
      SET upvotes = $1, downvotes = $2, score = $3
      WHERE id = $4
    `, [upvotes, downvotes, score, comment_id]);
  }

  console.log(`Aggregated ${recentPosts.rows.length} posts, ${recentComments.rows.length} comments`);
}

// Run every 30 seconds
setInterval(aggregateVotes, 30000);
aggregateVotes(); // Initial run
```

---

## 5. Deep Dive: Comment Tree API (8 minutes)

### Backend: Fetching Comments

```typescript
// routes/comments.ts
router.get('/posts/:postId/comments', async (req, res) => {
  const { postId } = req.params;
  const { sort = 'best' } = req.query;
  const userId = req.session?.userId;

  // Determine sort order
  const orderClause = {
    best: 'c.score DESC, c.path',
    top: 'c.score DESC, c.path',
    new: 'c.created_at DESC, c.path',
    controversial: '(c.upvotes + c.downvotes) * (LEAST(c.upvotes, c.downvotes)::float / GREATEST(c.upvotes, c.downvotes, 1)) DESC, c.path',
    old: 'c.created_at ASC, c.path'
  }[sort as string] || 'c.path';

  // Fetch comments with user vote status
  const result = await pool.query(`
    SELECT
      c.*,
      u.username as author_name,
      COALESCE(v.direction, 0) as user_vote
    FROM comments c
    LEFT JOIN users u ON c.author_id = u.id
    LEFT JOIN votes v ON v.comment_id = c.id AND v.user_id = $1
    WHERE c.post_id = $2
    ORDER BY ${orderClause}
    LIMIT 500
  `, [userId || null, postId]);

  res.json({ comments: result.rows });
});
```

### Backend: Creating Comments with Path

```typescript
router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
  const { postId } = req.params;
  const { parentId, content } = req.body;
  const userId = req.session.userId;

  // Validate content
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  let path: string;
  let depth: number;

  if (parentId) {
    // Get parent's path
    const parent = await pool.query(
      'SELECT path, depth FROM comments WHERE id = $1 AND post_id = $2',
      [parentId, postId]
    );

    if (parent.rows.length === 0) {
      return res.status(404).json({ error: 'Parent comment not found' });
    }

    // Generate unique path segment
    const segment = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    path = `${parent.rows[0].path}.${segment}`;
    depth = parent.rows[0].depth + 1;
  } else {
    // Top-level comment
    path = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    depth = 0;
  }

  // Insert comment
  const result = await pool.query(`
    INSERT INTO comments (post_id, parent_id, author_id, path, depth, content)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [postId, parentId, userId, path, depth, content]);

  // Increment post comment count
  await pool.query(
    'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
    [postId]
  );

  // Get author name for response
  const author = await pool.query(
    'SELECT username FROM users WHERE id = $1',
    [userId]
  );

  const comment = {
    ...result.rows[0],
    authorName: author.rows[0].username,
    userVote: 0
  };

  res.status(201).json({ comment });
});
```

### Frontend: Building Tree from Flat Data

```typescript
// utils/buildCommentTree.ts
export interface CommentWithChildren extends Comment {
  children: CommentWithChildren[];
}

export function buildCommentTree(comments: Comment[]): CommentWithChildren[] {
  const map = new Map<number, CommentWithChildren>();
  const roots: CommentWithChildren[] = [];

  // Create nodes with empty children arrays
  for (const comment of comments) {
    map.set(comment.id, { ...comment, children: [] });
  }

  // Build tree structure
  for (const comment of comments) {
    const node = map.get(comment.id)!;

    if (comment.parentId === null) {
      roots.push(node);
    } else {
      const parent = map.get(comment.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphaned comment (parent deleted)
        roots.push(node);
      }
    }
  }

  return roots;
}
```

### Frontend: Comment Component Integration

```tsx
// components/CommentThread.tsx
export function CommentThread({ postId }: { postId: number }) {
  const [sort, setSort] = useState<'best' | 'top' | 'new' | 'controversial'>('best');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['comments', postId, sort],
    queryFn: async () => {
      const res = await api.get(`/posts/${postId}/comments?sort=${sort}`);
      return res.data.comments;
    }
  });

  const commentTree = useMemo(() =>
    data ? buildCommentTree(data) : [],
    [data]
  );

  const handleNewComment = async (parentId: number | null, content: string) => {
    await api.post(`/posts/${postId}/comments`, { parentId, content });
    refetch(); // Reload comments to include new one
  };

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="comment-thread">
      <SortTabs value={sort} onChange={setSort} />
      <CommentComposer
        onSubmit={(content) => handleNewComment(null, content)}
      />
      {commentTree.map((comment) => (
        <CommentNode
          key={comment.id}
          comment={comment}
          onReply={handleNewComment}
        />
      ))}
    </div>
  );
}
```

---

## 6. Deep Dive: Session Management (5 minutes)

### Backend: Session Middleware

```typescript
// shared/auth.ts
import session from 'express-session';
import RedisStore from 'connect-redis';
import { redis } from './cache.js';

export const sessionMiddleware = session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET || 'reddit-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  }
});

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Extend session type
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
  }
}
```

### Auth Endpoints

```typescript
// routes/auth.ts
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const user = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username]
  );

  if (user.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Set session
  req.session.userId = user.rows[0].id;
  req.session.username = user.rows[0].username;

  res.json({
    user: {
      id: user.rows[0].id,
      username: user.rows[0].username
    }
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const user = await pool.query(
    'SELECT id, username, karma_post, karma_comment FROM users WHERE id = $1',
    [req.session.userId]
  );

  res.json({ user: user.rows[0] || null });
});
```

### Frontend: Auth Integration

```tsx
// store/authStore.ts
interface AuthStore {
  user: User | null;
  isLoading: boolean;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isLoading: true,

  checkAuth: async () => {
    try {
      const res = await api.get('/auth/me');
      set({ user: res.data.user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    set({ user: res.data.user });
  },

  logout: async () => {
    await api.post('/auth/logout');
    set({ user: null });
  }
}));

// App.tsx - check auth on mount
function App() {
  const { checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, []);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return <RouterProvider router={router} />;
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Vote consistency | Eventual (5-30s) | Users may see stale counts | Real-time (more DB load) |
| Comment tree | Flat API + client build | Extra client work | Server builds tree (larger payload) |
| Session storage | Redis | Extra infrastructure | JWT (stateless but no revocation) |
| Score caching | Redis with TTL | May drift from truth | Query DB each time (slower) |
| User vote state | Included in response | Larger payloads | Separate endpoint (extra requests) |

---

## 8. Error Handling Strategy

### Backend: Consistent Error Responses

```typescript
// shared/errors.ts
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

// Error middleware
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('Error:', err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message
      }
    });
  }

  // Unexpected error
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    }
  });
}
```

### Frontend: Error Handling

```typescript
// api/client.ts
const api = axios.create({
  baseURL: '/api',
  withCredentials: true
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Redirect to login
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }

    // Show toast for other errors
    const message = error.response?.data?.error?.message || 'Something went wrong';
    toast.error(message);

    return Promise.reject(error);
  }
);
```

---

## 9. Testing Strategy

### Integration Tests

```typescript
// tests/voting.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/shared/db.js';

describe('Voting Flow', () => {
  let sessionCookie: string;
  let postId: number;

  beforeEach(async () => {
    // Login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser', password: 'password' });
    sessionCookie = loginRes.headers['set-cookie'][0];

    // Create post
    const postRes = await request(app)
      .post('/api/r/test/posts')
      .set('Cookie', sessionCookie)
      .send({ title: 'Test Post', content: 'Content' });
    postId = postRes.body.post.id;
  });

  it('should upvote a post', async () => {
    const res = await request(app)
      .post('/api/vote')
      .set('Cookie', sessionCookie)
      .send({ type: 'post', id: postId, direction: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.newScore).toBe(1);
  });

  it('should change vote direction', async () => {
    // Upvote
    await request(app)
      .post('/api/vote')
      .set('Cookie', sessionCookie)
      .send({ type: 'post', id: postId, direction: 1 });

    // Change to downvote
    const res = await request(app)
      .post('/api/vote')
      .set('Cookie', sessionCookie)
      .send({ type: 'post', id: postId, direction: -1 });

    expect(res.body.newScore).toBe(-1);
  });

  it('should remove vote', async () => {
    // Upvote
    await request(app)
      .post('/api/vote')
      .set('Cookie', sessionCookie)
      .send({ type: 'post', id: postId, direction: 1 });

    // Remove vote
    const res = await request(app)
      .post('/api/vote')
      .set('Cookie', sessionCookie)
      .send({ type: 'post', id: postId, direction: 0 });

    expect(res.body.newScore).toBe(0);
  });
});
```

---

## 10. Future Enhancements

1. **Real-time Updates** - WebSocket for live vote counts and new comments
2. **Subreddit Moderation** - Mod tools with action queues
3. **Media Upload** - Image/video hosting with CDN
4. **Search** - Elasticsearch for post and comment search
5. **Notifications** - Push notifications for replies and mentions

---

## Summary

"To summarize, I've designed Reddit as a fullstack application with:

1. **Optimistic voting with reconciliation** - Votes update immediately in the UI, then sync with the server. If the server's score differs (due to aggregation timing), we reconcile.

2. **Flat comment API with client-side tree building** - The API returns comments sorted by path, the client builds the tree structure. This keeps the API simple and payloads reasonable.

3. **Session-based auth with Redis** - Simple session middleware stores user state in Redis, enabling easy logout and session management.

4. **Background workers for consistency** - Vote aggregation runs every 30 seconds, separating write path (fast inserts) from read path (aggregated counts).

The key insight is that eventual consistency for votes is acceptable because users don't notice 5-30 second delays in score updates, and this allows the system to scale without database contention."
