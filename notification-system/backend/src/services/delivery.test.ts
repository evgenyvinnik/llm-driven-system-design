import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/database.js', () => ({ query: vi.fn(), withTransaction: vi.fn(), pool: {} }));
vi.mock('../utils/redis.js', () => ({ redis: { set: vi.fn(), del: vi.fn() } }));
vi.mock('./outbox.js', () => ({ enqueueDeliveries: vi.fn(), PRIORITY_RANK: { critical: 0, high: 1, normal: 2, low: 3 } }));

import { aggregateStatus, DeduplicationService } from './delivery.js';

describe('aggregateStatus', () => {
  it('summarizes per-channel states', () => {
    expect(aggregateStatus([])).toBeNull();
    expect(aggregateStatus(['sent', 'sent'])).toBe('delivered');
    expect(aggregateStatus(['sent', 'delivered'])).toBe('delivered');
    expect(aggregateStatus(['failed', 'failed'])).toBe('failed');
    expect(aggregateStatus(['sent', 'failed'])).toBe('partial_success');
    expect(aggregateStatus(['pending', 'sending'])).toBe('pending');
    expect(aggregateStatus(['sent', 'retrying'])).toBe('partial');
  });

  it('ignores cancelled channels unless all were cancelled', () => {
    expect(aggregateStatus(['cancelled', 'sent'])).toBe('delivered');
    expect(aggregateStatus(['cancelled', 'cancelled'])).toBe('cancelled');
  });
});

describe('DeduplicationService', () => {
  it('scopes keys by user and hashes the content with SHA-256', () => {
    const dedup = new DeduplicationService();
    const a = dedup.generateKey('user-a', 'welcome', { name: 'Ann' });
    expect(a).toMatch(/^dedup:user-a:[0-9a-f]{64}$/);
    expect(dedup.generateKey('user-b', 'welcome', { name: 'Ann' })).not.toBe(a);
    expect(dedup.generateKey('user-a', 'welcome', { name: 'Ann' })).toBe(a);
  });
});
