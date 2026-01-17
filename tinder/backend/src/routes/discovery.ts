import { Router, Request, Response } from 'express';
import { DiscoveryService } from '../services/discoveryService.js';
import { MatchService } from '../services/matchService.js';
import { MessageService } from '../services/messageService.js';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/index.js';
import { swipeRateLimiter, hourlySwipeLimiter } from '../shared/rateLimit.js';
import { logger } from '../shared/logger.js';
import {
  swipesTotal,
  swipeProcessingDuration,
  matchesTotal,
  idempotentRequestsTotal,
  discoveryDeckRequestsTotal,
  discoveryDeckDuration,
  discoveryDeckSizeGauge,
} from '../shared/metrics.js';

/**
 * Discovery and swiping routes.
 * Handles the core matching experience: deck generation, profile viewing, and swipe processing.
 * All routes require authentication.
 *
 * Features:
 * - Rate limiting to protect matching algorithm
 * - Idempotency to prevent duplicate swipes
 * - Prometheus metrics for monitoring
 * - Structured logging
 */
const router = Router();
const discoveryService = new DiscoveryService();
const matchService = new MatchService();
const messageService = new MessageService();

/**
 * GET /api/discovery/deck
 * Returns a ranked deck of potential matches based on user preferences and location.
 * Excludes already-swiped users and applies bidirectional preference matching.
 */
router.get('/deck', requireAuth, async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const deck = await discoveryService.getDiscoveryDeck(req.session.userId!, limit);

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    discoveryDeckRequestsTotal.inc({ source: 'elasticsearch' });
    discoveryDeckDuration.observe(duration);
    discoveryDeckSizeGauge.set(deck.length);

    logger.info(
      { userId: req.session.userId, deckSize: deck.length, duration: `${duration.toFixed(3)}s` },
      'Discovery deck generated'
    );

    res.json(deck);
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get deck error');
    res.status(500).json({ error: 'Failed to get discovery deck' });
  }
});

/**
 * GET /api/discovery/profile/:userId
 * Returns a single profile card with distance calculated from requesting user.
 */
router.get('/profile/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const card = await discoveryService.getProfileCard(userId, req.session.userId!);

    if (!card) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(card);
  } catch (error) {
    logger.error({ error, targetUserId: req.params.userId }, 'Get profile card error');
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * POST /api/discovery/swipe
 * Records a swipe action (like/pass) and checks for mutual match.
 * Returns match data if both users have liked each other.
 * Publishes real-time notification to matched user via WebSocket.
 *
 * Features:
 * - Rate limiting: Prevents rapid-fire swiping
 * - Idempotency: Duplicate swipes return the previous result without re-processing
 *
 * WHY IDEMPOTENCY:
 * Idempotency prevents duplicate swipes when:
 * 1. Network issues cause client to retry the same request
 * 2. User double-taps the swipe button
 * 3. Client-side bugs result in duplicate submissions
 * Without idempotency, the same user could be matched multiple times,
 * notifications would be sent repeatedly, and metrics would be inflated.
 *
 * WHY RATE LIMITING:
 * Rate limiting protects the matching algorithm by:
 * 1. Preventing bots from mass-liking all users
 * 2. Ensuring fair distribution of visibility across users
 * 3. Reducing database load from rapid swipe processing
 * 4. Encouraging thoughtful swiping (better match quality)
 */
router.post(
  '/swipe',
  requireAuth,
  swipeRateLimiter,
  hourlySwipeLimiter,
  async (req: Request, res: Response) => {
    const startTime = Date.now();
    const swiperId = req.session.userId!;

    try {
      const { userId: swipedId, direction, idempotencyKey } = req.body;

      // Validate inputs
      if (!swipedId || !direction) {
        res.status(400).json({ error: 'userId and direction required' });
        return;
      }

      if (direction !== 'like' && direction !== 'pass') {
        res.status(400).json({ error: 'direction must be "like" or "pass"' });
        return;
      }

      if (swipedId === swiperId) {
        res.status(400).json({ error: 'Cannot swipe on yourself' });
        return;
      }

      // Check for idempotency - has this exact swipe been processed before?
      const existingSwipe = await checkIdempotency(swiperId, swipedId, idempotencyKey);

      if (existingSwipe.isDuplicate) {
        // Return cached result without re-processing
        idempotentRequestsTotal.inc({ operation: 'swipe' });
        logger.info(
          { swiperId, swipedId, direction, idempotencyKey },
          'Duplicate swipe detected, returning cached result'
        );

        const duration = (Date.now() - startTime) / 1000;
        swipeProcessingDuration.observe({ direction }, duration);
        swipesTotal.inc({ direction, result: 'duplicate' });

        res.json({
          success: true,
          match: existingSwipe.match,
          idempotent: true,
        });
        return;
      }

      // Process the swipe
      const result = await matchService.processSwipe(swiperId, swipedId, direction, idempotencyKey);

      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      swipeProcessingDuration.observe({ direction }, duration);
      swipesTotal.inc({ direction, result: 'success' });

      if (result.isNewMatch) {
        matchesTotal.inc();
      }

      logger.info(
        {
          swiperId,
          swipedId,
          direction,
          isMatch: result.isNewMatch,
          duration: `${duration.toFixed(3)}s`,
        },
        'Swipe processed'
      );

      if (result.isNewMatch && result.match) {
        // Get matched user info for notification
        const matchedUserResult = await pool.query(
          `SELECT u.id, u.name, p.url as primary_photo
           FROM users u
           LEFT JOIN photos p ON u.id = p.user_id AND p.is_primary = true
           WHERE u.id = $1`,
          [swipedId]
        );

        const matchedUser = matchedUserResult.rows[0];

        // Notify the other user via WebSocket
        await messageService.publishMatchNotification(swipedId, result.match.id, {
          id: swiperId,
          name: 'You',
          primary_photo: null,
        });

        res.json({
          success: true,
          match: {
            id: result.match.id,
            user: {
              id: matchedUser.id,
              name: matchedUser.name,
              primary_photo: matchedUser.primary_photo,
            },
          },
        });
      } else {
        res.json({ success: true, match: null });
      }
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      swipesTotal.inc({ direction: req.body.direction || 'unknown', result: 'error' });
      swipeProcessingDuration.observe({ direction: req.body.direction || 'unknown' }, duration);

      logger.error({ error, swiperId, swipedId: req.body.userId }, 'Swipe error');
      res.status(500).json({ error: 'Failed to process swipe' });
    }
  }
);

/**
 * Checks if a swipe action has already been processed (idempotency check).
 * Uses the idempotency key if provided, otherwise checks by swiper/swiped pair.
 *
 * @param swiperId - The user who is swiping
 * @param swipedId - The user being swiped on
 * @param idempotencyKey - Optional client-provided unique request identifier
 * @returns Object indicating if duplicate and the existing match if any
 */
async function checkIdempotency(
  swiperId: string,
  swipedId: string,
  idempotencyKey?: string
): Promise<{ isDuplicate: boolean; match: object | null }> {
  // If idempotency key is provided, check for exact key match
  if (idempotencyKey) {
    const result = await pool.query(
      `SELECT s.*, m.id as match_id, m.matched_at
       FROM swipes s
       LEFT JOIN matches m ON (
         (m.user1_id = s.swiper_id AND m.user2_id = s.swiped_id) OR
         (m.user1_id = s.swiped_id AND m.user2_id = s.swiper_id)
       )
       WHERE s.idempotency_key = $1`,
      [idempotencyKey]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        isDuplicate: true,
        match: row.match_id
          ? { id: row.match_id, matched_at: row.matched_at }
          : null,
      };
    }
  }

  // Check if swipe already exists for this pair (without idempotency key)
  const result = await pool.query(
    `SELECT s.*, m.id as match_id, m.matched_at
     FROM swipes s
     LEFT JOIN matches m ON (
       (m.user1_id = s.swiper_id AND m.user2_id = s.swiped_id) OR
       (m.user1_id = s.swiped_id AND m.user2_id = s.swiper_id)
     )
     WHERE s.swiper_id = $1 AND s.swiped_id = $2`,
    [swiperId, swipedId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      isDuplicate: true,
      match: row.match_id
        ? { id: row.match_id, matched_at: row.matched_at }
        : null,
    };
  }

  return { isDuplicate: false, match: null };
}

/**
 * GET /api/discovery/likes
 * Returns users who have liked the authenticated user but haven't been swiped on yet.
 * This is typically a premium feature in dating apps.
 */
router.get('/likes', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, calculate_age(u.birthdate) as age, p.url as primary_photo
       FROM swipes s
       JOIN users u ON s.swiper_id = u.id
       LEFT JOIN photos p ON u.id = p.user_id AND p.is_primary = true
       WHERE s.swiped_id = $1 AND s.direction = 'like'
         AND NOT EXISTS (
           SELECT 1 FROM swipes s2
           WHERE s2.swiper_id = $1 AND s2.swiped_id = s.swiper_id
         )
       ORDER BY s.created_at DESC
       LIMIT 20`,
      [req.session.userId]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get likes error');
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

export default router;
