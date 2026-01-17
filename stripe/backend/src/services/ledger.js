import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { query, transaction } from '../db/pool.js';

// Fee calculation: 2.9% + 30 cents
const FEE_PERCENT = parseFloat(process.env.PROCESSING_FEE_PERCENT || '2.9') / 100;
const FEE_FIXED = parseInt(process.env.PROCESSING_FEE_FIXED || '30');

export function calculateFee(amount) {
  return Math.round(amount * FEE_PERCENT + FEE_FIXED);
}

/**
 * Create double-entry ledger entries for a charge
 * Debits = Credits is enforced
 */
export async function createChargeEntries(client, { chargeId, paymentIntentId, amount, merchantId }) {
  const transactionId = uuidv4();
  const fee = calculateFee(amount);
  const netAmount = amount - fee;

  const entries = [
    // Debit: Funds receivable (we're owed money from card network)
    {
      account: 'funds_receivable',
      debit: amount,
      credit: 0,
      description: 'Card payment received'
    },
    // Credit: Merchant payable (we owe merchant)
    {
      account: `merchant:${merchantId}:payable`,
      debit: 0,
      credit: netAmount,
      description: 'Merchant payment due'
    },
    // Credit: Platform revenue (our fees)
    {
      account: 'revenue:transaction_fees',
      debit: 0,
      credit: fee,
      description: 'Processing fee'
    }
  ];

  // Verify balance
  const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

  if (totalDebit !== totalCredit) {
    throw new Error(`Ledger imbalance: debit=${totalDebit}, credit=${totalCredit}`);
  }

  // Insert all entries
  for (const entry of entries) {
    await client.query(`
      INSERT INTO ledger_entries
        (transaction_id, account, debit, credit, payment_intent_id, charge_id, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [transactionId, entry.account, entry.debit, entry.credit, paymentIntentId, chargeId, entry.description]);
  }

  return { transactionId, fee, netAmount };
}

/**
 * Create double-entry ledger entries for a refund
 */
export async function createRefundEntries(client, { refundId, chargeId, paymentIntentId, amount, merchantId, originalFee }) {
  const transactionId = uuidv4();

  // Calculate proportional fee refund
  const feeRefund = Math.round((amount / (amount + originalFee)) * originalFee);

  const entries = [
    // Debit: Reduce merchant payable (merchant owes us back)
    {
      account: `merchant:${merchantId}:payable`,
      debit: amount - feeRefund,
      credit: 0,
      description: 'Refund deducted from merchant'
    },
    // Debit: Reduce our revenue
    {
      account: 'revenue:transaction_fees',
      debit: feeRefund,
      credit: 0,
      description: 'Fee refund'
    },
    // Credit: Reduce funds receivable
    {
      account: 'funds_receivable',
      debit: 0,
      credit: amount,
      description: 'Refund to customer'
    }
  ];

  // Verify balance
  const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

  if (totalDebit !== totalCredit) {
    throw new Error(`Ledger imbalance: debit=${totalDebit}, credit=${totalCredit}`);
  }

  // Insert all entries
  for (const entry of entries) {
    await client.query(`
      INSERT INTO ledger_entries
        (transaction_id, account, debit, credit, payment_intent_id, charge_id, refund_id, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [transactionId, entry.account, entry.debit, entry.credit, paymentIntentId, chargeId, refundId, entry.description]);
  }

  return { transactionId, feeRefund };
}

/**
 * Get account balance
 */
export async function getAccountBalance(account, currency = 'usd') {
  const result = await query(`
    SELECT
      COALESCE(SUM(debit), 0) as total_debit,
      COALESCE(SUM(credit), 0) as total_credit,
      COALESCE(SUM(credit) - SUM(debit), 0) as balance
    FROM ledger_entries
    WHERE account = $1 AND currency = $2
  `, [account, currency]);

  return result.rows[0];
}

/**
 * Get merchant balance
 */
export async function getMerchantBalance(merchantId, currency = 'usd') {
  return getAccountBalance(`merchant:${merchantId}:payable`, currency);
}

/**
 * Get ledger entries for an account
 */
export async function getAccountLedger(account, limit = 100, offset = 0) {
  const result = await query(`
    SELECT
      id, transaction_id, account, debit, credit, currency,
      payment_intent_id, charge_id, refund_id, description, created_at
    FROM ledger_entries
    WHERE account = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [account, limit, offset]);

  return result.rows;
}

/**
 * Get all entries for a transaction (grouped by transaction_id)
 */
export async function getTransactionEntries(transactionId) {
  const result = await query(`
    SELECT
      id, transaction_id, account, debit, credit, currency,
      payment_intent_id, charge_id, refund_id, description, created_at
    FROM ledger_entries
    WHERE transaction_id = $1
    ORDER BY id
  `, [transactionId]);

  return result.rows;
}

/**
 * Verify ledger integrity - all transaction_ids should balance
 */
export async function verifyLedgerIntegrity() {
  const result = await query(`
    SELECT
      transaction_id,
      SUM(debit) as total_debit,
      SUM(credit) as total_credit,
      SUM(debit) - SUM(credit) as imbalance
    FROM ledger_entries
    GROUP BY transaction_id
    HAVING SUM(debit) != SUM(credit)
  `);

  return {
    valid: result.rows.length === 0,
    imbalances: result.rows
  };
}

/**
 * Get platform revenue summary
 */
export async function getPlatformRevenue(startDate, endDate) {
  const result = await query(`
    SELECT
      DATE(created_at) as date,
      SUM(credit) as revenue
    FROM ledger_entries
    WHERE account = 'revenue:transaction_fees'
      AND created_at >= $1 AND created_at < $2
    GROUP BY DATE(created_at)
    ORDER BY date
  `, [startDate, endDate]);

  return result.rows;
}
