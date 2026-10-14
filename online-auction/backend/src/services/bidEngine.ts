/**
 * Proxy-bid resolution for a single auction, as a pure function.
 *
 * The route loads the auction under `SELECT ... FOR UPDATE`, hands the state to
 * `resolveBid`, and writes back exactly what it returns. Keeping the auction
 * rules free of I/O is what makes them testable: every tie-break and price cap
 * below has a unit test in bidEngine.test.ts.
 *
 * Money is handled in integer cents. `pg` returns DECIMAL(12,2) as strings and
 * float dollars drift (0.1 + 0.2 !== 0.3), so the route converts once at the
 * boundary with toCents()/fromCents() and nothing in between touches floats.
 *
 * Rules (second-price proxy bidding, as on eBay):
 * - A manual bid is exact: if it leads, the price becomes exactly that amount.
 * - A proxy (auto-bid) is a maximum: the system bids only what is needed to
 *   lead, one increment over the strongest competitor, never above the maximum.
 * - Ties go to whoever committed to the amount first. The leader of an auction
 *   is therefore the EARLIEST bid at the HIGHEST amount, which is also how the
 *   closing path picks the winner, so bid rows are emitted in that order.
 * - The leader cannot outbid themselves; they can only raise their maximum.
 * - After every resolution only the leader may hold an active proxy. Every
 *   other proxy has been beaten and is returned in `deactivate`.
 */

export interface ProxyEntry {
  bidderId: string;
  maxCents: number;
  /** When this maximum was set (ms). Earlier wins ties. */
  since: number;
}

export interface AuctionBidState {
  priceCents: number;
  incrementCents: number;
  reserveCents: number | null;
  /** Bidder of the leading bid, or null when there are no bids yet. */
  leaderId: string | null;
  /** When the leading bid was placed (ms); used for ties when the leader has no proxy. */
  leaderSince: number;
  /** Active proxies on this auction. */
  proxies: ProxyEntry[];
}

export interface BidAction {
  bidderId: string;
  kind: 'manual' | 'proxy';
  amountCents: number;
  /** Request time (ms). */
  at: number;
}

export interface PlannedBid {
  bidderId: string;
  amountCents: number;
  isAuto: boolean;
}

export type BidResolution =
  | { ok: false; reason: 'below_minimum' | 'already_leading'; minimumCents: number }
  | {
      ok: true;
      priceCents: number;
      leaderId: string;
      isLeading: boolean;
      /** Rows to insert, in this order (sequence_num follows insertion order). */
      bids: PlannedBid[];
      /** For proxy actions: the caller's proxy after resolution. */
      proxy: { maxCents: number; active: boolean } | null;
      /** Bidders whose active proxy must be switched off. */
      deactivate: string[];
      /** Bidders who lost the lead or whose proxy was exhausted (not the caller). */
      outbid: string[];
    };

interface Contender {
  bidderId: string;
  maxCents: number;
  /** Manual bids and proxy-less leaders: the price is exactly maxCents if they lead. */
  exact: boolean;
  since: number;
  isLeader: boolean;
  isIncoming: boolean;
}

/** Parses a user-supplied amount into whole cents; null if it isn't a positive amount with at most 2 decimals. */
export function parseAmountToCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents > 0 ? cents : null;
}

/** Converts a DECIMAL value read from pg (string or number) to cents. */
export function toCents(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? Math.round(n * 100) : fallback;
}

/** Converts cents to the 2-decimal string used for DECIMAL parameters and API payloads. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Resolves one manual bid or proxy change against the locked auction state. */
export function resolveBid(state: AuctionBidState, action: BidAction): BidResolution {
  const { priceCents, incrementCents, reserveCents, leaderId } = state;
  const minimumCents = priceCents + incrementCents;

  if (action.amountCents < minimumCents) {
    return { ok: false, reason: 'below_minimum', minimumCents };
  }

  if (leaderId !== null && action.bidderId === leaderId) {
    if (action.kind === 'manual') {
      return { ok: false, reason: 'already_leading', minimumCents };
    }
    // The leader raises (or sets) a maximum. The visible price only moves if the
    // new maximum covers an unmet reserve: then the price jumps to the reserve.
    const bids: PlannedBid[] = [];
    let price = priceCents;
    if (reserveCents !== null && priceCents < reserveCents && action.amountCents >= reserveCents) {
      price = reserveCents;
      bids.push({ bidderId: leaderId, amountCents: price, isAuto: true });
    }
    return {
      ok: true,
      priceCents: price,
      leaderId,
      isLeading: true,
      bids,
      proxy: { maxCents: action.amountCents, active: true },
      deactivate: [],
      outbid: [],
    };
  }

  const contenders: Contender[] = [];
  const proxyOf = new Map(state.proxies.map((p) => [p.bidderId, p]));

  if (leaderId !== null) {
    const leaderProxy = proxyOf.get(leaderId);
    const hasProxy = leaderProxy !== undefined && leaderProxy.maxCents > priceCents;
    contenders.push({
      bidderId: leaderId,
      maxCents: hasProxy ? leaderProxy.maxCents : priceCents,
      exact: !hasProxy,
      since: hasProxy ? leaderProxy.since : state.leaderSince,
      isLeader: true,
      isIncoming: false,
    });
  }

  // Other live proxies. Under the invariant there are none, but stale rows
  // (older code paths, hand-written seed data) are resolved instead of ignored.
  for (const p of state.proxies) {
    if (p.bidderId === leaderId || p.bidderId === action.bidderId) continue;
    if (p.maxCents < minimumCents) continue; // can no longer place a valid bid
    contenders.push({
      bidderId: p.bidderId,
      maxCents: p.maxCents,
      exact: false,
      since: p.since,
      isLeader: false,
      isIncoming: false,
    });
  }

  contenders.push({
    bidderId: action.bidderId,
    maxCents: action.amountCents,
    exact: action.kind === 'manual',
    since: action.at,
    isLeader: false,
    isIncoming: true,
  });

  // Highest maximum first; at equal maximums whoever committed first wins, and
  // the incoming request is always the latest commitment.
  contenders.sort(
    (a, b) =>
      b.maxCents - a.maxCents ||
      Number(a.isIncoming) - Number(b.isIncoming) ||
      a.since - b.since
  );

  const [winner, runnerUp] = contenders;
  let price: number;
  if (winner.exact) {
    price = winner.maxCents;
  } else if (!runnerUp) {
    price = minimumCents;
  } else {
    price = Math.min(winner.maxCents, runnerUp.maxCents + incrementCents);
  }
  price = Math.max(price, minimumCents);
  if (!winner.exact && reserveCents !== null && winner.maxCents >= reserveCents && price < reserveCents) {
    price = reserveCents;
  }

  // Losers' final bids: a beaten proxy fought up to its maximum, a beaten manual
  // bid is recorded at its amount. A proxy-less leader already has a row at the
  // old price, so nothing new is written for them.
  const rows: Array<PlannedBid & { rank: number }> = [];
  contenders.forEach((c, rank) => {
    if (c === winner || (c.isLeader && c.exact)) return;
    rows.push({
      bidderId: c.bidderId,
      amountCents: c.maxCents,
      isAuto: !(c.isIncoming && action.kind === 'manual'),
      rank,
    });
  });
  rows.push({
    bidderId: winner.bidderId,
    amountCents: price,
    isAuto: !(winner.isIncoming && action.kind === 'manual'),
    rank: 0,
  });
  // Ascending amounts; at an equal amount the higher-ranked (earlier) contender
  // is inserted first, so "earliest bid at the highest amount" is the winner.
  rows.sort((a, b) => a.amountCents - b.amountCents || a.rank - b.rank);

  const deactivate = new Set<string>();
  for (const p of state.proxies) {
    if (p.bidderId !== winner.bidderId) deactivate.add(p.bidderId);
    else if (winner.exact && p.maxCents <= price) deactivate.add(p.bidderId);
  }

  const outbid = new Set<string>();
  for (const c of contenders) {
    if (c.bidderId !== winner.bidderId && !c.isIncoming) outbid.add(c.bidderId);
  }

  return {
    ok: true,
    priceCents: price,
    leaderId: winner.bidderId,
    isLeading: winner.bidderId === action.bidderId,
    bids: rows.map(({ rank: _rank, ...bid }) => bid),
    proxy:
      action.kind === 'proxy'
        ? { maxCents: action.amountCents, active: winner.bidderId === action.bidderId }
        : null,
    deactivate: [...deactivate],
    outbid: [...outbid],
  };
}
