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
+-----------------------------------------------------------+
|                    Frontend (React)                        |
|  +--------+  +--------+  +--------+  +--------+           |
|  | Profile|  |  Feed  |  | Network|  |  Jobs  |           |
|  +--------+  +--------+  +--------+  +--------+           |
|       |           |           |           |               |
|       +-----+-----+-----+-----+-----+-----+               |
|             |                                              |
|      +-------------+                                       |
|      | API Service |                                       |
|      +-------------+                                       |
+-----------------------------------------------------------+
              |
              v (HTTP/REST)
+-----------------------------------------------------------+
|                    API Gateway                             |
+-----------------------------------------------------------+
              |
    +---------+---------+---------+
    v         v         v         v
+-------+ +-------+ +-------+ +-------+
|Profile| |Graph  | |Feed   | |Jobs   |
|Service| |Service| |Service| |Service|
+-------+ +-------+ +-------+ +-------+
    |         |         |         |
    v         v         v         v
+-----------------------------------------------------------+
|  PostgreSQL  |  Valkey/Redis  |  Elasticsearch            |
|  (Profiles,  |  (Connections, |  (Search,                 |
|   Jobs)      |   PYMK Cache)  |   Indexing)               |
+-----------------------------------------------------------+
```

## Deep Dives

### 1. API Design for Graph Operations

**RESTful Endpoints:**

```typescript
// Connections
GET    /api/v1/connections                    // Get user's connections
GET    /api/v1/connections/:userId/degree     // Get connection degree to user
GET    /api/v1/connections/:userId/mutual     // Get mutual connections
POST   /api/v1/connections/request            // Send connection request
PUT    /api/v1/connections/request/:id/accept // Accept request
DELETE /api/v1/connections/:userId            // Remove connection

// PYMK
GET    /api/v1/pymk                           // Get recommendations
GET    /api/v1/pymk/:userId/score             // Get PYMK score for user

// Feed
GET    /api/v1/feed                           // Get ranked feed
POST   /api/v1/posts                          // Create post
POST   /api/v1/posts/:id/like                 // Like post
POST   /api/v1/posts/:id/comments             // Add comment

// Jobs
GET    /api/v1/jobs                           // List jobs
GET    /api/v1/jobs/recommended               // Get matched jobs
POST   /api/v1/jobs/:id/apply                 // Apply to job
GET    /api/v1/jobs/:id/match-score           // Get match score
```

**Response Shaping for Frontend:**

```typescript
// Connection degree response includes context for UI
interface ConnectionDegreeResponse {
  userId: number;
  degree: 1 | 2 | 3 | null;
  mutualConnections?: {
    count: number;
    sample: User[]; // First 3 for display
  };
  path?: User[]; // How you're connected (for 2nd/3rd degree)
}

// Express route handler
app.get('/api/v1/connections/:userId/degree', requireAuth, async (req, res) => {
  const targetUserId = parseInt(req.params.userId);
  const currentUserId = req.session.userId;

  // Check 1st degree
  const isFirstDegree = await checkConnection(currentUserId, targetUserId);
  if (isFirstDegree) {
    return res.json({ userId: targetUserId, degree: 1 });
  }

  // Check 2nd degree with mutuals
  const mutuals = await getMutualConnections(currentUserId, targetUserId);
  if (mutuals.length > 0) {
    return res.json({
      userId: targetUserId,
      degree: 2,
      mutualConnections: {
        count: mutuals.length,
        sample: mutuals.slice(0, 3),
      },
    });
  }

  // Check 3rd degree
  const path = await findConnectionPath(currentUserId, targetUserId, 3);
  if (path) {
    return res.json({
      userId: targetUserId,
      degree: 3,
      path,
    });
  }

  return res.json({ userId: targetUserId, degree: null });
});
```

### 2. Shared Type Definitions

**Shared Types (types/index.ts):**

```typescript
// Used in both frontend and backend

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  headline?: string;
  summary?: string;
  location?: string;
  industry?: string;
  profileImageUrl?: string;
  bannerImageUrl?: string;
  connectionCount: number;
  role: 'user' | 'recruiter' | 'admin';
  createdAt: string;
}

export interface Experience {
  id: number;
  userId: number;
  companyId?: number;
  companyName: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string;
  description?: string;
  isCurrent: boolean;
}

export interface Skill {
  id: number;
  name: string;
  endorsementCount?: number;
}

export interface Connection {
  userId: number;
  connectedTo: number;
  connectedAt: string;
}

export interface Post {
  id: number;
  userId: number;
  author: User;
  content: string;
  imageUrl?: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  createdAt: string;
}

export interface Job {
  id: number;
  companyId: number;
  company: Company;
  title: string;
  description: string;
  location?: string;
  isRemote: boolean;
  employmentType: 'full-time' | 'part-time' | 'contract' | 'internship';
  experienceLevel: 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive';
  yearsRequired?: number;
  salaryMin?: number;
  salaryMax?: number;
  requiredSkills: Skill[];
  status: 'active' | 'closed' | 'filled';
  createdAt: string;
}

export interface PYMKCandidate {
  user: User;
  score: number;
  mutualCount: number;
  sharedCompanies: string[];
  sharedSchools: string[];
  sharedSkills: string[];
}
```

### 3. Connection Request Flow (Full-Stack)

**Backend Handler:**

```typescript
// POST /api/v1/connections/request
app.post('/api/v1/connections/request', requireAuth, async (req, res) => {
  const { targetUserId, message } = req.body;
  const fromUserId = req.session.userId;

  // Validate not already connected
  const existing = await checkConnection(fromUserId, targetUserId);
  if (existing) {
    return res.status(400).json({ error: 'Already connected' });
  }

  // Check for existing pending request
  const pendingRequest = await getPendingRequest(fromUserId, targetUserId);
  if (pendingRequest) {
    return res.status(400).json({ error: 'Request already pending' });
  }

  // Create request
  const request = await pool.query(
    `INSERT INTO connection_requests (from_user_id, to_user_id, message, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id, from_user_id, to_user_id, message, status, created_at`,
    [fromUserId, targetUserId, message]
  );

  // Queue notification
  await rabbitmq.publish('notifications', {
    type: 'connection_request',
    userId: targetUserId,
    fromUserId,
    requestId: request.rows[0].id,
  });

  // Audit log
  await auditLog('connection.request.sent', fromUserId, 'user', targetUserId);

  res.status(201).json(request.rows[0]);
});
```

**Frontend Component:**

```tsx
function ConnectButton({ targetUser }: { targetUser: User }) {
  const { user } = useAuthStore();
  const [connectionStatus, setConnectionStatus] = useState<
    'none' | 'pending' | 'connected' | 'loading'
  >('none');

  useEffect(() => {
    async function checkStatus() {
      const degree = await connectionsApi.getConnectionDegree(targetUser.id);
      if (degree.degree === 1) {
        setConnectionStatus('connected');
      } else {
        const pending = await connectionsApi.getPendingRequest(targetUser.id);
        setConnectionStatus(pending ? 'pending' : 'none');
      }
    }
    checkStatus();
  }, [targetUser.id]);

  const handleConnect = async () => {
    setConnectionStatus('loading');
    try {
      await connectionsApi.sendRequest(targetUser.id);
      setConnectionStatus('pending');
    } catch (error) {
      setConnectionStatus('none');
      console.error('Failed to send connection request:', error);
    }
  };

  if (connectionStatus === 'connected') {
    return (
      <span className="px-4 py-2 text-gray-500">
        <Check className="inline w-4 h-4 mr-1" />
        Connected
      </span>
    );
  }

  if (connectionStatus === 'pending') {
    return (
      <span className="px-4 py-2 text-gray-500">
        <Clock className="inline w-4 h-4 mr-1" />
        Pending
      </span>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connectionStatus === 'loading'}
      className="px-4 py-2 bg-linkedin-blue text-white rounded-full hover:bg-linkedin-dark disabled:opacity-50"
    >
      {connectionStatus === 'loading' ? 'Connecting...' : 'Connect'}
    </button>
  );
}
```

### 4. PYMK Integration

**Backend - PYMK Scoring:**

```typescript
// GET /api/v1/pymk
app.get('/api/v1/pymk', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const limit = parseInt(req.query.limit as string) || 20;

  // Try cache first
  const cached = await valkey.get(`pymk:${userId}`);
  if (cached) {
    const candidates = JSON.parse(cached).slice(0, limit);
    return res.json(candidates);
  }

  // Compute PYMK (fallback if cache miss)
  const secondDegree = await getSecondDegreeConnections(userId);
  const scored: PYMKCandidate[] = [];

  for (const candidate of secondDegree) {
    const score = await computePYMKScore(userId, candidate.userId);
    scored.push({
      user: candidate,
      score: score.total,
      mutualCount: score.mutualCount,
      sharedCompanies: score.sharedCompanies,
      sharedSchools: score.sharedSchools,
      sharedSkills: score.sharedSkills,
    });
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, 100);

  // Cache for 1 hour
  await valkey.setex(`pymk:${userId}`, 3600, JSON.stringify(topCandidates));

  res.json(topCandidates.slice(0, limit));
});

async function computePYMKScore(userId: number, candidateId: number) {
  const [mutuals, companies, schools, skills] = await Promise.all([
    getMutualConnections(userId, candidateId),
    getSharedCompanies(userId, candidateId),
    getSharedSchools(userId, candidateId),
    getSharedSkills(userId, candidateId),
  ]);

  return {
    total:
      mutuals.length * 10 +
      companies.current * 8 +
      companies.past * 5 +
      schools.length * 5 +
      skills.length * 2,
    mutualCount: mutuals.length,
    sharedCompanies: companies.names,
    sharedSchools: schools.map((s) => s.name),
    sharedSkills: skills.map((s) => s.name),
  };
}
```

**Frontend - PYMK Display:**

```tsx
function PYMKSection() {
  const [candidates, setCandidates] = useState<PYMKCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPYMK() {
      try {
        const data = await pymkApi.getRecommendations(20);
        setCandidates(data);
      } catch (error) {
        console.error('Failed to load PYMK:', error);
      } finally {
        setLoading(false);
      }
    }
    loadPYMK();
  }, []);

  const handleConnect = async (candidateId: number) => {
    try {
      await connectionsApi.sendRequest(candidateId);
      setCandidates((prev) =>
        prev.filter((c) => c.user.id !== candidateId)
      );
    } catch (error) {
      console.error('Failed to send request:', error);
    }
  };

  if (loading) {
    return <PYMKSkeleton />;
  }

  return (
    <section className="bg-white rounded-lg shadow p-4">
      <h2 className="text-lg font-semibold mb-4">People you may know</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {candidates.map((candidate) => (
          <PYMKCard
            key={candidate.user.id}
            candidate={candidate}
            onConnect={() => handleConnect(candidate.user.id)}
          />
        ))}
      </div>
    </section>
  );
}

function PYMKCard({
  candidate,
  onConnect,
}: {
  candidate: PYMKCandidate;
  onConnect: () => void;
}) {
  const { user, mutualCount, sharedCompanies, sharedSchools } = candidate;

  // Determine the best "reason" to show
  const reason =
    mutualCount > 0
      ? `${mutualCount} mutual connections`
      : sharedCompanies.length > 0
      ? `Worked at ${sharedCompanies[0]}`
      : sharedSchools.length > 0
      ? `Attended ${sharedSchools[0]}`
      : null;

  return (
    <div className="border rounded-lg p-4 text-center">
      <Link to={`/profile/${user.id}`}>
        <img
          src={user.profileImageUrl || '/default-avatar.png'}
          alt=""
          className="w-16 h-16 rounded-full mx-auto mb-2"
        />
        <h3 className="font-medium hover:underline">
          {user.firstName} {user.lastName}
        </h3>
      </Link>
      <p className="text-sm text-gray-600 mb-2 line-clamp-2">
        {user.headline}
      </p>
      {reason && (
        <p className="text-xs text-gray-500 mb-3">{reason}</p>
      )}
      <button
        onClick={onConnect}
        className="w-full py-2 border border-linkedin-blue text-linkedin-blue rounded-full hover:bg-linkedin-light"
      >
        Connect
      </button>
    </div>
  );
}
```

### 5. Feed Ranking Integration

**Backend - Feed Generation:**

```typescript
// GET /api/v1/feed
app.get('/api/v1/feed', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const offset = parseInt(req.query.offset as string) || 0;
  const limit = parseInt(req.query.limit as string) || 20;

  // Get connections
  const connections = await getConnectionIds(userId);

  // Query posts with ranking
  const result = await pool.query(
    `WITH user_connections AS (
      SELECT connected_to AS conn_id FROM connections WHERE user_id = $1
      UNION
      SELECT user_id AS conn_id FROM connections WHERE connected_to = $1
    )
    SELECT
      p.*,
      u.first_name, u.last_name, u.headline, u.profile_image_url,
      -- Ranking score
      (
        p.like_count * 0.3 +
        p.comment_count * 0.5 +
        CASE WHEN p.user_id IN (SELECT conn_id FROM user_connections) THEN 15 ELSE 0 END +
        (1.0 / (1 + EXTRACT(EPOCH FROM NOW() - p.created_at) / 3600)) * 10
      ) AS rank_score
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.user_id IN (SELECT conn_id FROM user_connections)
       OR p.user_id = $1
    ORDER BY rank_score DESC
    LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  // Format response with author info
  const posts = result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    imageUrl: row.image_url,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    shareCount: row.share_count,
    createdAt: row.created_at,
    author: {
      id: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      headline: row.headline,
      profileImageUrl: row.profile_image_url,
    },
  }));

  res.json({ posts, hasMore: posts.length === limit });
});
```

**Frontend - Infinite Scroll Feed:**

```tsx
function FeedPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const loadPosts = useCallback(async (offset: number) => {
    const isInitial = offset === 0;
    if (isInitial) setLoading(true);
    else setLoadingMore(true);

    try {
      const data = await feedApi.getFeed(offset, 20);
      setPosts((prev) => (isInitial ? data.posts : [...prev, ...data.posts]));
      setHasMore(data.hasMore);
    } catch (error) {
      console.error('Failed to load feed:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadPosts(0);
  }, [loadPosts]);

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || loadingMore) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadPosts(posts.length);
        }
      },
      { threshold: 0.5 }
    );

    if (loadMoreRef.current) {
      observerRef.current.observe(loadMoreRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [hasMore, loadingMore, posts.length, loadPosts]);

  const handleLike = async (postId: number) => {
    // Optimistic update
    setPosts((prev) =>
      prev.map((post) =>
        post.id === postId
          ? { ...post, likeCount: post.likeCount + 1 }
          : post
      )
    );

    try {
      await feedApi.likePost(postId);
    } catch (error) {
      // Rollback on error
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId
            ? { ...post, likeCount: post.likeCount - 1 }
            : post
        )
      );
      console.error('Failed to like post:', error);
    }
  };

  if (loading) {
    return <FeedSkeleton />;
  }

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 space-y-4">
      <CreatePostCard onPostCreated={(post) => setPosts([post, ...posts])} />

      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onLike={() => handleLike(post.id)}
        />
      ))}

      {/* Infinite scroll trigger */}
      <div ref={loadMoreRef} className="h-10 flex items-center justify-center">
        {loadingMore && <Spinner />}
      </div>
    </div>
  );
}
```

### 6. Job Matching Integration

**Backend - Job Match Score:**

```typescript
// GET /api/v1/jobs/:id/match-score
app.get('/api/v1/jobs/:id/match-score', requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.id);
  const userId = req.session.userId;

  const [job, user] = await Promise.all([
    getJobWithSkills(jobId),
    getUserWithDetails(userId),
  ]);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Calculate match score
  const userSkillIds = new Set(user.skills.map((s) => s.id));
  const requiredSkills = job.skills.filter((s) => s.isRequired);
  const matchedSkills = requiredSkills.filter((s) => userSkillIds.has(s.skillId));

  const skillScore = (matchedSkills.length / requiredSkills.length) * 40;

  const expDiff = Math.abs((job.yearsRequired || 0) - (user.yearsExperience || 0));
  const expScore = Math.max(0, 25 - expDiff * 5);

  const locationScore =
    job.isRemote || user.location === job.location ? 15 : 0;

  const connectionScore = (await hasConnectionAtCompany(userId, job.companyId))
    ? 10
    : 0;

  const total = skillScore + expScore + locationScore + connectionScore;

  res.json({
    jobId,
    matchScore: Math.round(total),
    breakdown: {
      skills: {
        score: Math.round(skillScore),
        matched: matchedSkills.map((s) => s.skillName),
        missing: requiredSkills
          .filter((s) => !userSkillIds.has(s.skillId))
          .map((s) => s.skillName),
      },
      experience: { score: Math.round(expScore) },
      location: { score: locationScore },
      network: { score: connectionScore },
    },
  });
});
```

**Frontend - Job Card with Match Score:**

```tsx
function JobCard({ job }: { job: Job }) {
  const [matchScore, setMatchScore] = useState<JobMatchScore | null>(null);

  useEffect(() => {
    async function loadMatchScore() {
      try {
        const score = await jobsApi.getMatchScore(job.id);
        setMatchScore(score);
      } catch (error) {
        console.error('Failed to load match score:', error);
      }
    }
    loadMatchScore();
  }, [job.id]);

  return (
    <article className="bg-white rounded-lg shadow p-4">
      <div className="flex gap-4">
        <img
          src={job.company.logoUrl || '/default-company.png'}
          alt=""
          className="w-16 h-16 rounded"
        />
        <div className="flex-1">
          <Link
            to={`/jobs/${job.id}`}
            className="text-lg font-semibold text-linkedin-blue hover:underline"
          >
            {job.title}
          </Link>
          <p className="text-gray-600">{job.company.name}</p>
          <p className="text-sm text-gray-500">
            {job.location} {job.isRemote && '(Remote)'}
          </p>
        </div>

        {/* Match score badge */}
        {matchScore && (
          <div className="text-right">
            <div
              className={`text-2xl font-bold ${
                matchScore.matchScore >= 70
                  ? 'text-green-600'
                  : matchScore.matchScore >= 40
                  ? 'text-yellow-600'
                  : 'text-gray-400'
              }`}
            >
              {matchScore.matchScore}%
            </div>
            <div className="text-xs text-gray-500">match</div>
          </div>
        )}
      </div>

      {/* Skills match breakdown */}
      {matchScore && matchScore.breakdown.skills.matched.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {matchScore.breakdown.skills.matched.map((skill) => (
            <span
              key={skill}
              className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded"
            >
              {skill}
            </span>
          ))}
          {matchScore.breakdown.skills.missing.slice(0, 2).map((skill) => (
            <span
              key={skill}
              className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded"
            >
              {skill}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-between items-center">
        <span className="text-sm text-gray-500">
          Posted {formatDistanceToNow(new Date(job.createdAt))} ago
        </span>
        <Link
          to={`/jobs/${job.id}`}
          className="px-4 py-2 bg-linkedin-blue text-white rounded-full hover:bg-linkedin-dark"
        >
          Apply
        </Link>
      </div>
    </article>
  );
}
```

### 7. Session Management

**Backend Middleware:**

```typescript
// Session configuration
app.use(
  session({
    store: new (connectPgSimple(session))({ pool }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Login endpoint
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await getUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await auditLog('auth.login.failed', null, 'user', null, { email });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.role = user.role;

  await auditLog('auth.login.success', user.id, 'session', null);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      headline: user.headline,
      profileImageUrl: user.profileImageUrl,
      role: user.role,
    },
  });
});

// Session check
app.get('/api/v1/auth/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'User not found' });
  }
  res.json({ user });
});
```

**Frontend Auth Store:**

```typescript
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  checkSession: async () => {
    try {
      const response = await api.get('/auth/me');
      set({
        user: response.data.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  login: async (email, password) => {
    const response = await api.post('/auth/login', { email, password });
    set({ user: response.data.user, isAuthenticated: true });
  },

  logout: async () => {
    await api.post('/auth/logout');
    set({ user: null, isAuthenticated: false });
  },
}));

// Root layout checks session on mount
function RootLayout() {
  const { checkSession, isLoading } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  if (isLoading) {
    return <FullPageSpinner />;
  }

  return <Outlet />;
}
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
