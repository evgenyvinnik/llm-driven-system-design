import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shared modules before importing app
vi.mock('./services/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
}));

vi.mock('./services/redis.js', () => {
  const mockRedis = {
    on: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    disconnect: vi.fn(),
  };
  return { redis: mockRedis };
});

vi.mock('./services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  },
}));

vi.mock('pino-http', () => ({
  pinoHttp: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('./services/metrics.js', () => ({
  httpRequestDuration: { observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) },
  activeMeetings: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
  activeParticipants: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
  wsConnections: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
  metricsRegistry: {
    metrics: vi.fn().mockResolvedValue(''),
    contentType: 'text/plain',
  },
}));

vi.mock('./services/circuitBreaker.js', () => ({
  createCircuitBreaker: vi.fn((fn: unknown) => ({
    fire: fn,
    on: vi.fn(),
  })),
}));

vi.mock('./services/rateLimiter.js', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// app.ts imports the named RedisStore export; an in-memory store keeps real
// session semantics (cookies, regenerate) so authenticated routes can be tested.
vi.mock('connect-redis', async () => {
  const { default: session } = await import('express-session');
  return { RedisStore: class extends session.MemoryStore {} };
});

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$10$hashedpassword'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

import request from 'supertest';
import { app } from './app.js';
import { pool } from './services/db.js';
import { redis } from './services/redis.js';

const mockQuery = pool.query as ReturnType<typeof vi.fn>;
const mockRedis = redis as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };

const BOB = 'a0000000-0000-0000-0000-000000000002';
const MEETING = 'b0000000-0000-0000-0000-000000000002';

/** Logs in as bob and returns an agent that carries the session cookie. */
async function loginAsBob() {
  const agent = request.agent(app);
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: BOB, username: 'bob', email: 'bob@example.com', display_name: 'Bob Smith', password_hash: 'x', created_at: '2026-01-01' }],
  });
  const res = await agent.post('/api/auth/login').send({ username: 'bob', password: 'password123' });
  expect(res.status).toBe(200);
  return agent;
}

describe('Zoom Backend API', () => {
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

  describe('POST /api/auth/register', () => {
    it('should register a new user', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // check existing
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'user-1',
              username: 'testuser',
              email: 'test@example.com',
              display_name: 'Test User',
              created_at: new Date().toISOString(),
            },
          ],
        }); // insert

      const res = await request(app).post('/api/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe('testuser');
      // camelCase, like /login and /me
      expect(res.body.user.displayName).toBe('Test User');
      expect(res.body.user.display_name).toBeUndefined();
    });

    it('should return 400 when fields are missing', async () => {
      const res = await request(app).post('/api/auth/register').send({
        username: 'testuser',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 409 when user already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

      const res = await request(app).post('/api/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 when fields are missing', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
    });

    it('should return 401 for invalid credentials', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/api/auth/login').send({
        username: 'nonexistent',
        password: 'wrong',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/meetings', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/meetings');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/meetings', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).post('/api/meetings').send({
        title: 'Test Meeting',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/meetings/code/:code', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/meetings/code/abc-defg-hij');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/metrics', () => {
    it('should return metrics', async () => {
      const res = await request(app).get('/api/metrics');
      expect(res.status).toBe(200);
    });
  });

  describe('authorization', () => {
    it('hides chat history of meetings the caller never attended (404)', async () => {
      const agent = await loginAsBob();
      mockQuery.mockResolvedValueOnce({ rows: [] }); // getMeetingForViewer
      const res = await agent.get(`/api/chat/${MEETING}/messages`);
      expect(res.status).toBe(404);
      expect(mockQuery.mock.calls.at(-1)![1]).toEqual([MEETING, BOB]);
    });

    it('filters other people\'s direct messages out of chat history', async () => {
      const agent = await loginAsBob();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: MEETING, host_id: 'someone-else' }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await agent.get(`/api/chat/${MEETING}/messages?limit=5000`);
      expect(res.status).toBe(200);
      const [sql, params] = mockQuery.mock.calls.at(-1)!;
      expect(sql).toContain('m.recipient_id IS NULL OR m.sender_id = $2 OR m.recipient_id = $2');
      expect(params).toEqual([MEETING, BOB, 500]);
    });

    it('returns 404 for meetings by id the caller cannot see, without querying malformed ids', async () => {
      const agent = await loginAsBob();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect((await agent.get(`/api/meetings/${MEETING}`)).status).toBe(404);
      const calls = mockQuery.mock.calls.length;
      expect((await agent.get('/api/meetings/not-a-uuid/participants')).status).toBe(404);
      expect(mockQuery.mock.calls.length).toBe(calls);
    });

    it('lets only hosts manage breakout rooms (403 for attendees, 404 for strangers)', async () => {
      const agent = await loginAsBob();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const stranger = await agent.post(`/api/rooms/${MEETING}/breakout-rooms`).send({ rooms: [{ name: 'A' }] });
      expect(stranger.status).toBe(404);

      mockQuery.mockResolvedValueOnce({ rows: [{ id: MEETING, host_id: 'someone-else' }] });
      const attendee = await agent.post(`/api/rooms/${MEETING}/breakout-rooms`).send({ rooms: [{ name: 'A' }] });
      expect(attendee.status).toBe(403);
    });

    it('rejects scheduled times without a time zone', async () => {
      const agent = await loginAsBob();
      const res = await agent.post('/api/meetings').send({ title: 'Sync', scheduledStart: '2026-11-02T10:00' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/time zone/);

      const backwards = await agent.post('/api/meetings').send({
        scheduledStart: '2026-11-02T10:00:00Z',
        scheduledEnd: '2026-11-02T09:00:00Z',
      });
      expect(backwards.status).toBe(400);
    });

    it('replays the first meeting for a repeated Idempotency-Key', async () => {
      const agent = await loginAsBob();
      const row = { id: MEETING, meeting_code: 'abc-defg-hij', host_id: BOB };
      mockRedis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK');
      mockQuery.mockResolvedValueOnce({ rows: [row] });
      const first = await agent.post('/api/meetings').set('Idempotency-Key', 'k1').send({ title: 'Instant' });
      expect(first.status).toBe(201);

      mockRedis.set.mockResolvedValueOnce(null);
      mockRedis.get.mockResolvedValueOnce(MEETING);
      mockQuery.mockResolvedValueOnce({ rows: [row] });
      const second = await agent.post('/api/meetings').set('Idempotency-Key', 'k1').send({ title: 'Instant' });
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.meeting.id).toBe(MEETING);
      const inserts = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO meetings'));
      expect(inserts).toHaveLength(1);
    });

    it('refuses REST chat posts from people not in the live meeting', async () => {
      const agent = await loginAsBob();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: MEETING, host_id: BOB }] });
      const res = await agent.post(`/api/chat/${MEETING}/messages`).send({ content: 'hello' });
      expect(res.status).toBe(409);
    });
  });
});
