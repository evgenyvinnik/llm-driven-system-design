import { describe, it, expect } from 'vitest';
import { calculateFee, canonicalJson, requestFingerprint } from './validation.js';

describe('request fingerprints', () => {
  it('ignores key order and the idempotency key itself', () => {
    const a = requestFingerprint({ amount: 5000, currency: 'USD', payment_method: { type: 'card', last_four: '4242' }, idempotency_key: 'k1' });
    const b = requestFingerprint({ payment_method: { last_four: '4242', type: 'card' }, currency: 'USD', amount: 5000, idempotency_key: 'k2' });
    expect(a).toBe(b);
  });

  it('changes when the request changes', () => {
    const a = requestFingerprint({ amount: 5000, currency: 'USD' });
    const b = requestFingerprint({ amount: 5001, currency: 'USD' });
    expect(a).not.toBe(b);
  });

  it('serializes canonically and skips undefined fields', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe('calculateFee', () => {
  it('charges 2.9% + 30c in integer cents', () => {
    expect(calculateFee(10000)).toEqual({ feeAmount: 320, netAmount: 9680 });
  });
});
