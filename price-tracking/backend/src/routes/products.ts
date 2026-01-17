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

const router = Router();

// Validation schemas
const createProductSchema = z.object({
  url: z.string().url(),
  target_price: z.number().positive().optional(),
  notify_any_drop: z.boolean().optional(),
});

const updateProductSchema = z.object({
  target_price: z.number().positive().nullable().optional(),
  notify_any_drop: z.boolean().optional(),
});

// All routes require authentication
router.use(authMiddleware);

// Get user's tracked products
router.get('/', async (req: Request, res: Response) => {
  try {
    const products = await getUserProducts(req.user!.id);
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Add new product to track
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

// Get single product details
router.get('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const product = await getProductById(productId);

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    res.json({ product });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Update product tracking settings
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

// Stop tracking a product
router.delete('/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const deleted = await deleteUserProduct(req.user!.id, productId);

    if (!deleted) {
      res.status(404).json({ error: 'Product not found or not tracked by you' });
      return;
    }

    res.json({ message: 'Product removed from tracking' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

// Get price history for a product
router.get('/:productId/history', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { days = '90' } = req.query;

    const numDays = parseInt(days as string, 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - numDays);

    const history = await getPriceHistory(productId, startDate);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// Get daily price summary
router.get('/:productId/daily', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { days = '90' } = req.query;

    const daily = await getDailyPrices(productId, parseInt(days as string, 10));
    res.json({ daily });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch daily prices' });
  }
});

export default router;
