/**
 * Payment Routes with Idempotency and Audit Logging
 *
 * Express router for payment and biometric authentication endpoints.
 * Handles biometric auth flow, payment processing, and transaction history.
 *
 * CRITICAL FEATURES:
 * - Idempotency middleware on all payment mutations (prevents double-charging)
 * - Audit logging for compliance (PCI-DSS, SOX)
 * - Circuit breaker integration for network resilience
 * - Prometheus metrics for monitoring
 */
import { Router, Response } from 'express';
import { paymentService } from '../services/payment.js';
import { biometricService } from '../services/biometric.js';
import {
  AuthenticatedRequest,
  authMiddleware,
  biometricMiddleware,
} from '../middleware/auth.js';
import { z } from 'zod';

// Import shared infrastructure
import {
  logger,
  createChildLogger,
  idempotencyMiddleware,
  auditLog,
  recordPaymentMetrics,
} from '../shared/index.js';

const paymentLogger = createChildLogger({ module: 'PaymentRoutes' });

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
 *
 * Idempotency: Required - prevents duplicate session creation
 */
router.post(
  '/biometric/initiate',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = initiateAuthSchema.parse(req.body);
      const result = await biometricService.initiateAuth(
        req.userId!,
        data.device_id,
        data.auth_type
      );

      // Audit log biometric initiation
      await auditLog.biometric(req, result.sessionId, 'success', data.auth_type);

      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }
      paymentLogger.error({ error: (error as Error).message }, 'Initiate biometric error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/payments/biometric/verify
 * Verifies a biometric authentication response.
 *
 * Idempotency: Required - prevents duplicate verification attempts
 */
router.post(
  '/biometric/verify',
  authMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = verifyAuthSchema.parse(req.body);
      const result = await biometricService.verifyAuth(data.session_id, data.response);

      // Audit log biometric result
      await auditLog.biometric(
        req,
        data.session_id,
        result.success ? 'success' : 'failure',
        'verify'
      );

      if (!result.success) {
        return res.status(401).json({ error: result.error });
      }

      res.json({ success: true, session_id: data.session_id });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }
      paymentLogger.error({ error: (error as Error).message }, 'Verify biometric error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/payments/biometric/simulate
 * Simulates successful biometric authentication for demo purposes.
 *
 * Note: In production, this endpoint would not exist.
 */
router.post(
  '/biometric/simulate',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { session_id } = req.body;
      if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
      }

      const result = await biometricService.simulateBiometricSuccess(session_id);

      if (!result.success) {
        return res.status(401).json({ error: result.error });
      }

      // Audit log simulated biometric (for demo tracking)
      await auditLog.biometric(req, session_id, 'success', 'simulated');

      res.json({ success: true });
    } catch (error) {
      paymentLogger.error({ error: (error as Error).message }, 'Simulate biometric error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/payments/biometric/:sessionId
 * Retrieves the status of a biometric session.
 */
router.get(
  '/biometric/:sessionId',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const session = await biometricService.getSessionStatus(req.params.sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({ session });
    } catch (error) {
      paymentLogger.error({ error: (error as Error).message }, 'Get biometric session error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/payments/pay
 * Processes a payment transaction. Requires biometric verification.
 *
 * CRITICAL: This endpoint is protected by:
 * 1. Authentication middleware (valid session)
 * 2. Biometric middleware (verified biometric)
 * 3. Idempotency middleware (prevents double-charging)
 *
 * The idempotency key MUST be provided by the client.
 * If the same idempotency key is used:
 * - If request is identical: Returns cached response
 * - If request differs: Returns 422 error
 */
router.post(
  '/pay',
  authMiddleware,
  biometricMiddleware,
  idempotencyMiddleware({ required: true }),
  async (req: AuthenticatedRequest, res: Response) => {
    const startTime = Date.now();

    try {
      const data = paymentSchema.parse(req.body);

      paymentLogger.info(
        {
          userId: req.userId,
          amount: data.amount,
          currency: data.currency,
          merchantId: data.merchant_id,
          transactionType: data.transaction_type,
        },
        'Processing payment'
      );

      const result = await paymentService.processPayment(req.userId!, data);

      const duration = Date.now() - startTime;

      if (!result.success) {
        // Record declined payment metrics
        recordPaymentMetrics(
          'declined',
          data.transaction_type,
          'unknown', // Network not known for declined
          data.amount,
          duration
        );

        // Audit log declined payment
        await auditLog.payment(req, result.transaction_id || 'unknown', 'declined', {
          amount: data.amount,
          currency: data.currency,
          merchantId: data.merchant_id,
          cardLast4: 'xxxx', // Will be resolved in service
          network: 'unknown',
          transactionType: data.transaction_type,
          declineReason: result.error,
        });

        return res.status(400).json({
          error: result.error,
          transaction_id: result.transaction_id,
        });
      }

      // Record successful payment metrics
      recordPaymentMetrics('approved', data.transaction_type, 'visa', data.amount, duration);

      // Audit log approved payment
      await auditLog.payment(req, result.transaction_id!, 'approved', {
        amount: data.amount,
        currency: data.currency,
        merchantId: data.merchant_id,
        cardLast4: 'xxxx',
        network: 'visa',
        transactionType: data.transaction_type,
        authCode: result.auth_code,
      });

      // Add transaction ID to response header for tracing
      res.setHeader('X-Transaction-Id', result.transaction_id!);

      res.json({
        success: true,
        transaction_id: result.transaction_id,
        auth_code: result.auth_code,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      // Record error metrics
      recordPaymentMetrics('error', 'unknown', 'unknown', 0, duration);

      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input', details: error.errors });
      }

      paymentLogger.error({ error: (error as Error).message }, 'Payment error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/payments/transactions/:transactionId
 * Retrieves details of a specific transaction.
 */
router.get(
  '/transactions/:transactionId',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
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
      paymentLogger.error({ error: (error as Error).message }, 'Get transaction error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/payments/transactions
 * Lists transactions for the authenticated user with pagination.
 */
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
    paymentLogger.error({ error: (error as Error).message }, 'Get transactions error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
