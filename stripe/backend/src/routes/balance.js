import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { getMerchantBalance, getAccountLedger, verifyLedgerIntegrity, getPlatformRevenue } from '../services/ledger.js';

const router = Router();

// All routes require authentication
router.use(authenticateApiKey);

/**
 * Get merchant balance
 * GET /v1/balance
 */
router.get('/', async (req, res) => {
  try {
    const balance = await getMerchantBalance(req.merchantId);

    res.json({
      object: 'balance',
      available: [
        {
          amount: balance.balance || 0,
          currency: 'usd',
        },
      ],
      pending: [
        {
          amount: 0, // Would calculate from pending charges
          currency: 'usd',
        },
      ],
      livemode: false,
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve balance',
      },
    });
  }
});

/**
 * Get balance transactions (ledger entries)
 * GET /v1/balance/transactions
 */
router.get('/transactions', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const account = `merchant:${req.merchantId}:payable`;
    const entries = await getAccountLedger(account, parseInt(limit), parseInt(offset));

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) FROM ledger_entries WHERE account = $1
    `, [account]);

    res.json({
      object: 'list',
      data: entries.map(e => ({
        id: `txn_${e.id}`,
        object: 'balance_transaction',
        amount: e.credit - e.debit, // Net change to merchant balance
        currency: e.currency,
        type: e.debit > 0 ? 'refund' : 'charge',
        description: e.description,
        payment_intent: e.payment_intent_id,
        charge: e.charge_id,
        refund: e.refund_id,
        created: Math.floor(new Date(e.created_at).getTime() / 1000),
      })),
      has_more: parseInt(offset) + entries.length < parseInt(countResult.rows[0].count),
      total_count: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('Get balance transactions error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve balance transactions',
      },
    });
  }
});

/**
 * Get charges summary
 * GET /v1/balance/summary
 */
router.get('/summary', async (req, res) => {
  try {
    // Get totals for merchant
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'succeeded') as successful_charges,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_charges,
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) as total_amount,
        COALESCE(SUM(fee) FILTER (WHERE status = 'succeeded'), 0) as total_fees,
        COALESCE(SUM(net) FILTER (WHERE status = 'succeeded'), 0) as total_net,
        COALESCE(SUM(amount_refunded), 0) as total_refunded
      FROM charges
      WHERE merchant_id = $1
    `, [req.merchantId]);

    const row = result.rows[0];

    // Get today's stats
    const todayResult = await query(`
      SELECT
        COUNT(*) as charges,
        COALESCE(SUM(amount), 0) as amount
      FROM charges
      WHERE merchant_id = $1
        AND created_at >= CURRENT_DATE
        AND status = 'succeeded'
    `, [req.merchantId]);

    const today = todayResult.rows[0];

    res.json({
      object: 'balance_summary',
      lifetime: {
        successful_charges: parseInt(row.successful_charges),
        failed_charges: parseInt(row.failed_charges),
        total_amount: parseInt(row.total_amount),
        total_fees: parseInt(row.total_fees),
        total_net: parseInt(row.total_net),
        total_refunded: parseInt(row.total_refunded),
      },
      today: {
        charges: parseInt(today.charges),
        amount: parseInt(today.amount),
      },
      currency: 'usd',
    });
  } catch (error) {
    console.error('Get balance summary error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retrieve balance summary',
      },
    });
  }
});

export default router;
