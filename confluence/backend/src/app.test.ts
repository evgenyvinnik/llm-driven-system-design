import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock all shared services before importing app
vi.mock('./services/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    }),
  },
}));

vi.mock('./services/redis.js', () => ({
  redis: {
    status: 'ready',
    on: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    call: vi.fn(),
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDelPattern: vi.fn(),
}));

vi.mock('./services/queue.js', () => ({
  connectQueue: vi.fn(),
  publishToQueue: vi.fn(),
  getChannel: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock('./services/elasticsearch.js', () => ({
  esClient: {
    index: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    indices: {
      exists: vi.fn().mockResolvedValue(true),
      create: vi.fn(),
    },
  },
  ensureIndex: vi.fn(),
}));

vi.mock('./services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('./services/rateLimiter.js', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { app } from './app.js';
import { pool } from './services/db.js';

const mockPool = vi.mocked(pool);

describe('Confluence API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/register', () => {
    it('should reject registration without required fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('should reject short username', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'ab', email: 'test@test.com', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('3-30');
    });

    it('should reject short password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'testuser', email: 'test@test.com', password: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('6 characters');
    });

    it('should register user successfully', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // check existing
        .mockResolvedValueOnce({
          rows: [{
            id: 'user-1',
            username: 'testuser',
            email: 'test@test.com',
            display_name: 'testuser',
            role: 'user',
            created_at: new Date().toISOString(),
          }],
          rowCount: 1,
        } as never);

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          username: 'testuser',
          email: 'test@test.com',
          password: 'password123',
        });

      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe('testuser');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should reject login without credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should reject invalid username', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'nonexistent', password: 'password123' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/spaces', () => {
    it('should return spaces list', async () => {
      // 1st query: the caller's visible space IDs; 2nd: the spaces themselves
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 's1' }], rowCount: 1 } as never);
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 's1', key: 'ENG', name: 'Engineering', page_count: '5' },
        ],
        rowCount: 1,
      } as never);

      const res = await request(app).get('/api/v1/spaces');

      expect(res.status).toBe(200);
      expect(res.body.spaces).toHaveLength(1);
      expect(res.body.spaces[0].key).toBe('ENG');
    });
  });

  describe('GET /api/v1/pages/recent', () => {
    it('should return recent pages', async () => {
      // 1st query: visible space IDs (anonymous callers have no editable spaces)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: '00000000-0000-4000-8000-000000000001' }],
        rowCount: 1,
      } as never);
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'p1', title: 'Test Page', space_key: 'ENG' },
        ],
        rowCount: 1,
      } as never);

      const res = await request(app).get('/api/v1/pages/recent');

      expect(res.status).toBe(200);
      expect(res.body.pages).toHaveLength(1);
    });
  });

  describe('access control on unauthenticated requests', () => {
    it('hides a private space (404, not 403) from anonymous callers', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: '00000000-0000-4000-8000-000000000003', key: 'SEC', is_public: false }],
        rowCount: 1,
      } as never);
      const res = await request(app).get('/api/v1/spaces/SEC');
      expect(res.status).toBe(404);
    });

    it('requires sign-in to change a space or its members', async () => {
      expect((await request(app).put('/api/v1/spaces/ENG').send({ name: 'x' })).status).toBe(401);
      expect((await request(app).delete('/api/v1/spaces/ENG')).status).toBe(401);
      expect(
        (await request(app).post('/api/v1/spaces/ENG/members').send({ username: 'bob', role: 'admin' })).status,
      ).toBe(401);
    });

    it('treats a malformed page id as not found instead of a database error', async () => {
      const res = await request(app).get('/api/v1/pages/not-a-uuid');
      expect(res.status).toBe(404);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('returns 404 for a search scoped to an unknown space instead of searching everywhere', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      const res = await request(app).get('/api/v1/search?q=keys&space=NOPE');
      expect(res.status).toBe(404);
    });
  });
});
