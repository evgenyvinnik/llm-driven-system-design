import { Router, Request, Response } from 'express';
import { canvasService } from '../services/canvas.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, COLOR_PALETTE, COOLDOWN_SECONDS } from '../config.js';

const router = Router();

// Get canvas configuration
router.get('/config', (req: Request, res: Response) => {
  res.json({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    colors: COLOR_PALETTE,
    cooldownSeconds: COOLDOWN_SECONDS,
  });
});

// Get current canvas state
router.get('/', async (req: Request, res: Response) => {
  try {
    const canvasBase64 = await canvasService.getCanvasBase64();
    res.json({ canvas: canvasBase64 });
  } catch (error) {
    console.error('Error getting canvas:', error);
    res.status(500).json({ error: 'Failed to get canvas' });
  }
});

// Place a pixel (requires authentication)
router.post('/pixel', authMiddleware, async (req: Request, res: Response) => {
  const { x, y, color } = req.body;

  if (typeof x !== 'number' || typeof y !== 'number' || typeof color !== 'number') {
    res.status(400).json({ error: 'Invalid pixel data' });
    return;
  }

  const result = await canvasService.placePixel(req.user!.id, x, y, color);

  if (!result.success) {
    res.status(429).json({
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

// Get cooldown status
router.get('/cooldown', authMiddleware, async (req: Request, res: Response) => {
  const status = await canvasService.checkCooldown(req.user!.id);
  res.json({
    canPlace: status.canPlace,
    remainingSeconds: status.remainingSeconds,
    nextPlacement: status.canPlace ? Date.now() : Date.now() + status.remainingSeconds * 1000,
  });
});

// Get pixel history for a specific location
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

// Get recent events
router.get('/events', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const events = await canvasService.getRecentEvents(limit);
  res.json({ events });
});

// Get timelapse frames
router.get('/timelapse', async (req: Request, res: Response) => {
  const startTime = req.query.start ? new Date(req.query.start as string) : new Date(Date.now() - 3600000);
  const endTime = req.query.end ? new Date(req.query.end as string) : new Date();
  const frameCount = Math.min(parseInt(req.query.frames as string) || 30, 100);

  const frames = await canvasService.getTimelapseFrames(startTime, endTime, frameCount);
  res.json({ frames });
});

export default router;
