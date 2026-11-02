import { toNumber } from './decimal.js';

/** A resting limit order. Price and quantity are scaled BigInts (see decimal.ts). */
export interface OrderBookEntry {
  orderId: string;
  userId: string;
  side: 'buy' | 'sell';
  price: bigint;
  remainingQuantity: bigint;
  /**
   * Arrival sequence assigned by Postgres (orders.arrival_seq). Breaks price
   * ties, so in-memory time priority is exactly the durable priority and a
   * rebuild from the database reproduces the same book.
   */
  sequence: number;
}

/** An order arriving at the book. It is the taker for every fill it produces. */
export interface IncomingOrder {
  orderId: string;
  userId: string;
  side: 'buy' | 'sell';
  /** Worst acceptable price: the limit price, or a market order's protection price. */
  limitPrice: bigint;
  quantity: bigint;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

/** One execution between the incoming (taker) order and a resting (maker) order. */
export interface MatchResult {
  makerOrderId: string;
  makerUserId: string;
  takerOrderId: string;
  takerUserId: string;
  takerSide: 'buy' | 'sell';
  buyOrderId: string;
  sellOrderId: string;
  /** Executions happen at the resting order's price. */
  price: bigint;
  quantity: bigint;
}

/** In-memory order book with price-time priority for a single trading pair. */
export class OrderBook {
  private bids: OrderBookEntry[] = []; // price DESC, then sequence ASC
  private asks: OrderBookEntry[] = []; // price ASC, then sequence ASC

  /** Rests an order on its side of the book in priority position. */
  addOrder(entry: OrderBookEntry): void {
    const side = entry.side === 'buy' ? this.bids : this.asks;
    const outranks = (other: OrderBookEntry) =>
      entry.side === 'buy'
        ? entry.price > other.price ||
          (entry.price === other.price && entry.sequence < other.sequence)
        : entry.price < other.price ||
          (entry.price === other.price && entry.sequence < other.sequence);

    let insertIndex = side.length;
    for (let i = 0; i < side.length; i++) {
      if (outranks(side[i])) {
        insertIndex = i;
        break;
      }
    }
    side.splice(insertIndex, 0, entry);
  }

  /** Removes a resting order by ID. Returns true if it was in the book. */
  removeOrder(orderId: string): boolean {
    for (const side of [this.bids, this.asks]) {
      const idx = side.findIndex((o) => o.orderId === orderId);
      if (idx !== -1) {
        side.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  hasOrder(orderId: string): boolean {
    return (
      this.bids.some((o) => o.orderId === orderId) ||
      this.asks.some((o) => o.orderId === orderId)
    );
  }

  /**
   * Matches an incoming order against the opposite side, best price first,
   * stopping when the next resting price is worse than `limitPrice` or the
   * incoming quantity is exhausted. The incoming order is never inserted here:
   * the caller decides whether a remainder rests (limit) or is cancelled
   * (market / immediate-or-cancel). Resting entries are consumed in place.
   */
  match(incoming: IncomingOrder): { matches: MatchResult[]; remaining: bigint } {
    const opposite = incoming.side === 'buy' ? this.asks : this.bids;
    const matches: MatchResult[] = [];
    let remaining = incoming.quantity;

    while (remaining > 0n && opposite.length > 0) {
      const best = opposite[0];
      const crosses =
        incoming.side === 'buy'
          ? best.price <= incoming.limitPrice
          : best.price >= incoming.limitPrice;
      if (!crosses) break;

      const quantity = remaining < best.remainingQuantity ? remaining : best.remainingQuantity;
      matches.push({
        makerOrderId: best.orderId,
        makerUserId: best.userId,
        takerOrderId: incoming.orderId,
        takerUserId: incoming.userId,
        takerSide: incoming.side,
        buyOrderId: incoming.side === 'buy' ? incoming.orderId : best.orderId,
        sellOrderId: incoming.side === 'sell' ? incoming.orderId : best.orderId,
        price: best.price,
        quantity,
      });

      remaining -= quantity;
      best.remainingQuantity -= quantity;
      if (best.remainingQuantity === 0n) {
        opposite.shift();
      }
    }

    return { matches, remaining };
  }

  /** Drops every resting order. Used before rebuilding the book from Postgres. */
  clear(): void {
    this.bids = [];
    this.asks = [];
  }

  /** Returns aggregated price levels for display (numbers are display-only). */
  getDepth(levels: number = 20): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
    return {
      bids: this.aggregateLevels(this.bids, levels),
      asks: this.aggregateLevels(this.asks, levels),
    };
  }

  private aggregateLevels(orders: OrderBookEntry[], maxLevels: number): OrderBookLevel[] {
    const levels: { price: bigint; quantity: bigint; orderCount: number }[] = [];
    for (const order of orders) {
      const last = levels[levels.length - 1];
      if (last && last.price === order.price) {
        last.quantity += order.remainingQuantity;
        last.orderCount += 1;
      } else {
        if (levels.length >= maxLevels) break;
        levels.push({ price: order.price, quantity: order.remainingQuantity, orderCount: 1 });
      }
    }
    return levels.map((l) => ({
      price: toNumber(l.price),
      quantity: toNumber(l.quantity),
      orderCount: l.orderCount,
    }));
  }

  /** Returns the highest bid price, or null if no bids. */
  getBestBid(): number | null {
    return this.bids.length > 0 ? toNumber(this.bids[0].price) : null;
  }

  /** Returns the lowest ask price, or null if no asks. */
  getBestAsk(): number | null {
    return this.asks.length > 0 ? toNumber(this.asks[0].price) : null;
  }

  /** Returns best ask minus best bid, or null if either side is empty. */
  getSpread(): number | null {
    if (this.bids.length === 0 || this.asks.length === 0) return null;
    return toNumber(this.asks[0].price - this.bids[0].price);
  }

  getBidCount(): number {
    return this.bids.length;
  }

  getAskCount(): number {
    return this.asks.length;
  }
}

/** Manages order books for all trading pairs. */
class OrderBookManager {
  private books: Map<string, OrderBook> = new Map();

  getBook(tradingPairSymbol: string): OrderBook {
    let book = this.books.get(tradingPairSymbol);
    if (!book) {
      book = new OrderBook();
      this.books.set(tradingPairSymbol, book);
    }
    return book;
  }

  getAllBooks(): Map<string, OrderBook> {
    return this.books;
  }
}

/** Singleton order book manager shared across the application. */
export const orderBookManager = new OrderBookManager();
