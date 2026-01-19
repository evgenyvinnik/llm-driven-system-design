/**
 * Quality analysis routes for the admin service.
 * Handles batch quality analysis and quality statistics.
 * @module admin/quality
 */

import { Router, Request, Response } from 'express'
import { pool } from '../shared/db.js'
import { getDrawing } from '../shared/storage.js'
import { cacheDelete, CacheKeys } from '../shared/cache.js'
import { createChildLogger, logError } from '../shared/logger.js'
import { scoreDrawing, type StrokeData } from '../shared/quality.js'
import { requireAdmin } from './auth.js'

const router = Router()

/**
 * POST /api/admin/quality/analyze-batch - Batch analyzes quality of unscored drawings.
 *
 * @description Fetches drawings without quality scores and runs quality analysis.
 *   Can optionally persist scores to the database and auto-flag drawings below
 *   a minimum threshold. Use updateScores=false for a dry run.
 *
 * @route POST /api/admin/quality/analyze-batch
 *
 * @param {Request} req - Express request with body containing:
 *   - minScore {number} [optional] - Auto-flag drawings below this score
 *   - limit {number} [default=100] - Maximum drawings to analyze
 *   - updateScores {boolean} [default=false] - Persist scores to database
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Batch analysis results with summary statistics
 * @returns {object} 500 - If analysis fails
 *
 * @example
 * // Request body
 * { "minScore": 50, "limit": 50, "updateScores": true }
 *
 * // Success response
 * {
 *   "analyzed": 50,
 *   "failed": 2,
 *   "passed": 35,
 *   "avgScore": 62.5,
 *   "flagged": 10,
 *   "results": [{ "id": "uuid", "shape": "circle", "score": 75, "passed": true }],
 *   "errors": [{ "id": "uuid", "error": "Failed to fetch stroke data" }],
 *   "message": "Analyzed 50 drawings, updated scores, flagged 10 low quality"
 * }
 */
router.post('/analyze-batch', requireAdmin, async (req: Request, res: Response) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/quality/analyze-batch' })

  try {
    const { minScore, limit = 100, updateScores = false } = req.body

    // Fetch drawings that need quality analysis (null quality_score)
    const query = `
      SELECT d.id, d.stroke_data_path, s.name as shape
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      WHERE d.quality_score IS NULL AND d.deleted_at IS NULL
      LIMIT $1
    `
    const result = await pool.query(query, [limit])

    const analyzed: {
      id: string
      shape: string
      score: number
      passed: boolean
      recommendation: string
    }[] = []

    const failed: { id: string; error: string }[] = []

    for (const drawing of result.rows) {
      try {
        // Fetch stroke data
        const strokeData = await getDrawing(drawing.stroke_data_path) as StrokeData

        // Score the drawing
        const quality = scoreDrawing(strokeData)

        analyzed.push({
          id: drawing.id,
          shape: drawing.shape,
          score: quality.score,
          passed: quality.passed,
          recommendation: quality.recommendation,
        })

        // Update quality score in database if requested
        if (updateScores) {
          await pool.query(
            'UPDATE drawings SET quality_score = $1 WHERE id = $2',
            [quality.score, drawing.id]
          )
        }
      } catch (error) {
        failed.push({
          id: drawing.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    // Compute summary statistics
    const passedCount = analyzed.filter((d) => d.passed).length
    const avgScore = analyzed.length > 0
      ? analyzed.reduce((sum, d) => sum + d.score, 0) / analyzed.length
      : 0

    // If minScore is provided, auto-flag low quality drawings
    let flaggedCount = 0
    if (minScore !== undefined && updateScores) {
      const lowQuality = analyzed.filter((d) => d.score < minScore)
      for (const drawing of lowQuality) {
        await pool.query(
          'UPDATE drawings SET is_flagged = TRUE WHERE id = $1',
          [drawing.id]
        )
        flaggedCount++
      }
      if (flaggedCount > 0) {
        await cacheDelete(CacheKeys.adminStats())
      }
    }

    reqLogger.info({
      msg: 'Batch quality analysis complete',
      analyzed: analyzed.length,
      failed: failed.length,
      flagged: flaggedCount,
    })

    res.json({
      analyzed: analyzed.length,
      failed: failed.length,
      passed: passedCount,
      avgScore: Math.round(avgScore * 10) / 10,
      flagged: flaggedCount,
      results: analyzed,
      errors: failed,
      message: updateScores
        ? `Analyzed ${analyzed.length} drawings, updated scores${flaggedCount > 0 ? `, flagged ${flaggedCount} low quality` : ''}`
        : `Analyzed ${analyzed.length} drawings (dry run, scores not saved)`,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/quality/analyze-batch' })
    res.status(500).json({ error: 'Failed to analyze drawings' })
  }
})

/**
 * GET /api/admin/quality/stats - Returns quality score statistics.
 *
 * @description Aggregates quality metrics across all drawings including:
 *   - Distribution across quality tiers (high/medium/low/unscored)
 *   - Average quality score per shape
 *   - Count of unscored drawings pending analysis
 *
 * @route GET /api/admin/quality/stats
 *
 * @param {Request} _req - Express request (unused, auth handled by middleware)
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Quality statistics object
 * @returns {object} 500 - If fetching statistics fails
 *
 * @example
 * // Success response
 * {
 *   "distribution": [
 *     { "quality_tier": "high", "count": "150" },
 *     { "quality_tier": "medium", "count": "200" },
 *     { "quality_tier": "low", "count": "50" },
 *     { "quality_tier": "unscored", "count": "100" }
 *   ],
 *   "perShape": [
 *     { "shape": "circle", "avgScore": 72.5, "count": 120 },
 *     { "shape": "square", "avgScore": 68.3, "count": 85 }
 *   ],
 *   "unscoredCount": 100
 * }
 */
router.get('/stats', requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Overall quality score distribution
    const distribution = await pool.query(`
      SELECT
        CASE
          WHEN quality_score >= 70 THEN 'high'
          WHEN quality_score >= 50 THEN 'medium'
          WHEN quality_score IS NOT NULL THEN 'low'
          ELSE 'unscored'
        END as quality_tier,
        COUNT(*) as count
      FROM drawings
      WHERE deleted_at IS NULL
      GROUP BY quality_tier
    `)

    // Average score per shape
    const perShape = await pool.query(`
      SELECT s.name as shape, AVG(d.quality_score) as avg_score, COUNT(d.id) as count
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      WHERE d.quality_score IS NOT NULL AND d.deleted_at IS NULL
      GROUP BY s.name
      ORDER BY s.name
    `)

    // Unscored count
    const unscored = await pool.query(`
      SELECT COUNT(*) as count
      FROM drawings
      WHERE quality_score IS NULL AND deleted_at IS NULL
    `)

    res.json({
      distribution: distribution.rows,
      perShape: perShape.rows.map((r) => ({
        shape: r.shape,
        avgScore: r.avg_score ? Math.round(parseFloat(r.avg_score) * 10) / 10 : null,
        count: parseInt(r.count),
      })),
      unscoredCount: parseInt(unscored.rows[0].count),
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/quality/stats' })
    res.status(500).json({ error: 'Failed to fetch quality statistics' })
  }
})

export { router as qualityRouter }
