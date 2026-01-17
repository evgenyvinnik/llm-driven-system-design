import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { getAllProducts, getProductsToScrape } from '../services/productService.js';
import { getScraperConfigs, updateScraperConfig, createScraperConfig } from '../services/scraperService.js';
import { query } from '../db/pool.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authMiddleware, adminMiddleware);

// Dashboard stats
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const [
      userCount,
      productCount,
      alertCount,
      pricePointCount,
    ] = await Promise.all([
      query<{ count: number }>('SELECT COUNT(*)::integer as count FROM users'),
      query<{ count: number }>('SELECT COUNT(*)::integer as count FROM products'),
      query<{ count: number }>('SELECT COUNT(*)::integer as count FROM alerts WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      query<{ count: number }>('SELECT COUNT(*)::integer as count FROM price_history WHERE recorded_at > NOW() - INTERVAL \'24 hours\''),
    ]);

    // Get products by status
    const productsByStatus = await query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::integer as count
       FROM products
       GROUP BY status`
    );

    // Get scrape stats
    const scrapeStats = await query<{ domain: string; count: number }>(
      `SELECT domain, COUNT(*)::integer as count
       FROM products
       WHERE last_scraped > NOW() - INTERVAL '24 hours'
       GROUP BY domain
       ORDER BY count DESC
       LIMIT 10`
    );

    res.json({
      users: userCount[0]?.count || 0,
      products: productCount[0]?.count || 0,
      alertsToday: alertCount[0]?.count || 0,
      pricePointsToday: pricePointCount[0]?.count || 0,
      productsByStatus,
      recentScrapesByDomain: scrapeStats,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all products (admin view)
router.get('/products', async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '50', status } = req.query;
    const result = await getAllProducts(
      parseInt(page as string, 10),
      parseInt(limit as string, 10),
      status as string | undefined
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get products pending scrape
router.get('/scrape-queue', async (req: Request, res: Response) => {
  try {
    const { limit = '50' } = req.query;
    const products = await getProductsToScrape(parseInt(limit as string, 10));
    res.json({ products, count: products.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch scrape queue' });
  }
});

// Get scraper configurations
router.get('/scraper-configs', async (req: Request, res: Response) => {
  try {
    const configs = await getScraperConfigs();
    res.json({ configs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch scraper configs' });
  }
});

// Update scraper configuration
router.patch('/scraper-configs/:domain', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;
    const config = await updateScraperConfig(domain, req.body);

    if (!config) {
      res.status(404).json({ error: 'Scraper config not found' });
      return;
    }

    res.json({ config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update scraper config' });
  }
});

// Create new scraper configuration
router.post('/scraper-configs', async (req: Request, res: Response) => {
  try {
    const config = await createScraperConfig(req.body);
    if (!config) {
      res.status(400).json({ error: 'Failed to create scraper config' });
      return;
    }
    res.status(201).json({ config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create scraper config' });
  }
});

// Get recent price changes
router.get('/price-changes', async (req: Request, res: Response) => {
  try {
    const { hours = '24', limit = '50' } = req.query;

    const changes = await query(
      `SELECT
         p.id,
         p.title,
         p.url,
         p.current_price,
         ph1.price as previous_price,
         ph2.price as new_price,
         ph2.recorded_at
       FROM products p
       JOIN LATERAL (
         SELECT price, recorded_at
         FROM price_history
         WHERE product_id = p.id
         ORDER BY recorded_at DESC
         LIMIT 1
       ) ph2 ON true
       JOIN LATERAL (
         SELECT price
         FROM price_history
         WHERE product_id = p.id AND recorded_at < ph2.recorded_at
         ORDER BY recorded_at DESC
         LIMIT 1
       ) ph1 ON true
       WHERE ph2.recorded_at > NOW() - INTERVAL '${hours} hours'
         AND ph1.price != ph2.price
       ORDER BY ph2.recorded_at DESC
       LIMIT $1`,
      [parseInt(limit as string, 10)]
    );

    res.json({ changes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price changes' });
  }
});

export default router;
