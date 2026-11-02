import { describe, it, expect } from 'vitest';
import {
  ONE,
  fromNumber,
  mul,
  mulCeil,
  parseDecimal,
  roundToDecimals,
  toDecimalString,
} from './decimal.js';
import { OrderBook, type OrderBookEntry } from './orderBook.js';
import { stopOrderBook } from './stopOrders.js';
import { runExclusive } from './pairQueue.js';

const d = (value: string) => parseDecimal(value)!;

function resting(
  orderId: string,
  side: 'buy' | 'sell',
  price: string,
  quantity: string,
  sequence: number
): OrderBookEntry {
  return { orderId, userId: `u-${orderId}`, side, price: d(price), remainingQuantity: d(quantity), sequence };
}

describe('decimal', () => {
  it('parses plain decimals exactly', () => {
    expect(toDecimalString(d('0.1') + d('0.2'))).toBe('0.3');
    expect(toDecimalString(d('65000.25'))).toBe('65000.25');
    expect(toDecimalString(d('007.500'))).toBe('7.5');
  });

  it('rejects junk that parseFloat would accept', () => {
    for (const bad of ['12abc', '1e3', '-1', ' 1', '1.', '.5', '', 'NaN', 'Infinity', '0x10']) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
    expect(parseDecimal(12 as unknown as string)).toBeNull();
  });

  it('enforces the precision limit on significant digits only', () => {
    expect(parseDecimal('1.123', 2)).toBeNull();
    expect(toDecimalString(parseDecimal('1.120', 2)!)).toBe('1.12');
    expect(parseDecimal('12345678901')).toBeNull(); // overflows DECIMAL(28,18)
  });

  it('multiplies and rounds without float error', () => {
    expect(toDecimalString(mul(d('0.1'), d('3')))).toBe('0.3');
    expect(toDecimalString(mul(d('65000'), d('0.00000001')))).toBe('0.00065');
    expect(mulCeil(1n, 1n)).toBe(1n); // 1e-18 * 1e-18 rounds up, never to zero
    expect(toDecimalString(roundToDecimals(d('1.234'), 2, 'up'))).toBe('1.24');
    expect(toDecimalString(roundToDecimals(d('1.235'), 2, 'half-up'))).toBe('1.24');
    expect(toDecimalString(roundToDecimals(d('1.239'), 2, 'down'))).toBe('1.23');
    expect(toDecimalString(fromNumber(65000.126, 2))).toBe('65000.13');
    expect(ONE).toBe(10n ** 18n);
  });
});

describe('OrderBook', () => {
  it('fills an incoming buy at resting prices, best price first', () => {
    const book = new OrderBook();
    book.addOrder(resting('a2', 'sell', '101', '1', 2));
    book.addOrder(resting('a1', 'sell', '100', '1', 1));

    const { matches, remaining } = book.match({
      orderId: 'taker',
      userId: 'u-taker',
      side: 'buy',
      limitPrice: d('105'),
      quantity: d('1.5'),
    });

    expect(remaining).toBe(0n);
    expect(matches.map((m) => [m.makerOrderId, toDecimalString(m.price), toDecimalString(m.quantity)])).toEqual([
      ['a1', '100', '1'],
      ['a2', '101', '0.5'],
    ]);
    expect(matches.every((m) => m.takerSide === 'buy' && m.buyOrderId === 'taker')).toBe(true);
    expect(book.getDepth().asks).toEqual([{ price: 101, quantity: 0.5, orderCount: 1 }]);
  });

  it('honours time priority within a price level', () => {
    const book = new OrderBook();
    book.addOrder(resting('late', 'buy', '100', '1', 9));
    book.addOrder(resting('early', 'buy', '100', '1', 3));

    const { matches } = book.match({
      orderId: 's', userId: 'u-s', side: 'sell', limitPrice: d('100'), quantity: d('1'),
    });
    expect(matches[0].makerOrderId).toBe('early');
    expect(matches[0].sellOrderId).toBe('s');
  });

  it('stops at the limit price and reports the remainder without resting it', () => {
    const book = new OrderBook();
    book.addOrder(resting('a1', 'sell', '100', '1', 1));
    book.addOrder(resting('a2', 'sell', '110', '1', 2));

    const { matches, remaining } = book.match({
      orderId: 't', userId: 'u-t', side: 'buy', limitPrice: d('105'), quantity: d('3'),
    });
    expect(matches).toHaveLength(1);
    expect(toDecimalString(remaining)).toBe('2');
    expect(book.hasOrder('t')).toBe(false);
    expect(book.getBestAsk()).toBe(110);
  });

  it('never drifts on fractional quantities', () => {
    const book = new OrderBook();
    for (let i = 0; i < 10; i++) book.addOrder(resting(`a${i}`, 'sell', '1', '0.1', i));

    const { remaining } = book.match({
      orderId: 't', userId: 'u-t', side: 'buy', limitPrice: d('1'), quantity: d('0.7'),
    });
    expect(remaining).toBe(0n);
    // float64 would leave 0.30000000000000004 here
    expect(book.getDepth().asks).toEqual([{ price: 1, quantity: 0.3, orderCount: 3 }]);
  });

  it('aggregates depth per level and limits the level count', () => {
    const book = new OrderBook();
    book.addOrder(resting('b1', 'buy', '99', '1', 1));
    book.addOrder(resting('b2', 'buy', '99', '2', 2));
    book.addOrder(resting('b3', 'buy', '98', '1', 3));
    book.addOrder(resting('a1', 'sell', '101', '1', 4));

    expect(book.getDepth(1).bids).toEqual([{ price: 99, quantity: 3, orderCount: 2 }]);
    expect(book.getSpread()).toBe(2);
    expect(book.removeOrder('b1')).toBe(true);
    expect(book.removeOrder('b1')).toBe(false);
  });
});

describe('stopOrderBook', () => {
  it('fires buy stops on a rise and sell stops on a fall, nearest first', () => {
    const symbol = 'TEST-STOP';
    const add = (orderId: string, side: 'buy' | 'sell', stopPrice: string, sequence: number) =>
      stopOrderBook.add({ orderId, userId: 'u', symbol, side, stopPrice: d(stopPrice), quantity: d('1'), sequence });

    add('buy-110', 'buy', '110', 1);
    add('buy-105', 'buy', '105', 2);
    add('sell-90', 'sell', '90', 3);
    add('sell-95', 'sell', '95', 4);

    expect(stopOrderBook.takeTriggered(symbol, d('100'))).toEqual([]);
    expect(stopOrderBook.takeTriggered(symbol, d('112')).map((s) => s.orderId)).toEqual(['buy-105', 'buy-110']);
    expect(stopOrderBook.takeTriggered(symbol, d('89')).map((s) => s.orderId)).toEqual(['sell-95', 'sell-90']);
    expect(stopOrderBook.count(symbol)).toBe(0);
  });

  it('removes a cancelled stop so it can never fire', () => {
    const symbol = 'TEST-CANCEL';
    stopOrderBook.add({ orderId: 'x', userId: 'u', symbol, side: 'sell', stopPrice: d('90'), quantity: d('1'), sequence: 1 });
    expect(stopOrderBook.remove(symbol, 'x')).toBe(true);
    expect(stopOrderBook.takeTriggered(symbol, d('1'))).toEqual([]);
  });
});

describe('runExclusive', () => {
  it('runs commands for one pair strictly one at a time, in order', async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name;
    };

    const results = await Promise.all([
      runExclusive('BTC-USD', slow('a', 20)),
      runExclusive('BTC-USD', slow('b', 1)),
    ]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps the queue moving after a command fails', async () => {
    const failing = runExclusive('ETH-USD', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(runExclusive('ETH-USD', async () => 'next')).resolves.toBe('next');
  });

  it('does not serialize different pairs against each other', async () => {
    const log: string[] = [];
    await Promise.all([
      runExclusive('SOL-USD', async () => {
        await new Promise((r) => setTimeout(r, 20));
        log.push('sol');
      }),
      runExclusive('DOGE-USD', async () => {
        log.push('doge');
      }),
    ]);
    expect(log).toEqual(['doge', 'sol']);
  });
});
