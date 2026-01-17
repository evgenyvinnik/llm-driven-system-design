import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getNearbyMerchants,
  getMerchantById,
  getMerchantMenu,
  searchMerchants,
  getCategories,
} from '../services/merchantService.js';

const router = Router();

// Get all categories
router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const categories = await getCategories();

    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get categories',
    });
  }
});

// Search merchants
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, lat, lng, radius } = req.query;

    if (!q) {
      res.status(400).json({
        success: false,
        error: 'Search query (q) is required',
      });
      return;
    }

    const location = lat && lng
      ? { lat: parseFloat(lat as string), lng: parseFloat(lng as string) }
      : undefined;

    const merchants = await searchMerchants(
      q as string,
      location,
      radius ? parseFloat(radius as string) : 10
    );

    res.json({
      success: true,
      data: merchants,
    });
  } catch (error) {
    console.error('Search merchants error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search merchants',
    });
  }
});

// Get nearby merchants
router.get('/', async (req: Request, res: Response) => {
  try {
    const { lat, lng, radius, category } = req.query;

    if (!lat || !lng) {
      res.status(400).json({
        success: false,
        error: 'Latitude and longitude are required',
      });
      return;
    }

    const location = {
      lat: parseFloat(lat as string),
      lng: parseFloat(lng as string),
    };

    const merchants = await getNearbyMerchants(
      location,
      radius ? parseFloat(radius as string) : 10,
      category as string | undefined
    );

    res.json({
      success: true,
      data: merchants,
    });
  } catch (error) {
    console.error('Get merchants error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get merchants',
    });
  }
});

// Get merchant by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const merchant = await getMerchantById(req.params.id);

    if (!merchant) {
      res.status(404).json({
        success: false,
        error: 'Merchant not found',
      });
      return;
    }

    res.json({
      success: true,
      data: merchant,
    });
  } catch (error) {
    console.error('Get merchant error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get merchant',
    });
  }
});

// Get merchant menu
router.get('/:id/menu', async (req: Request, res: Response) => {
  try {
    const merchant = await getMerchantById(req.params.id);

    if (!merchant) {
      res.status(404).json({
        success: false,
        error: 'Merchant not found',
      });
      return;
    }

    const menu = await getMerchantMenu(req.params.id);

    res.json({
      success: true,
      data: {
        merchant,
        menu,
      },
    });
  } catch (error) {
    console.error('Get menu error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get menu',
    });
  }
});

export default router;
