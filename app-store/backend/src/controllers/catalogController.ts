/**
 * @fileoverview Catalog controller for public app store endpoints.
 * Handles app listing, search, categories, and downloads.
 */

import { Request, Response } from 'express';
import { catalogService } from '../services/catalogService.js';
import { searchService } from '../services/searchService.js';
import { config } from '../config/index.js';

/**
 * Retrieves all top-level categories with subcategories.
 * GET /api/v1/categories
 */
export async function getCategories(req: Request, res: Response): Promise<void> {
  const categories = await catalogService.getCategories();
  res.json({ data: categories });
}

/**
 * Retrieves a single category by its URL slug.
 * GET /api/v1/categories/:slug
 */
export async function getCategoryBySlug(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;
  const category = await catalogService.getCategoryBySlug(slug);

  if (!category) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }

  res.json({ data: category });
}

/**
 * Retrieves a paginated list of apps with optional filtering.
 * GET /api/v1/apps
 * @query category - Filter by category slug
 * @query page - Page number (default: 1)
 * @query limit - Items per page (default: 20, max: 50)
 * @query sortBy - Sort order: downloads, rating, date
 * @query priceType - Filter by price: free, paid, or all
 */
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

/**
 * Retrieves a single app by ID with similar apps.
 * GET /api/v1/apps/:id
 */
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

/**
 * Retrieves top-ranked apps for charts.
 * GET /api/v1/charts
 * @query type - Chart type: free, paid, grossing, new
 * @query category - Optional category slug filter
 * @query limit - Number of apps (default: 20, max: 50)
 */
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

/**
 * Searches apps using full-text search with Elasticsearch.
 * GET /api/v1/search
 * @query q - Search query string
 * @query category - Optional category filter
 * @query priceType - Filter: free, paid, all
 * @query minRating - Minimum rating filter
 * @query sortBy - Sort: relevance, rating, downloads, date
 */
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

/**
 * Provides search autocomplete suggestions.
 * GET /api/v1/search/suggest
 * @query q - Partial search query
 */
export async function getSearchSuggestions(req: Request, res: Response): Promise<void> {
  const { q = '' } = req.query;
  const suggestions = await searchService.suggest(q as string, 5);
  res.json({ data: suggestions });
}

/**
 * Records an app download and returns download URL.
 * POST /api/v1/apps/:id/download
 * @param id - App UUID
 */
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
