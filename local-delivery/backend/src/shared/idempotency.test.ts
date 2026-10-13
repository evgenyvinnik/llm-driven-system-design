import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row {
  key: string;
  user_id: string;
  operation: string;
  request_hash: string;
  status: string;
  response: unknown;
}

const state = vi.hoisted(() => ({ table: new Map<string, Row>(), failInsertWith: null as null | Error }));

/** A fake transaction client backed by an in-memory idempotency_keys table. */
const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('DELETE FROM idempotency_keys')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO idempotency_keys')) {
      if (state.failInsertWith) throw state.failInsertWith;
      const [key, userId, operation, hash] = params as string[];
      if (state.table.has(key)) return { rows: [], rowCount: 0 };
      state.table.set(key, { key, user_id: userId, operation, request_hash: hash, status: 'pending', response: null });
      return { rows: [{ key }], rowCount: 1 };
    }
    if (sql.includes('SELECT user_id')) {
      const row = state.table.get(params[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SET status = 'completed'")) {
      const row = state.table.get(params[0] as string)!;
      row.status = 'completed';
      row.response = JSON.parse(params[1] as string);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
};

vi.mock('../utils/db.js', () => ({
  execute: vi.fn(),
  withTransaction: (fn: (c: typeof client) => unknown) => fn(client),
}));

import { withIdempotentTransaction, hashRequest, IdempotencyError } from './idempotency.js';

const order = { id: 'order-1', delivery_address: 'Alice, 1 Private Lane' };
const request = { merchant_id: 'm1', items: [{ menu_item_id: 'i1', quantity: 1 }] };

beforeEach(() => {
  state.table.clear();
  state.failInsertWith = null;
});

describe('withIdempotentTransaction', () => {
  it('runs the operation once and replays the stored response for a retry', async () => {
    const fn = vi.fn().mockResolvedValue(order);
    const params = { key: 'key-123456', userId: 'alice', operation: 'create_order', request };

    const first = await withIdempotentTransaction(params, fn);
    const retry = await withIdempotentTransaction(params, fn);

    expect(first).toEqual({ executed: true, response: order });
    expect(retry).toEqual({ executed: false, response: order });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never returns another user's response for the same key (422, nothing leaked)", async () => {
    await withIdempotentTransaction(
      { key: 'key-123456', userId: 'alice', operation: 'create_order', request },
      vi.fn().mockResolvedValue(order)
    );

    const bob = withIdempotentTransaction(
      { key: 'key-123456', userId: 'bob', operation: 'create_order', request },
      vi.fn()
    );

    await expect(bob).rejects.toBeInstanceOf(IdempotencyError);
    await expect(bob).rejects.toMatchObject({ statusCode: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(bob).rejects.not.toHaveProperty('response');
  });

  it('rejects the same key with a different body (422)', async () => {
    await withIdempotentTransaction(
      { key: 'key-123456', userId: 'alice', operation: 'create_order', request },
      vi.fn().mockResolvedValue(order)
    );

    await expect(
      withIdempotentTransaction(
        { key: 'key-123456', userId: 'alice', operation: 'create_order', request: { ...request, tip: 5 } },
        vi.fn()
      )
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('runs directly in a transaction when no key is sent', async () => {
    const fn = vi.fn().mockResolvedValue(order);
    const result = await withIdempotentTransaction({ userId: 'alice', operation: 'create_order', request }, fn);
    expect(result.executed).toBe(true);
    expect(state.table.size).toBe(0);
  });

  it('rejects malformed keys (400)', async () => {
    await expect(
      withIdempotentTransaction({ key: 'bad key!', userId: 'alice', operation: 'create_order', request }, vi.fn())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers 409 when a concurrent request still holds the key past the lock timeout', async () => {
    state.failInsertWith = Object.assign(new Error('lock timeout'), { code: '55P03' });
    await expect(
      withIdempotentTransaction({ key: 'key-123456', userId: 'alice', operation: 'create_order', request }, vi.fn())
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_IN_PROGRESS' });
  });
});

describe('hashRequest', () => {
  it('ignores object key order but not values', () => {
    expect(hashRequest('op', { a: 1, b: [1, 2] })).toBe(hashRequest('op', { b: [1, 2], a: 1 }));
    expect(hashRequest('op', { a: 1 })).not.toBe(hashRequest('op', { a: 2 }));
  });
});
