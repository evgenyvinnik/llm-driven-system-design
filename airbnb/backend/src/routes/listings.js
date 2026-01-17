import { Router } from 'express';
import { query, transaction } from '../db.js';
import { authenticate, requireHost, optionalAuth } from '../middleware/auth.js';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const router = Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads/listings';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mime = allowedTypes.test(file.mimetype);
    if (ext && mime) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  },
});

// Create listing
router.post('/', authenticate, requireHost, async (req, res) => {
  const {
    title,
    description,
    latitude,
    longitude,
    address_line1,
    address_line2,
    city,
    state,
    country,
    postal_code,
    property_type,
    room_type,
    max_guests,
    bedrooms,
    beds,
    bathrooms,
    amenities,
    house_rules,
    price_per_night,
    cleaning_fee,
    instant_book,
    minimum_nights,
    maximum_nights,
    cancellation_policy,
  } = req.body;

  try {
    const result = await query(
      `INSERT INTO listings (
        host_id, title, description, location, address_line1, address_line2,
        city, state, country, postal_code, property_type, room_type,
        max_guests, bedrooms, beds, bathrooms, amenities, house_rules,
        price_per_night, cleaning_fee, instant_book, minimum_nights,
        maximum_nights, cancellation_policy
      ) VALUES (
        $1, $2, $3, ST_MakePoint($4, $5)::geography, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      ) RETURNING *`,
      [
        req.user.id, title, description, longitude, latitude, address_line1,
        address_line2, city, state, country, postal_code, property_type,
        room_type, max_guests, bedrooms, beds, bathrooms, amenities || [],
        house_rules, price_per_night, cleaning_fee || 0, instant_book || false,
        minimum_nights || 1, maximum_nights || 365, cancellation_policy || 'flexible',
      ]
    );

    res.status(201).json({ listing: result.rows[0] });
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

// Get all listings (with basic filters)
router.get('/', optionalAuth, async (req, res) => {
  const { limit = 20, offset = 0, host_id } = req.query;

  try {
    let sql = `
      SELECT l.*,
        ST_X(l.location::geometry) as longitude,
        ST_Y(l.location::geometry) as latitude,
        u.name as host_name, u.avatar_url as host_avatar,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as primary_photo
      FROM listings l
      JOIN users u ON l.host_id = u.id
      WHERE l.is_active = TRUE
    `;
    const params = [];

    if (host_id) {
      params.push(host_id);
      sql += ` AND l.host_id = $${params.length}`;
    }

    params.push(parseInt(limit), parseInt(offset));
    sql += ` ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);
    res.json({ listings: result.rows });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// Get single listing
router.get('/:id', optionalAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const listingResult = await query(
      `SELECT l.*,
        ST_X(l.location::geometry) as longitude,
        ST_Y(l.location::geometry) as latitude,
        u.name as host_name, u.avatar_url as host_avatar, u.bio as host_bio,
        u.is_verified as host_verified, u.created_at as host_since,
        u.response_rate as host_response_rate
      FROM listings l
      JOIN users u ON l.host_id = u.id
      WHERE l.id = $1`,
      [id]
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listingResult.rows[0];

    // Get photos
    const photosResult = await query(
      'SELECT * FROM listing_photos WHERE listing_id = $1 ORDER BY display_order',
      [id]
    );

    // Get reviews
    const reviewsResult = await query(
      `SELECT r.*, u.name as author_name, u.avatar_url as author_avatar
      FROM reviews r
      JOIN users u ON r.author_id = u.id
      JOIN bookings b ON r.booking_id = b.id
      WHERE b.listing_id = $1 AND r.is_public = TRUE AND r.author_type = 'guest'
      ORDER BY r.created_at DESC
      LIMIT 10`,
      [id]
    );

    res.json({
      listing: {
        ...listing,
        photos: photosResult.rows,
        reviews: reviewsResult.rows,
      },
    });
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// Update listing
router.put('/:id', authenticate, requireHost, async (req, res) => {
  const { id } = req.params;

  // Verify ownership
  const ownerCheck = await query(
    'SELECT id FROM listings WHERE id = $1 AND host_id = $2',
    [id, req.user.id]
  );

  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized to update this listing' });
  }

  const {
    title, description, latitude, longitude, address_line1, address_line2,
    city, state, country, postal_code, property_type, room_type,
    max_guests, bedrooms, beds, bathrooms, amenities, house_rules,
    price_per_night, cleaning_fee, instant_book, minimum_nights,
    maximum_nights, cancellation_policy, is_active,
  } = req.body;

  try {
    const result = await query(
      `UPDATE listings SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        location = COALESCE(ST_MakePoint($3, $4)::geography, location),
        address_line1 = COALESCE($5, address_line1),
        address_line2 = COALESCE($6, address_line2),
        city = COALESCE($7, city),
        state = COALESCE($8, state),
        country = COALESCE($9, country),
        postal_code = COALESCE($10, postal_code),
        property_type = COALESCE($11, property_type),
        room_type = COALESCE($12, room_type),
        max_guests = COALESCE($13, max_guests),
        bedrooms = COALESCE($14, bedrooms),
        beds = COALESCE($15, beds),
        bathrooms = COALESCE($16, bathrooms),
        amenities = COALESCE($17, amenities),
        house_rules = COALESCE($18, house_rules),
        price_per_night = COALESCE($19, price_per_night),
        cleaning_fee = COALESCE($20, cleaning_fee),
        instant_book = COALESCE($21, instant_book),
        minimum_nights = COALESCE($22, minimum_nights),
        maximum_nights = COALESCE($23, maximum_nights),
        cancellation_policy = COALESCE($24, cancellation_policy),
        is_active = COALESCE($25, is_active)
      WHERE id = $26
      RETURNING *`,
      [
        title, description, longitude, latitude, address_line1, address_line2,
        city, state, country, postal_code, property_type, room_type,
        max_guests, bedrooms, beds, bathrooms, amenities, house_rules,
        price_per_night, cleaning_fee, instant_book, minimum_nights,
        maximum_nights, cancellation_policy, is_active, id,
      ]
    );

    res.json({ listing: result.rows[0] });
  } catch (error) {
    console.error('Update listing error:', error);
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// Delete listing
router.delete('/:id', authenticate, requireHost, async (req, res) => {
  const { id } = req.params;

  const ownerCheck = await query(
    'SELECT id FROM listings WHERE id = $1 AND host_id = $2',
    [id, req.user.id]
  );

  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized to delete this listing' });
  }

  try {
    await query('DELETE FROM listings WHERE id = $1', [id]);
    res.json({ message: 'Listing deleted' });
  } catch (error) {
    console.error('Delete listing error:', error);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// Upload photos
router.post('/:id/photos', authenticate, requireHost, upload.array('photos', 10), async (req, res) => {
  const { id } = req.params;

  const ownerCheck = await query(
    'SELECT id FROM listings WHERE id = $1 AND host_id = $2',
    [id, req.user.id]
  );

  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const photos = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const url = `/uploads/listings/${file.filename}`;
      const result = await query(
        'INSERT INTO listing_photos (listing_id, url, display_order) VALUES ($1, $2, $3) RETURNING *',
        [id, url, i]
      );
      photos.push(result.rows[0]);
    }
    res.status(201).json({ photos });
  } catch (error) {
    console.error('Upload photos error:', error);
    res.status(500).json({ error: 'Failed to upload photos' });
  }
});

// Delete photo
router.delete('/:id/photos/:photoId', authenticate, requireHost, async (req, res) => {
  const { id, photoId } = req.params;

  const ownerCheck = await query(
    'SELECT l.id FROM listings l JOIN listing_photos p ON p.listing_id = l.id WHERE l.id = $1 AND l.host_id = $2 AND p.id = $3',
    [id, req.user.id, photoId]
  );

  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    await query('DELETE FROM listing_photos WHERE id = $1', [photoId]);
    res.json({ message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// Get availability calendar
router.get('/:id/availability', async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date } = req.query;

  try {
    const result = await query(
      `SELECT * FROM availability_blocks
      WHERE listing_id = $1
      AND start_date <= $3 AND end_date >= $2
      ORDER BY start_date`,
      [id, start_date || new Date().toISOString().split('T')[0], end_date || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]]
    );

    res.json({ availability: result.rows });
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Update availability (block/unblock dates)
router.put('/:id/availability', authenticate, requireHost, async (req, res) => {
  const { id } = req.params;
  const { start_date, end_date, status, price_per_night } = req.body;

  const ownerCheck = await query(
    'SELECT id FROM listings WHERE id = $1 AND host_id = $2',
    [id, req.user.id]
  );

  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    await transaction(async (client) => {
      // Find overlapping blocks
      const overlaps = await client.query(
        `SELECT * FROM availability_blocks
        WHERE listing_id = $1
        AND (start_date, end_date) OVERLAPS ($2::date, $3::date)
        AND status != 'booked'
        ORDER BY start_date`,
        [id, start_date, end_date]
      );

      // Delete overlapping non-booked blocks
      for (const block of overlaps.rows) {
        await client.query('DELETE FROM availability_blocks WHERE id = $1', [block.id]);

        // Recreate portions outside the new range
        if (block.start_date < start_date) {
          await client.query(
            `INSERT INTO availability_blocks (listing_id, start_date, end_date, status, price_per_night)
            VALUES ($1, $2, $3, $4, $5)`,
            [id, block.start_date, start_date, block.status, block.price_per_night]
          );
        }
        if (block.end_date > end_date) {
          await client.query(
            `INSERT INTO availability_blocks (listing_id, start_date, end_date, status, price_per_night)
            VALUES ($1, $2, $3, $4, $5)`,
            [id, end_date, block.end_date, block.status, block.price_per_night]
          );
        }
      }

      // Insert new block
      await client.query(
        `INSERT INTO availability_blocks (listing_id, start_date, end_date, status, price_per_night)
        VALUES ($1, $2, $3, $4, $5)`,
        [id, start_date, end_date, status, price_per_night]
      );
    });

    res.json({ message: 'Availability updated' });
  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// Get host's listings
router.get('/host/my-listings', authenticate, requireHost, async (req, res) => {
  try {
    const result = await query(
      `SELECT l.*,
        ST_X(l.location::geometry) as longitude,
        ST_Y(l.location::geometry) as latitude,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as primary_photo
      FROM listings l
      WHERE l.host_id = $1
      ORDER BY l.created_at DESC`,
      [req.user.id]
    );

    res.json({ listings: result.rows });
  } catch (error) {
    console.error('Get host listings error:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

export default router;
