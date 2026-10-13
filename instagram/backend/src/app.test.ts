/**
 * Unit tests for the Instagram backend API.
 * Uses vitest with mocked shared modules (db, redis, storage, queue, cassandra).
 * @module app.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ============================================
// Mock all shared modules BEFORE importing app
// ============================================

// Mock config
// Mock bcryptjs to avoid slow hashing in tests
vi.mock('bcryptjs', () => {
  const mockModule = {
    hash: vi.fn().mockResolvedValue('$2a$12$mockedhashvalue'),
    compare: vi.fn().mockResolvedValue(true),
    hashSync: vi.fn().mockReturnValue('$2a$12$mockedhashvalue'),
    compareSync: vi.fn().mockReturnValue(true),
    genSalt: vi.fn().mockResolvedValue('$2a$12$salt'),
    genSaltSync: vi.fn().mockReturnValue('$2a$12$salt'),
    getRounds: vi.fn().mockReturnValue(12),
  };
  return {
    ...mockModule,
    default: mockModule,
  };
});

// Mock config
vi.mock('./config/index.js', () => ({
  default: {
    port: 3000,
    nodeEnv: 'test',
    database: {
      host: 'localhost',
      port: 5432,
      database: 'instagram_test',
      user: 'test',
      password: 'test',
    },
    redis: {
      url: 'redis://localhost:6379',
      host: 'localhost',
      port: 6379,
    },
    minio: {
      endPoint: 'localhost',
      port: 9000,
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
      bucket: 'instagram-media',
      useSSL: false,
    },
    session: {
      secret: 'test-secret',
      maxAge: 86400000,
    },
    feed: {
      celebrityFollowerThreshold: 10000,
      timelineMaxEntries: 500,
      timelineTtlSeconds: 604800,
      fanoutBatchSize: 1000,
      followBackfillCount: 50,
    },
    mediaPipeline: {
      maxAttempts: 3,
      relayIntervalMs: 2000,
      relayBatchSize: 50,
    },
  },
}));

// Mock db service
vi.mock('./services/db.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  pool: {
    query: vi.fn(),
    end: vi.fn(),
    connect: vi.fn(),
  },
  default: {
    query: vi.fn(),
    end: vi.fn(),
    connect: vi.fn(),
    on: vi.fn(),
  },
}));

// Mock redis service
vi.mock('./services/redis.js', () => ({
  default: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zrevrange: vi.fn().mockResolvedValue([]),
    zrem: vi.fn().mockResolvedValue(1),
    zremrangebyrank: vi.fn().mockResolvedValue(0),
    call: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
    status: 'ready',
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  postCacheKey: (postId: string) => `post:v2:${postId}`,
  invalidatePostCache: vi.fn().mockResolvedValue(undefined),
  storyTrayGet: vi.fn().mockResolvedValue(null),
  storyTraySet: vi.fn().mockResolvedValue(undefined),
  invalidateStoryTrays: vi.fn().mockResolvedValue(undefined),
}));

// Mock timeline (Redis sorted sets) - feedService runs for real on top of it
vi.mock('./services/timeline.js', () => ({
  readTimeline: vi.fn().mockResolvedValue({ built: true, size: 0, entries: [] }),
  isTimelineBuilt: vi.fn().mockResolvedValue(true),
  markTimelineBuilt: vi.fn().mockResolvedValue(undefined),
  unmarkTimelineBuilt: vi.fn().mockResolvedValue(undefined),
  mergeIntoTimeline: vi.fn().mockResolvedValue(undefined),
  touchTimeline: vi.fn().mockResolvedValue(undefined),
  addToCachedTimelines: vi.fn().mockResolvedValue(0),
  removeFromTimelines: vi.fn().mockResolvedValue(undefined),
}));

// Mock outbox (relay + enqueue)
vi.mock('./services/outbox.js', () => ({
  OUTBOX_EVENT_TYPES: { POST_MEDIA_UPLOADED: 'post.media_uploaded' },
  enqueueOutboxEvent: vi.fn().mockResolvedValue(undefined),
  kickOutboxRelay: vi.fn(),
  getOutboxBacklog: vi.fn().mockResolvedValue({ pending: 0, oldestAgeSeconds: null }),
}));

// Mock storage service
vi.mock('./services/storage.js', () => ({
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  checkBucket: vi.fn().mockResolvedValue(undefined),
  storeOriginalImage: vi.fn().mockResolvedValue({ key: 'originals/test.jpg', fileId: 'test-id' }),
  processAndUploadImage: vi.fn().mockResolvedValue({
    id: 'test-id',
    urls: {},
    width: 1080,
    height: 1080,
    filter: 'none',
    mediaUrl: 'http://localhost:9000/images/test.jpg',
    thumbnailUrl: 'http://localhost:9000/images/test-thumb.jpg',
  }),
  uploadProfilePicture: vi.fn().mockResolvedValue('http://localhost:9000/profiles/test.jpg'),
  FILTERS: { none: '', clarendon: 'contrast(1.2)', moon: 'grayscale(1)' },
  getPublicUrl: vi.fn().mockReturnValue('http://localhost:9000/test'),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  default: {},
}));

// Mock queue service
vi.mock('./services/queue.js', () => ({
  initializeQueue: vi.fn().mockResolvedValue(undefined),
  closeQueue: vi.fn().mockResolvedValue(undefined),
  publishImageProcessingJob: vi.fn().mockResolvedValue(undefined),
  ensureQueueConnection: vi.fn(),
  isQueueReady: vi.fn().mockReturnValue(false),
  QUEUES: { IMAGE_PROCESSING: 'image-processing', IMAGE_PROCESSING_DLQ: 'image-processing-dlq' },
}));

// Mock cassandra service
vi.mock('./services/cassandra.js', () => ({
  initCassandra: vi.fn().mockResolvedValue(undefined),
  closeCassandra: vi.fn().mockResolvedValue(undefined),
  getCassandraClient: vi.fn().mockReturnValue(null),
  isCassandraConnected: vi.fn().mockReturnValue(false),
  generateTimeUuid: vi.fn(),
  toUuid: vi.fn(),
  generateUserPairKey: vi.fn(),
  types: {},
}));

// Mock message service
vi.mock('./services/messageService.js', () => ({
  getOrCreateConversation: vi.fn(),
  isConversationParticipant: vi.fn().mockResolvedValue(false),
  sendMessage: vi.fn(),
  getMessages: vi.fn(),
  getConversations: vi.fn(),
  markConversationRead: vi.fn(),
  setTypingIndicator: vi.fn(),
  getTypingIndicators: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));

// Mock logger service - silence all logging during tests
vi.mock('./services/logger.js', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    default: noopLogger,
    logger: noopLogger,
    logRequest: vi.fn(),
    logError: vi.fn(),
    logQuery: vi.fn(),
    logCache: vi.fn(),
    logMetric: vi.fn(),
    createRequestLogger: vi.fn().mockReturnValue(noopLogger),
  };
});

// Mock metrics service
vi.mock('./services/metrics.js', () => {
  const mockCounter = { inc: vi.fn(), dec: vi.fn(), labels: vi.fn().mockReturnValue({ inc: vi.fn(), dec: vi.fn() }) };
  const mockHistogram = { observe: vi.fn(), labels: vi.fn().mockReturnValue({ observe: vi.fn() }) };
  const mockGauge = { set: vi.fn(), inc: vi.fn(), dec: vi.fn(), labels: vi.fn().mockReturnValue({ set: vi.fn(), inc: vi.fn(), dec: vi.fn() }) };
  return {
    register: {
      contentType: 'text/plain',
      metrics: vi.fn().mockResolvedValue('# metrics'),
    },
    metricsMiddleware: vi.fn().mockImplementation((_req: unknown, _res: unknown, next: () => void) => next()),
    httpRequestDuration: mockHistogram,
    httpRequestsTotal: mockCounter,
    postsCreatedTotal: mockCounter,
    postsDeletedTotal: mockCounter,
    likesTotal: mockCounter,
    likesDuplicateTotal: mockCounter,
    followsTotal: mockCounter,
    followsRateLimited: mockCounter,
    feedGenerationDuration: mockHistogram,
    feedCacheHits: mockCounter,
    feedCacheMisses: mockCounter,
    feedFanoutTotal: mockCounter,
    feedFanoutTimelineWrites: mockCounter,
    outboxPendingEvents: mockGauge,
    outboxPublishedTotal: mockCounter,
    outboxPublishFailures: mockCounter,
    imageJobOutcomes: mockCounter,
    idempotentReplays: mockCounter,
    imageProcessingDuration: mockHistogram,
    imageProcessingErrors: mockCounter,
    storiesCreatedTotal: mockCounter,
    storyViewsTotal: mockCounter,
    activeSessions: mockGauge,
    authAttempts: mockCounter,
    rateLimitHits: mockCounter,
    circuitBreakerState: mockGauge,
    circuitBreakerEvents: mockCounter,
    dbQueryDuration: mockHistogram,
    dbConnectionPoolSize: mockGauge,
    timedOperation: vi.fn().mockImplementation(async (_h: unknown, _l: unknown, fn: () => Promise<unknown>) => fn()),
    default: {
      contentType: 'text/plain',
      metrics: vi.fn().mockResolvedValue('# metrics'),
    },
  };
});

// Mock rate limiter service - pass through all requests
vi.mock('./services/rateLimiter.js', () => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    generalRateLimiter: passThrough,
    postRateLimiter: passThrough,
    followRateLimiter: passThrough,
    followRateLimitMiddleware: passThrough,
    loginRateLimiter: passThrough,
    likeRateLimiter: passThrough,
    commentRateLimiter: passThrough,
    storyRateLimiter: passThrough,
    feedRateLimiter: passThrough,
    checkRateLimit: vi.fn().mockResolvedValue(true),
    default: {
      postRateLimiter: passThrough,
      followRateLimiter: passThrough,
      followRateLimitMiddleware: passThrough,
      loginRateLimiter: passThrough,
      likeRateLimiter: passThrough,
      commentRateLimiter: passThrough,
      storyRateLimiter: passThrough,
      feedRateLimiter: passThrough,
      generalRateLimiter: passThrough,
      checkRateLimit: vi.fn().mockResolvedValue(true),
    },
  };
});

// Mock circuit breaker service
vi.mock('./services/circuitBreaker.js', () => ({
  createCircuitBreaker: vi.fn().mockImplementation((_name: string, fn: (...args: unknown[]) => Promise<unknown>) => ({
    fire: vi.fn().mockImplementation((...args: unknown[]) => fn(...args)),
    fallback: vi.fn(),
    on: vi.fn(),
  })),
  fallbackWithDefault: vi.fn().mockImplementation((val: unknown) => () => val),
  fallbackWithError: vi.fn().mockImplementation((msg: string) => () => { throw new Error(msg); }),
  getCircuitBreakerHealth: vi.fn().mockReturnValue({}),
  default: vi.fn(),
}));

// Mock connect-redis (session store) with an in-memory store. It extends express-session's Store
// so regenerate()/createSession() exist, and it keeps sessions so a supertest agent can log in.
vi.mock('connect-redis', async () => {
  const expressSession = await import('express-session');
  const { Store } = expressSession.default;
  const sessions = new Map<string, string>();
  return {
    RedisStore: class MockRedisStore extends Store {
      get(sid: string, cb: (err: unknown, session?: import('express-session').SessionData | null) => void) {
        const raw = sessions.get(sid);
        cb(null, raw ? JSON.parse(raw) : null);
      }
      set(sid: string, session: import('express-session').SessionData, cb?: (err?: unknown) => void) {
        sessions.set(sid, JSON.stringify(session));
        cb?.();
      }
      destroy(sid: string, cb?: (err?: unknown) => void) {
        sessions.delete(sid);
        cb?.();
      }
      touch(_sid: string, _session: import('express-session').SessionData, cb?: () => void) {
        cb?.();
      }
    },
  };
});

// ============================================
// Import app AFTER all mocks are defined
// ============================================
import { app } from './app.js';
import { query, getClient } from './services/db.js';
import { readTimeline } from './services/timeline.js';
import { enqueueOutboxEvent } from './services/outbox.js';
import { deleteObject } from './services/storage.js';
import { isCassandraConnected } from './services/cassandra.js';
import { isConversationParticipant, getMessages } from './services/messageService.js';
import { fingerprintCreatePost } from './services/idempotency.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const POST_ID = 'ab111111-1111-1111-1111-111111111111';
const COMMENT_ID = 'c0111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Rows = { rows: unknown[]; rowCount?: number };
const rows = (r: unknown[]): never => ({ rows: r, rowCount: r.length }) as never;

/** Logs in through the real route (bcrypt is mocked) and returns an agent carrying the cookie. */
const loginAs = async (userId: string, username: string, role = 'user') => {
  const agent = request.agent(app);
  vi.mocked(query).mockResolvedValueOnce(
    rows([{ id: userId, username, email: `${username}@example.com`, password_hash: 'x', display_name: username, role }])
  );
  const response = await agent.post('/api/v1/auth/login').send({ username, password: 'password123' });
  expect(response.status).toBe(200);
  return agent;
};

/** A pg client whose answers depend on the SQL it receives. */
const mockClient = (answer: (sql: string) => Rows) => {
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => answer(sql)),
    release: vi.fn(),
  };
  vi.mocked(getClient).mockResolvedValue(client as never);
  return client;
};

describe('Instagram Backend API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop queued once-values so one test's leftovers can't leak into the next
    vi.mocked(query).mockReset();
    vi.mocked(getClient).mockReset();
  });

  // ============================================
  // Health Check Endpoints
  // ============================================

  describe('GET /api/health', () => {
    it('should return health status with ok and timestamp', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/health/live', () => {
    it('should return alive status', async () => {
      const response = await request(app).get('/api/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'alive' });
    });
  });

  // ============================================
  // 404 Handler
  // ============================================

  describe('404 handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/api/v1/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not found' });
    });
  });

  // ============================================
  // Auth Routes
  // ============================================

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user', async () => {
      const mockUser = {
        id: 'user-123',
        username: 'testuser',
        email: 'test@example.com',
        display_name: 'Test User',
        bio: null,
        profile_picture_url: null,
        follower_count: 0,
        following_count: 0,
        post_count: 0,
        role: 'user',
        created_at: new Date(),
      };

      // Mock: check for existing user (none found)
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // No existing user
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 } as never); // Create user

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          username: 'testuser',
          email: 'test@example.com',
          password: 'password123',
          displayName: 'Test User',
        });

      expect(response.status).toBe(201);
      expect(response.body.user).toHaveProperty('username', 'testuser');
      expect(response.body.user).toHaveProperty('email', 'test@example.com');
      expect(response.body.user).not.toHaveProperty('password_hash');
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'testuser' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username, email, and password are required' });
    });

    it('should return 400 for short username', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'ab', email: 'test@example.com', password: 'password123' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username must be 3-30 characters' });
    });

    it('should return 400 for short password', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'testuser', email: 'test@example.com', password: '12345' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Password must be at least 6 characters' });
    });

    it('should return 409 for duplicate username or email', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: 'existing-user' }], rowCount: 1 } as never);

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          username: 'existinguser',
          email: 'existing@example.com',
          password: 'password123',
        });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Username or email already exists' });
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should return 400 for missing credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password are required' });
    });

    it('should return 401 for non-existent user', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'nonexistent', password: 'password123' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid credentials' });
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return 401 for unauthenticated request', async () => {
      const response = await request(app).get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Not authenticated' });
    });
  });

  // ============================================
  // User Routes
  // ============================================

  describe('GET /api/v1/users/:username', () => {
    it('should return user profile', async () => {
      const mockUser = {
        id: 'user-123',
        username: 'alice',
        display_name: 'Alice',
        bio: 'Hello world',
        profile_picture_url: null,
        follower_count: 100,
        following_count: 50,
        post_count: 25,
        is_private: false,
        created_at: new Date('2024-01-01'),
      };

      vi.mocked(query).mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 } as never);

      const response = await request(app).get('/api/v1/users/alice');

      expect(response.status).toBe(200);
      expect(response.body.user).toHaveProperty('username', 'alice');
      expect(response.body.user).toHaveProperty('displayName', 'Alice');
      expect(response.body.user).toHaveProperty('followerCount', 100);
      expect(response.body.user).toHaveProperty('postCount', 25);
    });

    it('should return 404 for non-existent user', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get('/api/v1/users/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'User not found' });
    });

    it('should return 500 on database error', async () => {
      vi.mocked(query).mockRejectedValueOnce(new Error('DB connection failed'));

      const response = await request(app).get('/api/v1/users/alice');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/v1/users/:username/followers', () => {
    it('should return followers list', async () => {
      const mockUser = { id: 'user-123' };
      const mockFollowers = [
        {
          id: 'follower-1',
          username: 'bob',
          display_name: 'Bob',
          profile_picture_url: null,
          created_at: new Date('2024-06-01'),
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 } as never) // User lookup
        .mockResolvedValueOnce({ rows: mockFollowers, rowCount: 1 } as never); // Followers query

      const response = await request(app).get('/api/v1/users/alice/followers');

      expect(response.status).toBe(200);
      expect(response.body.followers).toHaveLength(1);
      expect(response.body.followers[0]).toHaveProperty('username', 'bob');
      expect(response.body).toHaveProperty('nextCursor', null);
    });

    it('should return 404 for unknown user followers', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get('/api/v1/users/unknown/followers');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'User not found' });
    });
  });

  // ============================================
  // Post Routes
  // ============================================

  describe('GET /api/v1/posts/:postId', () => {
    it('should return a post by ID', async () => {
      const mockPost = {
        id: POST_ID,
        user_id: ALICE,
        username: 'alice',
        display_name: 'Alice',
        profile_picture_url: null,
        is_private: false,
        status: 'published',
        caption: 'My first post!',
        location: 'New York',
        like_count: 10,
        comment_count: 3,
        created_at: new Date('2024-06-01'),
      };

      const mockMedia = [
        {
          id: 'media-1',
          media_type: 'image',
          media_url: 'http://localhost:9000/images/test.jpg',
          thumbnail_url: 'http://localhost:9000/images/test-thumb.jpg',
          filter_applied: 'none',
          width: 1080,
          height: 1080,
          order_index: 0,
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [mockPost], rowCount: 1 } as never) // Post query
        .mockResolvedValueOnce({ rows: mockMedia, rowCount: 1 } as never); // Media query

      const response = await request(app).get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.post).toHaveProperty('id', POST_ID);
      expect(response.body.post).toHaveProperty('caption', 'My first post!');
      expect(response.body.post).toHaveProperty('location', 'New York');
      expect(response.body.post.media).toHaveLength(1);
      expect(response.body.post.media[0]).toHaveProperty('mediaType', 'image');
    });

    it('should return 404 for non-existent post', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Post not found' });
    });

    it('should return 500 on database error when getting post', async () => {
      vi.mocked(query).mockRejectedValueOnce(new Error('DB error'));

      const response = await request(app).get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/v1/posts/filters/list', () => {
    it('should return available filters', async () => {
      const response = await request(app).get('/api/v1/posts/filters/list');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('filters');
      expect(response.body.filters).toContain('none');
      expect(response.body.filters).toContain('clarendon');
      expect(response.body.filters).toContain('moon');
    });
  });

  // ============================================
  // Comment Routes
  // ============================================

  describe('GET /api/v1/posts/:postId/comments', () => {
    it('should return comments for a post', async () => {
      const mockComments = [
        {
          id: 'comment-1',
          user_id: 'user-1',
          post_id: 'post-123',
          parent_comment_id: null,
          username: 'bob',
          display_name: 'Bob',
          profile_picture_url: null,
          content: 'Great post!',
          like_count: 2,
          created_at: new Date('2024-06-01'),
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ user_id: ALICE, status: 'published', is_private: false }])) // visibility
        .mockResolvedValueOnce({ rows: mockComments, rowCount: 1 } as never);

      const response = await request(app).get(`/api/v1/posts/${POST_ID}/comments`);

      expect(response.status).toBe(200);
      expect(response.body.comments).toHaveLength(1);
      expect(response.body.comments[0]).toHaveProperty('content', 'Great post!');
      expect(response.body.comments[0]).toHaveProperty('username', 'bob');
      expect(response.body).toHaveProperty('nextCursor', null);
    });

    it('should return empty comments list when no comments', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ user_id: ALICE, status: 'published', is_private: false }])) // visibility
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get(`/api/v1/posts/${POST_ID}/comments`);

      expect(response.status).toBe(200);
      expect(response.body.comments).toHaveLength(0);
      expect(response.body.nextCursor).toBeNull();
    });
  });

  // ============================================
  // Auth-protected Routes (unauthenticated tests)
  // ============================================

  describe('Auth-protected routes return 401 for unauthenticated requests', () => {
    it('POST /api/v1/posts should return 401', async () => {
      const response = await request(app).post('/api/v1/posts');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    it('DELETE /api/v1/posts/:postId should return 401', async () => {
      const response = await request(app).delete('/api/v1/posts/post-123');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    it('POST /api/v1/posts/:postId/like should return 401', async () => {
      const response = await request(app).post('/api/v1/posts/post-123/like');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    it('POST /api/v1/users/:userId/follow should return 401', async () => {
      const response = await request(app).post('/api/v1/users/user-123/follow');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    it('GET /api/v1/feed should return 401', async () => {
      const response = await request(app).get('/api/v1/feed');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    it('POST /api/v1/posts/:postId/comments should return 401', async () => {
      const response = await request(app)
        .post('/api/v1/posts/post-123/comments')
        .send({ content: 'test comment' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });
  });

  // ============================================
  // User Posts
  // ============================================

  describe('GET /api/v1/users/:username/posts', () => {
    it('should return posts for a public user', async () => {
      const mockUser = { id: 'user-123', is_private: false };
      const mockPosts = [
        {
          id: 'post-1',
          caption: 'Post one',
          like_count: 5,
          comment_count: 2,
          created_at: new Date('2024-06-01'),
          thumbnail: 'http://localhost:9000/images/thumb1.jpg',
          media_count: '1',
        },
        {
          id: 'post-2',
          caption: 'Post two',
          like_count: 10,
          comment_count: 0,
          created_at: new Date('2024-06-02'),
          thumbnail: 'http://localhost:9000/images/thumb2.jpg',
          media_count: '3',
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 } as never) // User lookup
        .mockResolvedValueOnce({ rows: mockPosts, rowCount: 2 } as never); // Posts query

      const response = await request(app).get('/api/v1/users/alice/posts');

      expect(response.status).toBe(200);
      expect(response.body.posts).toHaveLength(2);
      expect(response.body.posts[0]).toHaveProperty('id', 'post-1');
      expect(response.body.posts[0]).toHaveProperty('likeCount', 5);
      expect(response.body.posts[0]).toHaveProperty('mediaCount', 1);
      expect(response.body.nextCursor).toBeNull();
    });

    it('should return 404 for non-existent user posts', async () => {
      vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get('/api/v1/users/nonexistent/posts');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'User not found' });
    });
  });

  // ============================================
  // Post Likes List
  // ============================================

  describe('GET /api/v1/posts/:postId/likes', () => {
    it('should return users who liked a post', async () => {
      const mockLikes = [
        {
          id: 'user-1',
          username: 'bob',
          display_name: 'Bob',
          profile_picture_url: null,
          created_at: new Date('2024-06-01'),
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ user_id: ALICE, status: 'published', is_private: false }])) // visibility
        .mockResolvedValueOnce({ rows: mockLikes, rowCount: 1 } as never);

      const response = await request(app).get(`/api/v1/posts/${POST_ID}/likes`);

      expect(response.status).toBe(200);
      expect(response.body.likes).toHaveLength(1);
      expect(response.body.likes[0]).toHaveProperty('username', 'bob');
      expect(response.body.nextCursor).toBeNull();
    });

    it('should return empty list when no likes', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ user_id: ALICE, status: 'published', is_private: false }])) // visibility
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app).get(`/api/v1/posts/${POST_ID}/likes`);

      expect(response.status).toBe(200);
      expect(response.body.likes).toHaveLength(0);
    });
  });

  // ============================================
  // Comment Replies
  // ============================================

  describe('GET /api/v1/comments/:commentId/replies', () => {
    it('should return replies for a comment', async () => {
      const mockReplies = [
        {
          id: 'reply-1',
          user_id: 'user-2',
          post_id: 'post-123',
          parent_comment_id: 'comment-1',
          username: 'charlie',
          display_name: 'Charlie',
          profile_picture_url: null,
          content: 'Thanks!',
          like_count: 0,
          created_at: new Date('2024-06-01'),
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ post_id: POST_ID }])) // parent comment
        .mockResolvedValueOnce(rows([{ user_id: ALICE, status: 'published', is_private: false }])) // visibility
        .mockResolvedValueOnce({ rows: mockReplies, rowCount: 1 } as never);

      const response = await request(app).get(`/api/v1/comments/${COMMENT_ID}/replies`);

      expect(response.status).toBe(200);
      expect(response.body.replies).toHaveLength(1);
      expect(response.body.replies[0]).toHaveProperty('content', 'Thanks!');
      expect(response.body.replies[0]).toHaveProperty('username', 'charlie');
    });
  });

  // ============================================
  // User Search
  // ============================================

  describe('GET /api/v1/users/search/users', () => {
    it('should return matching users', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          username: 'alice',
          display_name: 'Alice',
          profile_picture_url: null,
        },
      ];

      vi.mocked(query).mockResolvedValueOnce({ rows: mockUsers, rowCount: 1 } as never);

      const response = await request(app).get('/api/v1/users/search/users?q=ali');

      expect(response.status).toBe(200);
      expect(response.body.users).toHaveLength(1);
      expect(response.body.users[0]).toHaveProperty('username', 'alice');
    });

    it('should return empty list for short query', async () => {
      const response = await request(app).get('/api/v1/users/search/users?q=a');

      expect(response.status).toBe(200);
      expect(response.body.users).toHaveLength(0);
    });
  });

  // ============================================
  // User Following list
  // ============================================

  describe('GET /api/v1/users/:username/following', () => {
    it('should return following list', async () => {
      const mockUser = { id: 'user-123' };
      const mockFollowing = [
        {
          id: 'following-1',
          username: 'diana',
          display_name: 'Diana',
          profile_picture_url: null,
          created_at: new Date('2024-05-01'),
        },
      ];

      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: mockFollowing, rowCount: 1 } as never);

      const response = await request(app).get('/api/v1/users/alice/following');

      expect(response.status).toBe(200);
      expect(response.body.following).toHaveLength(1);
      expect(response.body.following[0]).toHaveProperty('username', 'diana');
    });
  });

  // ============================================
  // Metrics Endpoint
  // ============================================

  describe('GET /metrics', () => {
    it('should return prometheus metrics', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toBe('# metrics');
    });
  });

  // ============================================
  // Visibility: private accounts and unpublished posts
  // ============================================

  describe('Post visibility', () => {
    const privatePost = {
      id: POST_ID,
      user_id: BOB,
      username: 'bob',
      display_name: 'Bob',
      profile_picture_url: null,
      is_private: true,
      status: 'published',
      caption: 'followers only',
      location: null,
      like_count: 0,
      comment_count: 0,
      created_at: new Date('2024-06-01'),
    };

    it("hides a private account's post from anonymous viewers", async () => {
      vi.mocked(query).mockResolvedValueOnce(rows([privatePost])).mockResolvedValueOnce(rows([]));

      const response = await request(app).get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(404);
    });

    it("hides a private account's post from a signed-in non-follower", async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query)
        .mockResolvedValueOnce(rows([privatePost])) // post + author
        .mockResolvedValueOnce(rows([])) // media
        .mockResolvedValueOnce(rows([])); // follows: alice does not follow bob

      const response = await agent.get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(404);
    });

    it('shows it to a follower, with their own like/save state', async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query)
        .mockResolvedValueOnce(rows([privatePost]))
        .mockResolvedValueOnce(rows([]))
        .mockResolvedValueOnce(rows([{ '?column?': 1 }])) // follows
        .mockResolvedValueOnce(rows([{ is_liked: true, is_saved: false }]));

      const response = await agent.get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.post).toMatchObject({ id: POST_ID, isLiked: true, isSaved: false });
    });

    it('shows a processing post to its author but never caches it', async () => {
      const { cacheSet } = await import('./services/redis.js');
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ ...privatePost, user_id: ALICE, is_private: false, status: 'processing' }]))
        .mockResolvedValueOnce(rows([]))
        .mockResolvedValueOnce(rows([{ is_liked: false, is_saved: false }]));

      const response = await agent.get(`/api/v1/posts/${POST_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.post).toHaveProperty('status', 'processing');
      expect(cacheSet).not.toHaveBeenCalled();
    });

    it('rejects a like on a post the viewer cannot see', async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ user_id: BOB, status: 'published', is_private: true }])) // access
        .mockResolvedValueOnce(rows([])); // not a follower

      const response = await agent.post(`/api/v1/posts/${POST_ID}/like`);

      expect(response.status).toBe(404);
      const sql = vi.mocked(query).mock.calls.map(([text]) => String(text));
      expect(sql.some((text) => text.includes('INSERT INTO likes'))).toBe(false);
    });
  });

  // ============================================
  // Post creation: transactional outbox + Idempotency-Key
  // ============================================

  describe('POST /api/v1/posts', () => {
    const imageBuffer = Buffer.from('fake-jpeg-bytes');
    const createdPost = {
      id: POST_ID,
      user_id: ALICE,
      caption: 'hello',
      location: null,
      status: 'processing',
      like_count: 0,
      comment_count: 0,
      created_at: new Date('2024-06-01'),
    };
    const requestHash = fingerprintCreatePost({
      caption: 'hello',
      location: null,
      filters: ['none'],
      files: [{ buffer: imageBuffer }],
    });

    const submit = (agent: ReturnType<typeof request.agent>, key?: string, contentType = 'image/jpeg') => {
      const req = agent
        .post('/api/v1/posts')
        .field('caption', 'hello')
        .field('filters', JSON.stringify(['none']))
        .attach('media', imageBuffer, { filename: 'a.jpg', contentType });
      return key ? req.set('Idempotency-Key', key) : req;
    };

    it('writes the post, its media and its processing job in one transaction', async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query).mockResolvedValueOnce(rows([])); // key not seen before
      const client = mockClient((sql) => {
        if (sql.includes('INSERT INTO posts')) return { rows: [createdPost] };
        if (sql.includes('INSERT INTO idempotency_keys')) return { rows: [{ post_id: POST_ID }] };
        return { rows: [] };
      });

      const response = await submit(agent, 'key-0001-abcdef');

      expect(response.status).toBe(202);
      expect(response.body.post).toMatchObject({ id: POST_ID, status: 'processing' });
      const statements = client.query.mock.calls.map(([sql]) => String(sql).trim());
      expect(statements[0]).toBe('BEGIN');
      expect(statements[statements.length - 1]).toBe('COMMIT');
      expect(statements.some((sql) => sql.startsWith('INSERT INTO post_media'))).toBe(true);
      expect(enqueueOutboxEvent).toHaveBeenCalledWith(client, {
        aggregateId: POST_ID,
        eventType: 'post.media_uploaded',
        payload: {
          postId: POST_ID,
          userId: ALICE,
          mediaItems: [{ originalKey: 'originals/test.jpg', filterName: 'none', orderIndex: 0 }],
        },
      });
    });

    it('replays the original post when the same key and body are retried', async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ request_hash: requestHash, post_id: POST_ID }]))
        .mockResolvedValueOnce(
          rows([{ ...createdPost, username: 'alice', display_name: 'Alice', profile_picture_url: null, is_private: false }])
        )
        .mockResolvedValueOnce(rows([]));

      const response = await submit(agent, 'key-0001-abcdef');

      expect(response.status).toBe(202);
      expect(response.headers['idempotent-replayed']).toBe('true');
      expect(response.body.post).toHaveProperty('id', POST_ID);
      expect(getClient).not.toHaveBeenCalled();
      expect(enqueueOutboxEvent).not.toHaveBeenCalled();
    });

    it('rejects a reused key with a different body (422)', async () => {
      const agent = await loginAs(ALICE, 'alice');
      vi.mocked(query).mockResolvedValueOnce(rows([{ request_hash: 'f'.repeat(64), post_id: POST_ID }]));

      const response = await submit(agent, 'key-0001-abcdef');

      expect(response.status).toBe(422);
      expect(getClient).not.toHaveBeenCalled();
    });

    it('lets a concurrent duplicate lose cleanly: roll back, delete its upload, replay the winner', async () => {
      const agent = await loginAs(ALICE, 'alice');
      const loserId = 'ab999999-9999-9999-9999-999999999999';
      vi.mocked(query)
        .mockResolvedValueOnce(rows([])) // key not seen yet when this request started
        .mockResolvedValueOnce(rows([{ request_hash: requestHash, post_id: POST_ID }])) // winner, after the conflict
        .mockResolvedValueOnce(
          rows([{ ...createdPost, username: 'alice', display_name: 'Alice', profile_picture_url: null, is_private: false }])
        )
        .mockResolvedValueOnce(rows([]));
      const client = mockClient((sql) => {
        if (sql.includes('INSERT INTO posts')) return { rows: [{ ...createdPost, id: loserId }] };
        return { rows: [] }; // the key INSERT ... ON CONFLICT DO NOTHING returns nothing: conflict
      });

      const response = await submit(agent, 'key-0001-abcdef');

      expect(response.status).toBe(202);
      expect(response.body.post.id).toBe(POST_ID);
      const statements = client.query.mock.calls.map(([sql]) => String(sql).trim());
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(deleteObject).toHaveBeenCalledWith('originals/test.jpg');
      expect(enqueueOutboxEvent).not.toHaveBeenCalled();
    });

    it('rejects non-image uploads before touching storage (415)', async () => {
      const agent = await loginAs(ALICE, 'alice');

      const response = await submit(agent, undefined, 'video/mp4');

      expect(response.status).toBe(415);
      expect(getClient).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Home feed: keyset cursor + push/pull merge
  // ============================================

  describe('GET /api/v1/feed', () => {
    it('rejects an offset-style or malformed cursor', async () => {
      const agent = await loginAs(ALICE, 'alice');

      const response = await agent.get('/api/v1/feed?cursor=20');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid cursor' });
    });

    it('merges timeline posts with followed celebrities and returns a keyset cursor', async () => {
      const agent = await loginAs(ALICE, 'alice');
      const P1 = 'aa000000-0000-4000-8000-000000000001';
      const P2 = 'aa000000-0000-4000-8000-000000000002';
      const P3 = 'aa000000-0000-4000-8000-000000000003';
      vi.mocked(readTimeline).mockResolvedValueOnce({
        built: true,
        size: 2,
        entries: [
          { postId: P1, score: 3000 },
          { postId: P2, score: 1000 },
        ],
      });
      const hydrated = (id: string) => ({
        id,
        user_id: BOB,
        caption: id,
        location: null,
        like_count: 0,
        comment_count: 0,
        created_at: new Date('2024-06-01'),
        username: 'bob',
        display_name: 'Bob',
        profile_picture_url: null,
        is_liked: false,
        is_saved: false,
        media: [],
      });
      vi.mocked(query)
        .mockResolvedValueOnce(rows([{ id: P3, created_ms: '2000' }])) // followed celebrity, pulled
        .mockResolvedValueOnce(rows([hydrated(P3), hydrated(P1)])); // hydration, any order

      const response = await agent.get('/api/v1/feed?limit=2');

      expect(response.status).toBe(200);
      expect(response.body.posts.map((p: { id: string }) => p.id)).toEqual([P1, P3]);
      expect(response.body.nextCursor).toBe(`2000_${P3}`);
      const hydration = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('json_agg'));
      expect(hydration?.[1]).toEqual([[P1, P3], ALICE]);
    });
  });

  // ============================================
  // Direct messages: participants only
  // ============================================

  describe('Direct message authorization', () => {
    beforeEach(() => {
      vi.mocked(isCassandraConnected).mockReturnValue(true);
    });

    afterEach(() => {
      vi.mocked(isCassandraConnected).mockReturnValue(false);
    });

    it('returns 404 to a user who is not a participant', async () => {
      vi.mocked(isConversationParticipant).mockResolvedValueOnce(false);
      const agent = await loginAs(ALICE, 'alice');

      const response = await agent.get(`/api/v1/messages/conversations/${CONVERSATION_ID}`);

      expect(response.status).toBe(404);
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('refuses to send into a conversation the user is not part of', async () => {
      const { sendMessage } = await import('./services/messageService.js');
      vi.mocked(isConversationParticipant).mockResolvedValueOnce(false);
      const agent = await loginAs(ALICE, 'alice');

      const response = await agent
        .post(`/api/v1/messages/conversations/${CONVERSATION_ID}`)
        .send({ content: 'hi' });

      expect(response.status).toBe(404);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('lets a participant read the conversation', async () => {
      vi.mocked(isConversationParticipant).mockResolvedValueOnce(true);
      vi.mocked(getMessages).mockResolvedValueOnce([]);
      const agent = await loginAs(ALICE, 'alice');

      const response = await agent.get(`/api/v1/messages/conversations/${CONVERSATION_ID}`);

      expect(response.status).toBe(200);
      expect(isConversationParticipant).toHaveBeenCalledWith(CONVERSATION_ID, ALICE);
    });
  });

  // ============================================
  // Sessions
  // ============================================

  describe('Session handling', () => {
    it('issues a new session id on every login (no session fixation)', async () => {
      const agent = request.agent(app);
      const userRow = { id: ALICE, username: 'alice', email: 'alice@example.com', password_hash: 'x', role: 'user' };
      vi.mocked(query).mockResolvedValueOnce(rows([userRow])).mockResolvedValueOnce(rows([userRow]));
      const sessionId = (res: request.Response) => String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];

      const first = await agent.post('/api/v1/auth/login').send({ username: 'alice', password: 'password123' });
      const second = await agent.post('/api/v1/auth/login').send({ username: 'alice', password: 'password123' });

      expect(sessionId(first)).toMatch(/^connect\.sid=/);
      expect(sessionId(second)).toMatch(/^connect\.sid=/);
      expect(sessionId(second)).not.toBe(sessionId(first));
    });
  });
});
