import { describe, expect, it } from 'vitest';
import {
  fromCents,
  parseAmountToCents,
  resolveBid,
  toCents,
  type AuctionBidState,
  type BidAction,
  type BidResolution,
} from './bidEngine.js';

const state = (over: Partial<AuctionBidState> = {}): AuctionBidState => ({
  priceCents: 10_000,
  incrementCents: 100,
  reserveCents: null,
  leaderId: null,
  leaderSince: 0,
  proxies: [],
  ...over,
});
const manual = (bidderId: string, amountCents: number): BidAction => ({ bidderId, kind: 'manual', amountCents, at: 5_000 });
const proxy = (bidderId: string, amountCents: number): BidAction => ({ bidderId, kind: 'proxy', amountCents, at: 5_000 });
const accepted = (r: BidResolution) => {
  if (!r.ok) throw new Error(`expected acceptance, got ${r.reason}`);
  return r;
};

// L leads at $101.00 through a proxy with a $150.00 maximum.
const proxyLeader = state({ priceCents: 10_100, leaderId: 'L', leaderSince: 100, proxies: [{ bidderId: 'L', maxCents: 15_000, since: 100 }] });

describe('money helpers', () => {
  it('parses user amounts into cents and rejects junk', () => {
    expect(parseAmountToCents('105.5')).toBe(10_550);
    expect(parseAmountToCents(0.29)).toBe(29);
    for (const bad of ['', 'abc', '-5', '0', '1.234', '1e5', null, undefined, {}]) {
      expect(parseAmountToCents(bad)).toBeNull();
    }
  });

  it('adds pg DECIMAL strings as money, never as strings', () => {
    expect(toCents('100') + toCents('1.00')).toBe(10_100);
    expect(fromCents(toCents('0.10') + toCents('0.20'))).toBe('0.30');
  });
});

describe('resolveBid', () => {
  it('rejects a bid below price + increment and reports the minimum', () => {
    expect(resolveBid(state(), manual('B', 10_050))).toEqual({ ok: false, reason: 'below_minimum', minimumCents: 10_100 });
  });

  it('a first manual bid sets the price to exactly its amount', () => {
    const r = accepted(resolveBid(state(), manual('B', 10_500)));
    expect(r.priceCents).toBe(10_500);
    expect(r.bids).toEqual([{ bidderId: 'B', amountCents: 10_500, isAuto: false }]);
    expect(r.isLeading).toBe(true);
  });

  it('a first proxy opens at the minimum, not at its maximum', () => {
    const r = accepted(resolveBid(state(), proxy('B', 50_000)));
    expect(r.priceCents).toBe(10_100);
    expect(r.bids).toEqual([{ bidderId: 'B', amountCents: 10_100, isAuto: true }]);
    expect(r.proxy).toEqual({ maxCents: 50_000, active: true });
  });

  it('a leading proxy answers with one increment, capped at its maximum', () => {
    const r = accepted(resolveBid(proxyLeader, manual('C', 12_000)));
    expect(r).toMatchObject({ priceCents: 12_100, leaderId: 'L', isLeading: false, deactivate: [], outbid: [] });
    expect(r.bids).toEqual([
      { bidderId: 'C', amountCents: 12_000, isAuto: false },
      { bidderId: 'L', amountCents: 12_100, isAuto: true },
    ]);
    expect(accepted(resolveBid(proxyLeader, manual('C', 14_950))).priceCents).toBe(15_000);
  });

  it('a tie goes to the earlier proxy, whose row is inserted first', () => {
    const r = accepted(resolveBid(proxyLeader, manual('C', 15_000)));
    expect(r.leaderId).toBe('L');
    expect(r.priceCents).toBe(15_000);
    expect(r.bids.map((b) => b.bidderId)).toEqual(['L', 'C']);
  });

  it('never records a manual bidder above what they typed', () => {
    for (const amount of [10_200, 14_900, 15_000, 15_100]) {
      const r = accepted(resolveBid(proxyLeader, manual('C', amount)));
      for (const bid of r.bids.filter((b) => b.bidderId === 'C')) expect(bid.amountCents).toBe(amount);
      for (const bid of r.bids.filter((b) => b.bidderId === 'L')) expect(bid.amountCents).toBeLessThanOrEqual(15_000);
    }
  });

  it('a manual bid above the proxy maximum wins at exactly its amount', () => {
    const r = accepted(resolveBid(proxyLeader, manual('C', 20_000)));
    expect(r).toMatchObject({ priceCents: 20_000, leaderId: 'C', isLeading: true, deactivate: ['L'], outbid: ['L'] });
    expect(r.bids).toEqual([
      { bidderId: 'L', amountCents: 15_000, isAuto: true },
      { bidderId: 'C', amountCents: 20_000, isAuto: false },
    ]);
  });

  it('proxy vs proxy: the higher maximum leads at one increment over the other', () => {
    const r = accepted(resolveBid(proxyLeader, proxy('C', 30_000)));
    expect(r).toMatchObject({ priceCents: 15_100, leaderId: 'C', deactivate: ['L'], outbid: ['L'] });
    expect(r.proxy).toEqual({ maxCents: 30_000, active: true });
  });

  it('a weaker new proxy is exhausted at once and recorded at its maximum', () => {
    const r = accepted(resolveBid(proxyLeader, proxy('C', 12_000)));
    expect(r).toMatchObject({ priceCents: 12_100, leaderId: 'L', isLeading: false });
    expect(r.proxy).toEqual({ maxCents: 12_000, active: false });
    expect(r.bids).toEqual([
      { bidderId: 'C', amountCents: 12_000, isAuto: true },
      { bidderId: 'L', amountCents: 12_100, isAuto: true },
    ]);
  });

  it('a proxy beats a proxy-less leader by exactly one increment', () => {
    const r = accepted(resolveBid(state({ priceCents: 12_100, leaderId: 'L' }), proxy('C', 13_000)));
    expect(r).toMatchObject({ priceCents: 12_200, leaderId: 'C', outbid: ['L'] });
    expect(r.bids).toEqual([{ bidderId: 'C', amountCents: 12_200, isAuto: true }]);
  });

  it('a leader cannot outbid themselves but may raise their maximum', () => {
    expect(resolveBid(proxyLeader, manual('L', 20_000))).toMatchObject({ ok: false, reason: 'already_leading' });
    const r = accepted(resolveBid(proxyLeader, proxy('L', 30_000)));
    expect(r).toMatchObject({ priceCents: 10_100, bids: [], proxy: { maxCents: 30_000, active: true } });
  });

  it('a maximum that covers an unmet reserve lifts the price to the reserve', () => {
    expect(accepted(resolveBid(state({ reserveCents: 20_000 }), proxy('B', 25_000))).priceCents).toBe(20_000);
    const raised = accepted(resolveBid({ ...proxyLeader, reserveCents: 20_000 }, proxy('L', 25_000)));
    expect(raised.priceCents).toBe(20_000);
    expect(raised.bids).toEqual([{ bidderId: 'L', amountCents: 20_000, isAuto: true }]);
  });

  it('resolves a stale proxy held by a non-leader instead of ignoring it', () => {
    const stale = state({
      priceCents: 168_500,
      incrementCents: 2_500,
      leaderId: 'marcus',
      leaderSince: 300,
      proxies: [{ bidderId: 'tomas', maxCents: 180_000, since: 200 }],
    });
    const r = accepted(resolveBid(stale, manual('nadia', 171_000)));
    expect(r).toMatchObject({ priceCents: 173_500, leaderId: 'tomas', outbid: ['marcus'] });
  });

  it('keeps exact cents with 10-cent increments', () => {
    const r = accepted(resolveBid(state({ priceCents: 30, incrementCents: 10, leaderId: 'L' }), proxy('B', 100)));
    expect(fromCents(r.priceCents)).toBe('0.40');
  });
});
