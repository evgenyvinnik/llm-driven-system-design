import type { PoolClient } from 'pg';

/** The platform's bookkeeping user and its cash wallet (created by init.sql). */
export const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000000';
export const PLATFORM_CASH_WALLET_ID = '00000000-0000-0000-0000-000000000001';

export type EntryType = 'debit' | 'credit';

/** Appends one side of a double-entry posting. */
export async function insertLedgerEntry(
  client: PoolClient,
  transactionId: string,
  walletId: string,
  entryType: EntryType,
  amountCents: number,
  balanceAfterCents: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, wallet_id, entry_type, amount_cents, balance_after_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [transactionId, walletId, entryType, amountCents, balanceAfterCents],
  );
}
