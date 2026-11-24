import { describe, it, expect, vi } from 'vitest';

vi.mock('../models/redis.js', () => ({ redis: {}, REDIS_KEYS: {} }));

import { parseCidr, parseCidrList, buildBlockList, chooseIpDelayMs } from './ipPolicy.js';

describe('parseCidr', () => {
  it('accepts IPv4 and IPv6 ranges and bare addresses', () => {
    expect(parseCidr('173.245.48.0/20')).toEqual({ address: '173.245.48.0', prefix: 20, family: 'ipv4' });
    expect(parseCidr('2001:db8::/32')).toEqual({ address: '2001:db8::', prefix: 32, family: 'ipv6' });
    expect(parseCidr('10.0.0.1')).toEqual({ address: '10.0.0.1', prefix: 32, family: 'ipv4' });
  });

  it('rejects malformed input', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
    expect(parseCidr('999.1.1.1/8')).toBeNull();
    expect(parseCidr('example.com/24')).toBeNull();
    expect(parseCidr('10.0.0.0/8/1')).toBeNull();
    expect(parseCidr('10.0.0.0/x')).toBeNull();
  });
});

describe('parseCidrList', () => {
  it('reads plain-text lists with comments and blank lines', () => {
    const body = '# edge ranges\n192.0.2.0/24\n\n198.51.100.0/24  \n2001:db8::/32\nnot-a-range\n';
    expect(parseCidrList(body)).toEqual(['192.0.2.0/24', '198.51.100.0/24', '2001:db8::/32']);
  });

  it('extracts CIDRs from JSON documents (e.g. a provider\'s public IP list)', () => {
    const body = JSON.stringify({ addresses: ['203.0.113.0/24'], ipv6_addresses: ['2001:db8:1::/48'], note: 'v1' });
    expect(parseCidrList(body).sort()).toEqual(['2001:db8:1::/48', '203.0.113.0/24']);
  });

  it('de-duplicates', () => {
    expect(parseCidrList('192.0.2.0/24\n192.0.2.0/24')).toEqual(['192.0.2.0/24']);
  });
});

describe('buildBlockList', () => {
  it('matches addresses inside ranges, for both families', () => {
    const list = buildBlockList(['192.0.2.0/24', '2001:db8::/32', 'garbage']);
    expect(list.check('192.0.2.77', 'ipv4')).toBe(true);
    expect(list.check('192.0.3.1', 'ipv4')).toBe(false);
    expect(list.check('2001:db8:abcd::1', 'ipv6')).toBe(true);
    expect(list.check('2001:db9::1', 'ipv6')).toBe(false);
  });
});

describe('chooseIpDelayMs', () => {
  it('uses the normal per-IP delay for non-CDN IPs', () => {
    expect(chooseIpDelayMs(250, 50, false)).toBe(250);
  });

  it('uses the reduced delay for CDN IPs', () => {
    expect(chooseIpDelayMs(250, 50, true)).toBe(50);
  });

  it('treats a CDN delay of 0 as full exemption', () => {
    expect(chooseIpDelayMs(250, 0, true)).toBe(0);
  });

  it('never limits a CDN IP more strictly than an ordinary one', () => {
    expect(chooseIpDelayMs(250, 1000, true)).toBe(250);
  });

  it('turns everything off when the per-IP limit is disabled', () => {
    expect(chooseIpDelayMs(0, 50, true)).toBe(0);
    expect(chooseIpDelayMs(0, 50, false)).toBe(0);
  });

  it('ignores a negative CDN delay', () => {
    expect(chooseIpDelayMs(250, -5, true)).toBe(0);
  });
});
