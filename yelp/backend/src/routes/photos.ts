import express from 'express';
import multer from 'multer';
import { uploadPhoto, deletePhoto } from '../utils/storage.js';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for memory storage (we'll upload to MinIO)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only images
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// Upload a business photo
router.post('/business/:businessId', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const { businessId } = req.params;
    const { caption, is_primary } = req.body;
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: { message: 'No photo file provided' } });
    }

    // Check business exists
    const businessCheck = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
    if (businessCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    // Upload to MinIO
    const url = await uploadPhoto(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'business'
    );

    // If setting as primary, unset other primary photos
    if (is_primary === 'true' || is_primary === true) {
      await pool.query(
        'UPDATE business_photos SET is_primary = false WHERE business_id = $1',
        [businessId]
      );
    }

    // Insert into database
    const result = await pool.query(
      `INSERT INTO business_photos (business_id, url, caption, is_primary, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, url, caption || null, is_primary === 'true' || is_primary === true, userId]
    );

    // Update photo count
    await pool.query(
      'UPDATE businesses SET photo_count = photo_count + 1 WHERE id = $1',
      [businessId]
    );

    res.status(201).json({ photo: result.rows[0] });
  } catch (error) {
    console.error('Upload business photo error:', error);
    res.status(500).json({ error: { message: 'Failed to upload photo' } });
  }
});

// Upload a review photo
router.post('/review/:reviewId', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { caption } = req.body;
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: { message: 'No photo file provided' } });
    }

    // Check review exists and belongs to user
    const reviewCheck = await pool.query(
      'SELECT id, user_id FROM reviews WHERE id = $1',
      [reviewId]
    );
    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }
    if (reviewCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ error: { message: 'Not authorized to add photos to this review' } });
    }

    // Upload to MinIO
    const url = await uploadPhoto(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'review'
    );

    // Insert into database
    const result = await pool.query(
      'INSERT INTO review_photos (review_id, url, caption) VALUES ($1, $2, $3) RETURNING *',
      [reviewId, url, caption || null]
    );

    res.status(201).json({ photo: result.rows[0] });
  } catch (error) {
    console.error('Upload review photo error:', error);
    res.status(500).json({ error: { message: 'Failed to upload photo' } });
  }
});

// Delete a business photo
router.delete('/business/:photoId', authenticate, async (req, res) => {
  try {
    const { photoId } = req.params;

    // Get photo URL before deleting
    const photoResult = await pool.query(
      'SELECT url, business_id FROM business_photos WHERE id = $1',
      [photoId]
    );

    if (photoResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Photo not found' } });
    }

    const { url, business_id } = photoResult.rows[0];

    // Delete from MinIO (only if it's a MinIO URL)
    if (url.includes('localhost:9000') || url.includes('minio')) {
      try {
        await deletePhoto(url);
      } catch (err) {
        console.warn('Failed to delete from MinIO:', err.message);
      }
    }

    // Delete from database
    await pool.query('DELETE FROM business_photos WHERE id = $1', [photoId]);

    // Update photo count
    await pool.query(
      'UPDATE businesses SET photo_count = photo_count - 1 WHERE id = $1',
      [business_id]
    );

    res.json({ message: 'Photo deleted successfully' });
  } catch (error) {
    console.error('Delete business photo error:', error);
    res.status(500).json({ error: { message: 'Failed to delete photo' } });
  }
});

// Delete a review photo
router.delete('/review/:photoId', authenticate, async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;

    // Get photo and verify ownership
    const photoResult = await pool.query(
      `SELECT rp.url, r.user_id
       FROM review_photos rp
       JOIN reviews r ON rp.review_id = r.id
       WHERE rp.id = $1`,
      [photoId]
    );

    if (photoResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Photo not found' } });
    }

    if (photoResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: { message: 'Not authorized to delete this photo' } });
    }

    const { url } = photoResult.rows[0];

    // Delete from MinIO (only if it's a MinIO URL)
    if (url.includes('localhost:9000') || url.includes('minio')) {
      try {
        await deletePhoto(url);
      } catch (err) {
        console.warn('Failed to delete from MinIO:', err.message);
      }
    }

    // Delete from database
    await pool.query('DELETE FROM review_photos WHERE id = $1', [photoId]);

    res.json({ message: 'Photo deleted successfully' });
  } catch (error) {
    console.error('Delete review photo error:', error);
    res.status(500).json({ error: { message: 'Failed to delete photo' } });
  }
});

export default router;
