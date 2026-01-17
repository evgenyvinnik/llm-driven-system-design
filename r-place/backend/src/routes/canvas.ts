/**
 * Canvas routes for pixel placement and canvas state retrieval.
 *
 * Provides endpoints for:
 * - Getting canvas configuration and current state
 * - Placing pixels with rate limiting and idempotency
 * - Retrieving pixel history and recent events
 * - Generating timelapse frames
 */
import { Router, Request, Response } from 'express';
import { canvasService } from '../services/canvas.js';
import { authMiddleware } from '../middleware/auth.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, COLOR_PALETTE, COOLDOWN_SECONDS } from '../config.js';
import { logger } from '../shared/logger.js';

const router = Router();

/**
 * GET /config - Get canvas configuration.
 * Returns dimensions, color palette, and cooldown settings.
 * No authentication required.
 */
router.get('/config', (req: Request, res: Response) => {
  res.json({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    colors: COLOR_PALETTE,
    cooldownSeconds: COOLDOWN_SECONDS,
  });
});

/**
 * GET / - Get current canvas state as base64-encoded data.
 * Returns the complete canvas as a byte array where each byte is a color index.
 * No authentication required.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const canvasBase64 = await canvasService.getCanvasBase64();
    res.json({ canvas: canvasBase64 });
  } catch (error) {
    logger.error({ error }, 'Error getting canvas');
    res.status(500).json({ error: 'Failed to get canvas' });
  }
});

/**
 * POST /pixel - Place a pixel on the canvas.
 * Requires authentication. Enforces rate limiting via cooldown.
 * Returns 429 if user is still in cooldown period.
 *
 * Supports idempotency via:
 * - X-Request-ID header: Client-provided request ID for exact duplicate detection
 * - X-Idempotency-Key header: Alternative header for idempotency key
 *
 * Duplicate requests with the same idempotency key will return the cached result.
 */
router.post('/pixel', authMiddleware, async (req: Request, res: Response) => {
  const { x, y, color } = req.body;

  if (typeof x !== 'number' || typeof y !== 'number' || typeof color !== 'number') {
    res.status(400).json({ error: 'Invalid pixel data' });
    return;
  }

  // Extract optional request ID for idempotency
  const requestId =
    req.headers['x-request-id'] as string ||
    req.headers['x-idempotency-key'] as string ||
    undefined;

  const result = await canvasService.placePixel(req.user!.id, x, y, color, requestId);

  if (!result.success) {
    // Return 429 for rate limiting, 400 for validation errors
    const status = result.error?.includes('Rate limited') ? 429 : 400;
    res.status(status).json({
      error: result.error,
      nextPlacement: result.nextPlacement,
    });
    return;
  }

  res.json({
    success: true,
    nextPlacement: result.nextPlacement,
  });
});

/**
 * GET /cooldown - Get the user's current cooldown status.
 * Requires authentication. Returns whether user can place and time remaining.
 */
router.get('/cooldown', authMiddleware, async (req: Request, res: Response) => {
  const status = await canvasService.checkCooldown(req.user!.id);
  res.json({
    canPlace: status.canPlace,
    remainingSeconds: status.remainingSeconds,
    nextPlacement: status.canPlace ? Date.now() : Date.now() + status.remainingSeconds * 1000,
  });
});

/**
 * GET /pixel/:x/:y/history - Get placement history for a specific pixel.
 * Returns a list of all placements at the given coordinates.
 * No authentication required.
 */
router.get('/pixel/:x/:y/history', async (req: Request, res: Response) => {
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  if (isNaN(x) || isNaN(y) || x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
    res.status(400).json({ error: 'Invalid coordinates' });
    return;
  }

  const history = await canvasService.getPixelHistory(x, y);
  res.json({ history });
});

/**
 * GET /events - Get recent pixel placement events.
 * Accepts optional limit query parameter (default 100, max 1000).
 * No authentication required.
 */
router.get('/events', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const events = await canvasService.getRecentEvents(limit);
  res.json({ events });
});

/**
 * GET /timelapse - Get timelapse frames for canvas history.
 * Reconstructs canvas state at intervals between start and end times.
 * Query params: start, end (ISO dates), frames (count, default 30, max 100).
 * No authentication required.
 */
router.get('/timelapse', async (req: Request, res: Response) => {
  const startTime = req.query.start ? new Date(req.query.start as string) : new Date(Date.now() - 3600000);
  const endTime = req.query.end ? new Date(req.query.end as string) : new Date();
  const frameCount = Math.min(parseInt(req.query.frames as string) || 30, 100);

  const frames = await canvasService.getTimelapseFrames(startTime, endTime, frameCount);
  res.json({ frames });
});

export default router;
