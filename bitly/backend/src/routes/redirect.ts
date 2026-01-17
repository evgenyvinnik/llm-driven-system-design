import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getUrlByShortCode, incrementClickCount } from '../services/urlService.js';
import { recordClick } from '../services/analyticsService.js';

const router = Router();

// Handle redirect
router.get(
  '/:shortCode',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;

    const longUrl = await getUrlByShortCode(shortCode);

    if (!longUrl) {
      res.status(404).json({ error: 'Short URL not found or has expired' });
      return;
    }

    // Record click asynchronously (don't block redirect)
    setImmediate(async () => {
      try {
        await Promise.all([
          incrementClickCount(shortCode),
          recordClick({
            short_code: shortCode,
            referrer: req.get('Referer'),
            user_agent: req.get('User-Agent'),
            ip_address: req.ip,
          }),
        ]);
      } catch (error) {
        console.error('Failed to record click:', error);
      }
    });

    // Use 302 (temporary) redirect to ensure analytics tracking
    // 301 would be cached by browsers and we'd miss analytics
    res.redirect(302, longUrl);
  })
);

export default router;
