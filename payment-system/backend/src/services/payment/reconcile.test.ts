import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shared modules before import
vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../shared/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  paymentReconcileTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
}));
vi.mock('./processor.js', () => ({
  lookupProcessorPayment: vi.fn(),
  authorizeWithProcessor: vi.fn(),
}));
vi.mock('./authorize.js', () => ({
  applyProcessorApproval: vi.fn(),
  applyProcessorDecline: vi.fn(),
}));

import { query } from '../../db/connection.js';
import { lookupProcessorPayment, authorizeWithProcessor } from './processor.js';
import { applyProcessorApproval, applyProcessorDecline } from './authorize.js';
import { reconcilePayment, reconcilePendingPayments } from './reconcile.js';
import type { Transaction } from './types.js';

const payment = {
  id: 'pay_1',
  amount: '5000',
  status: 'pending',
  payment_method: { type: 'card', last_four: '0002' },
  reconcile_attempts: 1,
} as unknown as Transaction;

describe('reconcilePayment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies an approval the processor recorded but we never heard about', async () => {
    vi.mocked(lookupProcessorPayment).mockResolvedValue({ status: 'approved', processorRef: 'proc_1' });
    vi.mocked(applyProcessorApproval).mockResolvedValue({ status: 'captured' } as Transaction);

    await expect(reconcilePayment(payment)).resolves.toBe('captured');
    expect(applyProcessorApproval).toHaveBeenCalledWith('pay_1', 'proc_1');
    expect(authorizeWithProcessor).not.toHaveBeenCalled();
  });

  it('resubmits a payment the processor never saw under the SAME reference', async () => {
    vi.mocked(lookupProcessorPayment).mockResolvedValue({ status: 'not_found' });
    vi.mocked(authorizeWithProcessor).mockResolvedValue({ kind: 'approved', processorRef: 'proc_2' });
    vi.mocked(applyProcessorApproval).mockResolvedValue({ status: 'authorized' } as Transaction);

    await expect(reconcilePayment(payment)).resolves.toBe('authorized');
    expect(authorizeWithProcessor).toHaveBeenCalledWith('pay_1', 5000, payment.payment_method);
  });

  it('fails the payment when the processor declined it', async () => {
    vi.mocked(lookupProcessorPayment).mockResolvedValue({ status: 'declined', reason: 'Card declined' });
    await expect(reconcilePayment(payment)).resolves.toBe('failed');
    expect(applyProcessorDecline).toHaveBeenCalledWith('pay_1', 'Card declined');
  });

  it('leaves the payment pending while the processor gives no answer', async () => {
    vi.mocked(lookupProcessorPayment).mockRejectedValue(new Error('ECONNRESET'));
    await expect(reconcilePayment(payment)).resolves.toBe('still_pending');
    expect(applyProcessorApproval).not.toHaveBeenCalled();
    expect(applyProcessorDecline).not.toHaveBeenCalled();
  });

  it('flags a payment for review once attempts are exhausted', async () => {
    vi.mocked(lookupProcessorPayment).mockResolvedValue({ status: 'not_found' });
    vi.mocked(authorizeWithProcessor).mockResolvedValue({ kind: 'unknown', reason: 'timeout' });
    await expect(reconcilePayment({ ...payment, reconcile_attempts: 10 } as Transaction, 10)).resolves.toBe('needs_review');
  });
});

describe('reconcilePendingPayments', () => {
  it('claims stuck payments with SKIP LOCKED and summarizes the results', async () => {
    vi.mocked(query).mockResolvedValue([payment]);
    vi.mocked(lookupProcessorPayment).mockResolvedValue({ status: 'declined', reason: 'Card declined' });

    const summary = await reconcilePendingPayments({ olderThanSeconds: 0 });
    expect(vi.mocked(query).mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(summary).toEqual({
      scanned: 1,
      results: { authorized: 0, captured: 0, failed: 1, still_pending: 0, needs_review: 0 },
    });
  });
});
