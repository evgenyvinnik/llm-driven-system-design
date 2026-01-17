import express from 'express'
import cors from 'cors'
import { pool } from '../shared/db.js'
import { publishTrainingJob } from '../shared/queue.js'
import { getDrawing } from '../shared/storage.js'
import { cacheGet, cacheSet, cacheDelete, CacheKeys } from '../shared/cache.js'
import { v4 as uuidv4 } from 'uuid'

const app = express()
const PORT = parseInt(process.env.PORT || '3002')

// Simple admin auth (in production, use proper auth)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token'

// Middleware
app.use(cors())
app.use(express.json())

// Auth middleware
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'admin' })
})

// Dashboard stats (cached for 30 seconds)
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    // Check cache first
    const cacheKey = CacheKeys.adminStats()
    const cached = await cacheGet<object>(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    // Total drawings
    const totalDrawings = await pool.query('SELECT COUNT(*) as count FROM drawings')

    // Drawings per shape
    const perShape = await pool.query(`
      SELECT s.name, COUNT(d.id) as count
      FROM shapes s
      LEFT JOIN drawings d ON d.shape_id = s.id
      GROUP BY s.id, s.name
      ORDER BY s.name
    `)

    // Flagged drawings
    const flagged = await pool.query(
      'SELECT COUNT(*) as count FROM drawings WHERE is_flagged = TRUE'
    )

    // Today's drawings
    const today = await pool.query(`
      SELECT COUNT(*) as count FROM drawings
      WHERE created_at > NOW() - INTERVAL '1 day'
    `)

    // Total users
    const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users')

    // Active model
    const activeModel = await pool.query(`
      SELECT id, version, accuracy, created_at
      FROM models WHERE is_active = TRUE
    `)

    // Recent training jobs
    const recentJobs = await pool.query(`
      SELECT id, status, created_at, completed_at,
             metrics->>'accuracy' as accuracy
      FROM training_jobs
      ORDER BY created_at DESC
      LIMIT 5
    `)

    const stats = {
      total_drawings: parseInt(totalDrawings.rows[0].count),
      drawings_per_shape: perShape.rows,
      flagged_count: parseInt(flagged.rows[0].count),
      today_count: parseInt(today.rows[0].count),
      total_users: parseInt(totalUsers.rows[0].count),
      active_model: activeModel.rows[0] || null,
      recent_jobs: recentJobs.rows,
    }

    // Cache for 30 seconds
    await cacheSet(cacheKey, stats, 30)

    res.json(stats)
  } catch (error) {
    console.error('Error fetching stats:', error)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

// List drawings with pagination and filters
app.get('/api/admin/drawings', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = (page - 1) * limit
    const shape = req.query.shape as string
    const flagged = req.query.flagged === 'true'

    let whereClause = 'WHERE 1=1'
    const params: (string | boolean | number)[] = []

    if (shape) {
      params.push(shape)
      whereClause += ` AND s.name = $${params.length}`
    }

    if (flagged) {
      whereClause += ' AND d.is_flagged = TRUE'
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      ${whereClause}
    `
    const countResult = await pool.query(countQuery, params)
    const total = parseInt(countResult.rows[0].count)

    // Get drawings
    params.push(limit, offset)
    const query = `
      SELECT d.id, d.stroke_data_path, d.metadata, d.quality_score,
             d.is_flagged, d.created_at, s.name as shape
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `

    const result = await pool.query(query, params)

    res.json({
      drawings: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Error fetching drawings:', error)
    res.status(500).json({ error: 'Failed to fetch drawings' })
  }
})

// Flag/unflag a drawing
app.post('/api/admin/drawings/:id/flag', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { flagged } = req.body

    await pool.query(
      'UPDATE drawings SET is_flagged = $1 WHERE id = $2',
      [flagged !== false, id]
    )

    // Invalidate stats cache since flagged count changed
    await cacheDelete(CacheKeys.adminStats())

    res.json({ success: true })
  } catch (error) {
    console.error('Error flagging drawing:', error)
    res.status(500).json({ error: 'Failed to flag drawing' })
  }
})

// Get stroke data for a drawing
app.get('/api/admin/drawings/:id/strokes', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Get the stroke data path from the database
    const result = await pool.query(
      'SELECT stroke_data_path FROM drawings WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drawing not found' })
    }

    const strokeDataPath = result.rows[0].stroke_data_path

    // Fetch from MinIO
    const strokeData = await getDrawing(strokeDataPath)

    res.json(strokeData)
  } catch (error) {
    console.error('Error fetching stroke data:', error)
    res.status(500).json({ error: 'Failed to fetch stroke data' })
  }
})

// Start a training job
app.post('/api/admin/training/start', requireAdmin, async (req, res) => {
  try {
    const config = req.body.config || {}

    // Create training job record
    const jobId = uuidv4()
    await pool.query(
      `INSERT INTO training_jobs (id, status, config)
       VALUES ($1, 'queued', $2)`,
      [jobId, JSON.stringify(config)]
    )

    // Publish to queue
    await publishTrainingJob(jobId, config)

    res.status(201).json({
      id: jobId,
      status: 'queued',
      message: 'Training job queued',
    })
  } catch (error) {
    console.error('Error starting training job:', error)
    res.status(500).json({ error: 'Failed to start training job' })
  }
})

// Get training job status
app.get('/api/admin/training/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `SELECT id, status, config, error_message, started_at, completed_at, metrics, model_path
       FROM training_jobs WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Training job not found' })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching training job:', error)
    res.status(500).json({ error: 'Failed to fetch training job' })
  }
})

// List all training jobs
app.get('/api/admin/training', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, status, config, started_at, completed_at,
             metrics->>'accuracy' as accuracy
      FROM training_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `)

    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching training jobs:', error)
    res.status(500).json({ error: 'Failed to fetch training jobs' })
  }
})

// List models
app.get('/api/admin/models', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.version, m.is_active, m.accuracy, m.model_path, m.created_at,
             tj.config as training_config
      FROM models m
      LEFT JOIN training_jobs tj ON m.training_job_id = tj.id
      ORDER BY m.created_at DESC
    `)

    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching models:', error)
    res.status(500).json({ error: 'Failed to fetch models' })
  }
})

// Activate a model
app.post('/api/admin/models/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Deactivate all models first
    await pool.query('UPDATE models SET is_active = FALSE')

    // Activate the selected model
    await pool.query('UPDATE models SET is_active = TRUE WHERE id = $1', [id])

    res.json({ success: true, message: 'Model activated' })
  } catch (error) {
    console.error('Error activating model:', error)
    res.status(500).json({ error: 'Failed to activate model' })
  }
})

// Start server
app.listen(PORT, () => {
  console.log(`Admin service running on http://localhost:${PORT}`)
})
