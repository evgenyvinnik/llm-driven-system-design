import { describe, it, expect, vi, beforeEach } from 'vitest';

const tracker = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  scheduleRetry: vi.fn(),
}));

vi.mock('../services/delivery.js', () => ({ deliveryTracker: tracker }));

import { processDelivery, retryDelayMs, MAX_ATTEMPTS, Provider } from './deliveryHandler.js';
import { CircuitBreakerOpenError } from '../utils/circuitBreaker.js';

const message = { notificationId: 'n-1', userId: 'u-1', channel: 'email', priority: 'high', queuedAt: 0 };
const claimed = (attempt: number) => ({
  notificationId: 'n-1', channel: 'email', userId: 'u-1', priority: 'high', content: {}, attempt,
});

describe('processDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tracker.complete.mockResolvedValue(true);
    tracker.scheduleRetry.mockResolvedValue(new Date());
  });

  it('acks without calling the provider when the delivery cannot be claimed', async () => {
    tracker.claim.mockResolvedValue(null);
    const email = vi.fn<Provider>();
    await expect(processDelivery(message, { email })).resolves.toBe('ack');
    expect(email).not.toHaveBeenCalled();
  });

  it('marks a successful send as sent', async () => {
    tracker.claim.mockResolvedValue(claimed(1));
    const email = vi.fn<Provider>().mockResolvedValue({ success: true });
    await expect(processDelivery(message, { email })).resolves.toBe('ack');
    expect(tracker.complete).toHaveBeenCalledWith(claimed(1), 'sent', expect.any(Object));
  });

  it('schedules a durable retry for a transient failure under the budget', async () => {
    tracker.claim.mockResolvedValue(claimed(2));
    const email = vi.fn<Provider>().mockResolvedValue({ success: false, error: 'smtp 451' });
    await expect(processDelivery(message, { email })).resolves.toBe('ack');
    expect(tracker.scheduleRetry).toHaveBeenCalledWith(claimed(2), expect.any(Number), expect.any(Object), true);
    expect(tracker.complete).not.toHaveBeenCalled();
  });

  it('defers without spending an attempt when the circuit is open', async () => {
    tracker.claim.mockResolvedValue(claimed(1));
    const email = vi.fn<Provider>().mockRejectedValue(new CircuitBreakerOpenError('email'));
    await expect(processDelivery(message, { email })).resolves.toBe('ack');
    expect(tracker.scheduleRetry).toHaveBeenCalledWith(claimed(1), 30000, expect.any(Object), false);
  });

  it('fails and dead-letters once the retry budget is spent', async () => {
    tracker.claim.mockResolvedValue(claimed(MAX_ATTEMPTS));
    const email = vi.fn<Provider>().mockResolvedValue({ success: false, retryable: true, error: 'timeout' });
    await expect(processDelivery(message, { email })).resolves.toBe('dead-letter');
    expect(tracker.complete).toHaveBeenCalledWith(claimed(MAX_ATTEMPTS), 'failed', expect.objectContaining({ exhaustedRetries: true }));
  });

  it('fails a permanent error immediately and acks it', async () => {
    tracker.claim.mockResolvedValue(claimed(1));
    const email = vi.fn<Provider>().mockResolvedValue({ success: false, reason: 'email_not_verified' });
    await expect(processDelivery(message, { email })).resolves.toBe('ack');
    expect(tracker.scheduleRetry).not.toHaveBeenCalled();
    expect(tracker.complete).toHaveBeenCalledWith(claimed(1), 'failed', expect.objectContaining({ exhaustedRetries: false }));
  });

  it('dead-letters a message for an unknown channel', async () => {
    await expect(processDelivery({ ...message, channel: 'fax' }, {})).resolves.toBe('dead-letter');
    expect(tracker.claim).not.toHaveBeenCalled();
  });

  it('backs off exponentially', () => {
    expect(retryDelayMs(1)).toBeGreaterThanOrEqual(5000);
    expect(retryDelayMs(1)).toBeLessThan(6001);
    expect(retryDelayMs(3)).toBeGreaterThanOrEqual(20000);
    expect(retryDelayMs(30)).toBeLessThanOrEqual(360000);
  });
});
