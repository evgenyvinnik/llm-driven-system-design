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
