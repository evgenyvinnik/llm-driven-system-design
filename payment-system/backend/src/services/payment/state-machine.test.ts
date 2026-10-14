import { describe, it, expect, vi } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition, transitionStatus } from './state-machine.js';

describe('payment state machine', () => {
  it('allows only forward lifecycle transitions', () => {
    expect(canTransition('pending', 'authorized')).toBe(true);
    expect(canTransition('authorized', 'captured')).toBe(true);
    expect(canTransition('authorized', 'voided')).toBe(true);
    expect(canTransition('captured', 'refunded')).toBe(true);
    expect(canTransition('captured', 'voided')).toBe(false);
    expect(canTransition('voided', 'captured')).toBe(false);
    expect(canTransition('failed', 'authorized')).toBe(false);
    expect(canTransition('pending', 'captured')).toBe(false);
  });

  it('has no way out of terminal states', () => {
    for (const terminal of ['refunded', 'voided', 'failed'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('issues a compare-and-set UPDATE guarded by the allowed source states', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'pay_1', status: 'captured' }] }) };
    const row = await transitionStatus(client as never, 'pay_1', ['authorized'], 'captured', { captured_at: 'now' });

    expect(row).toEqual({ id: 'pay_1', status: 'captured' });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('WHERE id = $1 AND status = ANY($3::varchar[])');
    expect(sql).toContain('captured_at = $4');
    expect(params).toEqual(['pay_1', 'captured', ['authorized'], 'now']);
  });

  it('returns null when another request changed the payment first', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(transitionStatus(client as never, 'pay_1', ['authorized'], 'voided')).resolves.toBeNull();
  });

  it('rejects illegal transitions and unknown columns without querying', async () => {
    const client = { query: vi.fn() };
    await expect(transitionStatus(client as never, 'pay_1', ['captured'], 'voided')).rejects.toThrow(/Illegal/);
    await expect(
      transitionStatus(client as never, 'pay_1', ['pending'], 'failed', { 'status = NULL; --': 1 })
    ).rejects.toThrow(/cannot be set/);
    expect(client.query).not.toHaveBeenCalled();
  });
});
