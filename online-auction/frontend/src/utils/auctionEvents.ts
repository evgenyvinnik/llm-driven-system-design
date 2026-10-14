import type { AuctionDetail, Bid, WebSocketMessage } from '../types';

/**
 * Applying real-time bid events to the auction detail snapshot.
 *
 * Every price change, close and cancel bumps the auction's `version` by one,
 * and the server sends that version with each `new_bid` event. That lets the
 * page apply events directly instead of refetching on every bid (which made
 * every watcher hit the API at once in the closing seconds), while staying
 * correct when events arrive late, twice, or not at all.
 */

/** Leader first: highest amount, and the earliest bid at that amount. */
const byStanding = (a: Bid, b: Bid): number =>
  parseFloat(b.amount) - parseFloat(a.amount) || a.sequence_num - b.sequence_num;

/**
 * Result of applying a `new_bid` event:
 * - `stale`: the snapshot already includes it (duplicate or late delivery);
 * - `gap`: at least one event was missed, so the caller should refetch;
 * - `applied`: the next snapshot.
 */
export type BidEventResult =
  | { kind: 'stale' }
  | { kind: 'gap' }
  | { kind: 'applied'; detail: AuctionDetail };

export function applyBidEvent(detail: AuctionDetail, event: WebSocketMessage): BidEventResult {
  if (event.version === undefined || event.current_price === undefined) return { kind: 'gap' };
  if (event.version <= detail.auction.version) return { kind: 'stale' };
  if (event.version > detail.auction.version + 1) return { kind: 'gap' };

  const known = new Set(detail.bids.map((b) => b.id));
  const bids = [...detail.bids, ...(event.bids ?? []).filter((b) => !known.has(b.id))].sort(byStanding).slice(0, 50);

  return {
    kind: 'applied',
    detail: {
      ...detail,
      bids,
      auction: {
        ...detail.auction,
        version: event.version,
        current_price: event.current_price.toFixed(2),
        end_time: event.end_time ?? detail.auction.end_time,
      },
    },
  };
}

/** A fetched snapshot replaces the current one unless it is older (a slow response racing a newer event). */
export function isNewerOrSame(current: AuctionDetail | null, fetched: AuctionDetail): boolean {
  return !current || current.auction.id !== fetched.auction.id || fetched.auction.version >= current.auction.version;
}
