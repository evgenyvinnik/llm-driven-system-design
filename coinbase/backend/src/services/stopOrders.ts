/** A stop order waiting for the market to reach its trigger price. */
export interface StopEntry {
  orderId: string;
  userId: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** Scaled BigInt trigger price (see decimal.ts). */
  stopPrice: bigint;
  quantity: bigint;
  sequence: number;
}

/**
 * Pending stop orders, kept apart from the limit order book because they are
 * invisible to matching until triggered. A buy stop fires when the price rises
 * to its stop; a sell stop fires when the price falls to its stop. Once fired,
 * the order executes as a market order protected relative to its stop price.
 */
class StopOrderBook {
  private bySymbol: Map<string, StopEntry[]> = new Map();

  add(entry: StopEntry): void {
    const entries = this.bySymbol.get(entry.symbol) ?? [];
    entries.push(entry);
    this.bySymbol.set(entry.symbol, entries);
  }

  remove(symbol: string, orderId: string): boolean {
    const entries = this.bySymbol.get(symbol);
    if (!entries) return false;
    const idx = entries.findIndex((e) => e.orderId === orderId);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    return true;
  }

  /**
   * Removes and returns every stop that `price` triggers, in the order a
   * moving market would reach them: buy stops lowest-first, sell stops
   * highest-first, arrival order within a price.
   */
  takeTriggered(symbol: string, price: bigint): StopEntry[] {
    const entries = this.bySymbol.get(symbol);
    if (!entries || entries.length === 0) return [];

    const triggered: StopEntry[] = [];
    const waiting: StopEntry[] = [];
    for (const entry of entries) {
      const fires = entry.side === 'buy' ? price >= entry.stopPrice : price <= entry.stopPrice;
      (fires ? triggered : waiting).push(entry);
    }
    this.bySymbol.set(symbol, waiting);

    return triggered.sort((a, b) => {
      if (a.stopPrice !== b.stopPrice) {
        const ascending = a.stopPrice < b.stopPrice ? -1 : 1;
        return a.side === 'buy' ? ascending : -ascending;
      }
      return a.sequence - b.sequence;
    });
  }

  clear(symbol: string): void {
    this.bySymbol.delete(symbol);
  }

  count(symbol: string): number {
    return this.bySymbol.get(symbol)?.length ?? 0;
  }
}

/** Singleton stop order book shared across the application. */
export const stopOrderBook = new StopOrderBook();
