/**
 * Unit tests for the Collection service API.
 * Uses vitest with mocked shared modules (db, storage, cache).
 * @module collection/app.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

// Mock the shared modules before importing app
vi.mock('../shared/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

vi.mock('../shared/storage.js', () => ({
  uploadDrawing: vi.fn().mockResolvedValue('drawings/test-id.json'),
  ensureBuckets: vi.fn().mockResolvedValue(undefined),
  minioClient: {
    bucketExists: vi.fn().mockResolvedValue(true),
  },
  DRAWINGS_BUCKET: 'drawings',
}))

vi.mock('../shared/cache.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  CacheKeys: {
    adminStats: () => 'admin:stats',
    shapes: () => 'shapes:all',
    userStats: (sessionId: string) => `user:stats:${sessionId}`,
    drawing: (id: string) => `drawing:${id}`,
  },
}))

// Mock circuit breakers to pass through
vi.mock('../shared/circuitBreaker.js', () => ({
  minioCircuitBreaker: {
    execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    getStatus: vi.fn().mockReturnValue({ name: 'minio', state: 'closed', failures: 0, lastFailureTime: null }),
  },
  postgresCircuitBreaker: {
    execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    getStatus: vi.fn().mockReturnValue({ name: 'postgres', state: 'closed', failures: 0, lastFailureTime: null }),
  },
  rabbitCircuitBreaker: {
    execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    getStatus: vi.fn().mockReturnValue({ name: 'rabbitmq', state: 'closed', failures: 0, lastFailureTime: null }),
  },
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    constructor(message: string, public circuitName: string, public retryAfterMs: number) {
      super(message)
      this.name = 'CircuitBreakerOpenError'
    }
  },
  getAllCircuitBreakerStatus: vi.fn().mockReturnValue([
    { name: 'minio', state: 'closed', failures: 0, lastFailureTime: null },
    { name: 'postgres', state: 'closed', failures: 0, lastFailureTime: null },
    { name: 'rabbitmq', state: 'closed', failures: 0, lastFailureTime: null },
  ]),
}))

// Mock retry to pass through immediately
vi.mock('../shared/retry.js', () => ({
  withRetry: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => {
    const result = await fn()
    return { result, attempts: 1, totalTimeMs: 1 }
  }),
  RetryPresets: {
    minio: { maxRetries: 4, initialDelayMs: 100 },
    postgres: { maxRetries: 3, initialDelayMs: 50 },
    rabbitmq: { maxRetries: 5, initialDelayMs: 500 },
  },
}))

// Mock metrics to no-op
vi.mock('../shared/metrics.js', () => ({
  metricsMiddleware: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
  metricsHandler: vi.fn().mockImplementation((_req: unknown, res: { send: (s: string) => void }) => res.send('# metrics')),
  drawingsTotal: {
    labels: vi.fn().mockReturnValue({ inc: vi.fn() }),
  },
  drawingProcessingDuration: {
    labels: vi.fn().mockReturnValue({ observe: vi.fn() }),
  },
  trackExternalCall: vi.fn().mockImplementation(async (_service: string, _op: string, fn: () => Promise<unknown>) => fn()),
}))

// Mock health check router
vi.mock('../shared/healthCheck.js', () => ({
  healthCheckRouter: vi.fn().mockReturnValue((req: { path: string }, res: { json: (data: unknown) => void }, next: () => void) => {
    if (req.path === '/health') {
      res.json({ status: 'ok', service: 'collection' })
    } else if (req.path === '/health/live') {
      res.json({ status: 'alive', service: 'collection' })
    } else if (req.path === '/health/ready') {
      res.json({ status: 'ready', service: 'collection' })
    } else {
      next()
    }
  }),
}))

// Import after mocking
import { app } from './app.js'
import { pool } from '../shared/db.js'

describe('Collection Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ status: 'ok', service: 'collection' })
    })
  })

  describe('GET /api/shapes', () => {
    it('should return list of shapes', async () => {
      const mockShapes = [
        { id: 1, name: 'circle', description: 'A round shape', difficulty: 2 },
        { id: 2, name: 'line', description: 'A straight line', difficulty: 1 },
      ]

      vi.mocked(pool.query).mockResolvedValueOnce({ rows: mockShapes } as never)

      const response = await request(app).get('/api/shapes')

      expect(response.status).toBe(200)
      expect(response.body).toEqual(mockShapes)
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT id, name, description, difficulty FROM shapes ORDER BY difficulty, name'
      )
    })

    it('should return 500 on database error', async () => {
      vi.mocked(pool.query).mockRejectedValueOnce(new Error('DB error'))

      const response = await request(app).get('/api/shapes')

      expect(response.status).toBe(500)
      expect(response.body).toEqual({ error: 'Failed to fetch shapes' })
    })
  })

  describe('POST /api/drawings', () => {
    const validDrawing = {
      sessionId: 'test-session-123',
      shape: 'circle',
      canvas: { width: 400, height: 400 },
      strokes: [
        {
          points: [{ x: 100, y: 100, pressure: 0.5, timestamp: 123456 }],
          color: '#000000',
          width: 3,
        },
      ],
      duration_ms: 1500,
      device: 'mouse',
    }

    it('should save a valid drawing', async () => {
      // Mock user lookup (not found)
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rows: [] } as never) // User not found
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] } as never) // Create user
        .mockResolvedValueOnce({ rows: [{ id: 1 }] } as never) // Shape lookup
        .mockResolvedValueOnce({ rows: [] } as never) // Insert drawing
        .mockResolvedValueOnce({ rows: [] } as never) // Update user count

      const response = await request(app).post('/api/drawings').send(validDrawing)

      expect(response.status).toBe(201)
      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('message', 'Drawing saved successfully')
    })

    it('should return 400 for missing required fields', async () => {
      const response = await request(app).post('/api/drawings').send({
        sessionId: 'test',
        // Missing shape and strokes
      })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'Missing required fields' })
    })

    it('should return 400 for invalid shape', async () => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] } as never) // User found
        .mockResolvedValueOnce({ rows: [] } as never) // Shape not found

      const response = await request(app)
        .post('/api/drawings')
        .send({ ...validDrawing, shape: 'invalid-shape' })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'Invalid shape' })
    })
  })

  describe('GET /api/user/stats', () => {
    it('should return user stats', async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rows: [{ total_drawings: 42, today_count: '5' }],
      } as never)

      const response = await request(app).get('/api/user/stats?sessionId=test-session')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        total_drawings: 42,
        today_count: 5,
      })
    })

    it('should return zeros for new user', async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never)

      const response = await request(app).get('/api/user/stats?sessionId=new-user')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        total_drawings: 0,
        today_count: 0,
      })
    })

    it('should return 400 if sessionId is missing', async () => {
      const response = await request(app).get('/api/user/stats')

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'Session ID required' })
    })
  })
})
