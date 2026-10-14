import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, SYSTEM_ACCOUNTS } from '../db/connection.js';
import type { LedgerEntry, Account } from '../types/index.js';

/**
 * Double-entry bookkeeping service
 *
 * Money moves in journals: a set of entries posted together (one capture, one
 * refund, one chargeback) whose debits equal their credits. Three layers keep
 * that invariant:
 * 1. The pure builders below produce balanced lines for each business event.
 * 2. postJournal() refuses to post an unbalanced set before touching the DB.
 * 3. A deferred constraint trigger in init.sql re-checks every journal at
 *    COMMIT, and another trigger makes ledger_entries append-only.
 *
 * Account balances are stored credit-positive for every account (a credit
 * adds, a debit subtracts), so the sum of all balances is always zero.
 */

/** One line of a journal before it is posted. */
export interface JournalLine {
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
  description: string;
}

/** Result of posting a journal. */
export interface PostedJournal {
  journalId: string;
  entries: LedgerEntry[];
}

/** Error thrown when application code builds an unbalanced journal. */
export class UnbalancedJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedJournalError';
  }
}

/** Drops zero-amount lines (e.g. a fee share that rounds to 0 cents). */
function nonZero(lines: JournalLine[]): JournalLine[] {
  return lines.filter((line) => line.amount !== 0);
}

/**
 * Throws unless the lines form a valid journal: at least two lines, positive
 * integer amounts, and sum(debits) === sum(credits).
 */
export function assertBalanced(lines: JournalLine[]): void {
  if (lines.length < 2) {
    throw new UnbalancedJournalError('A journal needs at least two entries');
  }
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
      throw new UnbalancedJournalError(`Invalid entry amount: ${line.amount}`);
    }
    if (line.entryType === 'debit') debits += line.amount;
    else credits += line.amount;
  }
  if (debits !== credits) {
    throw new UnbalancedJournalError(`Journal does not balance: debits ${debits}, credits ${credits}`);
  }
}

/**
 * Capture: debit Accounts Receivable for the gross amount, credit the merchant
 * for the net, credit Platform Revenue for the fee.
 */
export function buildCaptureJournal(
  merchantAccountId: string,
  amount: number,
  feeAmount: number
): JournalLine[] {
  return nonZero([
    { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, entryType: 'debit', amount, description: 'Payment received from processor' },
    { accountId: merchantAccountId, entryType: 'credit', amount: amount - feeAmount, description: 'Payment to merchant (net of fees)' },
    { accountId: SYSTEM_ACCOUNTS.PLATFORM_REVENUE, entryType: 'credit', amount: feeAmount, description: 'Platform transaction fee' },
  ]);
}

/**
 * Portion of the original fee returned by a refund. Computed as the difference
 * of cumulative shares, so a series of partial refunds that adds up to the full
 * amount returns exactly the original fee (no cent lost to rounding).
 */
export function refundFeeShare(
  refundAmount: number,
  alreadyRefunded: number,
  originalAmount: number,
  originalFee: number
): number {
  const shareAfter = Math.round(((alreadyRefunded + refundAmount) * originalFee) / originalAmount);
  const shareBefore = Math.round((alreadyRefunded * originalFee) / originalAmount);
  return shareAfter - shareBefore;
}

/**
 * Refund: the mirror image of a capture for the refunded share. Credit AR for
 * the refund, debit the merchant for the net share, debit revenue for the fee
 * share.
 */
export function buildRefundJournal(
  merchantAccountId: string,
  refundAmount: number,
  alreadyRefunded: number,
  originalAmount: number,
  originalFee: number,
  paymentId: string
): JournalLine[] {
  const feeRefund = refundFeeShare(refundAmount, alreadyRefunded, originalAmount, originalFee);
  return nonZero([
    { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, entryType: 'credit', amount: refundAmount, description: `Refund for transaction ${paymentId}` },
    { accountId: merchantAccountId, entryType: 'debit', amount: refundAmount - feeRefund, description: `Refund deduction for transaction ${paymentId}` },
    { accountId: SYSTEM_ACCOUNTS.PLATFORM_REVENUE, entryType: 'debit', amount: feeRefund, description: `Fee refund for transaction ${paymentId}` },
  ]);
}

/**
 * Chargeback: the disputed amount goes back through AR and the merchant also
 * pays a chargeback fee, which is platform revenue.
 */
export function buildChargebackJournal(
  merchantAccountId: string,
  amount: number,
  chargebackFee: number,
  paymentId: string
): JournalLine[] {
  return nonZero([
    { accountId: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, entryType: 'credit', amount, description: `Chargeback for transaction ${paymentId}` },
    { accountId: merchantAccountId, entryType: 'debit', amount: amount + chargebackFee, description: `Chargeback deduction for transaction ${paymentId}` },
    { accountId: SYSTEM_ACCOUNTS.PLATFORM_REVENUE, entryType: 'credit', amount: chargebackFee, description: 'Chargeback processing fee' },
  ]);
}

/** A won dispute reverses the chargeback journal line for line. */
export function buildChargebackReversalJournal(
  merchantAccountId: string,
  amount: number,
  chargebackFee: number,
  paymentId: string
): JournalLine[] {
  return buildChargebackJournal(merchantAccountId, amount, chargebackFee, paymentId).map((line) => ({
    ...line,
    entryType: line.entryType === 'debit' ? 'credit' : 'debit',
    description: `Reversal: ${line.description}`,
  }));
}

export class LedgerService {
  /**
   * Posts a balanced journal inside the caller's database transaction.
   *
   * Accounts are updated in a fixed order (by id) so two journals touching the
   * same accounts always lock them in the same order and cannot deadlock.
   * `balance = balance + delta` under the row lock is what makes balance_after
   * exact under concurrency; READ COMMITTED is sufficient.
   */
  async postJournal(
    client: PoolClient,
    transactionId: string,
    currency: string,
    lines: JournalLine[]
  ): Promise<PostedJournal> {
    assertBalanced(lines);
    const journalId = uuidv4();
    const ordered = [...lines].sort((a, b) => a.accountId.localeCompare(b.accountId));
    const entries: LedgerEntry[] = [];

    for (const line of ordered) {
      const accountResult = await client.query<Account>(
        `UPDATE accounts
         SET balance = balance + $2, updated_at = NOW()
         WHERE id = $1
         RETURNING balance`,
        [line.accountId, line.entryType === 'credit' ? line.amount : -line.amount]
      );
      if (accountResult.rowCount === 0) {
        throw new Error(`Ledger account ${line.accountId} does not exist`);
      }

      const result = await client.query<LedgerEntry>(
        `INSERT INTO ledger_entries (id, journal_id, transaction_id, account_id, entry_type, amount, currency, balance_after, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          uuidv4(),
          journalId,
          transactionId,
          line.accountId,
          line.entryType,
          line.amount,
          currency,
          accountResult.rows[0].balance,
          line.description,
        ]
      );
      entries.push(result.rows[0]);
    }

    return { journalId, entries };
  }

  /**
   * Get account balance
   */
  async getAccountBalance(accountId: string): Promise<number> {
    const account = await queryOne<Account>(
      'SELECT balance FROM accounts WHERE id = $1',
      [accountId]
    );
    return account?.balance ?? 0;
  }

  /**
   * Get all ledger entries for a transaction
   */
  async getEntriesForTransaction(transactionId: string): Promise<LedgerEntry[]> {
    return query<LedgerEntry>(
      'SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at, journal_id, entry_type DESC',
      [transactionId]
    );
  }

  /**
   * Reconciliation check. Within the window, total debits must equal total
   * credits and no journal may be unbalanced; across all time, every account's
   * stored balance must equal the signed sum of its entries (no drift).
   */
  async verifyLedgerBalance(
    startDate: Date,
    endDate: Date
  ): Promise<{
    balanced: boolean;
    totalDebits: number;
    totalCredits: number;
    unbalancedJournals: Array<{ journal_id: string; imbalance: number }>;
    accountDrift: Array<{ account_id: string; account_name: string; stored_balance: number; ledger_balance: number }>;
  }> {
    const result = await queryOne<{ debits: string; credits: string }>(
      `SELECT
         SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) as debits,
         SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) as credits
       FROM ledger_entries
       WHERE created_at >= $1 AND created_at < $2`,
      [startDate, endDate]
    );

    const unbalancedJournals = await query<{ journal_id: string; imbalance: number }>(
      `SELECT journal_id,
              SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END)::bigint AS imbalance
       FROM ledger_entries
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY journal_id
       HAVING SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END) <> 0`,
      [startDate, endDate]
    );

    const accountDrift = await query<{
      account_id: string;
      account_name: string;
      stored_balance: number;
      ledger_balance: number;
    }>(
      `SELECT a.id AS account_id, a.name AS account_name, a.balance AS stored_balance,
              COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END), 0)::bigint AS ledger_balance
       FROM accounts a
       LEFT JOIN ledger_entries le ON le.account_id = a.id
       GROUP BY a.id, a.name, a.balance
       HAVING a.balance <> COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END), 0)`
    );

    const totalDebits = parseInt(result?.debits || '0', 10);
    const totalCredits = parseInt(result?.credits || '0', 10);

    return {
      balanced: totalDebits === totalCredits && unbalancedJournals.length === 0 && accountDrift.length === 0,
      totalDebits,
      totalCredits,
      unbalancedJournals,
      accountDrift,
    };
  }

  /**
   * Get ledger summary for reporting
   */
  async getLedgerSummary(
    startDate: Date,
    endDate: Date
  ): Promise<{
    byAccount: Array<{ account_id: string; account_name: string; net_change: number }>;
    totalVolume: number;
  }> {
    const byAccount = await query<{
      account_id: string;
      account_name: string;
      net_change: number;
    }>(
      `SELECT
         le.account_id,
         a.name as account_name,
         SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END) as net_change
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       WHERE le.created_at >= $1 AND le.created_at < $2
       GROUP BY le.account_id, a.name`,
      [startDate, endDate]
    );

    const volumeResult = await queryOne<{ total: string }>(
      `SELECT SUM(amount) as total
       FROM ledger_entries
       WHERE entry_type = 'debit' AND created_at >= $1 AND created_at < $2`,
      [startDate, endDate]
    );

    return {
      byAccount,
      totalVolume: parseInt(volumeResult?.total || '0', 10),
    };
  }
}
