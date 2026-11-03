import { pool } from './db.js';
import { logger } from './logger.js';
import { walletOperations } from './metrics.js';
import {
  claimIdempotencyKey,
  hashRequest,
  storeIdempotencyResponse,
  type IdempotencyContext,
} from './idempotencyService.js';
import { PaymentError } from './errors.js';
import { insertLedgerEntry } from './ledger.js';

export interface WalletInfo {
  id: string;
  userId: string;
  balanceCents: number;
  currency: string;
  version: number;
}

export interface WalletOperationResult {
  transaction: {
    id: string;
    amountCents: number;
    type: string;
    status: string;
    note: string | null;
    paymentMethodId: string;
    createdAt: string;
  };
  wallet: WalletInfo;
}

export interface WalletOperationInput {
  userId: string;
  amountCents: number;
  paymentMethodId: string;
  note: string | null;
  idempotencyKey?: string;
}

/** Optimistic-lock attempts before a deposit/withdrawal gives up with 409. */
const MAX_VERSION_RETRIES = 3;

/** Thrown inside an attempt when the wallet's version moved under us. */
class VersionConflict extends Error {}

/** Retrieves the wallet balance and metadata for a given user. */
export async function getWallet(userId: string): Promise<WalletInfo | null> {
  const result = await pool.query(
    `SELECT id, user_id, balance_cents, currency, version
     FROM wallets WHERE user_id = $1 AND account_type = 'customer'`,
    [userId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    balanceCents: Number(row.balance_cents),
    currency: row.currency,
    version: row.version,
  };
}

/** Deposits funds from one of the user's linked payment methods. */
export function deposit(
  input: WalletOperationInput,
): Promise<{ result: WalletOperationResult; replayed: boolean }> {
  return walletOperation('deposit', input);
}

/** Withdraws funds to one of the user's linked payment methods. */
export function withdraw(
  input: WalletOperationInput,
): Promise<{ result: WalletOperationResult; replayed: boolean }> {
  return walletOperation('withdrawal', input);
}

/**
 * A single-wallet balance change, posted double-entry against the platform
 * cash account:
 *
 *   deposit:    debit platform cash, credit customer wallet
 *   withdrawal: debit customer wallet, credit platform cash
 *
 * The customer wallet uses optimistic locking: read balance and version, then
 * `UPDATE ... WHERE version = $read`. If another write got there first the
 * UPDATE matches no row, and the whole attempt (including the idempotency
 * claim) rolls back and is retried, so no update is lost.
 *
 * The platform cash row is updated last with an atomic increment. Every
 * deposit and withdrawal touches it, so it is the hot row; taking its lock at
 * the end keeps the time it is held short, and since transfers never touch it
 * and nothing waits on another lock after acquiring it, it can't deadlock.
 */
async function walletOperation(
  type: 'deposit' | 'withdrawal',
  input: WalletOperationInput,
): Promise<{ result: WalletOperationResult; replayed: boolean }> {
  const { userId, amountCents, paymentMethodId, note, idempotencyKey } = input;
  const idem: IdempotencyContext | null = idempotencyKey
    ? {
        userId,
        key: idempotencyKey,
        requestHash: hashRequest(type, { amountCents, paymentMethodId, note }),
      }
    : null;

  for (let attempt = 1; ; attempt++) {
    try {
      return await walletOperationAttempt(type, input, idem);
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      if (attempt >= MAX_VERSION_RETRIES) {
        logger.warn({ userId, type, attempt }, 'Wallet version conflict, giving up');
        throw new PaymentError(409, 'CONCURRENT_UPDATE', 'Wallet was updated concurrently, please retry');
      }
      // Short jittered pause so competing writers don't collide again in lockstep.
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));
    }
  }
}

async function walletOperationAttempt(
  type: 'deposit' | 'withdrawal',
  input: WalletOperationInput,
  idem: IdempotencyContext | null,
): Promise<{ result: WalletOperationResult; replayed: boolean }> {
  const { userId, amountCents, paymentMethodId, note } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (idem) {
      const claim = await claimIdempotencyKey(client, idem);
      if (claim.status === 'replay') {
        await client.query('ROLLBACK');
        return { result: claim.response as WalletOperationResult, replayed: true };
      }
    }

    // The funding source must be the caller's own. Someone else's card is
    // reported exactly like a missing one, so IDs can't be probed.
    const methodResult = await client.query(
      `SELECT id, type, label, last_four FROM payment_methods WHERE id = $1 AND user_id = $2`,
      [paymentMethodId, userId],
    );
    if (methodResult.rows.length === 0) {
      throw new PaymentError(404, 'PAYMENT_METHOD_NOT_FOUND', 'Payment method not found');
    }
    const method = methodResult.rows[0];

    const walletResult = await client.query(
      `SELECT id, balance_cents, currency, version FROM wallets
       WHERE user_id = $1 AND account_type = 'customer'`,
      [userId],
    );
    if (walletResult.rows.length === 0) {
      throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    }
    const wallet = walletResult.rows[0];

    if (type === 'withdrawal' && Number(wallet.balance_cents) < amountCents) {
      throw new PaymentError(400, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    }

    const delta = type === 'deposit' ? amountCents : -amountCents;
    const walletUpdate = await client.query(
      `UPDATE wallets SET balance_cents = balance_cents + $1, version = version + 1, updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING balance_cents, version`,
      [delta, wallet.id, wallet.version],
    );
    if (walletUpdate.rows.length === 0) {
      throw new VersionConflict();
    }
    const newBalance = Number(walletUpdate.rows[0].balance_cents);
    const newVersion = walletUpdate.rows[0].version;

    const defaultNote =
      type === 'deposit' ? `Transfer from ${method.label}` : `Withdrawal to ${method.label}`;
    // A deposit has no internal sender; a withdrawal's counterparty is the
    // user's own bank, so sender and recipient are both the user.
    const txResult = await client.query(
      `INSERT INTO transactions
         (idempotency_key, sender_id, recipient_id, amount_cents, type, status, note, payment_method_id)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7)
       RETURNING id, amount_cents, type, status, note, payment_method_id, created_at`,
      [
        idem?.key ?? null,
        type === 'deposit' ? null : userId,
        userId,
        amountCents,
        type,
        note ?? defaultNote,
        method.id,
      ],
    );
    const transaction = txResult.rows[0];

    // Platform cash is debit-normal: a deposit raises it, a withdrawal lowers
    // it. It equals the sum of customer balances, so it never goes negative.
    const cashUpdate = await client.query(
      `UPDATE wallets SET balance_cents = balance_cents + $1, version = version + 1, updated_at = NOW()
       WHERE account_type = 'platform_cash'
       RETURNING id, balance_cents`,
      [delta],
    );
    if (cashUpdate.rows.length === 0) {
      throw new Error('Platform cash account is missing; run npm run db:migrate');
    }
    const cash = cashUpdate.rows[0];
    const cashBalance = Number(cash.balance_cents);

    if (type === 'deposit') {
      await insertLedgerEntry(client, transaction.id, cash.id, 'debit', amountCents, cashBalance);
      await insertLedgerEntry(client, transaction.id, wallet.id, 'credit', amountCents, newBalance);
    } else {
      await insertLedgerEntry(client, transaction.id, wallet.id, 'debit', amountCents, newBalance);
      await insertLedgerEntry(client, transaction.id, cash.id, 'credit', amountCents, cashBalance);
    }

    const result: WalletOperationResult = {
      transaction: {
        id: transaction.id,
        amountCents: Number(transaction.amount_cents),
        type: transaction.type,
        status: transaction.status,
        note: transaction.note,
        paymentMethodId: transaction.payment_method_id,
        createdAt: transaction.created_at,
      },
      wallet: {
        id: wallet.id,
        userId,
        balanceCents: newBalance,
        currency: wallet.currency,
        version: newVersion,
      },
    };

    if (idem) {
      await storeIdempotencyResponse(client, idem, result);
    }

    await client.query('COMMIT');
    walletOperations.inc({ type });
    logger.info({ userId, type, amountCents, newBalance }, 'Wallet operation completed');

    return { result, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
