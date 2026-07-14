import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { marketService } from '../services/marketService.js';
import { orderBookManager } from '../services/orderBook.js';

const router = Router();

// GET /api/v1/markets/pairs - Get all trading pairs with prices
/** GET /api/v1/markets/pairs - Returns active trading pairs with live market data. */
router.get('/pairs', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, symbol, base_currency_id AS "baseCurrency",
              quote_currency_id AS "quoteCurrency",
              price_precision AS "pricePrecision",
              quantity_precision AS "quantityPrecision",
              min_order_size::text AS "minOrderSize",
              max_order_size::text AS "maxOrderSize",
              is_active AS "isActive"
       FROM trading_pairs WHERE is_active = true
       ORDER BY symbol`
    );

    const pairs = result.rows.map((pair) => {
      const priceData = marketService.getPriceData(pair.symbol);
      return {
        ...pair,
        price: priceData?.price ?? 0,
        change24h: priceData?.change24h ?? 0,
        changePercent24h: priceData?.changePercent24h ?? 0,
        volume24h: priceData?.volume24h ?? 0,
        high24h: priceData?.high24h ?? 0,
        low24h: priceData?.low24h ?? 0,
      };
    });

    res.json({ pairs });
  } catch (error) {
    console.error('Get trading pairs error:', error);
    res.status(500).json({ error: 'Failed to get trading pairs' });
  }
});

// GET /api/v1/markets/currencies - Get all currencies
/** GET /api/v1/markets/currencies - Returns all active currencies. */
router.get('/currencies', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, name, symbol, decimals, is_fiat AS "isFiat", is_active AS "isActive"
       FROM currencies WHERE is_active = true
       ORDER BY id`
    );
    res.json({ currencies: result.rows });
  } catch (error) {
    console.error('Get currencies error:', error);
    res.status(500).json({ error: 'Failed to get currencies' });
  }
});

// GET /api/v1/markets/:symbol/price - Get current price
/** GET /api/v1/markets/:symbol/price - Returns current price and 24h change for a trading pair. */
router.get('/:symbol/price', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const priceData = marketService.getPriceData(String(symbol));

  if (!priceData) {
    res.status(404).json({ error: 'Trading pair not found' });
    return;
  }

  res.json({ symbol, ...priceData });
});

// GET /api/v1/markets/:symbol/orderbook - Get order book depth
/** GET /api/v1/markets/:symbol/orderbook - Returns aggregated bid/ask levels and spread. */
router.get('/:symbol/orderbook', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const levels = parseInt(req.query.levels as string) || 20;

  const book = orderBookManager.getBook(String(symbol));
  const depth = book.getDepth(levels);
  const spread = book.getSpread();

  res.json({
    symbol,
    bids: depth.bids,
    asks: depth.asks,
    spread,
    bestBid: book.getBestBid(),
    bestAsk: book.getBestAsk(),
  });
});

// GET /api/v1/markets/:symbol/candles - Get candlestick data
/** GET /api/v1/markets/:symbol/candles - Returns OHLCV candlestick data for charting. */
router.get('/:symbol/candles', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const interval = (req.query.interval as string) || '1m';
    const limit = parseInt(req.query.limit as string) || 100;

    const result = await pool.query(
      `SELECT open_time AS time, open::text, high::text, low::text, close::text, volume::text
       FROM price_candles
       WHERE symbol = $1 AND interval = $2
       ORDER BY open_time DESC
       LIMIT $3`,
      [symbol, interval, limit]
    );

    // Convert to number format and reverse for chronological order
    const candles = result.rows.reverse().map((row) => ({
      time: Math.floor(new Date(row.time).getTime() / 1000),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
    }));

    res.json({ candles });
  } catch (error) {
    console.error('Get candles error:', error);
    res.status(500).json({ error: 'Failed to get candles' });
  }
});

// GET /api/v1/markets/:symbol/trades - Get recent trades
/** GET /api/v1/markets/:symbol/trades - Returns recent executed trades for a trading pair. */
router.get('/:symbol/trades', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    // Get trading pair ID
    const pairResult = await pool.query(
      'SELECT id FROM trading_pairs WHERE symbol = $1',
      [symbol]
    );

    if (pairResult.rows.length === 0) {
      res.status(404).json({ error: 'Trading pair not found' });
      return;
    }

    const result = await pool.query(
      `SELECT t.id, t.price::text, t.quantity::text,
              t.buyer_fee::text AS "buyerFee",
              t.seller_fee::text AS "sellerFee",
              t.created_at AS "createdAt",
              bo.side AS "takerSide"
       FROM trades t
       JOIN orders bo ON bo.id = t.buy_order_id
       WHERE t.trading_pair_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [pairResult.rows[0].id, limit]
    );

    res.json({ trades: result.rows });
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({ error: 'Failed to get trades' });
  }
});

export default router;
