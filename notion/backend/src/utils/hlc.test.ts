import { describe, it, expect } from 'vitest';
import { compareHLC, decodeHLC, encodeHLC, generateHLC, initHLC } from './hlc.js';

describe('encodeHLC', () => {
  it('round-trips timestamp and counter exactly', () => {
    const hlc = { timestamp: 1_760_000_000_123, counter: 7, nodeId: 'n1' };
    expect(decodeHLC(encodeHLC(hlc), 'n1')).toEqual(hlc);
  });

  it('keeps the counter that the old timestamp*1e6 number encoding rounded away', () => {
    const a = encodeHLC({ timestamp: 1_760_000_000_123, counter: 1, nodeId: '' });
    const b = encodeHLC({ timestamp: 1_760_000_000_123, counter: 2, nodeId: '' });
    expect(a).not.toBe(b);
    expect(BigInt(a) < BigInt(b)).toBe(true);
    // The old encoding collided: both values rounded to the same double.
    expect(1_760_000_000_123 * 1e6 + 1).toBe(1_760_000_000_123 * 1e6 + 2);
  });

  it('orders encoded values the same way compareHLC orders clocks', () => {
    initHLC('node-a');
    const clocks = Array.from({ length: 500 }, () => generateHLC());
    for (let i = 1; i < clocks.length; i++) {
      expect(compareHLC(clocks[i - 1], clocks[i])).toBeLessThan(0);
      expect(BigInt(encodeHLC(clocks[i - 1])) < BigInt(encodeHLC(clocks[i]))).toBe(true);
    }
  });
});
