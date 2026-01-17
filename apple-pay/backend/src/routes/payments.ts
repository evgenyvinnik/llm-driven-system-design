import { Router, Response } from 'express';
import { paymentService } from '../services/payment.js';
import { biometricService } from '../services/biometric.js';
import { AuthenticatedRequest, authMiddleware, biometricMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

/**
 * Express router for payment and biometric authentication endpoints.
 * Handles biometric auth flow, payment processing, and transaction history.
 */
const router = Router();

/** Zod schema for payment request validation */
const paymentSchema = z.object({
  card_id: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  merchant_id: z.string().uuid(),
  transaction_type: z.enum(['nfc', 'in_app', 'web']),
});

/** Zod schema for biometric auth initiation validation */
const initiateAuthSchema = z.object({
  device_id: z.string().uuid(),
  auth_type: z.enum(['face_id', 'touch_id', 'passcode']),
});

/** Zod schema for biometric verification validation */
const verifyAuthSchema = z.object({
  session_id: z.string().uuid(),
  response: z.string(),
});

/**
 * POST /api/payments/biometric/initiate
 * Initiates a biometric authentication session for payment authorization.
 */
router.post('/biometric/initiate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = initiateAuthSchema.parse(req.body);
    const result = await biometricService.initiateAuth(
      req.userId!,
      data.device_id,
      data.auth_type
    );
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Initiate biometric error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/payments/biometric/verify
 * Verifies a biometric authentication response.
 */
// Verify biometric authentication
router.post('/biometric/verify', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = verifyAuthSchema.parse(req.body);
    const result = await biometricService.verifyAuth(data.session_id, data.response);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({ success: true, session_id: data.session_id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Verify biometric error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/payments/biometric/simulate
 * Simulates successful biometric authentication for demo purposes.
 */
// Simulate biometric success (for demo purposes)
router.post('/biometric/simulate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const result = await biometricService.simulateBiometricSuccess(session_id);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Simulate biometric error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/payments/biometric/:sessionId
 * Retrieves the status of a biometric session.
 */
// Get biometric session status
router.get('/biometric/:sessionId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = await biometricService.getSessionStatus(req.params.sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session });
  } catch (error) {
    console.error('Get biometric session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/payments/pay
 * Processes a payment transaction. Requires biometric verification.
 */
// Process payment (requires biometric verification)
router.post('/pay', authMiddleware, biometricMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = paymentSchema.parse(req.body);
    const result = await paymentService.processPayment(req.userId!, data);

    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        transaction_id: result.transaction_id,
      });
    }

    res.json({
      success: true,
      transaction_id: result.transaction_id,
      auth_code: result.auth_code,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/payments/transactions/:transactionId
 * Retrieves details of a specific transaction.
 */
// Get transaction by ID
router.get('/transactions/:transactionId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const transaction = await paymentService.getTransaction(
      req.userId!,
      req.params.transactionId
    );

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ transaction });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/payments/transactions
 * Lists transactions for the authenticated user with pagination.
 */
// Get user's transactions
router.get('/transactions', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { limit, offset, card_id, status } = req.query;
    const result = await paymentService.getTransactions(req.userId!, {
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
      cardId: card_id as string,
      status: status as string,
    });

    res.json(result);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
