import { Request, Response } from 'express';
import { catalogService } from '../services/catalogService.js';
import { searchService } from '../services/searchService.js';
import { config } from '../config/index.js';

export async function getCategories(req: Request, res: Response): Promise<void> {
  const categories = await catalogService.getCategories();
  res.json({ data: categories });
}

export async function getCategoryBySlug(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;
  const category = await catalogService.getCategoryBySlug(slug);

  if (!category) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }

  res.json({ data: category });
}

export async function getApps(req: Request, res: Response): Promise<void> {
  const {
    category,
    page = '1',
    limit = '20',
    sortBy = 'downloads',
    priceType,
    minRating,
  } = req.query;

  // If category is provided, get category ID
  let categoryId: string | undefined;
  if (category) {
    const cat = await catalogService.getCategoryBySlug(category as string);
    if (cat) categoryId = cat.id;
  }

  const apps = await catalogService.getApps({
    categoryId,
    page: parseInt(page as string, 10),
    limit: Math.min(parseInt(limit as string, 10), 50),
    sortBy: sortBy as string,
    isFree: priceType === 'free' ? true : priceType === 'paid' ? false : undefined,
    minRating: minRating ? parseFloat(minRating as string) : undefined,
  });

  res.json(apps);
}

export async function getAppById(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const app = await catalogService.getAppById(id);

  if (!app) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  // Get similar apps
  const similar = await searchService.getSimilarApps(id, 6);

  res.json({ data: { ...app, similarApps: similar } });
}

export async function getTopApps(req: Request, res: Response): Promise<void> {
  const { type = 'free', category, limit = '20' } = req.query;

  let categoryId: string | undefined;
  if (category) {
    const cat = await catalogService.getCategoryBySlug(category as string);
    if (cat) categoryId = cat.id;
  }

  const apps = await catalogService.getTopApps({
    rankType: type as 'free' | 'paid' | 'grossing' | 'new',
    categoryId,
    limit: Math.min(parseInt(limit as string, 10), 50),
  });

  res.json({ data: apps });
}

export async function searchApps(req: Request, res: Response): Promise<void> {
  const {
    q = '',
    category,
    priceType = 'all',
    minRating,
    sortBy = 'relevance',
    page = '1',
    limit = '20',
  } = req.query;

  const results = await searchService.search({
    q: q as string,
    category: category as string | undefined,
    priceType: priceType as 'free' | 'paid' | 'all',
    minRating: minRating ? parseFloat(minRating as string) : undefined,
    sortBy: sortBy as 'relevance' | 'rating' | 'downloads' | 'date',
    page: parseInt(page as string, 10),
    limit: Math.min(parseInt(limit as string, 10), 50),
  });

  res.json(results);
}

export async function getSearchSuggestions(req: Request, res: Response): Promise<void> {
  const { q = '' } = req.query;
  const suggestions = await searchService.suggest(q as string, 5);
  res.json({ data: suggestions });
}

export async function downloadApp(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const app = await catalogService.getAppById(id);

  if (!app) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  // Record download
  await catalogService.recordDownload(id, req.user?.id, {
    country: req.headers['cf-ipcountry'] as string,
    deviceType: req.headers['user-agent']?.includes('iPhone') ? 'iphone' : 'other',
  });

  // In a real app, this would return a signed download URL
  // For demo, we just return success
  res.json({
    success: true,
    message: 'Download recorded',
    downloadUrl: `${config.minio.endpoint}:${config.minio.port}/${config.minio.buckets.packages}/${app.bundleId}/${app.version}.ipa`,
  });
}
