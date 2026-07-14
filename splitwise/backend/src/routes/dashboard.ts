import express, { type Request, type Response } from 'express';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { computeFriendBalances } from '../services/balances.js';

const router = express.Router();

/**
 * Dashboard summary for the home screen: the headline "you are owed / you owe /
 * net" figures, plus per-friend balances. Totals are derived from the same
 * pairwise friend balances so the headline and the list can never disagree.
 */
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const friends = await computeFriendBalances(authReq.user.id);

    let totalOwedCents = 0; // owed TO me
    let totalOweCents = 0; // I owe
    for (const f of friends) {
      if (f.netCents > 0) totalOwedCents += f.netCents;
      else totalOweCents += -f.netCents;
    }

    res.json({
      totalOwedCents,
      totalOweCents,
      netCents: totalOwedCents - totalOweCents,
      friends: friends.map((f) => ({
        userId: f.userId,
        name: f.name || f.username,
        username: f.username,
        avatarUrl: f.avatarUrl,
        netCents: f.netCents, // + = they owe me, - = I owe them
      })),
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

export default router;
