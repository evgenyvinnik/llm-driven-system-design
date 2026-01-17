/**
 * Inference service for ML model predictions.
 * Provides API endpoints for classifying drawings using trained models.
 * Currently uses heuristic-based classification; replace with actual ML inference in production.
 *
 * Enhanced with:
 * - Structured JSON logging for debugging and alerting
 * - Prometheus metrics for observability
 * - Health checks for container orchestration
 * - Circuit breakers for database resilience
 *
 * @module inference
 */

import express from 'express'
import cors from 'cors'
import { pool } from '../shared/db.js'
import { getModel } from '../shared/storage.js'
import {
  SHAPE_NAMES as PROTOTYPE_SHAPE_NAMES,
  denormalizeStrokes,
  addVariation,
  type ShapePrototype,
  type PrototypeData,
} from '../shared/prototype.js'

// New shared modules
import { logger, createChildLogger, logError } from '../shared/logger.js'
import { postgresCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { metricsMiddleware, metricsHandler, inferenceRequestsTotal, inferenceLatency, generationRequestsTotal, generationLatency, trackExternalCall } from '../shared/metrics.js'
import { healthCheckRouter } from '../shared/healthCheck.js'

const app = express()

/** Port for the inference service (default: 3003) */
const PORT = parseInt(process.env.PORT || '3003')

// Set service name for logging
process.env.SERVICE_NAME = 'inference'

/** Shape class names - must match training data order */
const SHAPE_NAMES = ['circle', 'heart', 'line', 'square', 'triangle']

// Middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// Prometheus metrics middleware (must be before routes)
app.use(metricsMiddleware())

// Health check endpoints
app.use(healthCheckRouter())

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler)

/**
 * GET /api/inference/model/info - Returns information about the active model.
 * Returns 404 if no model is active (train and activate one first).
 */
app.get('/api/inference/model/info', async (req, res) => {
  const reqLogger = createChildLogger({
    requestId: req.headers['x-request-id'] || Date.now().toString(),
    endpoint: '/api/inference/model/info',
  })

  try {
    const result = await postgresCircuitBreaker.execute(async () => {
      return trackExternalCall('postgres', 'select_active_model', async () => {
        return pool.query(`
          SELECT m.id, m.version, m.accuracy, m.model_path, m.created_at,
                 tj.config as training_config,
                 tj.metrics as training_metrics
          FROM models m
          LEFT JOIN training_jobs tj ON m.training_job_id = tj.id
          WHERE m.is_active = TRUE
        `)
      })
    })

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'No active model',
        message: 'Train a model first, then activate it',
      })
    }

    const model = result.rows[0]
    reqLogger.debug({ msg: 'Returned active model info', modelId: model.id })

    res.json({
      id: model.id,
      version: model.version,
      accuracy: model.accuracy,
      created_at: model.created_at,
      class_names: SHAPE_NAMES,
    })
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
    }

    logError(error as Error, { endpoint: '/api/inference/model/info' })
    res.status(500).json({ error: 'Failed to fetch model info' })
  }
})

/**
 * POST /api/inference/classify - Classifies a drawing.
 * Accepts stroke data and returns predicted shape with confidence scores.
 * Note: Currently uses heuristic analysis. For production, integrate actual ML model.
 */
app.post('/api/inference/classify', async (req, res) => {
  const startTime = Date.now()
  const reqLogger = createChildLogger({
    requestId: req.headers['x-request-id'] || Date.now().toString(),
    endpoint: '/api/inference/classify',
  })

  try {
    const { strokes, canvas } = req.body

    if (!strokes || !Array.isArray(strokes)) {
      return res.status(400).json({ error: 'Missing strokes data' })
    }

    // Check if we have an active model
    let activeModel: { id: string; version: string; model_path: string }
    try {
      const modelResult = await postgresCircuitBreaker.execute(async () => {
        return trackExternalCall('postgres', 'select_active_model', async () => {
          return pool.query(
            'SELECT id, version, model_path FROM models WHERE is_active = TRUE'
          )
        })
      })

      if (modelResult.rows.length === 0) {
        return res.status(503).json({
          error: 'No active model',
          message: 'Train and activate a model first',
        })
      }

      activeModel = modelResult.rows[0]
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        })
      }
      throw error
    }

    // In a real implementation, you would:
    // 1. Convert strokes to 64x64 image
    // 2. Load the model (cached in memory)
    // 3. Run inference
    // 4. Return predictions

    // For demo purposes, we'll return a mock prediction
    // based on simple heuristics

    const prediction = analyzeStrokes(strokes, canvas)

    // Simulate inference time
    await new Promise((resolve) => setTimeout(resolve, 50))
    const inferenceTime = Date.now() - startTime

    // Record metrics
    inferenceRequestsTotal.labels(activeModel.version, prediction.shape).inc()
    inferenceLatency.labels(activeModel.version).observe(inferenceTime / 1000)

    reqLogger.info({
      msg: 'Classification complete',
      predictedShape: prediction.shape,
      confidence: prediction.confidence,
      inferenceTimeMs: inferenceTime,
      modelVersion: activeModel.version,
    })

    res.json({
      prediction: prediction.shape,
      confidence: prediction.confidence,
      all_probabilities: prediction.probabilities,
      class_names: SHAPE_NAMES,
      model_version: activeModel.version,
      inference_time_ms: inferenceTime,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/inference/classify' })
    res.status(500).json({ error: 'Failed to classify drawing' })
  }
})

/**
 * POST /api/inference/generate - Generates a drawing for a given shape class.
 * Returns stroke data that can be rendered on a canvas.
 * Uses prototype strokes computed from training data or procedural fallbacks.
 */
app.post('/api/inference/generate', async (req, res) => {
  const startTime = Date.now()
  const reqLogger = createChildLogger({
    requestId: req.headers['x-request-id'] || Date.now().toString(),
    endpoint: '/api/inference/generate',
  })

  try {
    const { shape } = req.body

    if (!shape || typeof shape !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid shape parameter' })
    }

    if (!SHAPE_NAMES.includes(shape)) {
      return res.status(400).json({
        error: 'Invalid shape class',
        valid_classes: SHAPE_NAMES,
      })
    }

    // Check if we have an active model
    let activeModel: { id: string; version: string; config: PrototypeData | null }
    try {
      const modelResult = await postgresCircuitBreaker.execute(async () => {
        return trackExternalCall('postgres', 'select_active_model', async () => {
          return pool.query(
            'SELECT id, version, config FROM models WHERE is_active = TRUE'
          )
        })
      })

      if (modelResult.rows.length === 0) {
        return res.status(503).json({
          error: 'No active model',
          message: 'Train and activate a model first',
        })
      }

      activeModel = modelResult.rows[0]
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        })
      }
      throw error
    }

    // Get prototype strokes for the requested shape
    const canvas = { width: 400, height: 400 }
    let strokes: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }>

    // Check if model has prototype data
    const prototypeData = activeModel.config as PrototypeData | null
    if (prototypeData?.prototypes?.[shape]) {
      // Use prototype from training data
      const prototype = prototypeData.prototypes[shape]
      const withVariation = addVariation(prototype.strokes, 0.015)
      strokes = denormalizeStrokes(withVariation, canvas)

      reqLogger.info({
        msg: 'Generated shape from prototype',
        shape,
        sampleCount: prototype.sampleCount,
        modelVersion: activeModel.version,
      })
    } else {
      // Use procedural fallback
      strokes = generateProceduralStrokes(shape, canvas)

      reqLogger.info({
        msg: 'Generated shape using procedural fallback',
        shape,
        modelVersion: activeModel.version,
      })
    }

    const generationTime = Date.now() - startTime

    // Record metrics
    generationRequestsTotal.labels(activeModel.version, shape).inc()
    generationLatency.labels(activeModel.version).observe(generationTime / 1000)

    res.json({
      shape,
      strokes,
      canvas,
      generation_time_ms: generationTime,
      model_version: activeModel.version,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/inference/generate' })
    res.status(500).json({ error: 'Failed to generate shape' })
  }
})

/**
 * Generates procedural strokes for a shape when no prototype data is available.
 * Used as a fallback when the model hasn't been trained with enough data.
 *
 * @param shape - Shape name to generate
 * @param canvas - Canvas dimensions
 * @returns Array of strokes with pixel coordinates
 */
function generateProceduralStrokes(
  shape: string,
  canvas: { width: number; height: number }
): Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }> {
  const centerX = canvas.width / 2
  const centerY = canvas.height / 2
  const radius = Math.min(canvas.width, canvas.height) * 0.3

  switch (shape) {
    case 'circle': {
      const points: Array<{ x: number; y: number }> = []
      for (let i = 0; i <= 64; i++) {
        const angle = (i / 64) * 2 * Math.PI
        points.push({
          x: centerX + radius * Math.cos(angle) + (Math.random() - 0.5) * 3,
          y: centerY + radius * Math.sin(angle) + (Math.random() - 0.5) * 3,
        })
      }
      return [{ points, color: '#000000', width: 3 }]
    }

    case 'square': {
      const half = radius
      const jitter = () => (Math.random() - 0.5) * 3
      return [
        {
          points: [
            { x: centerX - half + jitter(), y: centerY - half + jitter() },
            { x: centerX + half + jitter(), y: centerY - half + jitter() },
            { x: centerX + half + jitter(), y: centerY + half + jitter() },
            { x: centerX - half + jitter(), y: centerY + half + jitter() },
            { x: centerX - half + jitter(), y: centerY - half + jitter() },
          ],
          color: '#000000',
          width: 3,
        },
      ]
    }

    case 'triangle': {
      const jitter = () => (Math.random() - 0.5) * 3
      return [
        {
          points: [
            { x: centerX + jitter(), y: centerY - radius + jitter() },
            { x: centerX + radius * 0.866 + jitter(), y: centerY + radius * 0.5 + jitter() },
            { x: centerX - radius * 0.866 + jitter(), y: centerY + radius * 0.5 + jitter() },
            { x: centerX + jitter(), y: centerY - radius + jitter() },
          ],
          color: '#000000',
          width: 3,
        },
      ]
    }

    case 'line': {
      const jitter = () => (Math.random() - 0.5) * 3
      const points: Array<{ x: number; y: number }> = []
      for (let i = 0; i <= 20; i++) {
        const t = i / 20
        points.push({
          x: canvas.width * 0.2 + t * canvas.width * 0.6 + jitter(),
          y: canvas.height * 0.2 + t * canvas.height * 0.6 + jitter(),
        })
      }
      return [{ points, color: '#000000', width: 3 }]
    }

    case 'heart': {
      const points: Array<{ x: number; y: number }> = []
      const scale = radius * 0.8
      for (let t = 0; t <= 1; t += 0.02) {
        const angle = t * 2 * Math.PI
        const x = 16 * Math.pow(Math.sin(angle), 3)
        const y =
          13 * Math.cos(angle) -
          5 * Math.cos(2 * angle) -
          2 * Math.cos(3 * angle) -
          Math.cos(4 * angle)
        points.push({
          x: centerX + (x / 16) * scale + (Math.random() - 0.5) * 3,
          y: centerY - (y / 16) * scale + (Math.random() - 0.5) * 3,
        })
      }
      return [{ points, color: '#000000', width: 3 }]
    }

    default:
      return []
  }
}

/**
 * Represents a point in a stroke.
 */
interface StrokePoint {
  x: number
  y: number
}

/**
 * Represents a stroke with its points.
 */
interface Stroke {
  points: StrokePoint[]
}

/**
 * Canvas dimensions.
 */
interface Canvas {
  width: number
  height: number
}

/**
 * Analyzes stroke data using heuristics to predict the drawn shape.
 * This is a placeholder for real ML inference - uses bounding box aspect ratio,
 * stroke count, and other simple features to make predictions.
 *
 * @param strokes - Array of strokes from the drawing
 * @param canvas - Canvas dimensions
 * @returns Prediction with shape name, confidence, and all class probabilities
 */
function analyzeStrokes(strokes: Stroke[], canvas: Canvas) {
  const allPoints: StrokePoint[] = strokes.flatMap((s) => s.points)

  if (allPoints.length < 2) {
    return {
      shape: 'line',
      confidence: 0.5,
      probabilities: SHAPE_NAMES.map((name) => ({
        class: name,
        probability: name === 'line' ? 0.5 : 0.125,
      })),
    }
  }

  // Calculate bounding box
  const xs = allPoints.map((p) => p.x)
  const ys = allPoints.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = maxX - minX
  const height = maxY - minY

  // Calculate aspect ratio
  const aspectRatio = width / (height || 1)

  // Count strokes
  const strokeCount = strokes.length

  // Analyze shape based on simple heuristics
  const probabilities: Record<string, number> = {
    line: 0.1,
    circle: 0.1,
    square: 0.1,
    triangle: 0.1,
    heart: 0.1,
  }

  // Line detection: high aspect ratio or very few strokes with straight path
  if (aspectRatio > 3 || aspectRatio < 0.33) {
    probabilities.line += 0.4
  }

  // Circle detection: roughly square bounding box, one stroke
  if (aspectRatio > 0.8 && aspectRatio < 1.2 && strokeCount === 1) {
    probabilities.circle += 0.4
  }

  // Square detection: roughly square bounding box, 4+ strokes or sharp corners
  if (aspectRatio > 0.8 && aspectRatio < 1.2 && strokeCount >= 1) {
    probabilities.square += 0.2
  }

  // Triangle detection: 3 strokes or triangular distribution
  if (strokeCount === 3 || strokeCount === 1) {
    probabilities.triangle += 0.2
  }

  // Heart detection: 2 strokes typically, wider at top
  if (strokeCount <= 2) {
    probabilities.heart += 0.2
  }

  // Normalize probabilities
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0)
  for (const key of Object.keys(probabilities)) {
    probabilities[key] /= total
  }

  // Find best prediction
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const bestShape = sorted[0][0]
  const bestConfidence = sorted[0][1]

  return {
    shape: bestShape,
    confidence: bestConfidence,
    probabilities: SHAPE_NAMES.map((name) => ({
      class: name,
      probability: probabilities[name] || 0,
    })),
  }
}

// Start server
app.listen(PORT, () => {
  logger.info({
    msg: 'Inference service started',
    port: PORT,
    env: process.env.NODE_ENV || 'development',
  })
})
