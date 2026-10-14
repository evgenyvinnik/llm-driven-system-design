import { describe, it, expect, vi } from 'vitest';

// Mock shared modules before import (connection.ts would open PG and Redis)
vi.mock('../db/connection.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  SYSTEM_ACCOUNTS: {
    ACCOUNTS_RECEIVABLE: '00000000-0000-0000-0000-000000000001',
    PLATFORM_REVENUE: '00000000-0000-0000-0000-000000000002',
    PENDING_SETTLEMENTS: '00000000-0000-0000-0000-000000000003',
  },
}));

import {
  LedgerService,
  UnbalancedJournalError,
  assertBalanced,
  buildCaptureJournal,
  buildChargebackJournal,
  buildChargebackReversalJournal,
  buildRefundJournal,
  refundFeeShare,
  type JournalLine,
} from './ledger.service.js';

const MERCHANT = '9f000000-0000-0000-0000-000000000099';

function net(lines: JournalLine[]): number {
  return lines.reduce((sum, l) => sum + (l.entryType === 'debit' ? l.amount : -l.amount), 0);
}

describe('journal builders', () => {
  it('builds a balanced three-line capture journal', () => {
    const lines = buildCaptureJournal(MERCHANT, 10000, 320);
    expect(lines).toHaveLength(3);
    expect(net(lines)).toBe(0);
    expect(lines.find((l) => l.accountId === MERCHANT)).toMatchObject({ entryType: 'credit', amount: 9680 });
  });

  it('drops a zero fee line instead of posting a 0-cent entry', () => {
    const lines = buildCaptureJournal(MERCHANT, 10000, 0);
    expect(lines).toHaveLength(2);
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('returns exactly the original fee across partial refunds that add up to the full amount', () => {
    const amount = 64000;
    const fee = 1886;
    const first = refundFeeShare(16000, 0, amount, fee);
    const second = refundFeeShare(16001, 16000, amount, fee);
    const third = refundFeeShare(amount - 32001, 32001, amount, fee);
    expect(first).toBe(472);
    expect(first + second + third).toBe(fee);
  });

  it('builds balanced refund, chargeback and reversal journals', () => {
    const refund = buildRefundJournal(MERCHANT, 16000, 0, 64000, 1886, 'pay_1');
    const chargeback = buildChargebackJournal(MERCHANT, 189900, 1500, 'pay_2');
    const reversal = buildChargebackReversalJournal(MERCHANT, 189900, 1500, 'pay_2');
    for (const lines of [refund, chargeback, reversal]) {
      expect(net(lines)).toBe(0);
    }
    expect(chargeback.find((l) => l.accountId === MERCHANT)).toMatchObject({ entryType: 'debit', amount: 191400 });
    expect(reversal.find((l) => l.accountId === MERCHANT)).toMatchObject({ entryType: 'credit', amount: 191400 });
  });

  it('rejects unbalanced, single-line and non-integer journals', () => {
    const unbalanced: JournalLine[] = [
      { accountId: 'a', entryType: 'debit', amount: 100, description: '' },
      { accountId: 'b', entryType: 'credit', amount: 99, description: '' },
    ];
    expect(() => assertBalanced(unbalanced)).toThrow(UnbalancedJournalError);
    expect(() => assertBalanced(unbalanced.slice(0, 1))).toThrow(UnbalancedJournalError);
    expect(() =>
      assertBalanced([
        { accountId: 'a', entryType: 'debit', amount: 10.5, description: '' },
        { accountId: 'b', entryType: 'credit', amount: 10.5, description: '' },
      ])
    ).toThrow(UnbalancedJournalError);
  });
});

describe('LedgerService.postJournal', () => {
  it('locks accounts in id order and tags every entry with one journal id', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('UPDATE accounts')) return { rowCount: 1, rows: [{ balance: 0 }] };
        return { rowCount: 1, rows: [{ id: params[0], journal_id: params[1], account_id: params[3] }] };
      }),
    };

    const ledger = new LedgerService();
    const posted = await ledger.postJournal(client as never, 'pay_1', 'USD', buildCaptureJournal(MERCHANT, 10000, 320));

    const accountOrder = calls.filter((c) => c.sql.includes('UPDATE accounts')).map((c) => c.params[0] as string);
    expect(accountOrder).toEqual([...accountOrder].sort());
    expect(new Set(posted.entries.map((e) => e.journal_id))).toEqual(new Set([posted.journalId]));
  });

  it('refuses an unbalanced journal before touching the database', async () => {
    const client = { query: vi.fn() };
    const ledger = new LedgerService();
    await expect(
      ledger.postJournal(client as never, 'pay_1', 'USD', [
        { accountId: 'a', entryType: 'debit', amount: 100, description: '' },
        { accountId: 'b', entryType: 'credit', amount: 90, description: '' },
      ])
    ).rejects.toThrow(UnbalancedJournalError);
    expect(client.query).not.toHaveBeenCalled();
  });
});
