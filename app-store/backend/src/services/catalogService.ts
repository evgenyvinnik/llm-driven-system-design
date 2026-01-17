/**
 * @fileoverview Catalog service for app and category management.
 * Handles CRUD operations, rankings, and download tracking.
 */

import { query } from '../config/database.js';
import { cacheGet, cacheSet, cacheDelete } from '../config/redis.js';
import type { App, Category, Screenshot, PaginatedResponse, Developer } from '../types/index.js';
import { publishEvent, QueueConfig } from '../shared/queue.js';
import { logger, logging } from '../shared/logger.js';
import { downloadsTotal } from '../shared/metrics.js';

/** Cache time-to-live in seconds (5 minutes) */
const CACHE_TTL = 300;

/**
 * Maps a database row to an App object.
 * @param row - Raw database row with snake_case columns
 * @returns Typed App object with camelCase properties
 */
function mapAppRow(row: Record<string, unknown>): App {
  return {
    id: row.id as string,
    bundleId: row.bundle_id as string,
    name: row.name as string,
    developerId: row.developer_id as string,
    categoryId: row.category_id as string | null,
    subcategoryId: row.subcategory_id as string | null,
    description: row.description as string | null,
    shortDescription: row.short_description as string | null,
    keywords: (row.keywords as string[]) || [],
    releaseNotes: row.release_notes as string | null,
    version: row.version as string | null,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    ageRating: row.age_rating as string,
    isFree: row.is_free as boolean,
    price: parseFloat(row.price as string) || 0,
    currency: row.currency as string,
    downloadCount: Number(row.download_count) || 0,
    ratingSum: parseFloat(row.rating_sum as string) || 0,
    ratingCount: Number(row.rating_count) || 0,
    averageRating: parseFloat(row.average_rating as string) || 0,
    iconUrl: row.icon_url as string | null,
    status: row.status as App['status'],
    rejectionReason: row.rejection_reason as string | null,
    publishedAt: row.published_at ? new Date(row.published_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Maps a database row to a Category object.
 * @param row - Raw database row
 * @returns Typed Category object
 */
function mapCategoryRow(row: Record<string, unknown>): Category {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: row.description as string | null,
    icon: row.icon as string | null,
    parentId: row.parent_id as string | null,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Maps a database row to a Developer object.
 * @param row - Raw database row
 * @returns Typed Developer object
 */
function mapDeveloperRow(row: Record<string, unknown>): Developer {
  return {
    id: row.id as string,
    userId: row.user_id as string | null,
    name: row.name as string,
    email: row.email as string,
    website: row.website as string | null,
    description: row.description as string | null,
    logoUrl: row.logo_url as string | null,
    verified: row.verified as boolean,
    revenueShare: parseFloat(row.revenue_share as string) || 0.7,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Service class for managing the app catalog.
 * Provides methods for categories, apps, rankings, and download tracking.
 * Uses Redis caching for frequently accessed data.
 */
export class CatalogService {
  /**
   * Retrieves all top-level categories with their subcategories.
   * Results are cached for performance.
   * @returns Array of categories with nested subcategories
   */
  async getCategories(): Promise<Category[]> {
    const cacheKey = 'categories:all';
    const cached = await cacheGet<Category[]>(cacheKey);
    if (cached) return cached;

    const result = await query(`
      SELECT * FROM categories
      WHERE parent_id IS NULL
      ORDER BY sort_order, name
    `);

    const categories = result.rows.map(mapCategoryRow);

    // Get subcategories
    for (const category of categories) {
      const subResult = await query(`
        SELECT * FROM categories
        WHERE parent_id = $1
        ORDER BY sort_order, name
      `, [category.id]);
      category.subcategories = subResult.rows.map(mapCategoryRow);
    }

    await cacheSet(cacheKey, categories, CACHE_TTL);
    return categories;
  }

  /**
   * Finds a category by its URL slug.
   * @param slug - URL-safe category identifier
   * @returns Category or null if not found
   */
  async getCategoryBySlug(slug: string): Promise<Category | null> {
    const result = await query(`SELECT * FROM categories WHERE slug = $1`, [slug]);
    if (result.rows.length === 0) return null;
    return mapCategoryRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Retrieves a paginated list of apps with filtering and sorting.
   * @param options - Query options including category, status, pagination, and sorting
   * @returns Paginated response with apps and pagination metadata
   */
  async getApps(options: {
    categoryId?: string;
    status?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    isFree?: boolean;
    minRating?: number;
  } = {}): Promise<PaginatedResponse<App>> {
    const {
      categoryId,
      status = 'published',
      page = 1,
      limit = 20,
      sortBy = 'downloads',
      isFree,
      minRating,
    } = options;

    const conditions: string[] = ['a.status = $1'];
    const params: unknown[] = [status];
    let paramIndex = 2;

    if (categoryId) {
      conditions.push(`(a.category_id = $${paramIndex} OR a.subcategory_id = $${paramIndex})`);
      params.push(categoryId);
      paramIndex++;
    }

    if (isFree !== undefined) {
      conditions.push(`a.is_free = $${paramIndex}`);
      params.push(isFree);
      paramIndex++;
    }

    if (minRating !== undefined) {
      conditions.push(`a.average_rating >= $${paramIndex}`);
      params.push(minRating);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderClause = 'ORDER BY a.download_count DESC';
    if (sortBy === 'rating') orderClause = 'ORDER BY a.average_rating DESC, a.rating_count DESC';
    if (sortBy === 'date') orderClause = 'ORDER BY a.published_at DESC';
    if (sortBy === 'name') orderClause = 'ORDER BY a.name ASC';

    // Get total count
    const countResult = await query(`SELECT COUNT(*) FROM apps a ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count as string, 10);

    // Get apps
    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await query(`
      SELECT a.*, d.name as developer_name
      FROM apps a
      LEFT JOIN developers d ON a.developer_id = d.id
      ${whereClause}
      ${orderClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    const apps = result.rows.map((row) => {
      const app = mapAppRow(row as Record<string, unknown>);
      if (row.developer_name) {
        app.developer = { name: row.developer_name } as Developer;
      }
      return app;
    });

    return {
      data: apps,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieves a single app by ID with developer, category, and screenshots.
   * Results are cached for performance.
   * @param id - App UUID
   * @returns Complete app data or null if not found
   */
  async getAppById(id: string): Promise<App | null> {
    const cacheKey = `app:${id}`;
    const cached = await cacheGet<App>(cacheKey);
    if (cached) return cached;

    const result = await query(`
      SELECT a.*, d.name as developer_name, d.verified as developer_verified,
             c.name as category_name, c.slug as category_slug
      FROM apps a
      LEFT JOIN developers d ON a.developer_id = d.id
      LEFT JOIN categories c ON a.category_id = c.id
      WHERE a.id = $1
    `, [id]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as Record<string, unknown>;
    const app = mapAppRow(row);

    if (row.developer_name) {
      app.developer = {
        id: app.developerId,
        name: row.developer_name as string,
        verified: row.developer_verified as boolean,
      } as Developer;
    }

    if (row.category_name) {
      app.category = {
        id: app.categoryId!,
        name: row.category_name as string,
        slug: row.category_slug as string,
      } as Category;
    }

    // Get screenshots
    const screenshotResult = await query(`
      SELECT * FROM app_screenshots WHERE app_id = $1 ORDER BY sort_order
    `, [id]);
    app.screenshots = screenshotResult.rows.map((r) => ({
      id: r.id as string,
      appId: r.app_id as string,
      url: r.url as string,
      deviceType: r.device_type as string,
      sortOrder: Number(r.sort_order),
      createdAt: new Date(r.created_at as string),
    }));

    await cacheSet(cacheKey, app, CACHE_TTL);
    return app;
  }

  /**
   * Finds an app by its bundle identifier.
   * @param bundleId - Unique bundle ID (e.g., com.example.app)
   * @returns App or null if not found
   */
  async getAppByBundleId(bundleId: string): Promise<App | null> {
    const result = await query(`SELECT id FROM apps WHERE bundle_id = $1`, [bundleId]);
    if (result.rows.length === 0) return null;
    return this.getAppById(result.rows[0].id as string);
  }

  /**
   * Creates a new app entry for a developer.
   * @param developerId - Developer's UUID
   * @param data - App metadata including bundleId, name, description
   * @returns Newly created app object
   */
  async createApp(developerId: string, data: {
    bundleId: string;
    name: string;
    description: string;
    shortDescription?: string;
    keywords?: string[];
    categoryId?: string;
    subcategoryId?: string;
    isFree?: boolean;
    price?: number;
    ageRating?: string;
  }): Promise<App> {
    const result = await query(`
      INSERT INTO apps (
        bundle_id, name, developer_id, description, short_description,
        keywords, category_id, subcategory_id, is_free, price, age_rating, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
      RETURNING *
    `, [
      data.bundleId,
      data.name,
      developerId,
      data.description,
      data.shortDescription || null,
      data.keywords || [],
      data.categoryId || null,
      data.subcategoryId || null,
      data.isFree !== false,
      data.price || 0,
      data.ageRating || '4+',
    ]);

    return mapAppRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Updates an existing app's metadata.
   * Clears cached data after update.
   * @param appId - App UUID to update
   * @param data - Fields to update
   * @returns Updated app object or null if not found
   */
  async updateApp(appId: string, data: Partial<{
    name: string;
    description: string;
    shortDescription: string;
    keywords: string[];
    categoryId: string;
    subcategoryId: string;
    releaseNotes: string;
    version: string;
    sizeBytes: number;
    ageRating: string;
    isFree: boolean;
    price: number;
    iconUrl: string;
  }>): Promise<App | null> {
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      shortDescription: 'short_description',
      keywords: 'keywords',
      categoryId: 'category_id',
      subcategoryId: 'subcategory_id',
      releaseNotes: 'release_notes',
      version: 'version',
      sizeBytes: 'size_bytes',
      ageRating: 'age_rating',
      isFree: 'is_free',
      price: 'price',
      iconUrl: 'icon_url',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in data) {
        updates.push(`${column} = $${paramIndex}`);
        params.push(data[key as keyof typeof data]);
        paramIndex++;
      }
    }

    if (updates.length === 0) return this.getAppById(appId);

    updates.push('updated_at = NOW()');
    params.push(appId);

    await query(`
      UPDATE apps SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
    `, params);

    await cacheDelete(`app:${appId}`);
    return this.getAppById(appId);
  }

  /**
   * Changes app status to 'pending' for review.
   * Only works for apps in 'draft' status.
   * @param appId - App UUID
   * @returns Updated app or null
   */
  async submitAppForReview(appId: string): Promise<App | null> {
    await query(`
      UPDATE apps SET status = 'pending', updated_at = NOW()
      WHERE id = $1 AND status = 'draft'
    `, [appId]);

    await cacheDelete(`app:${appId}`);
    return this.getAppById(appId);
  }

  /**
   * Publishes an app, making it visible in the store.
   * Works for 'approved' or 'draft' apps (demo mode allows direct publish).
   * @param appId - App UUID
   * @returns Updated app or null
   */
  async publishApp(appId: string): Promise<App | null> {
    await query(`
      UPDATE apps SET status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('approved', 'draft')
    `, [appId]);

    await cacheDelete(`app:${appId}`);
    return this.getAppById(appId);
  }

  /**
   * Adds a screenshot to an app.
   * Automatically assigns sort order based on existing screenshots.
   * @param appId - App UUID
   * @param url - Screenshot URL in MinIO
   * @param deviceType - Device type (e.g., 'iphone', 'ipad')
   * @returns Created screenshot object
   */
  async addScreenshot(appId: string, url: string, deviceType = 'iphone'): Promise<Screenshot> {
    const maxOrder = await query(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order
      FROM app_screenshots WHERE app_id = $1
    `, [appId]);

    const result = await query(`
      INSERT INTO app_screenshots (app_id, url, device_type, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [appId, url, deviceType, maxOrder.rows[0].next_order]);

    await cacheDelete(`app:${appId}`);

    const row = result.rows[0];
    return {
      id: row.id,
      appId: row.app_id,
      url: row.url,
      deviceType: row.device_type,
      sortOrder: row.sort_order,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Removes a screenshot from an app.
   * @param screenshotId - Screenshot UUID
   * @param appId - App UUID (for ownership verification)
   */
  async deleteScreenshot(screenshotId: string, appId: string): Promise<void> {
    await query(`DELETE FROM app_screenshots WHERE id = $1 AND app_id = $2`, [screenshotId, appId]);
    await cacheDelete(`app:${appId}`);
  }

  /**
   * Retrieves all apps belonging to a developer.
   * @param developerId - Developer's UUID
   * @returns Array of apps ordered by creation date (newest first)
   */
  async getDeveloperApps(developerId: string): Promise<App[]> {
    const result = await query(`
      SELECT * FROM apps WHERE developer_id = $1 ORDER BY created_at DESC
    `, [developerId]);

    return result.rows.map((row) => mapAppRow(row as Record<string, unknown>));
  }

  /**
   * Finds a developer account by their associated user ID.
   * @param userId - User's UUID
   * @returns Developer profile or null if not a developer
   */
  async getDeveloperByUserId(userId: string): Promise<Developer | null> {
    const result = await query(`SELECT * FROM developers WHERE user_id = $1`, [userId]);
    if (result.rows.length === 0) return null;
    return mapDeveloperRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Retrieves top-ranked apps based on type (free, paid, grossing, new).
   * Used for homepage charts and category-specific rankings.
   * @param options - Ranking type, optional category filter, and limit
   * @returns Array of apps ordered by ranking criteria
   */
  async getTopApps(options: {
    rankType?: 'free' | 'paid' | 'grossing' | 'new';
    categoryId?: string;
    limit?: number;
  } = {}): Promise<App[]> {
    const { rankType = 'free', categoryId, limit = 20 } = options;

    let whereClause = 'WHERE a.status = $1';
    const params: unknown[] = ['published'];
    let paramIndex = 2;

    if (rankType === 'free') {
      whereClause += ` AND a.is_free = true`;
    } else if (rankType === 'paid') {
      whereClause += ` AND a.is_free = false`;
    }

    if (categoryId) {
      whereClause += ` AND (a.category_id = $${paramIndex} OR a.subcategory_id = $${paramIndex})`;
      params.push(categoryId);
      paramIndex++;
    }

    let orderClause = 'ORDER BY a.download_count DESC';
    if (rankType === 'grossing') {
      orderClause = 'ORDER BY a.price * a.download_count DESC';
    } else if (rankType === 'new') {
      orderClause = 'ORDER BY a.published_at DESC';
    }

    params.push(limit);

    const result = await query(`
      SELECT a.*, d.name as developer_name
      FROM apps a
      LEFT JOIN developers d ON a.developer_id = d.id
      ${whereClause}
      ${orderClause}
      LIMIT $${paramIndex}
    `, params);

    return result.rows.map((row) => {
      const app = mapAppRow(row as Record<string, unknown>);
      if (row.developer_name) {
        app.developer = { name: row.developer_name } as Developer;
      }
      return app;
    });
  }

  /**
   * Records an app download and updates analytics.
   * Increments download count, creates download event, and updates user library.
   * Publishes download event to RabbitMQ for async processing.
   * @param appId - App UUID that was downloaded
   * @param userId - Optional user UUID if logged in
   * @param metadata - Optional download context (version, country, device)
   */
  async recordDownload(appId: string, userId?: string, metadata?: {
    version?: string;
    country?: string;
    deviceType?: string;
  }): Promise<void> {
    const startTime = Date.now();

    try {
      // Update download count (eventual consistency is acceptable)
      await query(`
        UPDATE apps SET download_count = download_count + 1, updated_at = NOW()
        WHERE id = $1
      `, [appId]);

      // Record download event in database
      const downloadResult = await query(`
        INSERT INTO download_events (app_id, user_id, version, country, device_type)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [appId, userId || null, metadata?.version || null, metadata?.country || null, metadata?.deviceType || null]);

      const downloadId = downloadResult.rows[0]?.id;

      // Update user_apps if user is logged in
      if (userId) {
        await query(`
          INSERT INTO user_apps (user_id, app_id, download_count, last_downloaded_at)
          VALUES ($1, $2, 1, NOW())
          ON CONFLICT (user_id, app_id)
          DO UPDATE SET download_count = user_apps.download_count + 1, last_downloaded_at = NOW()
        `, [userId, appId]);
      }

      // Publish download event to RabbitMQ for async processing
      // (analytics, recommendations update, etc.)
      const eventPublished = await publishEvent(QueueConfig.routingKeys.downloadCreated, {
        downloadId,
        appId,
        userId: userId || null,
        version: metadata?.version || null,
        country: metadata?.country || null,
        deviceType: metadata?.deviceType || null,
        timestamp: new Date().toISOString(),
      });

      if (!eventPublished) {
        logger.warn({ appId, userId }, 'Failed to publish download event to queue');
      }

      // Update metrics
      const app = await this.getAppById(appId);
      if (app) {
        downloadsTotal.inc({ app_id: appId, is_free: app.isFree ? 'true' : 'false' });
      }

      // Log business event
      logging.businessEvent('download', {
        appId,
        userId,
        country: metadata?.country,
        deviceType: metadata?.deviceType,
        durationMs: Date.now() - startTime,
      });

      await cacheDelete(`app:${appId}`);
    } catch (error) {
      logger.error({
        appId,
        userId,
        error: (error as Error).message,
      }, 'Failed to record download');
      throw error;
    }
  }
}

/** Singleton instance of the catalog service */
export const catalogService = new CatalogService();
