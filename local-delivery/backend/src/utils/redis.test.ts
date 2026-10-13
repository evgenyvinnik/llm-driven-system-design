import { describe, it, expect } from 'vitest';
import { filterFreshDrivers } from './redis.js';

describe('filterFreshDrivers', () => {
  const now = 1_000_000;
  const candidates = [
    { id: 'fresh', distance: 0.4 },
    { id: 'stale', distance: 0.2 },
    { id: 'unknown', distance: 0.1 },
    { id: 'edge', distance: 1.0 },
  ];

  it('keeps couriers who pinged recently and drops ghosts', () => {
    const lastSeen = [String(now - 5_000), String(now - 120_000), null, String(now - 30_000)];
    expect(filterFreshDrivers(candidates, lastSeen, now, 30_000).map((c) => c.id)).toEqual(['fresh', 'edge']);
  });

  it('preserves the nearest-first order of the geo search', () => {
    const lastSeen = candidates.map(() => String(now));
    expect(filterFreshDrivers(candidates, lastSeen, now, 30_000)).toEqual(candidates);
  });
});
