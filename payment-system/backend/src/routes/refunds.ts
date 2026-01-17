import { Router } from 'express';
import type { Request, Response } from 'express';
import { RefundService, ChargebackService } from '../services/refund.service.js';

/**
 * Refund routes module.
 * Provides endpoints for listing and retrieving refunds,
 * plus an embedded chargebacks endpoint.
 */
const router = Router();
const refundService = new RefundService();
const chargebackService = new ChargebackService();

/**
 * Lists all refunds for the authenticated merchant with pagination.
 * GET /api/v1/refunds
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await refundService.listRefunds(req.merchant.id, limit, offset);

    res.json({
      data: result.refunds,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('List refunds error:', error);
    res.status(500).json({ error: 'Failed to list refunds' });
  }
});

/**
 * Retrieves a specific refund by ID.
 * Only returns refunds owned by the authenticated merchant.
 * GET /api/v1/refunds/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const refund = await refundService.getRefund(req.params.id);

    if (!refund) {
      res.status(404).json({ error: 'Refund not found' });
      return;
    }

    if (refund.merchant_id !== req.merchant.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(refund);
  } catch (error) {
    console.error('Get refund error:', error);
    res.status(500).json({ error: 'Failed to get refund' });
  }
});

/**
 * Lists chargebacks for the authenticated merchant.
 * Note: This endpoint is deprecated; use /api/v1/chargebacks instead.
 * GET /api/v1/refunds/chargebacks
 */
router.get('/chargebacks', async (req: Request, res: Response) => {
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

export default router;
