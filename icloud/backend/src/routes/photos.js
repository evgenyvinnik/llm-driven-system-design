import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { pool, minioClient } from '../db.js';
import { broadcastToUser } from '../services/websocket.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max for photos
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const PHOTOS_BUCKET = 'icloud-photos';
const THUMBNAILS_BUCKET = 'icloud-thumbnails';

// List photos
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0, favorite, albumId } = req.query;

    let query = `
      SELECT p.id, p.original_hash, p.thumbnail_key, p.preview_key,
             p.width, p.height, p.taken_at, p.location_lat, p.location_lng,
             p.is_favorite, p.created_at, p.metadata
      FROM photos p
    `;
    const params = [userId];
    let paramIndex = 2;

    if (albumId) {
      query += ` JOIN album_photos ap ON p.id = ap.photo_id WHERE ap.album_id = $${paramIndex++} AND `;
      params.push(albumId);
    } else {
      query += ' WHERE ';
    }

    query += `p.user_id = $1 AND p.is_deleted = FALSE`;

    if (favorite === 'true') {
      query += ' AND p.is_favorite = TRUE';
    }

    query += ` ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC
               LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      photos: result.rows.map(p => ({
        id: p.id,
        thumbnailUrl: `/api/v1/photos/${p.id}/thumbnail`,
        previewUrl: `/api/v1/photos/${p.id}/preview`,
        width: p.width,
        height: p.height,
        takenAt: p.taken_at,
        location: p.location_lat && p.location_lng
          ? { lat: parseFloat(p.location_lat), lng: parseFloat(p.location_lng) }
          : null,
        isFavorite: p.is_favorite,
        createdAt: p.created_at,
        metadata: p.metadata,
      })),
      hasMore: result.rows.length === parseInt(limit),
    });
  } catch (error) {
    console.error('List photos error:', error);
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

// Upload photo
router.post('/upload', upload.single('photo'), async (req, res) => {
  try {
    const userId = req.user.id;
    const photo = req.file;

    if (!photo) {
      return res.status(400).json({ error: 'No photo provided' });
    }

    // Calculate hash
    const originalHash = crypto.createHash('sha256').update(photo.buffer).digest('hex');

    // Check for duplicate
    const existing = await pool.query(
      'SELECT id FROM photos WHERE user_id = $1 AND original_hash = $2 AND is_deleted = FALSE',
      [userId, originalHash]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Photo already exists',
        photoId: existing.rows[0].id,
      });
    }

    // Get image metadata
    const metadata = await sharp(photo.buffer).metadata();

    // Generate derivatives
    const thumbnail = await sharp(photo.buffer)
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer();

    const preview = await sharp(photo.buffer)
      .resize(1024, 1024, { fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Store in MinIO
    const photoId = uuidv4();
    const fullResKey = `full/${userId}/${photoId}`;
    const thumbnailKey = `thumb/${userId}/${photoId}`;
    const previewKey = `preview/${userId}/${photoId}`;

    await Promise.all([
      minioClient.putObject(PHOTOS_BUCKET, fullResKey, photo.buffer, photo.size, {
        'Content-Type': photo.mimetype,
      }),
      minioClient.putObject(THUMBNAILS_BUCKET, thumbnailKey, thumbnail, thumbnail.length, {
        'Content-Type': 'image/jpeg',
      }),
      minioClient.putObject(THUMBNAILS_BUCKET, previewKey, preview, preview.length, {
        'Content-Type': 'image/jpeg',
      }),
    ]);

    // Extract EXIF data
    let takenAt = null;
    let locationLat = null;
    let locationLng = null;
    let cameraMake = null;
    let cameraModel = null;

    // Try to parse EXIF from metadata
    if (metadata.exif) {
      try {
        // Sharp provides basic EXIF info
        // For full EXIF, you would use a dedicated library
      } catch (e) {
        console.log('EXIF parsing skipped');
      }
    }

    // Insert into database
    const result = await pool.query(
      `INSERT INTO photos (id, user_id, original_hash, thumbnail_key, preview_key, full_res_key,
                           width, height, taken_at, location_lat, location_lng,
                           camera_make, camera_model, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, created_at`,
      [
        photoId, userId, originalHash, thumbnailKey, previewKey, fullResKey,
        metadata.width, metadata.height, takenAt, locationLat, locationLng,
        cameraMake, cameraModel, JSON.stringify({ format: metadata.format, space: metadata.space }),
      ]
    );

    // Update storage used
    await pool.query(
      'UPDATE users SET storage_used = storage_used + $1 WHERE id = $2',
      [photo.size + thumbnail.length + preview.length, userId]
    );

    // Notify other devices
    broadcastToUser(userId, {
      type: 'photo_added',
      photo: { id: photoId },
    });

    res.status(201).json({
      id: photoId,
      thumbnailUrl: `/api/v1/photos/${photoId}/thumbnail`,
      previewUrl: `/api/v1/photos/${photoId}/preview`,
      width: metadata.width,
      height: metadata.height,
      createdAt: result.rows[0].created_at,
    });
  } catch (error) {
    console.error('Upload photo error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// Get thumbnail
router.get('/:photoId/thumbnail', async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;

    const photo = await pool.query(
      'SELECT thumbnail_key FROM photos WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [photoId, userId]
    );

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const stream = await minioClient.getObject(THUMBNAILS_BUCKET, photo.rows[0].thumbnail_key);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    stream.pipe(res);
  } catch (error) {
    console.error('Get thumbnail error:', error);
    res.status(500).json({ error: 'Failed to get thumbnail' });
  }
});

// Get preview
router.get('/:photoId/preview', async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;

    const photo = await pool.query(
      'SELECT preview_key FROM photos WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [photoId, userId]
    );

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const stream = await minioClient.getObject(THUMBNAILS_BUCKET, photo.rows[0].preview_key);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
  } catch (error) {
    console.error('Get preview error:', error);
    res.status(500).json({ error: 'Failed to get preview' });
  }
});

// Get full resolution
router.get('/:photoId/full', async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;
    const deviceId = req.deviceId;

    const photo = await pool.query(
      'SELECT full_res_key, original_hash FROM photos WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
      [photoId, userId]
    );

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Update device photo state
    if (deviceId) {
      await pool.query(
        `INSERT INTO device_photos (device_id, photo_id, has_full_res, last_viewed, downloaded_at)
         VALUES ($1, $2, TRUE, NOW(), NOW())
         ON CONFLICT (device_id, photo_id) DO UPDATE
         SET has_full_res = TRUE, last_viewed = NOW(), downloaded_at = NOW()`,
        [deviceId, photoId]
      );
    }

    const stream = await minioClient.getObject(PHOTOS_BUCKET, photo.rows[0].full_res_key);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Photo-Hash', photo.rows[0].original_hash);
    stream.pipe(res);
  } catch (error) {
    console.error('Get full resolution error:', error);
    res.status(500).json({ error: 'Failed to get full resolution' });
  }
});

// Toggle favorite
router.post('/:photoId/favorite', async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE photos SET is_favorite = NOT is_favorite, modified_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, is_favorite`,
      [photoId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    broadcastToUser(userId, {
      type: 'photo_updated',
      photo: { id: photoId, isFavorite: result.rows[0].is_favorite },
    });

    res.json({
      id: photoId,
      isFavorite: result.rows[0].is_favorite,
    });
  } catch (error) {
    console.error('Toggle favorite error:', error);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Delete photo
router.delete('/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE photos SET is_deleted = TRUE, modified_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [photoId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    broadcastToUser(userId, {
      type: 'photo_deleted',
      photo: { id: photoId },
    });

    res.json({ message: 'Photo deleted', id: photoId });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// List albums
router.get('/albums', async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT a.id, a.name, a.is_shared, a.created_at, a.updated_at,
              COUNT(ap.photo_id) as photo_count,
              p.thumbnail_key as cover_thumbnail
       FROM albums a
       LEFT JOIN album_photos ap ON a.id = ap.album_id
       LEFT JOIN photos p ON a.cover_photo_id = p.id
       WHERE a.user_id = $1
       GROUP BY a.id, p.thumbnail_key
       ORDER BY a.updated_at DESC`,
      [userId]
    );

    res.json({
      albums: result.rows.map(a => ({
        id: a.id,
        name: a.name,
        isShared: a.is_shared,
        photoCount: parseInt(a.photo_count),
        coverUrl: a.cover_thumbnail ? `/api/v1/photos/albums/${a.id}/cover` : null,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (error) {
    console.error('List albums error:', error);
    res.status(500).json({ error: 'Failed to list albums' });
  }
});

// Create album
router.post('/albums', async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, photoIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Album name is required' });
    }

    const result = await pool.query(
      `INSERT INTO albums (user_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [userId, name]
    );

    const album = result.rows[0];

    // Add photos if provided
    if (photoIds && Array.isArray(photoIds) && photoIds.length > 0) {
      const values = photoIds.map((photoId, i) => `($1, $${i + 2})`).join(', ');
      await pool.query(
        `INSERT INTO album_photos (album_id, photo_id) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [album.id, ...photoIds]
      );

      // Set first photo as cover
      await pool.query(
        'UPDATE albums SET cover_photo_id = $1 WHERE id = $2',
        [photoIds[0], album.id]
      );
    }

    res.status(201).json({
      id: album.id,
      name: album.name,
      createdAt: album.created_at,
    });
  } catch (error) {
    console.error('Create album error:', error);
    res.status(500).json({ error: 'Failed to create album' });
  }
});

// Add photos to album
router.post('/albums/:albumId/photos', async (req, res) => {
  try {
    const userId = req.user.id;
    const { albumId } = req.params;
    const { photoIds } = req.body;

    if (!photoIds || !Array.isArray(photoIds)) {
      return res.status(400).json({ error: 'photoIds array is required' });
    }

    // Verify album belongs to user
    const album = await pool.query(
      'SELECT id FROM albums WHERE id = $1 AND user_id = $2',
      [albumId, userId]
    );

    if (album.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const values = photoIds.map((photoId, i) => `($1, $${i + 2})`).join(', ');
    await pool.query(
      `INSERT INTO album_photos (album_id, photo_id) VALUES ${values}
       ON CONFLICT DO NOTHING`,
      [albumId, ...photoIds]
    );

    await pool.query(
      'UPDATE albums SET updated_at = NOW() WHERE id = $1',
      [albumId]
    );

    res.json({ message: 'Photos added to album', count: photoIds.length });
  } catch (error) {
    console.error('Add photos to album error:', error);
    res.status(500).json({ error: 'Failed to add photos to album' });
  }
});

export default router;
