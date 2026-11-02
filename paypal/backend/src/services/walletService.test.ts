import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeClient, type FakeClient } from '../test/fakeDb.js';

const mocks = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock('./db.js', () => ({
  // Each attempt checks out a fresh client; tests queue them in order.
  pool: { connect: vi.fn(async () => mocks.clients.shift()), query: vi.fn() },
}));

import { deposit, withdraw } from './walletService.js';
import { PLATFORM_CASH_WALLET_ID } from './ledger.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const CARD = 'b0000000-0000-0000-0000-000000000001';

function walletClient(opts: { balance?: string; versionMatches?: boolean; ownsMethod?: boolean } = {}) {
  const { balance = '10000', versionMatches = true, ownsMethod = true } = opts;
  const client = createFakeClient();
  client
    .on(/FROM payment_methods/, ownsMethod ? [{ id: CARD, type: 'bank', label: 'Chase Checking', last_four: '4821' }] : [])
    .on(/SELECT id, balance_cents, currency, version FROM wallets/, [
      { id: 'wa', balance_cents: balance, currency: 'USD', version: 4 },
    ])
    .on(/WHERE id = \$2 AND version = \$3/, (p) => ({
      rows: versionMatches ? [{ balance_cents: String(Number(balance) + (p[0] as number)), version: 5 }] : [],
    }))
    .on(/INSERT INTO transactions/, (p) => ({
      rows: [{ id: 'tx-9', amount_cents: String(p[3]), type: p[4], status: 'completed', note: p[5], payment_method_id: p[6], created_at: 'now' }],
    }))
    .on(/WHERE account_type = 'platform_cash'/, (p) => ({
      rows: [{ id: PLATFORM_CASH_WALLET_ID, balance_cents: String(50000 + (p[0] as number)) }],
    }));
  return client;
}

function ledger(client: FakeClient) {
  return client.calls
    .filter((c) => c.sql.includes('INSERT INTO ledger_entries'))
    .map((c) => [c.params[1], c.params[2], c.params[3]]);
}

describe('deposit', () => {
  beforeEach(() => {
    mocks.clients = [];
  });

  it('is two-sided: debits platform cash and credits the customer by the same amount', async () => {
    const client = walletClient();
    mocks.clients.push(client);

    const { result } = await deposit({ userId: ALICE, amountCents: 2000, paymentMethodId: CARD, note: null });

    expect(ledger(client)).toEqual([
      [PLATFORM_CASH_WALLET_ID, 'debit', 2000],
      ['wa', 'credit', 2000],
    ]);
    expect(result.wallet.balanceCents).toBe(12000);
    expect(result.transaction.note).toBe('Transfer from Chase Checking');
    expect(client.sqlLog().at(-1)).toBe('COMMIT');
  });

  it("refuses someone else's payment method with 404 and moves nothing", async () => {
    const client = walletClient({ ownsMethod: false });
    mocks.clients.push(client);

    await expect(
      deposit({ userId: ALICE, amountCents: 2000, paymentMethodId: CARD, note: null }),
    ).rejects.toMatchObject({ status: 404, code: 'PAYMENT_METHOD_NOT_FOUND' });

    const methodQuery = client.calls.find((c) => c.sql.includes('FROM payment_methods'))!;
    expect(methodQuery.params).toEqual([CARD, ALICE]);
    expect(client.sqlLog().some((s) => s.startsWith('UPDATE wallets'))).toBe(false);
    expect(client.sqlLog().at(-1)).toBe('ROLLBACK');
  });

  it('retries when the optimistic version check loses a race, then succeeds', async () => {
    const lost = walletClient({ versionMatches: false });
    const won = walletClient();
    mocks.clients.push(lost, won);

    const { result } = await deposit({ userId: ALICE, amountCents: 500, paymentMethodId: CARD, note: null });

    expect(lost.sqlLog().at(-1)).toBe('ROLLBACK');
    expect(ledger(lost)).toEqual([]);
    expect(won.sqlLog().at(-1)).toBe('COMMIT');
    expect(result.wallet.balanceCents).toBe(10500);
  });

  it('gives up with 409 after repeated version conflicts', async () => {
    mocks.clients.push(
      walletClient({ versionMatches: false }),
      walletClient({ versionMatches: false }),
      walletClient({ versionMatches: false }),
    );
    await expect(
      deposit({ userId: ALICE, amountCents: 500, paymentMethodId: CARD, note: null }),
    ).rejects.toMatchObject({ status: 409, code: 'CONCURRENT_UPDATE' });
  });
});

describe('withdraw', () => {
  beforeEach(() => {
    mocks.clients = [];
  });

  it('debits the customer and credits platform cash', async () => {
    const client = walletClient();
    mocks.clients.push(client);

    await withdraw({ userId: ALICE, amountCents: 3000, paymentMethodId: CARD, note: null });

    expect(ledger(client)).toEqual([
      ['wa', 'debit', 3000],
      [PLATFORM_CASH_WALLET_ID, 'credit', 3000],
    ]);
    const update = client.calls.find((c) => /version = \$3/.test(c.sql))!;
    expect(update.params[0]).toBe(-3000);
  });

  it('refuses to overdraw', async () => {
    const client = walletClient({ balance: '2999' });
    mocks.clients.push(client);
    await expect(
      withdraw({ userId: ALICE, amountCents: 3000, paymentMethodId: CARD, note: null }),
    ).rejects.toMatchObject({ status: 400, code: 'INSUFFICIENT_FUNDS' });
    expect(client.sqlLog().some((s) => s.startsWith('UPDATE wallets'))).toBe(false);
  });
});
