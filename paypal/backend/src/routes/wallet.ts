import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getWallet, deposit, withdraw } from '../services/walletService.js';
import { moneyLimiter } from '../services/rateLimiter.js';
import { PaymentError, sendError } from '../services/errors.js';
import {
  MAX_WALLET_OP_CENTS,
  isUuid,
  parseAmountCents,
  parseIdempotencyKey,
  parseNote,
} from '../services/validation.js';

const router = Router();

// GET /api/wallet - Get current user's wallet balance
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const wallet = await getWallet(req.session.userId!);

    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    res.json({ wallet });
  } catch (err) {
    sendError(res, err, 'Failed to get wallet');
  }
});

/** Shared handler: deposits and withdrawals take the same body and differ only in direction. */
function walletOperationHandler(operation: typeof deposit) {
  return async (req: Request, res: Response) => {
    try {
      const amountCents = parseAmountCents(req.body?.amountCents, MAX_WALLET_OP_CENTS);
      const { paymentMethodId } = req.body ?? {};
      if (!isUuid(paymentMethodId)) {
        throw new PaymentError(400, 'PAYMENT_METHOD_REQUIRED', 'Choose a linked payment method');
      }
      const { result, replayed } = await operation({
        userId: req.session.userId!,
        amountCents,
        paymentMethodId,
        note: parseNote(req.body?.note),
        idempotencyKey: parseIdempotencyKey(req),
      });
      if (replayed) res.set('Idempotent-Replayed', 'true');
      res.json(result);
    } catch (err) {
      sendError(res, err, 'Wallet operation failed');
    }
  };
}

// POST /api/wallet/deposit - Deposit funds from a linked payment method
router.post('/deposit', requireAuth, moneyLimiter, walletOperationHandler(deposit));

// POST /api/wallet/withdraw - Withdraw funds to a linked payment method
router.post('/withdraw', requireAuth, moneyLimiter, walletOperationHandler(withdraw));

/** Wallet router for balance queries, deposits, and withdrawals with validation. */
export default router;
