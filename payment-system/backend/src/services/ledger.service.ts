import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, SYSTEM_ACCOUNTS } from '../db/connection.js';
import type { LedgerEntry, Account } from '../types/index.js';

/**
 * Double-entry bookkeeping service
 *
 * Every financial transaction creates balanced entries:
 * - Debits increase asset/expense accounts
 * - Credits increase liability/revenue/equity accounts
 *
 * The fundamental equation: Assets = Liabilities + Equity
 */
export class LedgerService {
  /**
   * Record ledger entries for a captured payment
   *
   * When a payment is captured:
   * 1. Debit Accounts Receivable (money coming from processor)
   * 2. Credit Merchant Account (money owed to merchant)
   * 3. Credit Platform Revenue (our fee)
   */
  async recordPaymentCapture(
    client: PoolClient,
    transactionId: string,
    merchantAccountId: string,
    amount: number,
    feeAmount: number,
    currency: string
  ): Promise<LedgerEntry[]> {
    const netAmount = amount - feeAmount;
    const entries: LedgerEntry[] = [];

    // 1. Debit Accounts Receivable (asset increases)
    const arEntry = await this.createEntry(
      client,
      transactionId,
      SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE,
      'debit',
      amount,
      currency,
      'Payment received from processor'
    );
    entries.push(arEntry);

    // 2. Credit Merchant Account (liability increases - we owe them money)
    const merchantEntry = await this.createEntry(
      client,
      transactionId,
      merchantAccountId,
      'credit',
      netAmount,
      currency,
      'Payment to merchant (net of fees)'
    );
    entries.push(merchantEntry);

    // 3. Credit Platform Revenue (our fee)
    const revenueEntry = await this.createEntry(
      client,
      transactionId,
      SYSTEM_ACCOUNTS.PLATFORM_REVENUE,
      'credit',
      feeAmount,
      currency,
      'Platform transaction fee'
    );
    entries.push(revenueEntry);

    return entries;
  }

  /**
   * Record ledger entries for a refund
   *
   * Refunds reverse the original entries:
   * 1. Credit Accounts Receivable (money going back to processor)
   * 2. Debit Merchant Account (reduce what we owe them)
   * 3. Debit Platform Revenue (return our fee proportionally)
   */
  async recordRefund(
    client: PoolClient,
    transactionId: string,
    refundTransactionId: string,
    merchantAccountId: string,
    refundAmount: number,
    originalAmount: number,
    originalFee: number,
    currency: string
  ): Promise<LedgerEntry[]> {
    // Calculate proportional fee refund
    const feeRefund = Math.round((refundAmount / originalAmount) * originalFee);
    const merchantRefund = refundAmount - feeRefund;
    const entries: LedgerEntry[] = [];

    // 1. Credit Accounts Receivable (asset decreases)
    const arEntry = await this.createEntry(
      client,
      refundTransactionId,
      SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE,
      'credit',
      refundAmount,
      currency,
      `Refund for transaction ${transactionId}`
    );
    entries.push(arEntry);

    // 2. Debit Merchant Account (liability decreases)
    const merchantEntry = await this.createEntry(
      client,
      refundTransactionId,
      merchantAccountId,
      'debit',
      merchantRefund,
      currency,
      `Refund deduction for transaction ${transactionId}`
    );
    entries.push(merchantEntry);

    // 3. Debit Platform Revenue (return fee)
    const revenueEntry = await this.createEntry(
      client,
      refundTransactionId,
      SYSTEM_ACCOUNTS.PLATFORM_REVENUE,
      'debit',
      feeRefund,
      currency,
      `Fee refund for transaction ${transactionId}`
    );
    entries.push(revenueEntry);

    return entries;
  }

  /**
   * Record ledger entries for a chargeback
   *
   * Similar to refund but includes additional fees
   */
  async recordChargeback(
    client: PoolClient,
    transactionId: string,
    chargebackId: string,
    merchantAccountId: string,
    amount: number,
    chargebackFee: number,
    currency: string
  ): Promise<LedgerEntry[]> {
    const entries: LedgerEntry[] = [];

    // 1. Credit Accounts Receivable (money going back)
    const arEntry = await this.createEntry(
      client,
      chargebackId,
      SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE,
      'credit',
      amount,
      currency,
      `Chargeback for transaction ${transactionId}`
    );
    entries.push(arEntry);

    // 2. Debit Merchant Account (full amount + chargeback fee)
    const merchantEntry = await this.createEntry(
      client,
      chargebackId,
      merchantAccountId,
      'debit',
      amount + chargebackFee,
      currency,
      `Chargeback deduction for transaction ${transactionId}`
    );
    entries.push(merchantEntry);

    // 3. Credit Platform Revenue (chargeback fee - we charge for chargebacks)
    const revenueEntry = await this.createEntry(
      client,
      chargebackId,
      SYSTEM_ACCOUNTS.PLATFORM_REVENUE,
      'credit',
      chargebackFee,
      currency,
      'Chargeback processing fee'
    );
    entries.push(revenueEntry);

    return entries;
  }

  /**
   * Create a single ledger entry and update account balance
   */
  private async createEntry(
    client: PoolClient,
    transactionId: string,
    accountId: string,
    entryType: 'debit' | 'credit',
    amount: number,
    currency: string,
    description: string
  ): Promise<LedgerEntry> {
    // Update account balance atomically
    const balanceChange = entryType === 'debit' ? amount : -amount;

    // For asset accounts, debits increase balance
    // For liability/revenue accounts, credits increase balance
    // We use a simplified model where we track from liability perspective
    const accountResult = await client.query<Account>(
      `UPDATE accounts
       SET balance = balance + $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [accountId, entryType === 'credit' ? amount : -amount]
    );

    const balanceAfter = accountResult.rows[0]?.balance ?? 0;

    // Create the ledger entry
    const entryId = uuidv4();
    const result = await client.query<LedgerEntry>(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, currency, balance_after, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [entryId, transactionId, accountId, entryType, amount, currency, balanceAfter, description]
    );

    return result.rows[0];
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
      'SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at',
      [transactionId]
    );
  }

  /**
   * Daily reconciliation check - debits must equal credits
   */
  async verifyLedgerBalance(
    startDate: Date,
    endDate: Date
  ): Promise<{ balanced: boolean; totalDebits: number; totalCredits: number }> {
    const result = await queryOne<{ debits: string; credits: string }>(
      `SELECT
         SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) as debits,
         SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) as credits
       FROM ledger_entries
       WHERE created_at >= $1 AND created_at < $2`,
      [startDate, endDate]
    );

    const totalDebits = parseInt(result?.debits || '0', 10);
    const totalCredits = parseInt(result?.credits || '0', 10);

    return {
      balanced: totalDebits === totalCredits,
      totalDebits,
      totalCredits,
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
