import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { quoteService } from '../services/quoteService.js';

const router = Router();

// Get all available stocks
router.get('/stocks', (_req, res: Response) => {
  const stocks = quoteService.getAllStocks();
  res.json(stocks);
});

// Get all quotes
router.get('/', (_req, res: Response) => {
  const quotes = quoteService.getAllQuotes();
  res.json(quotes);
});

// Get quotes for specific symbols
router.get('/batch', (req, res: Response) => {
  const symbols = req.query.symbols as string;

  if (!symbols) {
    res.status(400).json({ error: 'symbols query parameter required' });
    return;
  }

  const symbolList = symbols.split(',').map((s) => s.trim().toUpperCase());
  const quotes = quoteService.getQuotes(symbolList);
  res.json(quotes);
});

// Get quote for single symbol
router.get('/:symbol', (req, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const quote = quoteService.getQuote(symbol);

  if (!quote) {
    res.status(404).json({ error: `Quote not found for ${symbol}` });
    return;
  }

  const stockInfo = quoteService.getStockInfo(symbol);

  res.json({
    ...quote,
    name: stockInfo?.name,
  });
});

// Get stock details
router.get('/:symbol/details', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const quote = quoteService.getQuote(symbol);
  const stockInfo = quoteService.getStockInfo(symbol);

  if (!quote || !stockInfo) {
    res.status(404).json({ error: `Stock not found: ${symbol}` });
    return;
  }

  // In a real app, this would fetch more data from a financial API
  res.json({
    symbol,
    name: stockInfo.name,
    quote,
    // Mock additional data
    marketCap: Math.round(quote.last * 1000000000 * Math.random() * 10),
    peRatio: 15 + Math.random() * 30,
    week52High: quote.last * (1 + Math.random() * 0.3),
    week52Low: quote.last * (1 - Math.random() * 0.3),
    avgVolume: quote.volume * 0.8,
    dividend: Math.random() > 0.5 ? (Math.random() * 3).toFixed(2) : null,
    description: `${stockInfo.name} is a publicly traded company.`,
  });
});

export default router;
