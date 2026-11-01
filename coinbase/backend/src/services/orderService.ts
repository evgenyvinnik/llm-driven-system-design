import { EventEmitter } from 'events';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { orderBookManager, type IncomingOrder, type MatchResult } from './orderBook.js';
import { stopOrderBook, type StopEntry } from './stopOrders.js';
import { runExclusive } from './pairQueue.js';
import { marketService } from './marketService.js';
import * as walletService from './walletService.js';
import { checkIdempotencyKey, setIdempotencyKey } from './idempotency.js';
import { publishMessage } from './kafka.js';
import { config } from '../config/index.js';
import { orderCounter, tradeCounter } from './metrics.js';
import { logger } from './logger.js';
import { EXCHANGE_USER_ID } from './exchangeAccount.js';
import {
  ONE,
  fromNumber,
  mul,
  mulCeil,
  parseDecimal,
  roundToDecimals,
  toDecimalString,
  toNumber,
} from './decimal.js';

const MAKER_FEE = parseDecimal(config.fees.makerFee)!;
const TAKER_FEE = parseDecimal(config.fees.takerFee)!;
const PROTECTION = parseDecimal(config.marketProtection)!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rejection the client caused (bad input, insufficient funds). Carries its HTTP status. */
export class OrderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

/** Emits `order_update` whenever an order's state changes; index.ts forwards it to WebSocket. */
export const orderEvents = new EventEmitter();

export interface OrderUpdateEvent {
  userId: string;
  orderId: string;
  symbol: string;
  status: string;
}

interface TradingPair {
  id: string;
  symbol: string;
  base_currency_id: string;
  quote_currency_id: string;
  min_order_size: string;
  max_order_size: string;
  price_precision: number;
  quantity_precision: number;
  is_active: boolean;
}

interface PlaceOrderParams {
  tradingPairId: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop';
  quantity: string;
  price?: string;
  stopPrice?: string;
  idempotencyKey?: string;
}

interface ValidatedOrder {
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop';
  quantity: bigint;
  limitPrice: bigint | null;
  stopPrice: bigint | null;
}

interface OrderResult {
  id: string;
  status: string;
  filledQuantity: string;
  avgFillPrice: string | null;
}

interface FilledOrder {
  orderId: string;
  userId: string;
  status: string;
  holdRemaining: bigint;
}

/**
 * Places an order. Validation and idempotency happen up front; everything that
 * touches the pair's book runs inside the pair's command queue, so it never
 * interleaves with another order, cancel, or stop trigger for the same pair.
 */
export async function placeOrder(userId: string, params: PlaceOrderParams): Promise<OrderResult> {
  const { idempotencyKey } = params;
  if (idempotencyKey !== undefined && !/^[\w.:-]{1,64}$/.test(idempotencyKey)) {
    throw new OrderError('idempotencyKey must be 1-64 letters, digits, or . _ : -');
  }

  // Keys are per user: two users choosing the same key must not see each other's order.
  const cacheKey = idempotencyKey ? `${userId}:${idempotencyKey}` : null;
  if (cacheKey) {
    const existing = await checkIdempotencyKey(cacheKey);
    if (existing.exists && existing.response) {
      return JSON.parse(existing.response);
    }
  }

  const pair = await loadPair(params.tradingPairId);
  const order = validateOrder(pair, params);
  const result = await runExclusive(pair.symbol, () =>
    executePlacement(userId, pair, order, idempotencyKey)
  );

  if (cacheKey) {
    await setIdempotencyKey(cacheKey, result as unknown as Record<string, unknown>);
  }
  return result;
}

async function loadPair(tradingPairId: string): Promise<TradingPair> {
  if (typeof tradingPairId !== 'string' || !UUID_RE.test(tradingPairId)) {
    throw new OrderError('Trading pair not found', 404);
  }
  const result = await pool.query(
    `SELECT id, symbol, base_currency_id, quote_currency_id,
            min_order_size::text, max_order_size::text,
            price_precision, quantity_precision, is_active
     FROM trading_pairs WHERE id = $1`,
    [tradingPairId]
  );
  const pair = result.rows[0] as TradingPair | undefined;
  if (!pair) throw new OrderError('Trading pair not found', 404);
  if (!pair.is_active) throw new OrderError('Trading pair is not active');
  return pair;
}

async function loadPairBySymbol(symbol: string): Promise<TradingPair> {
  const result = await pool.query(
    `SELECT id, symbol, base_currency_id, quote_currency_id,
            min_order_size::text, max_order_size::text,
            price_precision, quantity_precision, is_active
     FROM trading_pairs WHERE symbol = $1`,
    [symbol]
  );
  if (!result.rows[0]) throw new Error(`Unknown trading pair ${symbol}`);
  return result.rows[0];
}

function validateOrder(pair: TradingPair, params: PlaceOrderParams): ValidatedOrder {
  const { side, orderType } = params;

  const quantity = parseDecimal(params.quantity, pair.quantity_precision);
  if (quantity === null || quantity === 0n) {
    throw new OrderError(
      `Quantity must be a positive number with at most ${pair.quantity_precision} decimal places`
    );
  }
  const min = parseDecimal(pair.min_order_size)!;
  const max = parseDecimal(pair.max_order_size)!;
  if (quantity < min || quantity > max) {
    throw new OrderError(
      `Order size must be between ${toDecimalString(min)} and ${toDecimalString(max)}`
    );
  }

  const priceError = (field: string) =>
    new OrderError(
      `${field} must be a positive number with at most ${pair.price_precision} decimal places`
    );

  if (orderType === 'limit') {
    const limitPrice = parseDecimal(params.price, pair.price_precision);
    if (limitPrice === null || limitPrice === 0n) throw priceError('Limit price');
    return { side, orderType, quantity, limitPrice, stopPrice: null };
  }

  if (orderType === 'stop') {
    const stopPrice = parseDecimal(params.stopPrice, pair.price_precision);
    if (stopPrice === null || stopPrice === 0n) throw priceError('Stop price');
    // A stop that is already through the market would fire instantly; that is a
    // market order, and accepting it as a stop hides that from the user.
    const current = referencePrice(pair);
    if (side === 'buy' && stopPrice <= current) {
      throw new OrderError(
        `Buy stop price must be above the current price (${toDecimalString(current)})`
      );
    }
    if (side === 'sell' && stopPrice >= current) {
      throw new OrderError(
        `Sell stop price must be below the current price (${toDecimalString(current)})`
      );
    }
    return { side, orderType, quantity, limitPrice: null, stopPrice };
  }

  referencePrice(pair); // market orders need a price to protect against
  return { side, orderType, quantity, limitPrice: null, stopPrice: null };
}

/** The simulated market price, rounded to the pair's tick size. */
function referencePrice(pair: TradingPair): bigint {
  const price = marketService.getCurrentPrice(pair.symbol);
  if (price === undefined) throw new OrderError('Market price not available', 503);
  return fromNumber(price, pair.price_precision);
}

/** Worst price a market execution accepts: reference ± the protection band, on the tick grid. */
function protectionPrice(side: 'buy' | 'sell', reference: bigint, pricePrecision: number): bigint {
  return side === 'buy'
    ? roundToDecimals(mulCeil(reference, ONE + PROTECTION), pricePrecision, 'up')
    : roundToDecimals(mul(reference, ONE - PROTECTION), pricePrecision, 'down');
}

/**
 * Funds to hold for an order. A sell holds the base quantity. A buy holds
 * quantity × worst price × (1 + taker fee) in quote: fills can only happen at
 * that price or better and the taker fee is the larger rate, so the hold
 * always covers what the order can spend. The unspent part is released when
 * the order finishes.
 */
function holdFor(side: 'buy' | 'sell', quantity: bigint, priceCap: bigint): bigint {
  if (side === 'sell') return quantity;
  return mulCeil(mulCeil(quantity, priceCap), ONE + TAKER_FEE);
}

function holdCurrency(pair: TradingPair, side: 'buy' | 'sell'): string {
  return side === 'buy' ? pair.quote_currency_id : pair.base_currency_id;
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

/** Runs inside the pair queue. */
async function executePlacement(
  userId: string,
  pair: TradingPair,
  order: ValidatedOrder,
  idempotencyKey: string | undefined
): Promise<OrderResult> {
  const { side, orderType, quantity } = order;

  // The price cap is read here, inside the queue, so a market order is
  // protected relative to the price at execution rather than at validation.
  const cap =
    orderType === 'limit'
      ? order.limitPrice!
      : protectionPrice(
          side,
          orderType === 'market' ? referencePrice(pair) : order.stopPrice!,
          pair.price_precision
        );
  const currency = holdCurrency(pair, side);
  const hold = holdFor(side, quantity, cap);

  // Reserve and insert in ONE transaction: a failed insert can no longer leave
  // funds held for an order that does not exist.
  let placed: { id: string; sequence: number };
  try {
    placed = await withTransaction(async (client) => {
      const reserved = await walletService.reserveBalance(
        userId,
        currency,
        toDecimalString(hold),
        client
      );
      if (!reserved) {
        throw new OrderError(
          `Insufficient ${currency} balance: this order holds ${toDecimalString(hold)} ${currency}`
        );
      }
      const inserted = await client.query(
        `INSERT INTO orders (user_id, trading_pair_id, side, order_type, quantity, price,
                             stop_price, hold_remaining, idempotency_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
         RETURNING id, arrival_seq::text`,
        [
          userId,
          pair.id,
          side,
          orderType,
          toDecimalString(quantity),
          order.limitPrice === null ? null : toDecimalString(order.limitPrice),
          order.stopPrice === null ? null : toDecimalString(order.stopPrice),
          toDecimalString(hold),
          idempotencyKey ?? null,
        ]
      );
      return { id: inserted.rows[0].id, sequence: Number(inserted.rows[0].arrival_seq) };
    });
  } catch (error) {
    // Same key, same user, raced past the Redis check: the database is the backstop.
    if (idempotencyKey && isUniqueViolation(error)) {
      const existing = await pool.query(
        `SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      if (existing.rows[0]) return loadOrderResult(existing.rows[0].id);
    }
    throw error;
  }

  orderCounter.inc({ side, type: orderType, status: 'placed' });

  if (orderType === 'stop') {
    stopOrderBook.add({
      orderId: placed.id,
      userId,
      symbol: pair.symbol,
      side,
      stopPrice: order.stopPrice!,
      quantity,
      sequence: placed.sequence,
    });
  } else {
    await executeAgainstBook(
      pair,
      { orderId: placed.id, userId, side, limitPrice: cap, quantity },
      placed.sequence,
      orderType === 'limit' ? 'rest' : 'immediate-or-cancel'
    );
  }

  const result = await loadOrderResult(placed.id);
  notify(userId, placed.id, pair.symbol, result.status);
  return result;
}

/**
 * Matches an incoming order against the book and settles every fill.
 * `rest` (limit): any remainder joins the book.
 * `immediate-or-cancel` (market, triggered stop): the remainder fills against
 * exchange liquidity if the market price is inside the protection band, and
 * whatever is still left is cancelled with its hold released.
 */
async function executeAgainstBook(
  pair: TradingPair,
  incoming: IncomingOrder,
  sequence: number,
  mode: 'rest' | 'immediate-or-cancel'
): Promise<void> {
  const book = orderBookManager.getBook(pair.symbol);
  const { matches, remaining } = book.match(incoming);

  try {
    for (const match of matches) {
      await settle(pair, match);
    }
  } catch (error) {
    // The book consumed these resting quantities in memory before the fills
    // committed. Rebuild it from what Postgres actually recorded so the two
    // agree again; the incoming order is reloaded from its committed state.
    logger.error({ err: error, symbol: pair.symbol }, 'Settlement failed; rebuilding book');
    await rebuildBookUnlocked(pair.symbol);
    throw error;
  }

  let left = remaining;
  if (left > 0n && mode === 'immediate-or-cancel') {
    left = await fillFromExchange(pair, incoming, left);
  }
  if (left === 0n) return;

  if (mode === 'rest') {
    book.addOrder({
      orderId: incoming.orderId,
      userId: incoming.userId,
      side: incoming.side,
      price: incoming.limitPrice,
      remainingQuantity: left,
      sequence,
    });
  } else {
    await withTransaction((client) => closeOrder(client, incoming.orderId));
  }
}

/** Settles one book match in its own transaction, then publishes its effects. */
async function settle(pair: TradingPair, match: MatchResult): Promise<void> {
  const tradeId = await withTransaction((client) => applySettlement(client, pair, match));
  afterSettlement(pair, match, tradeId);
}

/**
 * Fills the remainder of an immediate-or-cancel order against the exchange
 * account at the current market price. Returns the quantity still unfilled
 * (all of it if the price is outside the protection band or liquidity is short).
 */
async function fillFromExchange(
  pair: TradingPair,
  incoming: IncomingOrder,
  quantity: bigint
): Promise<bigint> {
  const current = marketService.getCurrentPrice(pair.symbol);
  if (current === undefined) return quantity;
  const price = fromNumber(current, pair.price_precision);
  const withinProtection =
    incoming.side === 'buy' ? price <= incoming.limitPrice : price >= incoming.limitPrice;
  if (!withinProtection) return quantity;

  const makerSide = incoming.side === 'buy' ? 'sell' : 'buy';
  const makerHold = holdFor(makerSide, quantity, price);

  const settled = await withTransaction(async (client) => {
    const reserved = await walletService.reserveBalance(
      EXCHANGE_USER_ID,
      holdCurrency(pair, makerSide),
      toDecimalString(makerHold),
      client
    );
    if (!reserved) return null;

    const counter = await client.query(
      `INSERT INTO orders (user_id, trading_pair_id, side, order_type, quantity, price,
                           hold_remaining, status)
       VALUES ($1, $2, $3, 'limit', $4, $5, $6, 'open')
       RETURNING id`,
      [
        EXCHANGE_USER_ID,
        pair.id,
        makerSide,
        toDecimalString(quantity),
        toDecimalString(price),
        toDecimalString(makerHold),
      ]
    );
    const makerOrderId: string = counter.rows[0].id;
    const match: MatchResult = {
      makerOrderId,
      makerUserId: EXCHANGE_USER_ID,
      takerOrderId: incoming.orderId,
      takerUserId: incoming.userId,
      takerSide: incoming.side,
      buyOrderId: incoming.side === 'buy' ? incoming.orderId : makerOrderId,
      sellOrderId: incoming.side === 'sell' ? incoming.orderId : makerOrderId,
      price,
      quantity,
    };
    const tradeId = await applySettlement(client, pair, match);
    return { match, tradeId };
  });

  if (!settled) {
    logger.warn({ symbol: pair.symbol }, 'Exchange liquidity exhausted; remainder cancelled');
    return quantity;
  }
  afterSettlement(pair, settled.match, settled.tradeId);
  return 0n;
}

/**
 * Moves value for one execution, inside the caller's transaction. Fees are in
 * the quote currency: the buyer pays notional + fee out of their hold, the
 * seller receives notional − fee, and the exchange account receives both fees,
 * so the quote leaving the buyer equals the quote arriving everywhere else.
 */
async function applySettlement(
  client: PoolClient,
  pair: TradingPair,
  match: MatchResult
): Promise<string> {
  const base = pair.base_currency_id;
  const quote = pair.quote_currency_id;
  const notional = mul(match.price, match.quantity);
  const takerFee = mul(notional, TAKER_FEE);
  const makerFee = mul(notional, MAKER_FEE);
  const buyerFee = match.takerSide === 'buy' ? takerFee : makerFee;
  const sellerFee = match.takerSide === 'sell' ? takerFee : makerFee;
  const buyerPays = notional + buyerFee;
  const sellerReceives = notional - sellerFee;
  const quantity = toDecimalString(match.quantity);

  const trade = await client.query(
    `INSERT INTO trades (trading_pair_id, buy_order_id, sell_order_id, price, quantity,
                         buyer_fee, seller_fee, taker_side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      pair.id,
      match.buyOrderId,
      match.sellOrderId,
      toDecimalString(match.price),
      quantity,
      toDecimalString(buyerFee),
      toDecimalString(sellerFee),
      match.takerSide,
    ]
  );
  const tradeId: string = trade.rows[0].id;

  const buyer = await applyFill(client, match.buyOrderId, match, buyerPays);
  const seller = await applyFill(client, match.sellOrderId, match, match.quantity);

  await walletService.spendReserved(client, buyer.userId, quote, toDecimalString(buyerPays));
  await walletService.credit(client, buyer.userId, base, quantity);
  await walletService.spendReserved(client, seller.userId, base, quantity);
  await walletService.credit(client, seller.userId, quote, toDecimalString(sellerReceives));
  if (buyerFee + sellerFee > 0n) {
    await walletService.credit(client, EXCHANGE_USER_ID, quote, toDecimalString(buyerFee + sellerFee));
  }

  // A finished order gives back whatever its worst-case hold did not spend:
  // price improvement on a limit buy, maker-vs-taker fee difference, the
  // protection band on a market buy.
  for (const [order, currency] of [
    [buyer, quote],
    [seller, base],
  ] as const) {
    if (order.status === 'filled' && order.holdRemaining > 0n) {
      await client.query(`UPDATE orders SET hold_remaining = 0 WHERE id = $1`, [order.orderId]);
      await walletService.releaseReserve(
        order.userId,
        currency,
        toDecimalString(order.holdRemaining),
        client
      );
    }
  }

  // Ledger rows: one per currency each side received, plus fee rows. Fees get
  // their own rows so the amount and its currency are never ambiguous.
  await client.query(
    `INSERT INTO transactions (user_id, type, currency_id, amount, reference_id, status) VALUES
       ($1, 'trade', $2, $3, $7, 'completed'),
       ($4, 'trade', $5, $6, $7, 'completed')`,
    [buyer.userId, base, quantity, seller.userId, quote, toDecimalString(notional), tradeId]
  );
  for (const [userId, fee] of [
    [buyer.userId, buyerFee],
    [seller.userId, sellerFee],
  ] as const) {
    if (fee > 0n) {
      await client.query(
        `INSERT INTO transactions (user_id, type, currency_id, amount, reference_id, status)
         VALUES ($1, 'fee', $2, $3, $4, 'completed')`,
        [userId, quote, toDecimalString(fee), tradeId]
      );
    }
  }

  return tradeId;
}

/**
 * Records a fill on an order and consumes part of its hold. The WHERE clause
 * refuses to fill an order that is no longer live or to overfill it, and the
 * hold_remaining >= 0 CHECK refuses to spend more than was held. Either
 * failure aborts the settlement instead of persisting a bad state.
 */
async function applyFill(
  client: PoolClient,
  orderId: string,
  match: MatchResult,
  holdConsumed: bigint
): Promise<FilledOrder> {
  const result = await client.query(
    `UPDATE orders SET
       avg_fill_price = CASE WHEN filled_quantity = 0 THEN $3::numeric
         ELSE (avg_fill_price * filled_quantity + $3::numeric * $2::numeric)
              / (filled_quantity + $2::numeric) END,
       filled_quantity = filled_quantity + $2::numeric,
       status = CASE WHEN filled_quantity + $2::numeric >= quantity
         THEN 'filled' ELSE 'partially_filled' END,
       hold_remaining = hold_remaining - $4::numeric,
       updated_at = NOW()
     WHERE id = $1
       AND status IN ('open', 'partially_filled')
       AND filled_quantity + $2::numeric <= quantity
     RETURNING user_id, status, hold_remaining::text`,
    [
      orderId,
      toDecimalString(match.quantity),
      toDecimalString(match.price),
      toDecimalString(holdConsumed),
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Order ${orderId} is not fillable; book and database disagree`);
  }
  return {
    orderId,
    userId: row.user_id,
    status: row.status,
    holdRemaining: parseDecimal(row.hold_remaining)!,
  };
}

/** Effects that must only happen after a fill commits. */
function afterSettlement(pair: TradingPair, match: MatchResult, tradeId: string): void {
  const notional = mul(match.price, match.quantity);
  marketService.updatePriceFromTrade(pair.symbol, toNumber(match.price), toNumber(notional));
  tradeCounter.inc();

  publishMessage('trade-events', pair.symbol, {
    type: 'trade',
    tradeId,
    buyOrderId: match.buyOrderId,
    sellOrderId: match.sellOrderId,
    takerSide: match.takerSide,
    price: toDecimalString(match.price),
    quantity: toDecimalString(match.quantity),
    timestamp: Date.now(),
  }).catch(() => {
    // Non-critical: the trade is already durable in Postgres.
  });

  notify(match.makerUserId, match.makerOrderId, pair.symbol);
  notify(match.takerUserId, match.takerOrderId, pair.symbol);

  // A trade moves the price, which may reach a pending stop.
  scheduleStopCheck(pair.symbol);
}

/**
 * Cancels a live order inside the caller's transaction and returns its unspent
 * hold to the wallet. Returns null if the order is not live (or not the user's).
 */
async function closeOrder(
  client: PoolClient,
  orderId: string,
  userId?: string
): Promise<{ userId: string; symbol: string; side: string } | null> {
  const result = await client.query(
    `UPDATE orders o
     SET status = 'cancelled', hold_remaining = 0, updated_at = NOW()
     FROM (
       SELECT o2.id, o2.hold_remaining AS released, tp.symbol,
              CASE WHEN o2.side = 'buy' THEN tp.quote_currency_id
                   ELSE tp.base_currency_id END AS hold_currency
       FROM orders o2
       JOIN trading_pairs tp ON tp.id = o2.trading_pair_id
       WHERE o2.id = $1
         AND ($2::uuid IS NULL OR o2.user_id = $2::uuid)
         AND o2.status IN ('open', 'partially_filled')
       FOR UPDATE OF o2
     ) previous
     WHERE o.id = previous.id
     RETURNING o.user_id, o.side, previous.symbol, previous.hold_currency,
               previous.released::text`,
    [orderId, userId ?? null]
  );
  const row = result.rows[0];
  if (!row) return null;

  if (parseDecimal(row.released)! > 0n) {
    await walletService.releaseReserve(row.user_id, row.hold_currency, row.released, client);
  }
  return { userId: row.user_id, symbol: row.symbol, side: row.side };
}

/**
 * Cancels an open, partially filled, or untriggered stop order and releases its hold.
 * @returns True if cancelled, false if the order is not found or not cancellable.
 */
export async function cancelOrder(userId: string, orderId: string): Promise<boolean> {
  if (!UUID_RE.test(orderId)) return false;
  const lookup = await pool.query(
    `SELECT tp.symbol FROM orders o
     JOIN trading_pairs tp ON tp.id = o.trading_pair_id
     WHERE o.id = $1 AND o.user_id = $2`,
    [orderId, userId]
  );
  if (!lookup.rows[0]) return false;
  const symbol: string = lookup.rows[0].symbol;

  return runExclusive(symbol, async () => {
    const closed = await withTransaction((client) => closeOrder(client, orderId, userId));
    if (!closed) return false;

    // Only after the commit: if it had failed, the order would still be live.
    orderBookManager.getBook(symbol).removeOrder(orderId);
    stopOrderBook.remove(symbol, orderId);
    orderCounter.inc({ side: closed.side, type: 'cancel', status: 'cancelled' });
    notify(userId, orderId, symbol, 'cancelled');
    return true;
  });
}

/** Queues a check of pending stops against the current price for one pair. */
function scheduleStopCheck(symbol: string): void {
  if (stopOrderBook.count(symbol) === 0) return;
  setImmediate(() => checkStopTriggers(symbol));
}

/**
 * Fires every stop the current price has reached. Called on each price tick
 * and after every trade. Each triggered stop runs through the pair queue.
 */
export function checkStopTriggers(symbol: string): void {
  if (stopOrderBook.count(symbol) === 0) return;
  const price = marketService.getCurrentPrice(symbol);
  if (price === undefined) return;

  for (const stop of stopOrderBook.takeTriggered(symbol, fromNumber(price))) {
    runExclusive(symbol, () => executeTriggeredStop(stop)).catch((error) => {
      logger.error({ err: error, orderId: stop.orderId }, 'Stop order execution failed');
    });
  }
}

async function executeTriggeredStop(stop: StopEntry): Promise<void> {
  // A cancel may have been queued ahead of this trigger.
  const current = await pool.query(`SELECT status FROM orders WHERE id = $1`, [stop.orderId]);
  if (current.rows[0]?.status !== 'open') return;

  const pair = await loadPairBySymbol(stop.symbol);
  logger.info(
    { orderId: stop.orderId, symbol: stop.symbol, stopPrice: toDecimalString(stop.stopPrice) },
    'Stop order triggered'
  );
  await executeAgainstBook(
    pair,
    {
      orderId: stop.orderId,
      userId: stop.userId,
      side: stop.side,
      limitPrice: protectionPrice(stop.side, stop.stopPrice, pair.price_precision),
      quantity: stop.quantity,
    },
    stop.sequence,
    'immediate-or-cancel'
  );
  const result = await loadOrderResult(stop.orderId);
  notify(stop.userId, stop.orderId, stop.symbol, result.status);
}

/**
 * Rebuilds one pair's book and stop list from Postgres. Caller must hold the
 * pair queue. Live limit orders are replayed in arrival_seq order, which is
 * the order they originally entered the book, so priority is preserved
 * exactly. A market order (or triggered stop) still live was interrupted
 * mid-execution; those are immediate-or-cancel, so it is cancelled and its
 * hold released.
 */
async function rebuildBookUnlocked(
  symbol: string
): Promise<{ resting: number; stops: number; cancelled: number }> {
  const book = orderBookManager.getBook(symbol);
  book.clear();
  stopOrderBook.clear(symbol);

  const result = await pool.query(
    `SELECT o.id, o.user_id, o.side, o.order_type, o.quantity::text,
            o.filled_quantity::text, o.price::text, o.stop_price::text, o.arrival_seq::text
     FROM orders o
     JOIN trading_pairs tp ON tp.id = o.trading_pair_id
     WHERE tp.symbol = $1 AND o.status IN ('open', 'partially_filled')
     ORDER BY o.arrival_seq`,
    [symbol]
  );

  const counts = { resting: 0, stops: 0, cancelled: 0 };
  for (const row of result.rows) {
    const filled = parseDecimal(row.filled_quantity)!;
    const remaining = parseDecimal(row.quantity)! - filled;
    const sequence = Number(row.arrival_seq);
    if (row.order_type === 'limit' && row.price !== null && remaining > 0n) {
      book.addOrder({
        orderId: row.id,
        userId: row.user_id,
        side: row.side,
        price: parseDecimal(row.price)!,
        remainingQuantity: remaining,
        sequence,
      });
      counts.resting++;
    } else if (row.order_type === 'stop' && row.stop_price !== null && filled === 0n) {
      // Only untriggered stops wait again; one that already started filling was
      // triggered, and its remainder is immediate-or-cancel like any market order.
      stopOrderBook.add({
        orderId: row.id,
        userId: row.user_id,
        symbol,
        side: row.side,
        stopPrice: parseDecimal(row.stop_price)!,
        quantity: remaining,
        sequence,
      });
      counts.stops++;
    } else {
      await withTransaction((client) => closeOrder(client, row.id));
      counts.cancelled++;
    }
  }
  return counts;
}

/** Rebuilds every pair's book from Postgres. Run once at boot, before serving traffic. */
export async function rehydrateOrderBooks(): Promise<{
  resting: number;
  stops: number;
  cancelled: number;
}> {
  const pairs = await pool.query(`SELECT symbol FROM trading_pairs`);
  const totals = { resting: 0, stops: 0, cancelled: 0 };
  for (const { symbol } of pairs.rows) {
    const counts = await runExclusive(symbol, () => rebuildBookUnlocked(symbol));
    totals.resting += counts.resting;
    totals.stops += counts.stops;
    totals.cancelled += counts.cancelled;
  }
  return totals;
}

async function loadOrderResult(orderId: string): Promise<OrderResult> {
  const result = await pool.query(
    `SELECT id, status, filled_quantity::text AS "filledQuantity",
            avg_fill_price::text AS "avgFillPrice"
     FROM orders WHERE id = $1`,
    [orderId]
  );
  return result.rows[0];
}

function notify(userId: string, orderId: string, symbol: string, status?: string): void {
  if (userId === EXCHANGE_USER_ID) return;
  const event: OrderUpdateEvent = { userId, orderId, symbol, status: status ?? 'updated' };
  orderEvents.emit('order_update', event);
}

/**
 * Retrieves a user's orders with optional status filter.
 * @param userId - ID of the user.
 * @param status - Optional order status filter.
 * @param limit - Maximum number of orders to return.
 * @returns Array of order records.
 */
export async function getUserOrders(
  userId: string,
  status?: string,
  limit: number = 50
): Promise<Record<string, unknown>[]> {
  let query = `
    SELECT o.id, o.trading_pair_id AS "tradingPairId", tp.symbol,
           o.side, o.order_type AS "orderType",
           o.quantity::text, o.price::text,
           o.stop_price::text AS "stopPrice",
           o.filled_quantity::text AS "filledQuantity",
           o.avg_fill_price::text AS "avgFillPrice",
           o.status, o.created_at AS "createdAt"
    FROM orders o
    JOIN trading_pairs tp ON tp.id = o.trading_pair_id
    WHERE o.user_id = $1
  `;

  const queryParams: (string | number)[] = [userId];

  if (status) {
    queryParams.push(status);
    query += ` AND o.status = $${queryParams.length}`;
  }

  queryParams.push(Math.min(Math.max(limit, 1), 200));
  query += ` ORDER BY o.created_at DESC LIMIT $${queryParams.length}`;

  const result = await pool.query(query, queryParams);
  return result.rows;
}
