import { Router, Response } from 'express';
import { tokenizationService } from '../services/tokenization.js';
import { AuthenticatedRequest, authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();

const provisionCardSchema = z.object({
  pan: z.string().regex(/^\d{13,19}$/),
  expiry_month: z.number().min(1).max(12),
  expiry_year: z.number().min(2024),
  cvv: z.string().regex(/^\d{3,4}$/),
  card_holder_name: z.string().min(1),
  device_id: z.string().uuid(),
});

// Get all cards
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
    console.error('Get cards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Provision a new card
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = provisionCardSchema.parse(req.body);
    const result = await tokenizationService.provisionCard(req.userId!, data);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({ card: result.card });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Provision card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific card
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
    console.error('Get card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Suspend a card
router.post('/:cardId/suspend', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = req.body.reason || 'user_request';
    const result = await tokenizationService.suspendCard(req.userId!, req.params.cardId, reason);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Suspend card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reactivate a card
router.post('/:cardId/reactivate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await tokenizationService.reactivateCard(req.userId!, req.params.cardId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Reactivate card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove a card
router.delete('/:cardId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await tokenizationService.removeCard(req.userId!, req.params.cardId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Remove card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set default card
router.post('/:cardId/default', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await tokenizationService.setDefaultCard(req.userId!, req.params.cardId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Set default card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
