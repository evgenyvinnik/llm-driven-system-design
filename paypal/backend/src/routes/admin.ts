import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import { sendError } from '../services/errors.js';

const router = Router();

/**
 * GET /api/admin/reconciliation - checks the double-entry invariants:
 *
 * 1. Every transaction's ledger entries net to zero (debits = credits).
 * 2. Every transaction has ledger entries.
 * 3. Each wallet's stored balance equals its ledger: credits - debits for a
 *    customer wallet, debits - credits for the debit-normal platform cash.
 * 4. Total customer balances equal platform cash.
 *
 * Runs in one REPEATABLE READ snapshot so transfers committing mid-report
 * can't make a correct ledger look unbalanced.
 */
router.get('/reconciliation', requireAdmin, async (_req: Request, res: Response) => {
  let client: import('pg').PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const wallets = await client.query(`
      SELECT w.id, w.account_type, w.balance_cents, u.username, u.display_name,
             COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount_cents ELSE 0 END), 0) AS credits,
             COALESCE(SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount_cents ELSE 0 END), 0) AS debits,
             COUNT(le.id) AS entries
      FROM wallets w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      GROUP BY w.id, u.username, u.display_name
      ORDER BY w.account_type DESC, u.username`);

    const unbalanced = await client.query(`
      SELECT COUNT(*) AS count FROM (
        SELECT transaction_id FROM ledger_entries
        GROUP BY transaction_id
        HAVING SUM(CASE WHEN entry_type = 'debit' THEN amount_cents ELSE -amount_cents END) <> 0
      ) t`);

    const missing = await client.query(`
      SELECT COUNT(*) AS count FROM transactions t
      WHERE NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = t.id)`);

    await client.query('COMMIT');

    let totalDebits = 0;
    let totalCredits = 0;
    let customerTotal = 0;
    let platformCash = 0;

    const rows = wallets.rows.map((row) => {
      const balance = Number(row.balance_cents);
      const credits = Number(row.credits);
      const debits = Number(row.debits);
      const isCash = row.account_type === 'platform_cash';
      const ledgerBalance = isCash ? debits - credits : credits - debits;
      totalDebits += debits;
      totalCredits += credits;
      if (isCash) platformCash += balance;
      else customerTotal += balance;
      return {
        walletId: row.id,
        username: row.username,
        displayName: row.display_name,
        accountType: row.account_type,
        balanceCents: balance,
        ledgerBalanceCents: ledgerBalance,
        driftCents: balance - ledgerBalance,
        entries: Number(row.entries),
      };
    });

    const summary = {
      totalDebitsCents: totalDebits,
      totalCreditsCents: totalCredits,
      customerTotalCents: customerTotal,
      platformCashCents: platformCash,
      walletsWithDrift: rows.filter((r) => r.driftCents !== 0).length,
      unbalancedTransactions: Number(unbalanced.rows[0].count),
      transactionsWithoutEntries: Number(missing.rows[0].count),
    };
    const balanced =
      summary.totalDebitsCents === summary.totalCreditsCents &&
      summary.customerTotalCents === summary.platformCashCents &&
      summary.walletsWithDrift === 0 &&
      summary.unbalancedTransactions === 0 &&
      summary.transactionsWithoutEntries === 0;

    res.json({ balanced, summary, wallets: rows });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => undefined);
    sendError(res, err, 'Reconciliation failed');
  } finally {
    client?.release();
  }
});

/** Admin-only reporting endpoints. */
export default router;
