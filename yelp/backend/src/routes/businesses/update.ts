/**
 * Business update route handler.
 * @module routes/businesses/update
 */
import { Router, Response } from 'express';
import { pool } from '../../utils/db.js';
import { cache } from '../../utils/redis.js';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.js';
import { publishBusinessReindex } from '../../utils/queue.js';
import { BusinessRow, OwnerCheckRow, UpdateBusinessBody } from './types.js';

/**
 * Express router for business update endpoints.
 */
export const router = Router();

/**
 * Updates an existing business.
 *
 * @description
 * Updates business information for the specified business ID.
 * Only the business owner or an admin can update a business.
 * Supports partial updates - only provided fields are modified.
 * After updating, clears the cache and publishes an event for Elasticsearch reindexing.
 *
 * @route PATCH /:id
 *
 * @param req.params.id - Business UUID
 * @param req.body.name - Updated business name
 * @param req.body.description - Updated description
 * @param req.body.address - Updated street address
 * @param req.body.city - Updated city
 * @param req.body.state - Updated state/province
 * @param req.body.zip_code - Updated postal code
 * @param req.body.phone - Updated phone number
 * @param req.body.website - Updated website URL
 * @param req.body.email - Updated email address
 * @param req.body.price_level - Updated price level (1-4)
 * @param req.body.latitude - Updated geographic latitude
 * @param req.body.longitude - Updated geographic longitude
 * @param req.body.categories - Updated array of category IDs
 *
 * @returns {Object} JSON object containing the updated business
 * @returns {BusinessRow} response.business - The updated business
 *
 * @throws {400} No updates provided
 * @throws {401} User not authenticated
 * @throws {403} User not authorized (not owner or admin)
 * @throws {404} Business not found
 * @throws {500} Database or server error
 *
 * @example
 * // PATCH /businesses/550e8400-e29b-41d4-a716-446655440000
 * // Request body
 * {
 *   "name": "Joe's Coffee - Downtown",
 *   "phone": "(555) 123-4567"
 * }
 */
router.patch(
  '/:id',
  authenticate as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const paramId = req.params.id;
      const id = Array.isArray(paramId) ? paramId[0] : paramId;
      const body = req.body as UpdateBusinessBody;

      // Check ownership
      const ownerCheck = await pool.query<OwnerCheckRow>(
        'SELECT owner_id FROM businesses WHERE id = $1',
        [id]
      );

      if (ownerCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Business not found' } });
      }

      if (
        ownerCheck.rows[0].owner_id !== req.user!.id &&
        req.user!.role !== 'admin'
      ) {
        return res
          .status(403)
          .json({ error: { message: 'Not authorized to update this business' } });
      }

      const allowedFields = [
        'name',
        'description',
        'address',
        'city',
        'state',
        'zip_code',
        'phone',
        'website',
        'email',
        'price_level',
        'latitude',
        'longitude',
      ];
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if ((body as Record<string, unknown>)[field] !== undefined) {
          updates.push(`${field} = $${paramIndex++}`);
          values.push((body as Record<string, unknown>)[field]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: { message: 'No updates provided' } });
      }

      values.push(id);

      const result = await pool.query<BusinessRow>(
        `UPDATE businesses SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex}
       RETURNING *`,
        values
      );

      const business = result.rows[0];

      // Update categories if provided
      if (body.categories) {
        await pool.query('DELETE FROM business_categories WHERE business_id = $1', [
          id,
        ]);
        if (body.categories.length > 0) {
          const categoryValues = body.categories
            .map((_, index) => `($1, $${index + 2})`)
            .join(', ');
          await pool.query(
            `INSERT INTO business_categories (business_id, category_id) VALUES ${categoryValues}`,
            [id, ...body.categories]
          );
        }
      }

      // Publish to queue for async Elasticsearch reindex
      publishBusinessReindex(id);

      // Clear cache
      await cache.delPattern(`business:${id}*`);
      await cache.delPattern(`business:${business.slug}*`);

      res.json({ business });
    } catch (error) {
      console.error('Update business error:', error);
      res.status(500).json({ error: { message: 'Failed to update business' } });
    }
  }
);
