import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { logger } from './logger.js';
import { transferTotal, transferDuration, walletOperations } from './metrics.js';
import {
  claimIdempotencyKey,
  hashRequest,
  storeIdempotencyResponse,
  type IdempotencyContext,
} from './idempotencyService.js';
import { PaymentError } from './errors.js';
import { insertLedgerEntry } from './ledger.js';

export interface TransferResult {
  transaction: {
    id: string;
    senderId: string;
    recipientId: string;
    amountCents: number;
    type: string;
    status: string;
    note: string | null;
    createdAt: string;
  };
  senderBalance: number;
}

export interface TransferInput {
  senderId: string;
  recipientId: string;
  amountCents: number;
  note: string | null;
  idempotencyKey?: string;
}

/**
 * Moves money between two customer wallets inside the caller's transaction:
 * locks both wallets in user_id order, debits the sender, credits the
 * recipient, and writes the transaction row plus a balanced debit/credit pair.
 *
 * Shared by POST /transfers and by paying a money request, so a request's
 * status change and its transfer commit or roll back together.
 */
export async function transferWithinTransaction(
  client: PoolClient,
  senderId: string,
  recipientId: string,
  amountCents: number,
  note: string | null,
  idempotencyKey: string | null,
): Promise<TransferResult> {
  if (senderId === recipientId) {
    throw new PaymentError(400, 'SELF_TRANSFER', 'Cannot transfer to yourself');
  }

  // One statement locks both rows. ORDER BY is applied before FOR UPDATE takes
  // the locks, so every transfer locks the lower user_id first: Alice->Bob and
  // Bob->Alice at the same moment queue on the same first row instead of each
  // holding one lock and waiting on the other. The platform cash account is
  // excluded, so nobody can send money to or from it.
  const walletsResult = await client.query(
    `SELECT id, user_id, balance_cents, version FROM wallets
     WHERE user_id IN ($1, $2) AND account_type = 'customer'
     ORDER BY user_id
     FOR UPDATE`,
    [senderId, recipientId],
  );

  const senderWallet = walletsResult.rows.find((w: { user_id: string }) => w.user_id === senderId);
  const recipientWallet = walletsResult.rows.find((w: { user_id: string }) => w.user_id === recipientId);

  if (!senderWallet) {
    throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  }
  if (!recipientWallet) {
    throw new PaymentError(404, 'RECIPIENT_NOT_FOUND', 'Recipient not found');
  }

  if (Number(senderWallet.balance_cents) < amountCents) {
    throw new PaymentError(400, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
  }

  // Arithmetic happens in Postgres on BIGINT; JavaScript only reads the result.
  // The version check can't fail while we hold the row lock; it is a tripwire
  // in case the lock is ever removed.
  const senderUpdate = await client.query(
    `UPDATE wallets SET balance_cents = balance_cents - $1, version = version + 1, updated_at = NOW()
     WHERE id = $2 AND version = $3
     RETURNING balance_cents`,
    [amountCents, senderWallet.id, senderWallet.version],
  );
  if (senderUpdate.rows.length === 0) {
    throw new Error('Concurrent modification detected on sender wallet');
  }

  const recipientUpdate = await client.query(
    `UPDATE wallets SET balance_cents = balance_cents + $1, version = version + 1, updated_at = NOW()
     WHERE id = $2 AND version = $3
     RETURNING balance_cents`,
    [amountCents, recipientWallet.id, recipientWallet.version],
  );
  if (recipientUpdate.rows.length === 0) {
    throw new Error('Concurrent modification detected on recipient wallet');
  }

  const newSenderBalance = Number(senderUpdate.rows[0].balance_cents);
  const newRecipientBalance = Number(recipientUpdate.rows[0].balance_cents);

  const txResult = await client.query(
    `INSERT INTO transactions (idempotency_key, sender_id, recipient_id, amount_cents, type, status, note)
     VALUES ($1, $2, $3, $4, 'transfer', 'completed', $5)
     RETURNING id, sender_id, recipient_id, amount_cents, type, status, note, created_at`,
    [idempotencyKey, senderId, recipientId, amountCents, note],
  );
  const transaction = txResult.rows[0];

  // Double-entry: the debit and the credit carry the same amount, so every
  // transfer's entries net to zero.
  await insertLedgerEntry(client, transaction.id, senderWallet.id, 'debit', amountCents, newSenderBalance);
  await insertLedgerEntry(client, transaction.id, recipientWallet.id, 'credit', amountCents, newRecipientBalance);

  return {
    transaction: {
      id: transaction.id,
      senderId: transaction.sender_id,
      recipientId: transaction.recipient_id,
      amountCents: Number(transaction.amount_cents),
      type: transaction.type,
      status: transaction.status,
      note: transaction.note,
      createdAt: transaction.created_at,
    },
    senderBalance: newSenderBalance,
  };
}

/**
 * Executes a P2P transfer in its own transaction. With an idempotency key, the
 * key is claimed first in the same transaction, so a retry replays the stored
 * result and a concurrent duplicate waits rather than paying twice.
 */
export async function executeTransfer(
  input: TransferInput,
): Promise<{ result: TransferResult; replayed: boolean }> {
  const startTime = Date.now();
  const { senderId, recipientId, amountCents, note, idempotencyKey } = input;

  const idem: IdempotencyContext | null = idempotencyKey
    ? {
        userId: senderId,
        key: idempotencyKey,
        requestHash: hashRequest('transfer', { recipientId, amountCents, note }),
      }
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (idem) {
      const claim = await claimIdempotencyKey(client, idem);
      if (claim.status === 'replay') {
        await client.query('ROLLBACK');
        return { result: claim.response as TransferResult, replayed: true };
      }
    }

    const result = await transferWithinTransaction(
      client,
      senderId,
      recipientId,
      amountCents,
      note,
      idempotencyKey ?? null,
    );

    if (idem) {
      await storeIdempotencyResponse(client, idem, result);
    }

    await client.query('COMMIT');

    transferDuration.observe({ status: 'completed' }, (Date.now() - startTime) / 1000);
    transferTotal.inc({ status: 'completed' });
    walletOperations.inc({ type: 'transfer' });
    logger.info(
      { senderId, recipientId, amountCents, transactionId: result.transaction.id },
      'Transfer completed',
    );

    return { result, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);

    transferDuration.observe({ status: 'failed' }, (Date.now() - startTime) / 1000);
    transferTotal.inc({ status: 'failed' });
    if (!(err instanceof PaymentError)) {
      logger.error({ err, senderId, recipientId, amountCents }, 'Transfer failed');
    }
    throw err;
  } finally {
    client.release();
  }
}
