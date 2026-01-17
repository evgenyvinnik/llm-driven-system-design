import { Router } from 'express';
import type { Request, Response } from 'express';
import { LedgerService } from '../services/ledger.service.js';

/**
 * Ledger routes module.
 * Provides endpoints for financial reconciliation and reporting.
 * Exposes double-entry bookkeeping verification and summaries.
 */
const router = Router();
const ledgerService = new LedgerService();

/**
 * Verifies that ledger debits equal credits for a given period.
 * Used for daily reconciliation to ensure financial integrity.
 * GET /api/v1/ledger/verify
 */
router.get('/verify', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Default to last 24 hours
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 1);

    if (req.query.start_date) {
      startDate.setTime(new Date(req.query.start_date as string).getTime());
    }
    if (req.query.end_date) {
      endDate.setTime(new Date(req.query.end_date as string).getTime());
    }

    const result = await ledgerService.verifyLedgerBalance(startDate, endDate);

    res.json({
      balanced: result.balanced,
      total_debits: result.totalDebits,
      total_credits: result.totalCredits,
      period: {
        start: startDate,
        end: endDate,
      },
    });
  } catch (error) {
    console.error('Verify ledger error:', error);
    res.status(500).json({ error: 'Failed to verify ledger' });
  }
});

/**
 * Retrieves a summary of net changes by account for reporting.
 * Shows total volume and per-account movements for the period.
 * GET /api/v1/ledger/summary
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Default to last 30 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    if (req.query.start_date) {
      startDate.setTime(new Date(req.query.start_date as string).getTime());
    }
    if (req.query.end_date) {
      endDate.setTime(new Date(req.query.end_date as string).getTime());
    }

    const result = await ledgerService.getLedgerSummary(startDate, endDate);

    res.json({
      by_account: result.byAccount,
      total_volume: result.totalVolume,
      period: {
        start: startDate,
        end: endDate,
      },
    });
  } catch (error) {
    console.error('Get ledger summary error:', error);
    res.status(500).json({ error: 'Failed to get ledger summary' });
  }
});

export default router;
