# LinkedIn - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design LinkedIn, a professional social network where users build career profiles, connect with colleagues, and discover job opportunities. The full-stack challenge involves building an integrated system where the frontend efficiently consumes graph-based APIs for connection recommendations (PYMK), job matching, and algorithmic feed ranking.

## Requirements Clarification

### Functional Requirements
- **Profiles**: Rich professional profiles with experience, education, skills
- **Connections**: Send/accept requests, view network by degree
- **PYMK**: "People You May Know" recommendations
- **Feed**: Posts from connections with ranking
- **Jobs**: Job listings with candidate matching
- **Search**: Global search across people, companies, jobs

### Non-Functional Requirements
- **Latency**: < 200ms for feed, < 500ms for PYMK
- **Scale**: 900M users, 100B+ connections
- **Consistency**: Strong for connections, eventual for feed
- **Availability**: 99.9% uptime

### Full-Stack Concerns
- Efficient API design for graph data
- Optimistic updates for social actions
- Real-time feedback for connection requests
- Shared type definitions between frontend and backend

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                      │
│  │ Profile │  │  Feed   │  │ Network │  │  Jobs   │                      │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘                      │
│       │            │            │            │                            │
│       └────────────┼────────────┼────────────┘                            │
│                    │                                                       │
│               ┌────┴────┐                                                  │
│               │   API   │                                                  │
│               │ Service │                                                  │
│               └────┬────┘                                                  │
└────────────────────┼───────────────────────────────────────────────────────┘
                     │ HTTP/REST
                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         API Gateway                                        │
└────────────────────┬───────────────────────────────────────────────────────┘
                     │
      ┌──────────────┼──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Profile  │  │  Graph   │  │   Feed   │  │   Jobs   │
│ Service  │  │ Service  │  │ Service  │  │ Service  │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │             │
     └─────────────┼─────────────┼─────────────┘
                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL        │  Valkey/Redis       │  Elasticsearch                 │
│  (Profiles, Jobs)  │  (Connections,      │  (Search, Indexing)            │
│                    │   PYMK Cache)       │                                │
└───────────────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. API Design for Graph Operations

**RESTful Endpoints:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Connection APIs                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  GET    /api/v1/connections              ──▶ Get user's connections       │
│  GET    /api/v1/connections/:userId/degree ──▶ Get connection degree      │
│  GET    /api/v1/connections/:userId/mutual ──▶ Get mutual connections     │
│  POST   /api/v1/connections/request      ──▶ Send connection request      │
│  PUT    /api/v1/connections/request/:id/accept ──▶ Accept request         │
│  DELETE /api/v1/connections/:userId      ──▶ Remove connection            │
├───────────────────────────────────────────────────────────────────────────┤
│                         PYMK APIs                                          │
├───────────────────────────────────────────────────────────────────────────┤
│  GET    /api/v1/pymk                     ──▶ Get recommendations          │
│  GET    /api/v1/pymk/:userId/score       ──▶ Get PYMK score for user      │
├───────────────────────────────────────────────────────────────────────────┤
│                         Feed APIs                                          │
├───────────────────────────────────────────────────────────────────────────┤
│  GET    /api/v1/feed                     ──▶ Get ranked feed              │
│  POST   /api/v1/posts                    ──▶ Create post                  │
│  POST   /api/v1/posts/:id/like           ──▶ Like post                    │
│  POST   /api/v1/posts/:id/comments       ──▶ Add comment                  │
├───────────────────────────────────────────────────────────────────────────┤
│                         Jobs APIs                                          │
├───────────────────────────────────────────────────────────────────────────┤
│  GET    /api/v1/jobs                     ──▶ List jobs                    │
│  GET    /api/v1/jobs/recommended         ──▶ Get matched jobs             │
│  POST   /api/v1/jobs/:id/apply           ──▶ Apply to job                 │
│  GET    /api/v1/jobs/:id/match-score     ──▶ Get match score              │
└───────────────────────────────────────────────────────────────────────────┘
```

**Response Shaping for Frontend:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│              ConnectionDegreeResponse Structure                            │
├───────────────────────────────────────────────────────────────────────────┤
│  {                                                                         │
│    userId: number,                                                         │
│    degree: 1 | 2 | 3 | null,                                               │
│    mutualConnections?: {                                                   │
│      count: number,                                                        │
│      sample: User[]   ──▶ First 3 for UI display                          │
│    },                                                                      │
│    path?: User[]      ──▶ Connection path for 2nd/3rd degree              │
│  }                                                                         │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│              Connection Degree Handler Flow                                │
├───────────────────────────────────────────────────────────────────────────┤
│  1. Check 1st degree (direct connection)                                   │
│     └── If connected ──▶ return { degree: 1 }                              │
│                                                                            │
│  2. Check 2nd degree (get mutuals)                                         │
│     └── If mutuals exist ──▶ return { degree: 2, mutualConnections }       │
│                                                                            │
│  3. Check 3rd degree (find path with max depth 3)                          │
│     └── If path found ──▶ return { degree: 3, path }                       │
│                                                                            │
│  4. No connection found ──▶ return { degree: null }                        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2. Shared Type Definitions

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    Shared Types (Frontend + Backend)                       │
├───────────────────────────────────────────────────────────────────────────┤
│  User                                                                      │
│  ├── id, email, firstName, lastName                                        │
│  ├── headline?, summary?, location?, industry?                             │
│  ├── profileImageUrl?, bannerImageUrl?                                     │
│  ├── connectionCount                                                       │
│  ├── role: 'user' | 'recruiter' | 'admin'                                  │
│  └── createdAt                                                             │
├───────────────────────────────────────────────────────────────────────────┤
│  Experience                                                                │
│  ├── id, userId, companyId?, companyName                                   │
│  ├── title, location?, startDate, endDate?                                 │
│  ├── description?, isCurrent                                               │
├───────────────────────────────────────────────────────────────────────────┤
│  Skill                                                                     │
│  ├── id, name, endorsementCount?                                           │
├───────────────────────────────────────────────────────────────────────────┤
│  Post                                                                      │
│  ├── id, userId, author: User, content, imageUrl?                          │
│  ├── likeCount, commentCount, shareCount, createdAt                        │
├───────────────────────────────────────────────────────────────────────────┤
│  Job                                                                       │
│  ├── id, companyId, company: Company, title, description                   │
│  ├── location?, isRemote, employmentType, experienceLevel                  │
│  ├── yearsRequired?, salaryMin?, salaryMax?                                │
│  ├── requiredSkills: Skill[], status, createdAt                            │
├───────────────────────────────────────────────────────────────────────────┤
│  PYMKCandidate                                                             │
│  ├── user: User, score, mutualCount                                        │
│  ├── sharedCompanies: string[]                                             │
│  ├── sharedSchools: string[]                                               │
│  └── sharedSkills: string[]                                                │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3. Connection Request Flow (Full-Stack)

**Backend Handler:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│              POST /api/v1/connections/request                              │
├───────────────────────────────────────────────────────────────────────────┤
│  INPUT: { targetUserId, message? }                                         │
├───────────────────────────────────────────────────────────────────────────┤
│  VALIDATIONS                                                               │
│  ├── Check not already connected ──▶ 400 "Already connected"              │
│  └── Check no pending request ──▶ 400 "Request already pending"           │
├───────────────────────────────────────────────────────────────────────────┤
│  ACTIONS                                                                   │
│  1. INSERT INTO connection_requests                                        │
│     (from_user_id, to_user_id, message, status='pending')                  │
│                                                                            │
│  2. Queue notification via RabbitMQ                                        │
│     { type: 'connection_request', userId: targetUserId, ... }              │
│                                                                            │
│  3. Audit log: 'connection.request.sent'                                   │
├───────────────────────────────────────────────────────────────────────────┤
│  RESPONSE: 201 with created request                                        │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend Component:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      ConnectButton Component                               │
├───────────────────────────────────────────────────────────────────────────┤
│  STATE: connectionStatus: 'none' | 'pending' | 'connected' | 'loading'    │
├───────────────────────────────────────────────────────────────────────────┤
│  ON MOUNT (useEffect)                                                      │
│  ├── Get connection degree                                                 │
│  │   └── degree === 1 ──▶ setConnectionStatus('connected')                 │
│  └── Check pending request                                                 │
│      └── pending exists ──▶ setConnectionStatus('pending')                 │
├───────────────────────────────────────────────────────────────────────────┤
│  RENDER                                                                    │
│                                                                            │
│  connectionStatus === 'connected':                                         │
│  ├── [Check icon] "Connected" (gray text)                                  │
│                                                                            │
│  connectionStatus === 'pending':                                           │
│  ├── [Clock icon] "Pending" (gray text)                                    │
│                                                                            │
│  connectionStatus === 'none' or 'loading':                                 │
│  └── [Connect] button (blue, LinkedIn style)                               │
│      └── onClick ──▶ optimistic 'loading' ──▶ API call                     │
│          ├── Success: setConnectionStatus('pending')                       │
│          └── Failure: setConnectionStatus('none')                          │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4. PYMK Integration

**Backend - PYMK Scoring:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   GET /api/v1/pymk Handler                                 │
├───────────────────────────────────────────────────────────────────────────┤
│  1. Try cache first                                                        │
│     └── valkey.get(`pymk:${userId}`) ──▶ if hit, return top N              │
│                                                                            │
│  2. Cache miss: compute PYMK                                               │
│     ├── Get 2nd-degree connections                                         │
│     ├── For each candidate: computePYMKScore()                             │
│     ├── Sort by score descending                                           │
│     └── Take top 100                                                       │
│                                                                            │
│  3. Cache for 1 hour                                                       │
│     └── valkey.setex(`pymk:${userId}`, 3600, JSON.stringify(candidates))   │
│                                                                            │
│  4. Return top N (from query.limit, default 20)                            │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                   computePYMKScore Algorithm                               │
├───────────────────────────────────────────────────────────────────────────┤
│  Parallel fetch:                                                           │
│  ├── getMutualConnections(userId, candidateId)                             │
│  ├── getSharedCompanies(userId, candidateId)                               │
│  ├── getSharedSchools(userId, candidateId)                                 │
│  └── getSharedSkills(userId, candidateId)                                  │
├───────────────────────────────────────────────────────────────────────────┤
│  SCORING WEIGHTS                                                           │
│  ├── Mutual connections: 10 points each                                    │
│  ├── Same current company: 8 points                                        │
│  ├── Same past company: 5 points                                           │
│  ├── Same school: 5 points each                                            │
│  └── Shared skills: 2 points each                                          │
├───────────────────────────────────────────────────────────────────────────┤
│  RETURN                                                                    │
│  {                                                                         │
│    total: sum of all weighted scores,                                      │
│    mutualCount, sharedCompanies[], sharedSchools[], sharedSkills[]        │
│  }                                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend - PYMK Display:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                       PYMKSection Component                                │
├───────────────────────────────────────────────────────────────────────────┤
│  STATE                                                                     │
│  ├── candidates: PYMKCandidate[]                                           │
│  └── loading: boolean                                                      │
├───────────────────────────────────────────────────────────────────────────┤
│  ON MOUNT                                                                  │
│  └── pymkApi.getRecommendations(20) ──▶ setCandidates                      │
├───────────────────────────────────────────────────────────────────────────┤
│  handleConnect(candidateId)                                                │
│  ├── connectionsApi.sendRequest(candidateId)                               │
│  └── Remove candidate from list (optimistic removal)                       │
├───────────────────────────────────────────────────────────────────────────┤
│  RENDER                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  "People you may know"                                               │  │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐           │  │
│  │  │  ┌──────────┐  │ │  ┌──────────┐  │ │  ┌──────────┐  │           │  │
│  │  │  │  Avatar  │  │ │  │  Avatar  │  │ │  │  Avatar  │  │           │  │
│  │  │  └──────────┘  │ │  └──────────┘  │ │  └──────────┘  │           │  │
│  │  │  Name          │ │  Name          │ │  Name          │           │  │
│  │  │  Headline      │ │  Headline      │ │  Headline      │           │  │
│  │  │  "X mutual"    │ │  "Worked at X" │ │  "Attended X"  │           │  │
│  │  │  [Connect]     │ │  [Connect]     │ │  [Connect]     │           │  │
│  │  └────────────────┘ └────────────────┘ └────────────────┘           │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                       PYMKCard "Reason" Logic                              │
├───────────────────────────────────────────────────────────────────────────┤
│  Priority order for display reason:                                        │
│  1. mutualCount > 0 ──▶ "X mutual connections"                             │
│  2. sharedCompanies.length > 0 ──▶ "Worked at [first company]"             │
│  3. sharedSchools.length > 0 ──▶ "Attended [first school]"                 │
│  4. None of above ──▶ no reason displayed                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5. Feed Ranking Integration

**Backend - Feed Generation:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   GET /api/v1/feed Handler                                 │
├───────────────────────────────────────────────────────────────────────────┤
│  QUERY PARAMS: offset (default 0), limit (default 20)                      │
├───────────────────────────────────────────────────────────────────────────┤
│  SQL QUERY (with CTE for connections)                                      │
│                                                                            │
│  WITH user_connections AS (                                                │
│    SELECT connected_to AS conn_id FROM connections WHERE user_id = $1      │
│    UNION                                                                   │
│    SELECT user_id AS conn_id FROM connections WHERE connected_to = $1      │
│  )                                                                         │
│  SELECT p.*, u.first_name, u.last_name, ...                                │
│                                                                            │
│  RANKING FORMULA:                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  rank_score =                                                        │  │
│  │    like_count * 0.3                    (engagement)                  │  │
│  │  + comment_count * 0.5                 (engagement)                  │  │
│  │  + (is_connection ? 15 : 0)            (relationship boost)          │  │
│  │  + (1 / (1 + hours_since_post)) * 10   (recency decay)               │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  WHERE: posts from connections OR own posts                                │
│  ORDER BY: rank_score DESC                                                 │
│  LIMIT: $limit OFFSET: $offset                                             │
├───────────────────────────────────────────────────────────────────────────┤
│  RESPONSE: { posts: Post[], hasMore: boolean }                             │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend - Infinite Scroll Feed:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                       FeedPage Component                                   │
├───────────────────────────────────────────────────────────────────────────┤
│  STATE                                                                     │
│  ├── posts: Post[]                                                         │
│  ├── loading: boolean (initial load)                                       │
│  ├── loadingMore: boolean (infinite scroll)                                │
│  └── hasMore: boolean                                                      │
├───────────────────────────────────────────────────────────────────────────┤
│  INFINITE SCROLL (IntersectionObserver)                                    │
│  ├── observerRef watches loadMoreRef element                               │
│  ├── When visible & hasMore & !loadingMore ──▶ loadPosts(posts.length)    │
│  └── Cleanup: observerRef.disconnect()                                     │
├───────────────────────────────────────────────────────────────────────────┤
│  handleLike (optimistic update)                                            │
│  1. Immediate UI: increment likeCount                                      │
│  2. API call: feedApi.likePost(postId)                                     │
│  3. On error: decrement likeCount (rollback)                               │
├───────────────────────────────────────────────────────────────────────────┤
│  RENDER                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  <CreatePostCard onPostCreated={(post) => prepend to posts} />       │  │
│  │                                                                       │  │
│  │  posts.map((post) => <PostCard post={post} onLike={handleLike} />)   │  │
│  │                                                                       │  │
│  │  <div ref={loadMoreRef}>                                              │  │
│  │    {loadingMore && <Spinner />}                                       │  │
│  │  </div>                                                               │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6. Job Matching Integration

**Backend - Job Match Score:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│              GET /api/v1/jobs/:id/match-score Handler                      │
├───────────────────────────────────────────────────────────────────────────┤
│  Parallel fetch: [job with skills, user with details]                      │
├───────────────────────────────────────────────────────────────────────────┤
│  SCORING BREAKDOWN                                                         │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ SKILL SCORE (max 40 points)                                         │   │
│  │ (matchedSkills.length / requiredSkills.length) * 40                 │   │
│  │                                                                      │   │
│  │ EXPERIENCE SCORE (max 25 points)                                    │   │
│  │ 25 - (abs(job.yearsRequired - user.yearsExperience) * 5)            │   │
│  │                                                                      │   │
│  │ LOCATION SCORE (15 points)                                          │   │
│  │ job.isRemote || user.location === job.location ? 15 : 0             │   │
│  │                                                                      │   │
│  │ NETWORK SCORE (10 points)                                           │   │
│  │ hasConnectionAtCompany(userId, job.companyId) ? 10 : 0              │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  total = skillScore + expScore + locationScore + networkScore             │
├───────────────────────────────────────────────────────────────────────────┤
│  RESPONSE                                                                  │
│  {                                                                         │
│    jobId,                                                                  │
│    matchScore: Math.round(total),                                          │
│    breakdown: {                                                            │
│      skills: { score, matched[], missing[] },                              │
│      experience: { score },                                                │
│      location: { score },                                                  │
│      network: { score }                                                    │
│    }                                                                       │
│  }                                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend - Job Card with Match Score:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                       JobCard Component                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  STATE: matchScore: JobMatchScore | null                                   │
│  ON MOUNT: jobsApi.getMatchScore(job.id) ──▶ setMatchScore                │
├───────────────────────────────────────────────────────────────────────────┤
│  RENDER                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  ┌───────┐  Job Title (LinkedIn blue, link)     ┌────────────────┐  │  │
│  │  │ Logo  │  Company Name                        │  75%           │  │  │
│  │  │       │  Location (Remote)                   │  match         │  │  │
│  │  └───────┘                                      │  (color coded) │  │  │
│  │                                                  └────────────────┘  │  │
│  │  Skills: [React] [TypeScript] [Node.js] [GraphQL]                   │  │
│  │          ^^^^^^^^ green ^^^^^^^^         ^^^ gray ^^^                │  │
│  │          (matched)                       (missing)                   │  │
│  │                                                                       │  │
│  │  Posted 3 days ago                              [Apply]              │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Match score colors:                                                       │
│  ├── >= 70: text-green-600                                                 │
│  ├── >= 40: text-yellow-600                                                │
│  └── < 40:  text-gray-400                                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 7. Session Management

**Backend Middleware:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    Session Configuration                                   │
├───────────────────────────────────────────────────────────────────────────┤
│  express-session with connect-pg-simple                                    │
│                                                                            │
│  Cookie settings:                                                          │
│  ├── secure: true (production)                                             │
│  ├── httpOnly: true                                                        │
│  ├── sameSite: 'strict'                                                    │
│  └── maxAge: 7 days                                                        │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                    requireAuth Middleware                                  │
├───────────────────────────────────────────────────────────────────────────┤
│  if (!req.session.userId) ──▶ 401 Unauthorized                             │
│  else ──▶ next()                                                           │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                    POST /api/v1/auth/login                                 │
├───────────────────────────────────────────────────────────────────────────┤
│  1. Get user by email                                                      │
│  2. Verify password with bcrypt.compare                                    │
│  3. Failed ──▶ auditLog + 401 Invalid credentials                          │
│  4. Success:                                                               │
│     ├── Set session: userId, email, role                                   │
│     ├── auditLog('auth.login.success')                                     │
│     └── Return user object (no password hash)                              │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                    GET /api/v1/auth/me                                     │
├───────────────────────────────────────────────────────────────────────────┤
│  1. requireAuth middleware                                                 │
│  2. Get user by session.userId                                             │
│  3. If user not found ──▶ destroy session, 401                             │
│  4. Return user object                                                     │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend Auth Store:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    useAuthStore (Zustand)                                  │
├───────────────────────────────────────────────────────────────────────────┤
│  STATE                                                                     │
│  ├── user: User | null                                                     │
│  ├── isAuthenticated: boolean                                              │
│  └── isLoading: boolean (default: true)                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  ACTIONS                                                                   │
│                                                                            │
│  checkSession:                                                             │
│  ├── api.get('/auth/me')                                                   │
│  ├── Success ──▶ set user, isAuthenticated=true, isLoading=false           │
│  └── Error ──▶ set user=null, isAuthenticated=false, isLoading=false       │
│                                                                            │
│  login(email, password):                                                   │
│  ├── api.post('/auth/login', { email, password })                          │
│  └── set user, isAuthenticated=true                                        │
│                                                                            │
│  logout:                                                                   │
│  ├── api.post('/auth/logout')                                              │
│  └── set user=null, isAuthenticated=false                                  │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                    RootLayout Component                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  ON MOUNT                                                                  │
│  └── checkSession()                                                        │
│                                                                            │
│  RENDER                                                                    │
│  ├── isLoading ──▶ <FullPageSpinner />                                     │
│  └── else ──▶ <Outlet />                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| API style | REST | GraphQL | Simpler for defined queries, GraphQL adds complexity |
| Session storage | PostgreSQL | Redis/Valkey | One less service, sufficient for scale |
| State management | Zustand | Redux | Simpler API, less boilerplate |
| Type sharing | Shared types file | Code generation | Manual is sufficient for project size |
| Feed loading | Infinite scroll | Pagination | Better UX for social content |
| Match scoring | Real-time compute | Precomputed | Scores update as user adds skills |
| PYMK caching | 1-hour TTL | Real-time | Balance freshness vs. performance |

## Future Enhancements

1. **WebSocket for real-time**: Live notifications for connection requests and post engagement
2. **GraphQL API**: Consider for complex nested queries (profile + connections + posts)
3. **Optimistic UI everywhere**: Immediate feedback for all social actions
4. **Service worker**: Offline profile viewing and post drafts
5. **Type generation**: Auto-generate frontend types from OpenAPI spec
6. **A/B testing framework**: Tune PYMK weights and feed ranking
7. **Analytics pipeline**: Track feature engagement for optimization
8. **Rate limiting feedback**: Show users when they're approaching limits
