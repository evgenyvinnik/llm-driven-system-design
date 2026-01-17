import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { portfolioService } from '../services/portfolioService.js';

const router = Router();

// All portfolio routes require authentication
router.use(authMiddleware);

// Get portfolio summary
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const portfolio = await portfolioService.getPortfolio(userId);
    res.json(portfolio);
  } catch (error) {
    console.error('Get portfolio error:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

// Get all positions
router.get('/positions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const positions = await portfolioService.getPositions(userId);
    res.json(positions);
  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Get specific position
router.get('/positions/:symbol', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const position = await portfolioService.getPosition(userId, req.params.symbol);

    if (!position) {
      res.status(404).json({ error: `No position in ${req.params.symbol}` });
      return;
    }

    res.json(position);
  } catch (error) {
    console.error('Get position error:', error);
    res.status(500).json({ error: 'Failed to fetch position' });
  }
});

// Get user account info
router.get('/account', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const portfolio = await portfolioService.getPortfolio(user.id);

    res.json({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      accountStatus: user.account_status,
      buyingPower: portfolio.buyingPower,
      portfolioValue: portfolio.totalValue,
      totalEquity: portfolio.buyingPower + portfolio.totalValue,
    });
  } catch (error) {
    console.error('Get account error:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

export default router;
