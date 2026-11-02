import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeClient, type FakeClient } from '../test/fakeDb.js';

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('./db.js', () => ({
  pool: { connect: vi.fn(async () => mocks.client), query: vi.fn() },
}));

import { executeTransfer, transferWithinTransaction } from './transferService.js';
import { hashRequest } from './idempotencyService.js';
import { PaymentError } from './errors.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

function walletsFixture(client: FakeClient, aliceBalance = '10000', bobBalance = '5000') {
  client
    .on(/FROM wallets[\s\S]*FOR UPDATE/, [
      { id: 'wa', user_id: ALICE, balance_cents: aliceBalance, version: 3 },
      { id: 'wb', user_id: BOB, balance_cents: bobBalance, version: 7 },
    ])
    .on(/UPDATE wallets SET balance_cents = balance_cents - \$1/, (p) => ({
      rows: [{ balance_cents: String(Number(aliceBalance) - (p[0] as number)) }],
    }))
    .on(/UPDATE wallets SET balance_cents = balance_cents \+ \$1/, (p) => ({
      rows: [{ balance_cents: String(Number(bobBalance) + (p[0] as number)) }],
    }))
    .on(/INSERT INTO transactions/, (p) => ({
      rows: [
        {
          id: 'tx-1',
          sender_id: p[1],
          recipient_id: p[2],
          amount_cents: String(p[3]),
          type: 'transfer',
          status: 'completed',
          note: p[4],
          created_at: '2026-11-01T00:00:00Z',
        },
      ],
    }));
}

describe('transferWithinTransaction', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = createFakeClient();
  });

  it('locks both customer wallets in one ordered FOR UPDATE and posts a balanced pair', async () => {
    walletsFixture(client);
    const result = await transferWithinTransaction(client as never, ALICE, BOB, 2500, 'rent', null);

    const lock = client.sqlLog().find((s) => s.includes('FOR UPDATE'))!;
    expect(lock).toContain("account_type = 'customer'");
    expect(lock).toMatch(/ORDER BY user_id FOR UPDATE/);

    // Balance arithmetic runs in SQL on BIGINT, with the amount as a parameter.
    const debit = client.calls.find((c) => /balance_cents - \$1/.test(c.sql))!;
    expect(debit.params).toEqual([2500, 'wa', 3]);

    const entries = client.calls.filter((c) => c.sql.includes('INSERT INTO ledger_entries'));
    expect(entries.map((e) => [e.params[1], e.params[2], e.params[3], e.params[4]])).toEqual([
      ['wa', 'debit', 2500, 7500],
      ['wb', 'credit', 2500, 7500],
    ]);
    expect(result.senderBalance).toBe(7500);
    expect(result.transaction.amountCents).toBe(2500);
  });

  it('refuses a self-transfer before touching any wallet', async () => {
    await expect(transferWithinTransaction(client as never, ALICE, ALICE, 100, null, null)).rejects.toMatchObject({
      status: 400,
      code: 'SELF_TRANSFER',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('returns 404 for an unknown recipient (or the platform account, which the lock query excludes)', async () => {
    client.on(/FOR UPDATE/, [{ id: 'wa', user_id: ALICE, balance_cents: '10000', version: 1 }]);
    await expect(transferWithinTransaction(client as never, ALICE, BOB, 100, null, null)).rejects.toMatchObject({
      status: 404,
      code: 'RECIPIENT_NOT_FOUND',
    });
  });

  it('refuses to overdraw and writes nothing', async () => {
    walletsFixture(client, '99');
    await expect(transferWithinTransaction(client as never, ALICE, BOB, 100, null, null)).rejects.toMatchObject({
      status: 400,
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(client.sqlLog().some((s) => s.startsWith('UPDATE') || s.startsWith('INSERT'))).toBe(false);
  });
});

describe('executeTransfer idempotency', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = createFakeClient();
    mocks.client = client;
  });

  it('claims the key first, then moves money, stores the response, and commits', async () => {
    walletsFixture(client);
    client.on(/INSERT INTO idempotency_keys/, [{ key: 'k1' }]);

    const { result, replayed } = await executeTransfer({
      senderId: ALICE,
      recipientId: BOB,
      amountCents: 2500,
      note: null,
      idempotencyKey: 'k1',
    });

    expect(replayed).toBe(false);
    const log = client.sqlLog();
    expect(log[0]).toBe('BEGIN');
    expect(log[1]).toMatch(/^INSERT INTO idempotency_keys/);
    expect(log.findIndex((s) => s.includes('FOR UPDATE'))).toBeGreaterThan(1);
    expect(log.some((s) => s.startsWith('UPDATE idempotency_keys SET response'))).toBe(true);
    expect(log[log.length - 1]).toBe('COMMIT');

    // The key is scoped to the sender and bound to this exact request.
    const claim = client.calls[1];
    expect(claim.params).toEqual([ALICE, 'k1', hashRequest('transfer', { recipientId: BOB, amountCents: 2500, note: null })]);
    expect(result.transaction.id).toBe('tx-1');
  });

  it('replays the stored response without locking or moving money', async () => {
    const stored = { transaction: { id: 'tx-old' }, senderBalance: 1 };
    client
      .on(/INSERT INTO idempotency_keys/, [])
      .on(/SELECT request_hash, response FROM idempotency_keys/, [
        { request_hash: hashRequest('transfer', { recipientId: BOB, amountCents: 2500, note: null }), response: stored },
      ]);

    const { result, replayed } = await executeTransfer({
      senderId: ALICE,
      recipientId: BOB,
      amountCents: 2500,
      note: null,
      idempotencyKey: 'k1',
    });

    expect(replayed).toBe(true);
    expect(result).toEqual(stored);
    const log = client.sqlLog();
    expect(log.some((s) => s.includes('FOR UPDATE') || s.startsWith('UPDATE wallets'))).toBe(false);
    expect(log[log.length - 1]).toBe('ROLLBACK');
  });

  it('rejects the same key with a different amount (422) and rolls back', async () => {
    client
      .on(/INSERT INTO idempotency_keys/, [])
      .on(/SELECT request_hash, response FROM idempotency_keys/, [
        { request_hash: hashRequest('transfer', { recipientId: BOB, amountCents: 2500, note: null }), response: {} },
      ]);

    const err = await executeTransfer({
      senderId: ALICE,
      recipientId: BOB,
      amountCents: 9999,
      note: null,
      idempotencyKey: 'k1',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PaymentError);
    expect(err.status).toBe(422);
    expect(client.sqlLog()).toContain('ROLLBACK');
    expect(client.sqlLog().some((s) => s.startsWith('UPDATE wallets'))).toBe(false);
  });
});

describe('hashRequest', () => {
  it('is independent of key order and sensitive to every value', () => {
    expect(hashRequest('transfer', { a: 1, b: 2 })).toBe(hashRequest('transfer', { b: 2, a: 1 }));
    expect(hashRequest('transfer', { a: 1 })).not.toBe(hashRequest('transfer', { a: 2 }));
    expect(hashRequest('deposit', { a: 1 })).not.toBe(hashRequest('withdrawal', { a: 1 }));
  });
});
