/**
 * Prototype computation utilities for shape generation.
 * Computes "average" shapes from training data by normalizing and averaging stroke coordinates.
 * Used to generate representative drawings for each shape class.
 *
 * @module shared/prototype
 */

import { pool } from './db.js'
import { getDrawing } from './storage.js'
import { logger } from './logger.js'

/**
 * Shape names supported for prototype generation.
 */
export const SHAPE_NAMES = ['circle', 'heart', 'line', 'square', 'triangle']

/**
 * A point in a stroke with normalized coordinates (0-1).
 */
interface NormalizedPoint {
  x: number
  y: number
}

/**
 * A stroke with normalized points.
 */
interface NormalizedStroke {
  points: NormalizedPoint[]
  color: string
  width: number
}

/**
 * Prototype strokes for a single shape class.
 */
export interface ShapePrototype {
  shape: string
  strokes: NormalizedStroke[]
  sampleCount: number
}

/**
 * Complete prototype data for all shape classes.
 */
export interface PrototypeData {
  prototypes: Record<string, ShapePrototype>
  generatedAt: string
}

/**
 * Fetches high-quality drawings for a specific shape.
 *
 * @param shapeName - The shape class to fetch drawings for
 * @param limit - Maximum number of drawings to fetch
 * @returns Array of drawing metadata with stroke paths
 */
async function fetchDrawingsForShape(shapeName: string, limit = 50) {
  const result = await pool.query(
    `
    SELECT d.id, d.stroke_data_path, d.quality_score
    FROM drawings d
    JOIN shapes s ON d.shape_id = s.id
    WHERE s.name = $1
      AND d.deleted_at IS NULL
      AND d.is_flagged = FALSE
      AND d.quality_score >= 50
    ORDER BY d.quality_score DESC, d.created_at DESC
    LIMIT $2
    `,
    [shapeName, limit]
  )

  return result.rows
}

/**
 * Normalizes stroke coordinates to 0-1 range.
 *
 * @param strokes - Raw stroke data
 * @param canvas - Canvas dimensions
 * @returns Normalized strokes
 */
function normalizeStrokes(
  strokes: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }>,
  canvas: { width: number; height: number }
): NormalizedStroke[] {
  return strokes.map((stroke) => ({
    points: stroke.points.map((p) => ({
      x: p.x / canvas.width,
      y: p.y / canvas.height,
    })),
    color: stroke.color,
    width: stroke.width,
  }))
}

/**
 * Denormalizes strokes back to pixel coordinates.
 *
 * @param strokes - Normalized strokes
 * @param canvas - Target canvas dimensions
 * @returns Strokes with pixel coordinates
 */
export function denormalizeStrokes(
  strokes: NormalizedStroke[],
  canvas: { width: number; height: number }
): Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }> {
  return strokes.map((stroke) => ({
    points: stroke.points.map((p) => ({
      x: p.x * canvas.width,
      y: p.y * canvas.height,
    })),
    color: stroke.color,
    width: stroke.width,
  }))
}

/**
 * Resamples a stroke to have a fixed number of points.
 * Uses linear interpolation along the path.
 *
 * @param points - Original points
 * @param targetCount - Desired number of points
 * @returns Resampled points
 */
function resamplePoints(points: NormalizedPoint[], targetCount: number): NormalizedPoint[] {
  if (points.length < 2) return points
  if (points.length === targetCount) return points

  // Calculate total path length
  let totalLength = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    totalLength += Math.sqrt(dx * dx + dy * dy)
  }

  if (totalLength === 0) return points

  const segmentLength = totalLength / (targetCount - 1)
  const resampled: NormalizedPoint[] = [points[0]]

  let currentLength = 0
  let pointIndex = 0

  for (let i = 1; i < targetCount - 1; i++) {
    const targetLength = i * segmentLength

    while (pointIndex < points.length - 1) {
      const dx = points[pointIndex + 1].x - points[pointIndex].x
      const dy = points[pointIndex + 1].y - points[pointIndex].y
      const segLen = Math.sqrt(dx * dx + dy * dy)

      if (currentLength + segLen >= targetLength) {
        const t = (targetLength - currentLength) / segLen
        resampled.push({
          x: points[pointIndex].x + dx * t,
          y: points[pointIndex].y + dy * t,
        })
        break
      }

      currentLength += segLen
      pointIndex++
    }
  }

  resampled.push(points[points.length - 1])
  return resampled
}

/**
 * Averages multiple strokes with the same number of points.
 *
 * @param allStrokes - Array of stroke arrays to average
 * @param weights - Optional quality weights for each drawing
 * @returns Averaged strokes
 */
function averageNormalizedStrokes(
  allStrokes: NormalizedStroke[][],
  weights?: number[]
): NormalizedStroke[] {
  if (allStrokes.length === 0) return []

  // Use first drawing's structure as template
  const template = allStrokes[0]
  const result: NormalizedStroke[] = []

  // Normalize weights
  const totalWeight = weights ? weights.reduce((a, b) => a + b, 0) : allStrokes.length
  const normalizedWeights = weights
    ? weights.map((w) => w / totalWeight)
    : allStrokes.map(() => 1 / allStrokes.length)

  for (let strokeIdx = 0; strokeIdx < template.length; strokeIdx++) {
    const targetPointCount = 64 // Fixed point count for averaging

    // Resample all corresponding strokes
    const resampledStrokes = allStrokes
      .filter((strokes) => strokes[strokeIdx])
      .map((strokes, idx) => ({
        points: resamplePoints(strokes[strokeIdx].points, targetPointCount),
        weight: normalizedWeights[idx],
      }))

    if (resampledStrokes.length === 0) continue

    // Average the points
    const avgPoints: NormalizedPoint[] = []
    for (let pointIdx = 0; pointIdx < targetPointCount; pointIdx++) {
      let sumX = 0
      let sumY = 0
      let sumWeight = 0

      for (const { points, weight } of resampledStrokes) {
        if (points[pointIdx]) {
          sumX += points[pointIdx].x * weight
          sumY += points[pointIdx].y * weight
          sumWeight += weight
        }
      }

      if (sumWeight > 0) {
        avgPoints.push({
          x: sumX / sumWeight,
          y: sumY / sumWeight,
        })
      }
    }

    result.push({
      points: avgPoints,
      color: '#000000',
      width: 3,
    })
  }

  return result
}

/**
 * Generates a procedural fallback shape when no training data is available.
 *
 * @param shapeName - The shape to generate
 * @returns Procedural strokes for the shape
 */
function generateProceduralShape(shapeName: string): NormalizedStroke[] {
  const centerX = 0.5
  const centerY = 0.5
  const radius = 0.3

  switch (shapeName) {
    case 'circle': {
      const points: NormalizedPoint[] = []
      for (let i = 0; i <= 64; i++) {
        const angle = (i / 64) * 2 * Math.PI
        points.push({
          x: centerX + radius * Math.cos(angle),
          y: centerY + radius * Math.sin(angle),
        })
      }
      return [{ points, color: '#000000', width: 3 }]
    }

    case 'square': {
      const size = 0.4
      const half = size / 2
      return [
        {
          points: [
            { x: centerX - half, y: centerY - half },
            { x: centerX + half, y: centerY - half },
            { x: centerX + half, y: centerY + half },
            { x: centerX - half, y: centerY + half },
            { x: centerX - half, y: centerY - half },
          ],
          color: '#000000',
          width: 3,
        },
      ]
    }

    case 'triangle': {
      const size = 0.4
      return [
        {
          points: [
            { x: centerX, y: centerY - size },
            { x: centerX + size * 0.866, y: centerY + size * 0.5 },
            { x: centerX - size * 0.866, y: centerY + size * 0.5 },
            { x: centerX, y: centerY - size },
          ],
          color: '#000000',
          width: 3,
        },
      ]
    }

    case 'line': {
      return [
        {
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.8, y: 0.8 },
          ],
          color: '#000000',
          width: 3,
        },
      ]
    }

    case 'heart': {
      const points: NormalizedPoint[] = []
      // Parametric heart curve
      for (let t = 0; t <= 1; t += 0.02) {
        const angle = t * 2 * Math.PI
        const x = 16 * Math.pow(Math.sin(angle), 3)
        const y =
          13 * Math.cos(angle) -
          5 * Math.cos(2 * angle) -
          2 * Math.cos(3 * angle) -
          Math.cos(4 * angle)
        // Normalize to 0-1 range (heart curve goes from -16 to 16 in x, -17 to 12 in y)
        points.push({
          x: centerX + (x / 40) * 0.6,
          y: centerY - (y / 40) * 0.6,
        })
      }
      return [{ points, color: '#000000', width: 3 }]
    }

    default:
      return []
  }
}

/**
 * Computes prototypes for all shape classes by averaging training data.
 *
 * @param samplesPerShape - Number of drawings to sample per shape
 * @returns Prototype data for all shapes
 */
export async function computePrototypes(samplesPerShape = 50): Promise<PrototypeData> {
  const prototypes: Record<string, ShapePrototype> = {}

  for (const shapeName of SHAPE_NAMES) {
    try {
      // Fetch high-quality drawings for this shape
      const drawings = await fetchDrawingsForShape(shapeName, samplesPerShape)

      if (drawings.length < 3) {
        // Not enough data, use procedural fallback
        logger.info({
          msg: 'Using procedural fallback for shape',
          shape: shapeName,
          drawingCount: drawings.length,
        })

        prototypes[shapeName] = {
          shape: shapeName,
          strokes: generateProceduralShape(shapeName),
          sampleCount: 0,
        }
        continue
      }

      // Fetch stroke data from MinIO
      const allNormalizedStrokes: NormalizedStroke[][] = []
      const weights: number[] = []

      for (const drawing of drawings) {
        try {
          const strokeData = await getDrawing(drawing.stroke_data_path)
          const canvas = strokeData.canvas || { width: 400, height: 400 }
          const normalized = normalizeStrokes(strokeData.strokes, canvas)
          allNormalizedStrokes.push(normalized)
          weights.push(drawing.quality_score || 50)
        } catch (err) {
          // Skip drawings that fail to load
          logger.warn({
            msg: 'Failed to load drawing for prototype',
            drawingId: drawing.id,
            error: (err as Error).message,
          })
        }
      }

      if (allNormalizedStrokes.length < 3) {
        prototypes[shapeName] = {
          shape: shapeName,
          strokes: generateProceduralShape(shapeName),
          sampleCount: allNormalizedStrokes.length,
        }
        continue
      }

      // Average the strokes
      const averagedStrokes = averageNormalizedStrokes(allNormalizedStrokes, weights)

      prototypes[shapeName] = {
        shape: shapeName,
        strokes: averagedStrokes.length > 0 ? averagedStrokes : generateProceduralShape(shapeName),
        sampleCount: allNormalizedStrokes.length,
      }

      logger.info({
        msg: 'Computed prototype for shape',
        shape: shapeName,
        sampleCount: allNormalizedStrokes.length,
        strokeCount: prototypes[shapeName].strokes.length,
      })
    } catch (err) {
      logger.error({
        msg: 'Failed to compute prototype for shape',
        shape: shapeName,
        error: (err as Error).message,
      })

      // Use procedural fallback on error
      prototypes[shapeName] = {
        shape: shapeName,
        strokes: generateProceduralShape(shapeName),
        sampleCount: 0,
      }
    }
  }

  return {
    prototypes,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Adds slight random variation to strokes for more natural generation.
 *
 * @param strokes - Input strokes
 * @param jitter - Amount of random jitter (0-1 range)
 * @returns Strokes with added variation
 */
export function addVariation(strokes: NormalizedStroke[], jitter = 0.02): NormalizedStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((p) => ({
      x: p.x + (Math.random() - 0.5) * jitter,
      y: p.y + (Math.random() - 0.5) * jitter,
    })),
  }))
}
