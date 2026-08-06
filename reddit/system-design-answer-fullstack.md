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
┌──────────────── Client (React + TanStack Router) ──────────────┐
│  Zustand store  │  fetch layer  │  optimistic vote/comment     │
└────────────────────────────┬───────────────────────────────────┘
                             ▼
┌──────────────── API (Node + Express) ──────────────────────────┐
│  session · auth · rate limiting · CORS                         │
│  /api/auth/*   /api/r/:subreddit   /api/posts/:id              │
│  /api/vote     /api/comments       /api/users/:username        │
└──────┬─────────────────────┬──────────────────────┬────────────┘
       ▼                     ▼                      ▼
┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐
│ PostgreSQL   │   │ Valkey           │   │ Workers            │
│ source of    │   │ sessions +       │   │ ranking sweep,     │
│ truth, incl. │   │ per-user vote    │   │ vote-drift repair  │
│ sessions     │   │ cache            │   │                    │
└──────────────┘   └──────────────────┘   └────────────────────┘
```

One thing worth flagging in this diagram: **sessions live in Postgres, not Valkey.** Valkey holds only a per-user vote cache. That's unusual for this repo — most projects here put sessions in Redis — and it means an auth check is a database round trip rather than a sub-millisecond lookup. The upside is that a Redis restart doesn't log everyone out; the cost is that the busiest read in the system (every authenticated request) lands on the same database serving the feed.

### 🔄 Request Flow Overview

```
click upvote ──▶ optimistic +1 in Zustand ──▶ POST /api/vote
                                                    │
                                            insert/update votes row
                                                    │
                                    aggregateVotesForTarget() — inline
                                    SUM(CASE…) then UPDATE posts.score
                                                    │
                                         response carries the true score
```

**Note that this is synchronous, not the async pattern it's tempting to draw.** `castVote` re-tallies and writes `posts.score` inside the same request, so the response carries a correct score and the client never has to reconcile its optimistic update against a later refetch.

The async alternative — insert the vote, return immediately, let a worker tally every few seconds — removes the contended `UPDATE` from the write path. It's the better answer at scale and it's genuinely worse here: the user upvotes, the counter doesn't move for up to five seconds, and they reasonably conclude the click was lost. Patching that with a client-side optimistic increment then puts the client and server in disagreement whenever someone else voted in the same window.

What synchronous aggregation costs is exactly what async would have bought: every voter on a hot post serializes on `UPDATE posts SET … WHERE id = $1`. A background sweeper still runs every 5 seconds over recently-voted targets, but it repairs drift from failed writes — it does nothing for contention. The real fix at scale is Redis `INCR` counters flushed periodically, deliberately not built here.

---

## 3. Deep Dive: API Contract Design (8 minutes)

### 📋 Feed Endpoint

**GET /api/r/:subreddit/:sort?page=0&limit=25&time=day**

Response structure:
- **posts[]**: Array of Post objects
- **hasMore**: Boolean for pagination
- **nextPage**: Number or null

**Post object fields:**
- id, subredditId, subredditName
- authorId, authorName (null = "[deleted]")
- title, content, url, thumbnail
- score, upvotes, downvotes, commentCount
- createdAt (ISO 8601)
- **userVote**: 1 | -1 | 0 (current user's vote)

### 📋 Post Detail with Comments

**GET /api/posts/:id?sort=best**

Response includes post and flat comment array where each comment has:
- id, postId, parentId
- **path**: Materialized path string (e.g., "1.a2b.c3d")
- **depth**: Nesting level
- authorId, authorName, content
- score, upvotes, downvotes
- createdAt, userVote

### 📋 Vote Endpoint

**POST /api/vote**

Request: { type: 'post' | 'comment', id: number, direction: 1 | -1 | 0 }

Response: { success: boolean, newScore: number }

"The newScore may differ from the optimistic update due to aggregation timing."

### 📋 Comment Creation

**POST /api/posts/:postId/comments**

Request: { parentId: number | null, content: string }

Response: { comment: Comment }

---

## 4. Deep Dive: End-to-End Voting Flow (10 minutes)

### 🖥️ Frontend: Optimistic Update Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    Zustand Vote Store                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   State:                                                        │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  votes: Map<"post:123" | "comment:456", {               │   │
│   │    direction: 1 | -1 | 0,                               │   │
│   │    score: number                                        │   │
│   │  }>                                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Actions:                                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  vote(type, id, newDirection):                          │   │
│   │    1. Calculate scoreDelta = newDirection - oldDirection │   │
│   │    2. Set optimistic state immediately                  │   │
│   │    3. POST to /api/vote                                 │   │
│   │    4. On success: reconcile if server score differs     │   │
│   │    5. On failure: rollback to previous state            │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🔧 Backend: Vote Handler Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    POST /api/vote Handler                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. requireAuth middleware ──▶ Validate session                │
│                                                                  │
│   2. Validate direction ∈ {1, -1, 0}                            │
│                                                                  │
│   3. If direction = 0:                                          │
│      └──▶ DELETE FROM votes WHERE user_id AND target_id         │
│                                                                  │
│   4. Else:                                                      │
│      └──▶ INSERT INTO votes ... ON CONFLICT DO UPDATE           │
│           (upsert: change vote direction if exists)             │
│                                                                  │
│   5. Update cache for immediate feedback:                       │
│      └──▶ INCR post:{id}:score                                  │
│                                                                  │
│   6. Return { success: true, newScore }                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

"Key insight: We insert votes without contention. The votes table is append-only during normal operation."

### ⚙️ Background Worker: Vote Aggregation

```
┌─────────────────────────────────────────────────────────────────┐
│                 Vote Aggregation Worker                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Runs every 30 seconds:                                        │
│                                                                  │
│   1. Find posts with recent votes:                              │
│      SELECT DISTINCT post_id FROM votes                         │
│      WHERE created_at > NOW() - INTERVAL '5 minutes'            │
│                                                                  │
│   2. For each post_id:                                          │
│      ┌─────────────────────────────────────────────────────┐    │
│      │  COUNT(*) FILTER (WHERE direction = 1)  → upvotes   │    │
│      │  COUNT(*) FILTER (WHERE direction = -1) → downvotes │    │
│      │  score = upvotes - downvotes                        │    │
│      └─────────────────────────────────────────────────────┘    │
│                                                                  │
│   3. UPDATE posts SET upvotes, downvotes, score                 │
│                                                                  │
│   4. SET post:{id}:score in Redis with 5min TTL                 │
│                                                                  │
│   5. Repeat for comments                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Comment Tree API (8 minutes)

### 📊 Materialized Path Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                   Comment Tree Structure                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Path encoding:                                                │
│                                                                  │
│   Comment A (root)      path = "k4x2"         depth = 0         │
│       │                                                         │
│       ├── Comment B     path = "k4x2.m9p1"    depth = 1         │
│       │       │                                                 │
│       │       └── Comment D  path = "k4x2.m9p1.n3q7"  depth = 2 │
│       │                                                         │
│       └── Comment C     path = "k4x2.p2w5"    depth = 1         │
│                                                                  │
│   Fetch subtree: WHERE path LIKE 'k4x2.%'                       │
│   Sort by path: Maintains hierarchical order                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🔧 Backend: Fetching Comments

```
┌─────────────────────────────────────────────────────────────────┐
│              GET /posts/:postId/comments                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Sort options (ORDER BY clause):                               │
│   ┌────────────────┬────────────────────────────────────────┐   │
│   │ best           │ score DESC, path                       │   │
│   │ top            │ score DESC, path                       │   │
│   │ new            │ created_at DESC, path                  │   │
│   │ controversial  │ magnitude * (min/max ratio) DESC, path │   │
│   │ old            │ created_at ASC, path                   │   │
│   └────────────────┴────────────────────────────────────────┘   │
│                                                                  │
│   Query joins:                                                  │
│   - users (for author_name)                                     │
│   - votes (for current user's vote)                            │
│                                                                  │
│   Returns flat array sorted by path                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🔧 Backend: Creating Comments

```
┌─────────────────────────────────────────────────────────────────┐
│              POST /posts/:postId/comments                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. Validate content is not empty                              │
│                                                                  │
│   2. If parentId provided:                                      │
│      ┌─────────────────────────────────────────────────────┐    │
│      │  Fetch parent's path and depth                      │    │
│      │  Generate segment: timestamp_base36 + random_chars  │    │
│      │  new_path = parent_path + "." + segment             │    │
│      │  new_depth = parent_depth + 1                       │    │
│      └─────────────────────────────────────────────────────┘    │
│                                                                  │
│   3. Else (top-level comment):                                  │
│      ┌─────────────────────────────────────────────────────┐    │
│      │  path = timestamp_base36 + random_chars             │    │
│      │  depth = 0                                          │    │
│      └─────────────────────────────────────────────────────┘    │
│                                                                  │
│   4. INSERT INTO comments                                       │
│                                                                  │
│   5. UPDATE posts SET comment_count = comment_count + 1         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🖥️ Frontend: Building Tree from Flat Data

```
┌─────────────────────────────────────────────────────────────────┐
│                  buildCommentTree() Utility                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Input: Flat array of comments                                 │
│   Output: Nested tree structure                                 │
│                                                                  │
│   Algorithm:                                                    │
│   1. Create Map<id, CommentWithChildren>                        │
│   2. Initialize each comment with children = []                 │
│   3. For each comment:                                          │
│      - If parentId is null → add to roots                       │
│      - Else → add to parent.children                            │
│      - If parent not found → treat as orphan (root)            │
│                                                                  │
│   Result:                                                       │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  [                                                      │   │
│   │    { id: 1, children: [                                 │   │
│   │      { id: 2, children: [{ id: 4, children: [] }] },    │   │
│   │      { id: 3, children: [] }                            │   │
│   │    ]}                                                   │   │
│   │  ]                                                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Session Management (5 minutes)

### 🔐 Backend: Session Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session Architecture                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐         ┌─────────────┐         ┌──────────┐  │
│   │   Browser   │────────▶│   Express   │────────▶│  Redis   │  │
│   │ (cookie)    │         │ (middleware)│         │ (store)  │  │
│   └─────────────┘         └─────────────┘         └──────────┘  │
│                                                                  │
│   Cookie settings:                                              │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  secure: true (production only)                         │   │
│   │  httpOnly: true (prevents XSS access)                   │   │
│   │  maxAge: 30 days                                        │   │
│   │  sameSite: 'lax' (CSRF protection)                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Session data:                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  userId: number                                         │   │
│   │  username: string                                       │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🔧 Auth Endpoints

```
┌─────────────────────────────────────────────────────────────────┐
│                      Auth API Routes                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   POST /auth/login                                              │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  1. Lookup user by username                             │   │
│   │  2. bcrypt.compare(password, hash)                      │   │
│   │  3. Set req.session.userId and username                 │   │
│   │  4. Return { user: { id, username } }                   │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   POST /auth/logout                                             │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  1. req.session.destroy()                               │   │
│   │  2. res.clearCookie('connect.sid')                      │   │
│   │  3. Return { success: true }                            │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   GET /auth/me                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  1. If !session.userId → { user: null }                 │   │
│   │  2. Fetch user with karma                               │   │
│   │  3. Return { user }                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🖥️ Frontend: Auth Store

```
┌─────────────────────────────────────────────────────────────────┐
│                    Zustand Auth Store                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   State:                                                        │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  user: User | null                                      │   │
│   │  isLoading: boolean (true on init)                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Actions:                                                      │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  checkAuth() ──▶ GET /auth/me on app mount              │   │
│   │  login(u, p)  ──▶ POST /auth/login                      │   │
│   │  logout()     ──▶ POST /auth/logout                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   App initialization:                                           │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  useEffect(() => checkAuth(), [])                       │   │
│   │  if (isLoading) return <LoadingScreen />                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
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

### 🔧 Backend: Consistent Error Responses

```
┌─────────────────────────────────────────────────────────────────┐
│                    Error Response Format                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   { error: { code: "VALIDATION_ERROR", message: "..." } }       │
│                                                                  │
│   AppError class:                                               │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  statusCode: number (400, 401, 403, 404, 500)           │   │
│   │  code: string (machine-readable)                        │   │
│   │  message: string (human-readable)                       │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Error middleware catches all errors and formats response      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 🖥️ Frontend: Error Handling

```
┌─────────────────────────────────────────────────────────────────┐
│                    Axios Interceptor                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Response interceptor:                                         │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  401 ──▶ logout() + redirect to /login                  │   │
│   │  other ──▶ toast.error(message)                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Testing Strategy

### 🧪 Integration Test Example: Voting Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Vote Flow Tests                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Setup:                                                        │
│   1. Login as test user, capture session cookie                 │
│   2. Create a post                                              │
│                                                                  │
│   Test cases:                                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  "should upvote a post"                                 │   │
│   │  → POST /api/vote { type: 'post', id, direction: 1 }    │   │
│   │  → expect status 200, newScore = 1                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  "should change vote direction"                         │   │
│   │  → Upvote first, then downvote                          │   │
│   │  → expect newScore = -1                                 │   │
│   └─────────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  "should remove vote"                                   │   │
│   │  → Upvote first, then direction: 0                      │   │
│   │  → expect newScore = 0                                  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
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
