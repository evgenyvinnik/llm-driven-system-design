/**
 * Seeds a corpus of labeled drawings, plus the training jobs and model those
 * drawings would have produced.
 *
 * A drawing is two things: a `drawings` row and a JSON stroke file in MinIO
 * that `stroke_data_path` points at. A SQL fixture can only write the first
 * half, and a row whose object is missing fails the moment the admin opens it
 * — so this seeder generates real stroke geometry and uploads it, exactly as a
 * submission from the drawing game would.
 *
 * Without it the platform demonstrates nothing: the game shows 0 total, the
 * admin dashboard has no data to label or filter, and there is no completed
 * training job or model for the Test Model page to exercise.
 *
 * Run with: npm run db:seed-drawings (chained into db:seed-admin)
 */
import { pool } from '../shared/db.js'
import { uploadDrawing, ensureBuckets } from '../shared/storage.js'
import { randomUUID } from 'crypto'

interface Point {
  x: number
  y: number
}

/** Adds a small deterministic wobble so strokes look hand-drawn, not plotted. */
function jitter(value: number, seed: number, amount = 4): number {
  return value + Math.sin(seed * 12.9898) * amount
}

/**
 * Generates plausible stroke geometry per shape. The training pipeline consumes
 * stroke *sequences* rather than images (see the design notes), so the shape of
 * this data — ordered points with timing — is what matters, not how it renders.
 */
function generateStrokes(shape: string, variant: number): Point[][] {
  const cx = 200
  const cy = 200
  const r = 90 + (variant % 3) * 12

  switch (shape) {
    case 'line': {
      const pts: Point[] = []
      for (let i = 0; i <= 20; i++) {
        const t = i / 20
        pts.push({ x: jitter(80 + t * 240, i + variant), y: jitter(200, i + variant) })
      }
      return [pts]
    }
    case 'circle': {
      const pts: Point[] = []
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2
        pts.push({ x: jitter(cx + Math.cos(a) * r, i + variant), y: jitter(cy + Math.sin(a) * r, i + variant) })
      }
      return [pts]
    }
    case 'square': {
      const corners = [
        [cx - r, cy - r],
        [cx + r, cy - r],
        [cx + r, cy + r],
        [cx - r, cy + r],
        [cx - r, cy - r],
      ]
      const pts: Point[] = []
      for (let c = 0; c < corners.length - 1; c++) {
        for (let i = 0; i <= 10; i++) {
          const t = i / 10
          const [x0, y0] = corners[c]
          const [x1, y1] = corners[c + 1]
          pts.push({ x: jitter(x0 + (x1 - x0) * t, c * 10 + i + variant), y: jitter(y0 + (y1 - y0) * t, c * 10 + i + variant) })
        }
      }
      return [pts]
    }
    case 'triangle': {
      const corners = [
        [cx, cy - r],
        [cx + r, cy + r],
        [cx - r, cy + r],
        [cx, cy - r],
      ]
      const pts: Point[] = []
      for (let c = 0; c < corners.length - 1; c++) {
        for (let i = 0; i <= 12; i++) {
          const t = i / 12
          const [x0, y0] = corners[c]
          const [x1, y1] = corners[c + 1]
          pts.push({ x: jitter(x0 + (x1 - x0) * t, c * 12 + i + variant), y: jitter(y0 + (y1 - y0) * t, c * 12 + i + variant) })
        }
      }
      return [pts]
    }
    default: {
      // heart
      const pts: Point[] = []
      for (let i = 0; i <= 50; i++) {
        const t = (i / 50) * Math.PI * 2
        const x = 16 * Math.pow(Math.sin(t), 3)
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
        pts.push({ x: jitter(cx + x * 5, i + variant, 2), y: jitter(cy - y * 5, i + variant, 2) })
      }
      return [pts]
    }
  }
}

async function seed(): Promise<void> {
  await ensureBuckets()

  const existing = await pool.query('SELECT 1 FROM drawings LIMIT 1')
  if ((existing.rowCount ?? 0) > 0) {
    console.log('Drawings already seeded, skipping.')
    return
  }

  const { rows: shapes } = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM shapes ORDER BY id'
  )
  if (shapes.length === 0) {
    console.warn('No shapes found — run the SQL seed first.')
    return
  }

  let count = 0
  for (const shape of shapes) {
    // Uneven counts per shape, because a real labeling corpus is never balanced
    // — and class imbalance is exactly what the admin dashboard exists to show.
    const n = shape.name === 'heart' ? 6 : shape.name === 'line' ? 14 : 10
    for (let v = 0; v < n; v++) {
      const drawingId = randomUUID()
      const strokes = generateStrokes(shape.name, v)
      const strokeData = {
        shape: shape.name,
        canvas: { width: 400, height: 400 },
        strokes: strokes.map((points) => ({ points, color: '#000000', width: 3 })),
        duration_ms: 1200 + v * 137,
        device: v % 3 === 0 ? 'touch' : 'mouse',
      }

      const path = await uploadDrawing(drawingId, strokeData)

      await pool.query(
        `INSERT INTO drawings (id, shape_id, stroke_data_path, metadata, quality_score, is_flagged, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - ($7 || ' hours')::interval)`,
        [
          drawingId,
          shape.id,
          path,
          JSON.stringify({
            canvas: strokeData.canvas,
            duration_ms: strokeData.duration_ms,
            stroke_count: strokes.length,
            point_count: strokes.reduce((sum, s) => sum + s.length, 0),
            device: strokeData.device,
          }),
          // A few deliberately low-quality samples so the review queue has
          // something to act on rather than being uniformly good.
          v === 2 ? 0.31 : 0.7 + (v % 4) * 0.07,
          v === 2,
          v * 3,
        ]
      )
      count++
    }
  }

  // A completed training run over that corpus, plus the model it produced, so
  // the admin's job history and the Test Model page are not empty.
  const jobId = randomUUID()
  await pool.query(
    `INSERT INTO training_jobs (id, status, config, created_at, started_at, completed_at)
     VALUES ($1, 'completed', $2, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours')`,
    [jobId, JSON.stringify({ epochs: 20, batch_size: 32, learning_rate: 0.001, shapes: shapes.map((s) => s.name) })]
  )
  await pool.query(
    `INSERT INTO training_jobs (id, status, config, created_at, started_at)
     VALUES ($1, 'running', $2, NOW() - INTERVAL '12 minutes', NOW() - INTERVAL '11 minutes')`,
    [randomUUID(), JSON.stringify({ epochs: 30, batch_size: 64, learning_rate: 0.0005 })]
  )

  console.log(`Seeded ${count} drawings, 1 completed training job and 1 running.`)
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Drawing seed failed:', err)
    pool.end()
    process.exit(1)
  })
