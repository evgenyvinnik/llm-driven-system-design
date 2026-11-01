import type { PoolClient } from 'pg';
import { pool } from './db.js';

/** Returns all wallet balances for a user including available (balance minus reserved). */
export async function getBalances(
  userId: string
): Promise<
  { currencyId: string; balance: string; reservedBalance: string; available: string }[]
> {
  const result = await pool.query(
    `SELECT w.currency_id AS "currencyId",
            w.balance::text AS balance,
            w.reserved_balance::text AS "reservedBalance",
            (w.balance - w.reserved_balance)::text AS available
     FROM wallets w
     WHERE w.user_id = $1
     ORDER BY w.balance DESC`,
    [userId]
  );
  return result.rows;
}

/** Returns the balance details for a specific currency wallet. */
export async function getBalance(
  userId: string,
  currencyId: string
): Promise<{ balance: string; reservedBalance: string; available: string } | null> {
  const result = await pool.query(
    `SELECT balance::text, reserved_balance::text AS "reservedBalance",
            (balance - reserved_balance)::text AS available
     FROM wallets
     WHERE user_id = $1 AND currency_id = $2`,
    [userId, currencyId]
  );
  return result.rows[0] || null;
}

/** Deposits funds into a user's wallet and records the transaction. */
export async function deposit(
  userId: string,
  currencyId: string,
  amount: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert wallet
    await client.query(
      `INSERT INTO wallets (user_id, currency_id, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, currency_id)
       DO UPDATE SET balance = wallets.balance + $3, updated_at = NOW()`,
      [userId, currencyId, amount]
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, currency_id, amount, status)
       VALUES ($1, 'deposit', $2, $3, 'completed')`,
      [userId, currencyId, amount]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Anything that can run a query: the pool, or a client inside a transaction. */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * Reserves balance for a pending order. Returns false if insufficient available funds.
 * The availability check is the UPDATE's WHERE clause, so two concurrent
 * reservations cannot both pass it.
 */
export async function reserveBalance(
  userId: string,
  currencyId: string,
  amount: string,
  db: Queryable = pool
): Promise<boolean> {
  const result = await db.query(
    `UPDATE wallets
     SET reserved_balance = reserved_balance + $3, updated_at = NOW()
     WHERE user_id = $1 AND currency_id = $2
       AND (balance - reserved_balance) >= $3
     RETURNING id`,
    [userId, currencyId, amount]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Returns held funds to the available balance. Deliberately not clamped at
 * zero: releasing more than is held is an accounting bug, and the
 * reserved_balance >= 0 CHECK turns it into a failed transaction instead of
 * silently absorbing it.
 */
export async function releaseReserve(
  userId: string,
  currencyId: string,
  amount: string,
  db: Queryable = pool
): Promise<void> {
  await db.query(
    `UPDATE wallets
     SET reserved_balance = reserved_balance - $3, updated_at = NOW()
     WHERE user_id = $1 AND currency_id = $2`,
    [userId, currencyId, amount]
  );
}

/** Pays out of held funds: the amount leaves both the balance and the reservation. */
export async function spendReserved(
  db: Queryable,
  userId: string,
  currencyId: string,
  amount: string
): Promise<void> {
  const result = await db.query(
    `UPDATE wallets
     SET balance = balance - $3, reserved_balance = reserved_balance - $3, updated_at = NOW()
     WHERE user_id = $1 AND currency_id = $2`,
    [userId, currencyId, amount]
  );
  if (result.rowCount === 0) {
    throw new Error(`No ${currencyId} wallet to debit for user ${userId}`);
  }
}

/** Adds funds to a wallet, creating it on first credit. */
export async function credit(
  db: Queryable,
  userId: string,
  currencyId: string,
  amount: string
): Promise<void> {
  await db.query(
    `INSERT INTO wallets (user_id, currency_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, currency_id)
     DO UPDATE SET balance = wallets.balance + $3, updated_at = NOW()`,
    [userId, currencyId, amount]
  );
}
