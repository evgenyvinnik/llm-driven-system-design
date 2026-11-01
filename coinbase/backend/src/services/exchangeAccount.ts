import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * The exchange's own account. It plays two roles:
 *
 * 1. Liquidity of last resort. When a market order exhausts the book, the
 *    remainder fills against this account at the simulated market price, as a
 *    real trade with a real counter-order. That keeps every trade two-sided:
 *    no fill ever credits one user without debiting someone.
 * 2. Fee collector. Maker and taker fees are credited here, so a trade moves
 *    value between wallets without creating or destroying any.
 *
 * Its balances are topped up at boot and each top-up is recorded as a deposit,
 * so the only place money enters the system is visible in `transactions`.
 */
export const EXCHANGE_USER_ID = '00000000-0000-4000-8000-00000000e0c0';

/** Available balance the account is topped back up to, per currency. */
const LIQUIDITY_TARGET = '1000000000';

export async function ensureExchangeAccount(): Promise<void> {
  // A random password nobody knows: the account exists for bookkeeping, not login.
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
  await pool.query(
    `INSERT INTO users (id, username, email, password_hash, display_name, is_verified)
     VALUES ($1, 'exchange-liquidity-desk', 'liquidity-desk@exchange.internal', $2,
             'Exchange Liquidity Desk', true)
     ON CONFLICT DO NOTHING`,
    [EXCHANGE_USER_ID, passwordHash]
  );

  await pool.query(
    `INSERT INTO wallets (user_id, currency_id, balance)
     SELECT $1, id, 0 FROM currencies
     ON CONFLICT (user_id, currency_id) DO NOTHING`,
    [EXCHANGE_USER_ID]
  );

  const topped = await pool.query(
    `WITH previous AS (
       SELECT id, balance AS old_balance
       FROM wallets
       WHERE user_id = $1 AND balance - reserved_balance < $2::numeric / 2
       FOR UPDATE
     ), updated AS (
       UPDATE wallets w
       SET balance = w.reserved_balance + $2::numeric, updated_at = NOW()
       FROM previous
       WHERE w.id = previous.id
       RETURNING w.currency_id, w.balance - previous.old_balance AS minted
     )
     INSERT INTO transactions (user_id, type, currency_id, amount, status)
     SELECT $1, 'deposit', currency_id, minted, 'completed' FROM updated WHERE minted > 0
     RETURNING currency_id`,
    [EXCHANGE_USER_ID, LIQUIDITY_TARGET]
  );

  if (topped.rowCount) {
    logger.info(
      { currencies: topped.rows.map((r) => r.currency_id) },
      'Topped up exchange liquidity account'
    );
  }
}
