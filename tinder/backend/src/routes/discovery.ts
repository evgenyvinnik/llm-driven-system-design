import { Router, Request, Response } from 'express';
import { DiscoveryService } from '../services/discoveryService.js';
import { MatchService } from '../services/matchService.js';
import { MessageService } from '../services/messageService.js';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/index.js';

/**
 * Discovery and swiping routes.
 * Handles the core matching experience: deck generation, profile viewing, and swipe processing.
 * All routes require authentication.
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
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const deck = await discoveryService.getDiscoveryDeck(req.session.userId!, limit);
    res.json(deck);
  } catch (error) {
    console.error('Get deck error:', error);
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
    console.error('Get profile card error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * POST /api/discovery/swipe
 * Records a swipe action (like/pass) and checks for mutual match.
 * Returns match data if both users have liked each other.
 * Publishes real-time notification to matched user via WebSocket.
 */
router.post('/swipe', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, direction } = req.body;

    if (!userId || !direction) {
      res.status(400).json({ error: 'userId and direction required' });
      return;
    }

    if (direction !== 'like' && direction !== 'pass') {
      res.status(400).json({ error: 'direction must be "like" or "pass"' });
      return;
    }

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot swipe on yourself' });
      return;
    }

    const result = await matchService.processSwipe(req.session.userId!, userId, direction);

    if (result.isNewMatch && result.match) {
      // Get matched user info for notification
      const matchedUserResult = await pool.query(
        `SELECT u.id, u.name, p.url as primary_photo
         FROM users u
         LEFT JOIN photos p ON u.id = p.user_id AND p.is_primary = true
         WHERE u.id = $1`,
        [userId]
      );

      const matchedUser = matchedUserResult.rows[0];

      // Notify the other user via WebSocket
      await messageService.publishMatchNotification(userId, result.match.id, {
        id: req.session.userId!,
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
    console.error('Swipe error:', error);
    res.status(500).json({ error: 'Failed to process swipe' });
  }
});

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
    console.error('Get likes error:', error);
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

export default router;
