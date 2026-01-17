/**
 * @fileoverview Developer controller for app management.
 * Handles app creation, updates, publishing, and analytics for developers.
 */

import { Request, Response } from 'express';
import { catalogService } from '../services/catalogService.js';
import { searchService } from '../services/searchService.js';
import { reviewService } from '../services/reviewService.js';
import { uploadFile, getPresignedUploadUrl } from '../config/minio.js';
import { config } from '../config/index.js';
import multer from 'multer';

/** Multer middleware configured for memory storage (files in buffer) */
const upload = multer({ storage: multer.memoryStorage() });

/** Express middleware for single file uploads */
export const uploadMiddleware = upload.single('file');

/**
 * Retrieves all apps belonging to the authenticated developer.
 * GET /api/v1/developer/apps
 */
export async function getDeveloperApps(req: Request, res: Response): Promise<void> {
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const apps = await catalogService.getDeveloperApps(developer.id);
  res.json({ data: apps });
}

/**
 * Creates a new app for the authenticated developer.
 * POST /api/v1/developer/apps
 */
export async function createApp(req: Request, res: Response): Promise<void> {
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const {
    bundleId,
    name,
    description,
    shortDescription,
    keywords,
    categoryId,
    subcategoryId,
    isFree,
    price,
    ageRating,
  } = req.body;

  if (!bundleId || !name || !description) {
    res.status(400).json({ error: 'bundleId, name, and description are required' });
    return;
  }

  // Check if bundle ID already exists
  const existing = await catalogService.getAppByBundleId(bundleId);
  if (existing) {
    res.status(409).json({ error: 'An app with this bundle ID already exists' });
    return;
  }

  const app = await catalogService.createApp(developer.id, {
    bundleId,
    name,
    description,
    shortDescription,
    keywords: keywords || [],
    categoryId,
    subcategoryId,
    isFree: isFree !== false,
    price: price || 0,
    ageRating: ageRating || '4+',
  });

  res.status(201).json({ data: app });
}

/**
 * Updates an existing app's metadata.
 * PUT /api/v1/developer/apps/:id
 */
export async function updateApp(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  // Verify ownership
  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  const {
    name,
    description,
    shortDescription,
    keywords,
    categoryId,
    subcategoryId,
    releaseNotes,
    version,
    sizeBytes,
    ageRating,
    isFree,
    price,
  } = req.body;

  const updated = await catalogService.updateApp(id, {
    name,
    description,
    shortDescription,
    keywords,
    categoryId,
    subcategoryId,
    releaseNotes,
    version,
    sizeBytes,
    ageRating,
    isFree,
    price,
  });

  // Re-index in Elasticsearch if published
  if (updated && updated.status === 'published') {
    await searchService.indexApp(updated);
  }

  res.json({ data: updated });
}

/**
 * Submits an app for review before publishing.
 * POST /api/v1/developer/apps/:id/submit
 */
export async function submitForReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  if (app.status !== 'draft') {
    res.status(400).json({ error: 'Only draft apps can be submitted for review' });
    return;
  }

  const updated = await catalogService.submitAppForReview(id);
  res.json({ data: updated });
}

/**
 * Publishes an approved app to the store.
 * POST /api/v1/developer/apps/:id/publish
 */
export async function publishApp(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  // For demo, allow direct publish from draft
  // In production, this would require approval
  const updated = await catalogService.publishApp(id);

  if (updated) {
    await searchService.indexApp(updated);
  }

  res.json({ data: updated });
}

/**
 * Uploads an app icon.
 * POST /api/v1/developer/apps/:id/icon
 */
export async function uploadIcon(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const objectName = `${id}/icon.png`;
  const url = await uploadFile(
    config.minio.buckets.icons,
    objectName,
    req.file.buffer,
    req.file.mimetype
  );

  await catalogService.updateApp(id, { iconUrl: url });

  res.json({ data: { url } });
}

/**
 * Uploads a screenshot for an app.
 * POST /api/v1/developer/apps/:id/screenshots
 */
export async function uploadScreenshot(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { deviceType = 'iphone' } = req.body;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const timestamp = Date.now();
  const objectName = `${id}/${timestamp}.png`;
  const url = await uploadFile(
    config.minio.buckets.screenshots,
    objectName,
    req.file.buffer,
    req.file.mimetype
  );

  const screenshot = await catalogService.addScreenshot(id, url, deviceType);

  res.json({ data: screenshot });
}

/**
 * Deletes a screenshot from an app.
 * DELETE /api/v1/developer/apps/:id/screenshots/:screenshotId
 */
export async function deleteScreenshot(req: Request, res: Response): Promise<void> {
  const { id, screenshotId } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  await catalogService.deleteScreenshot(screenshotId, id);
  res.json({ success: true });
}

/**
 * Generates a presigned URL for direct file upload to MinIO.
 * GET /api/v1/developer/apps/:id/upload-url
 */
export async function getUploadUrl(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { type, filename } = req.query;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  let bucket: string;
  let objectName: string;

  switch (type) {
    case 'icon':
      bucket = config.minio.buckets.icons;
      objectName = `${id}/icon.png`;
      break;
    case 'screenshot':
      bucket = config.minio.buckets.screenshots;
      objectName = `${id}/${filename || Date.now()}.png`;
      break;
    case 'package':
      bucket = config.minio.buckets.packages;
      objectName = `${id}/${filename || 'app.ipa'}`;
      break;
    default:
      res.status(400).json({ error: 'Invalid upload type' });
      return;
  }

  const url = await getPresignedUploadUrl(bucket, objectName, 3600);
  res.json({ data: { uploadUrl: url, objectName } });
}

/**
 * Retrieves analytics data for an app.
 * GET /api/v1/developer/apps/:id/analytics
 */
export async function getAppAnalytics(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  // Get rating summary
  const ratings = await reviewService.getRatingSummary(id);

  // In production, this would include download trends, revenue, etc.
  res.json({
    data: {
      app: {
        id: app.id,
        name: app.name,
        status: app.status,
      },
      downloads: {
        total: app.downloadCount,
        // Placeholder for trend data
        trend: [],
      },
      ratings,
      revenue: {
        total: app.isFree ? 0 : app.price * app.downloadCount * 0.7, // 70% developer share
        // Placeholder for trend data
        trend: [],
      },
    },
  });
}

/**
 * Retrieves reviews for a developer's app.
 * GET /api/v1/developer/apps/:id/reviews
 */
export async function getAppReviews(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { page = '1', limit = '20' } = req.query;
  const developer = await catalogService.getDeveloperByUserId(req.user!.id);

  if (!developer) {
    res.status(404).json({ error: 'Developer account not found' });
    return;
  }

  const app = await catalogService.getAppById(id);
  if (!app || app.developerId !== developer.id) {
    res.status(404).json({ error: 'App not found' });
    return;
  }

  const reviews = await reviewService.getReviewsForApp(id, {
    page: parseInt(page as string, 10),
    limit: parseInt(limit as string, 10),
    sortBy: 'recent',
  });

  res.json(reviews);
}
