import { describe, it, expect } from 'vitest';
import { computeSimHash, fingerprintBands, hammingDistance } from './simhash.js';

/** Small deterministic PRNG so the property test is reproducible. */
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('fingerprintBands', () => {
  it('splits into four 16-bit bands, lowest first', () => {
    const fp = 0xAAAA_BBBB_CCCC_DDDDn;
    expect(fingerprintBands(fp)).toEqual([0xDDDD, 0xCCCC, 0xBBBB, 0xAAAA]);
  });

  it('handles the full unsigned 64-bit range', () => {
    expect(fingerprintBands(2n ** 64n - 1n)).toEqual([65535, 65535, 65535, 65535]);
  });

  it('guarantees a shared band for any fingerprint within distance 3 (pigeonhole)', () => {
    const random = lcg(42);
    for (let trial = 0; trial < 2000; trial++) {
      const fp = BigInt(Math.floor(random() * 2 ** 32)) << 32n | BigInt(Math.floor(random() * 2 ** 32));
      let other = fp;
      const flips = 1 + Math.floor(random() * 3);
      for (let i = 0; i < flips; i++) {
        other ^= 1n << BigInt(Math.floor(random() * 64));
      }
      expect(hammingDistance(fp, other)).toBeLessThanOrEqual(3);
      const a = fingerprintBands(fp);
      const b = fingerprintBands(other);
      expect(a.some((band, i) => band === b[i])).toBe(true);
    }
  });
});

describe('computeSimHash', () => {
  it('is deterministic and identical for identical text', () => {
    const text = 'Central bank raises interest rates by a quarter point';
    expect(computeSimHash(text)).toBe(computeSimHash(text));
    expect(hammingDistance(computeSimHash(text), computeSimHash(text))).toBe(0);
  });

  it('returns 0 for text without usable tokens', () => {
    expect(computeSimHash('a an')).toBe(0n);
  });
});
