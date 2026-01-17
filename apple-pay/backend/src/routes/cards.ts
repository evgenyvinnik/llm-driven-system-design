/**
 * Card Management Routes with Idempotency and Audit Logging
 *
 * Express router for payment card management endpoints.
 * Handles card provisioning, retrieval, suspension, and removal.
 *
 * CRITICAL FEATURES:
 * - Idempotency middleware on all card mutations
 * - Audit logging for compliance
 * - Prometheus metrics for card provisioning
 */
import { Router, Response } from 'express';
import { tokenizationService } from '../services/tokenization.js';
import { AuthenticatedRequest, authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

// Import shared infrastructure
import {
  createChildLogger,
  idempotencyMiddleware,
  auditLog,
  recordProvisioningMetrics,
} from '../shared/index.js';

const cardLogger = createChildLogger({ module: 'CardRoutes' });

/**
 * Express router for payment card management endpoints.
 * Handles card provisioning, retrieval, suspension, and removal.
 */
const router = Router();

/** Zod schema for card provisioning request validation */
const provisionCardSchema = z.object({
  pan: z.string().regex(/^\d{13,19}$/),
  expiry_month: z.number().min(1).max(12),
  expiry_year: z.number().min(2024),
  cvv: z.string().regex(/^\d{3,4}$/),
  card_holder_name: z.string().min(1),
  device_id: z.string().uuid(),
});

/**
 * GET /api/cards
 * Lists all provisioned cards for the authenticated user.
 * Returns sanitized card data (no sensitive token information).
 */
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cards = await tokenizationService.getCards(req.userId!);
    // Remove sensitive data from response
    const safeCards = cards.map((card) => ({
      id: card.id,
      network: card.network,
      last4: card.last4,
      card_type: card.card_type,
      card_holder_name: card.card_holder_name,
      expiry_month: card.expiry_month,
      expiry_year: card.expiry_year,
      is_default: card.is_default,
      status: card.status,
      device_id: card.device_id,
      device_name: (card as any).device_name,
      device_type: (card as any).device_type,
      provisioned_at: card.provisioned_at,
    }));
    res.json({ cards: safeCards });
  } catch (error) {
    cardLogger.error({ error: (error as Error).message }, 'Get cards error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/cards
 * Provisions a new payment card to a user's device.
 * Tokenizes the card and stores it in the simulated Secure Element.
 *
 * Idempotency: Required - prevents duplicate card provisioning
 */
router.post(
  '/',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = provisionCardSchema.parse(req.body);

      cardLogger.info(
        {
          userId: req.userId,
          deviceId: data.device_id,
          last4: data.pan.slice(-4),
        },
        'Provisioning card'
      );

      const result = await tokenizationService.provisionCard(req.userId!, data);

      if (!result.success) {
        // Record failed provisioning metrics
        recordProvisioningMetrics('unknown', 'failure');

        return res.status(400).json({ error: result.error });
      }

      // Record successful provisioning metrics
      const card = result.card!;
      recordProvisioningMetrics(card.network || 'unknown', 'success');

      // Audit log card provisioning
      await auditLog.cardProvisioned(req, card.id || 'unknown', {
        network: card.network || 'unknown',
        last4: card.last4 || 'xxxx',
        deviceId: data.device_id,
      });

      res.status(201).json({ card: result.card });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }
      cardLogger.error({ error: (error as Error).message }, 'Provision card error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/cards/:cardId
 * Retrieves details of a specific card by ID.
 */
router.get('/:cardId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const card = await tokenizationService.getCard(req.userId!, req.params.cardId);

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({
      card: {
        id: card.id,
        network: card.network,
        last4: card.last4,
        card_type: card.card_type,
        card_holder_name: card.card_holder_name,
        expiry_month: card.expiry_month,
        expiry_year: card.expiry_year,
        is_default: card.is_default,
        status: card.status,
        suspended_at: card.suspended_at,
        suspend_reason: card.suspend_reason,
        provisioned_at: card.provisioned_at,
      },
    });
  } catch (error) {
    cardLogger.error({ error: (error as Error).message }, 'Get card error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/cards/:cardId/suspend
 * Temporarily suspends a card, preventing transactions.
 *
 * Idempotency: Required - prevents duplicate suspend operations
 */
router.post(
  '/:cardId/suspend',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reason = req.body.reason || 'user_request';
      const result = await tokenizationService.suspendCard(req.userId!, req.params.cardId, reason);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Audit log card suspension
      await auditLog.cardSuspended(req, req.params.cardId, reason);

      cardLogger.info(
        { userId: req.userId, cardId: req.params.cardId, reason },
        'Card suspended'
      );

      res.json({ success: true });
    } catch (error) {
      cardLogger.error({ error: (error as Error).message }, 'Suspend card error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/cards/:cardId/reactivate
 * Reactivates a previously suspended card.
 *
 * Idempotency: Required - prevents duplicate reactivation
 */
router.post(
  '/:cardId/reactivate',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await tokenizationService.reactivateCard(req.userId!, req.params.cardId);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      cardLogger.info({ userId: req.userId, cardId: req.params.cardId }, 'Card reactivated');

      res.json({ success: true });
    } catch (error) {
      cardLogger.error({ error: (error as Error).message }, 'Reactivate card error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * DELETE /api/cards/:cardId
 * Permanently removes a card from the user's wallet.
 *
 * Idempotency: Required - prevents duplicate removal attempts
 */
router.delete(
  '/:cardId',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await tokenizationService.removeCard(req.userId!, req.params.cardId);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      cardLogger.info({ userId: req.userId, cardId: req.params.cardId }, 'Card removed');

      res.json({ success: true });
    } catch (error) {
      cardLogger.error({ error: (error as Error).message }, 'Remove card error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/cards/:cardId/default
 * Sets a card as the user's default payment method.
 *
 * Idempotency: Required - prevents duplicate default setting
 */
router.post(
  '/:cardId/default',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await tokenizationService.setDefaultCard(req.userId!, req.params.cardId);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      cardLogger.info({ userId: req.userId, cardId: req.params.cardId }, 'Default card set');

      res.json({ success: true });
    } catch (error) {
      cardLogger.error({ error: (error as Error).message }, 'Set default card error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
