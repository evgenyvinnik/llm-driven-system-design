import express from 'express'
import cors from 'cors'
import { pool } from '../shared/db.js'
import { uploadDrawing } from '../shared/storage.js'
import { cacheGet, cacheSet, cacheDelete, CacheKeys } from '../shared/cache.js'
import { v4 as uuidv4 } from 'uuid'

export const app = express()

// Middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'collection' })
})

// Get available shapes (cached for 5 minutes since shapes rarely change)
app.get('/api/shapes', async (_req, res) => {
  try {
    // Check cache first
    const cacheKey = CacheKeys.shapes()
    const cached = await cacheGet<object[]>(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const result = await pool.query(
      'SELECT id, name, description, difficulty FROM shapes ORDER BY difficulty, name'
    )

    // Cache for 5 minutes
    await cacheSet(cacheKey, result.rows, 300)

    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching shapes:', error)
    res.status(500).json({ error: 'Failed to fetch shapes' })
  }
})

// Submit a drawing
interface DrawingSubmission {
  sessionId: string
  shape: string
  canvas: { width: number; height: number }
  strokes: Array<{
    points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
    color: string
    width: number
  }>
  duration_ms: number
  device?: string
}

app.post('/api/drawings', async (req, res) => {
  try {
    const submission: DrawingSubmission = req.body

    // Validate required fields
    if (!submission.sessionId || !submission.shape || !submission.strokes) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Get or create user
    let userId: string
    const userResult = await pool.query(
      'SELECT id FROM users WHERE session_id = $1',
      [submission.sessionId]
    )

    if (userResult.rows.length > 0) {
      userId = userResult.rows[0].id
    } else {
      const newUser = await pool.query(
        'INSERT INTO users (session_id) VALUES ($1) RETURNING id',
        [submission.sessionId]
      )
      userId = newUser.rows[0].id
    }

    // Get shape ID
    const shapeResult = await pool.query(
      'SELECT id FROM shapes WHERE name = $1',
      [submission.shape]
    )

    if (shapeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid shape' })
    }

    const shapeId = shapeResult.rows[0].id

    // Generate drawing ID and upload to MinIO
    const drawingId = uuidv4()
    const strokeData = {
      id: drawingId,
      shape: submission.shape,
      canvas: submission.canvas,
      strokes: submission.strokes,
      duration_ms: submission.duration_ms,
      device: submission.device || 'unknown',
      user_agent: req.get('user-agent') || 'unknown',
    }

    const objectPath = await uploadDrawing(drawingId, strokeData)

    // Calculate metadata
    const metadata = {
      canvas_width: submission.canvas.width,
      canvas_height: submission.canvas.height,
      stroke_count: submission.strokes.length,
      point_count: submission.strokes.reduce((sum, s) => sum + s.points.length, 0),
      duration_ms: submission.duration_ms,
      device: submission.device || 'unknown',
    }

    // Insert drawing record
    await pool.query(
      `INSERT INTO drawings (id, user_id, shape_id, stroke_data_path, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [drawingId, userId, shapeId, objectPath, JSON.stringify(metadata)]
    )

    // Increment user's drawing count
    await pool.query(
      'UPDATE users SET total_drawings = total_drawings + 1, updated_at = NOW() WHERE id = $1',
      [userId]
    )

    // Invalidate caches (admin stats will be stale)
    await cacheDelete(CacheKeys.adminStats())
    await cacheDelete(CacheKeys.userStats(submission.sessionId))

    res.status(201).json({
      id: drawingId,
      message: 'Drawing saved successfully',
    })
  } catch (error) {
    console.error('Error saving drawing:', error)
    res.status(500).json({ error: 'Failed to save drawing' })
  }
})

// Get user stats (cached for 60 seconds)
app.get('/api/user/stats', async (req, res) => {
  try {
    const sessionId = req.query.sessionId as string

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' })
    }

    // Check cache first
    const cacheKey = CacheKeys.userStats(sessionId)
    const cached = await cacheGet<object>(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const result = await pool.query(
      `SELECT u.total_drawings,
              (SELECT COUNT(*) FROM drawings d WHERE d.user_id = u.id AND d.created_at > NOW() - INTERVAL '1 day') as today_count
       FROM users u
       WHERE u.session_id = $1`,
      [sessionId]
    )

    const stats = result.rows.length === 0
      ? { total_drawings: 0, today_count: 0 }
      : {
          total_drawings: result.rows[0].total_drawings,
          today_count: parseInt(result.rows[0].today_count),
        }

    // Cache for 60 seconds
    await cacheSet(cacheKey, stats, 60)

    res.json(stats)
  } catch (error) {
    console.error('Error fetching user stats:', error)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})
