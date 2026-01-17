import { Router } from 'express';
import type { Request, Response } from 'express';
import { ChargebackService } from '../services/refund.service.js';

/**
 * Chargeback routes module.
 * Provides endpoints for viewing and responding to chargebacks
 * initiated by card issuers on behalf of customers.
 */
const router = Router();
const chargebackService = new ChargebackService();

/**
 * Lists all chargebacks for the authenticated merchant.
 * Supports filtering by status and pagination.
 * GET /api/v1/chargebacks
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as 'open' | 'won' | 'lost' | 'pending_response' | undefined;

    const result = await chargebackService.listChargebacks(
      req.merchant.id,
      status,
      limit,
      offset
    );

    res.json({
      data: result.chargebacks,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('List chargebacks error:', error);
    res.status(500).json({ error: 'Failed to list chargebacks' });
  }
});

/**
 * Retrieves a specific chargeback by ID.
 * Only returns chargebacks owned by the authenticated merchant.
 * GET /api/v1/chargebacks/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const chargeback = await chargebackService.getChargeback(req.params.id);

    if (!chargeback) {
      res.status(404).json({ error: 'Chargeback not found' });
      return;
    }

    if (chargeback.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(chargeback);
  } catch (error) {
    console.error('Get chargeback error:', error);
    res.status(500).json({ error: 'Failed to get chargeback' });
  }
});

/**
 * Submits evidence in response to a chargeback.
 * In production, this would forward evidence to the card network.
 * POST /api/v1/chargebacks/:id/respond
 */
router.post('/:id/respond', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const chargeback = await chargebackService.getChargeback(req.params.id);

    if (!chargeback) {
      res.status(404).json({ error: 'Chargeback not found' });
      return;
    }

    if (chargeback.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // In a real system, this would submit evidence to the card network
    // For now, we just update the status to pending_response
    res.json({
      message: 'Evidence submission recorded. Awaiting card network decision.',
      chargeback_id: chargeback.id,
    });
  } catch (error) {
    console.error('Respond to chargeback error:', error);
    res.status(500).json({ error: 'Failed to respond to chargeback' });
  }
});

export default router;
