/**
 * Business action route handlers.
 * Handles business hours, photos, and claim operations.
 * @module routes/businesses/actions
 */
import { Router, Response } from 'express';
import { pool } from '../../utils/db.js';
import { cache } from '../../utils/redis.js';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.js';
import {
  BusinessPhoto,
  OwnerCheckRow,
  ClaimCheckRow,
  AddHoursBody,
  AddPhotoBody,
} from './types.js';

/**
 * Express router for business action endpoints.
 */
export const router = Router();

/**
 * Adds or updates business hours.
 *
 * @description
 * Sets the operating hours for a business. Replaces all existing hours
 * with the provided schedule. Only the business owner or an admin can
 * update hours. Clears the cache after updating.
 *
 * @route POST /:id/hours
 *
 * @param req.params.id - Business UUID
 * @param req.body.hours - Array of operating hours for each day
 * @param req.body.hours[].day_of_week - Day of the week (0 = Sunday, 6 = Saturday)
 * @param req.body.hours[].open_time - Opening time in HH:MM format
 * @param req.body.hours[].close_time - Closing time in HH:MM format
 * @param req.body.hours[].is_closed - Whether closed on this day (default: false)
 *
 * @returns {Object} JSON object with success message
 * @returns {string} response.message - "Hours updated successfully"
 *
 * @throws {401} User not authenticated
 * @throws {403} User not authorized (not owner or admin)
 * @throws {404} Business not found
 * @throws {500} Database or server error
 *
 * @example
 * // POST /businesses/550e8400-e29b-41d4-a716-446655440000/hours
 * // Request body
 * {
 *   "hours": [
 *     { "day_of_week": 0, "open_time": "09:00", "close_time": "17:00", "is_closed": false },
 *     { "day_of_week": 1, "open_time": "08:00", "close_time": "18:00", "is_closed": false }
 *   ]
 * }
 */
router.post(
  '/:id/hours',
  authenticate as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const { id } = req.params;
      const { hours } = req.body as AddHoursBody;

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
        return res.status(403).json({ error: { message: 'Not authorized' } });
      }

      // Delete existing hours and insert new ones
      await pool.query('DELETE FROM business_hours WHERE business_id = $1', [id]);

      for (const hour of hours) {
        await pool.query(
          `INSERT INTO business_hours (business_id, day_of_week, open_time, close_time, is_closed)
         VALUES ($1, $2, $3, $4, $5)`,
          [id, hour.day_of_week, hour.open_time, hour.close_time, hour.is_closed || false]
        );
      }

      // Clear cache
      await cache.delPattern(`business:${id}*`);

      res.json({ message: 'Hours updated successfully' });
    } catch (error) {
      console.error('Update hours error:', error);
      res.status(500).json({ error: { message: 'Failed to update hours' } });
    }
  }
);

/**
 * Adds a photo to a business.
 *
 * @description
 * Uploads a photo URL to the specified business. Any authenticated user can
 * add photos. If `is_primary` is true, all other photos are unmarked as primary.
 * Updates the business photo count and clears the cache.
 *
 * @route POST /:id/photos
 *
 * @param req.params.id - Business UUID
 * @param req.body.url - URL of the photo (required)
 * @param req.body.caption - Optional caption for the photo
 * @param req.body.is_primary - Whether this should be the primary photo (default: false)
 *
 * @returns {Object} JSON object containing the created photo
 * @returns {BusinessPhoto} response.photo - The newly created photo object
 * @returns {string} response.photo.id - Photo UUID
 * @returns {string} response.photo.url - Photo URL
 * @returns {string} response.photo.caption - Photo caption
 * @returns {boolean} response.photo.is_primary - Whether this is the primary photo
 *
 * @throws {400} Photo URL is required
 * @throws {401} User not authenticated
 * @throws {404} Business not found
 * @throws {500} Database or server error
 *
 * @example
 * // POST /businesses/550e8400-e29b-41d4-a716-446655440000/photos
 * // Request body
 * {
 *   "url": "https://example.com/photos/storefront.jpg",
 *   "caption": "Our beautiful storefront",
 *   "is_primary": true
 * }
 */
router.post(
  '/:id/photos',
  authenticate as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const { id } = req.params;
      const { url, caption, is_primary = false } = req.body as AddPhotoBody;

      if (!url) {
        return res.status(400).json({ error: { message: 'Photo URL is required' } });
      }

      // Check if business exists
      const businessCheck = await pool.query<{ id: string }>(
        'SELECT id FROM businesses WHERE id = $1',
        [id]
      );
      if (businessCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Business not found' } });
      }

      // If setting as primary, unset other primary photos
      if (is_primary) {
        await pool.query(
          'UPDATE business_photos SET is_primary = false WHERE business_id = $1',
          [id]
        );
      }

      const result = await pool.query<BusinessPhoto & { uploaded_by: string; created_at: string }>(
        `INSERT INTO business_photos (business_id, url, caption, is_primary, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
        [id, url, caption, is_primary, req.user!.id]
      );

      // Update photo count
      await pool.query(
        'UPDATE businesses SET photo_count = photo_count + 1 WHERE id = $1',
        [id]
      );

      // Clear cache
      await cache.delPattern(`business:${id}*`);

      res.status(201).json({ photo: result.rows[0] });
    } catch (error) {
      console.error('Add photo error:', error);
      res.status(500).json({ error: { message: 'Failed to add photo' } });
    }
  }
);

/**
 * Claims ownership of a business.
 *
 * @description
 * Allows an authenticated user to claim an unclaimed business as their own.
 * Sets the user as the business owner and updates their role to 'business_owner'
 * if they were previously a regular user. Only unclaimed businesses can be claimed.
 *
 * @route POST /:id/claim
 *
 * @param req.params.id - Business UUID
 *
 * @returns {Object} JSON object with success message
 * @returns {string} response.message - "Business claimed successfully"
 *
 * @throws {401} User not authenticated
 * @throws {404} Business not found
 * @throws {409} Business already claimed by another user
 * @throws {500} Database or server error
 *
 * @example
 * // POST /businesses/550e8400-e29b-41d4-a716-446655440000/claim
 */
router.post(
  '/:id/claim',
  authenticate as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const { id } = req.params;

      const result = await pool.query<ClaimCheckRow>(
        'SELECT is_claimed, owner_id FROM businesses WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Business not found' } });
      }

      if (result.rows[0].is_claimed) {
        return res
          .status(409)
          .json({ error: { message: 'Business already claimed' } });
      }

      await pool.query(
        'UPDATE businesses SET is_claimed = true, owner_id = $1 WHERE id = $2',
        [req.user!.id, id]
      );

      // Update user role
      if (req.user!.role === 'user') {
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [
          'business_owner',
          req.user!.id,
        ]);
      }

      res.json({ message: 'Business claimed successfully' });
    } catch (error) {
      console.error('Claim business error:', error);
      res.status(500).json({ error: { message: 'Failed to claim business' } });
    }
  }
);
