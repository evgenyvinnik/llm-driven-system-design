import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createProduct,
  getUserProducts,
  getProductById,
  updateUserProduct,
  deleteUserProduct,
  getPriceHistory,
  getDailyPrices,
} from '../services/productService.js';
import { authMiddleware } from '../middleware/auth.js';
import { isValidUrl } from '../utils/helpers.js';

/**
 * Product routes for tracking and managing product subscriptions.
 * All routes require authentication. Users can add products to track,
 * configure alert settings, and view price history.
 * @module routes/products
 */
const router = Router();

/** Zod schema for creating a new product subscription */
const createProductSchema = z.object({
  url: z.string().url(),
  target_price: z.number().positive().optional(),
  notify_any_drop: z.boolean().optional(),
});

/** Zod schema for updating product subscription settings */
const updateProductSchema = z.object({
  target_price: z.number().positive().nullable().optional(),
  notify_any_drop: z.boolean().optional(),
});

/** All product routes require authentication */
router.use(authMiddleware);

/**
 * GET / - Retrieves all products the authenticated user is tracking.
 * Returns products with user-specific settings (target price, notification preferences).
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const products = await getUserProducts(req.user!.id);
    res.json({ products });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/**
 * POST / - Adds a new product to track.
 * Creates the product if not already in database, then creates user subscription.
 * Triggers initial scrape for new products.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = createProductSchema.parse(req.body);

    if (!isValidUrl(data.url)) {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    const product = await createProduct(
      data.url,
      req.user!.id,
      data.target_price,
      data.notify_any_drop
    );

    res.status(201).json({ product });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to add product' });
  }
});

/**
 * GET /:productId - Retrieves details for a specific product.
 * Returns product data including current price, status, and metadata.
 */
router.get('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const product = await getProductById(productId);

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    res.json({ product });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

/**
 * PATCH /:productId - Updates user's subscription settings for a product.
 * Allows changing target price and notification preferences.
 */
router.patch('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const data = updateProductSchema.parse(req.body);

    const subscription = await updateUserProduct(req.user!.id, productId, {
      target_price: data.target_price,
      notify_any_drop: data.notify_any_drop,
    });

    if (!subscription) {
      res.status(404).json({ error: 'Product not found or not tracked by you' });
      return;
    }

    res.json({ subscription });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    res.status(500).json({ error: 'Failed to update product' });
  }
});

/**
 * DELETE /:productId - Stops tracking a product.
 * Removes user's subscription but keeps product for other users.
 */
router.delete('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const deleted = await deleteUserProduct(req.user!.id, productId);

    if (!deleted) {
      res.status(404).json({ error: 'Product not found or not tracked by you' });
      return;
    }

    res.json({ message: 'Product removed from tracking' });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

/**
 * GET /:productId/history - Retrieves raw price history for a product.
 * Returns individual price points for detailed charting.
 * Query params: days (default: 90)
 */
router.get('/:productId/history', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { days = '90' } = req.query;

    const numDays = parseInt(days as string, 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - numDays);

    const history = await getPriceHistory(productId, startDate);
    res.json({ history });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

/**
 * GET /:productId/daily - Retrieves aggregated daily price statistics.
 * Returns min/max/avg prices per day using TimescaleDB aggregation.
 * More efficient for long date ranges than raw history.
 * Query params: days (default: 90)
 */
router.get('/:productId/daily', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { days = '90' } = req.query;

    const daily = await getDailyPrices(productId, parseInt(days as string, 10));
    res.json({ daily });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch daily prices' });
  }
});

export default router;
