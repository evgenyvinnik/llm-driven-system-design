import { Router } from 'express';
import { query } from '../db.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

// Search listings with geographic filter and availability
router.get('/', optionalAuth, async (req, res) => {
  const {
    latitude,
    longitude,
    radius = 25000, // 25km default
    check_in,
    check_out,
    guests = 1,
    min_price,
    max_price,
    property_type,
    room_type,
    amenities,
    instant_book,
    bedrooms,
    beds,
    bathrooms,
    limit = 20,
    offset = 0,
    sort = 'relevance',
  } = req.query;

  try {
    let params = [];
    let conditions = ['l.is_active = TRUE'];
    let orderBy = 'l.rating DESC NULLS LAST, l.review_count DESC';

    // Geographic filter
    if (latitude && longitude) {
      params.push(parseFloat(longitude), parseFloat(latitude), parseInt(radius));
      conditions.push(`ST_DWithin(l.location, ST_MakePoint($${params.length - 2}, $${params.length - 1})::geography, $${params.length})`);
    }

    // Guest count
    params.push(parseInt(guests));
    conditions.push(`l.max_guests >= $${params.length}`);

    // Price range
    if (min_price) {
      params.push(parseFloat(min_price));
      conditions.push(`l.price_per_night >= $${params.length}`);
    }
    if (max_price) {
      params.push(parseFloat(max_price));
      conditions.push(`l.price_per_night <= $${params.length}`);
    }

    // Property type
    if (property_type) {
      params.push(property_type);
      conditions.push(`l.property_type = $${params.length}`);
    }

    // Room type
    if (room_type) {
      params.push(room_type);
      conditions.push(`l.room_type = $${params.length}`);
    }

    // Amenities
    if (amenities) {
      const amenityList = Array.isArray(amenities) ? amenities : amenities.split(',');
      params.push(amenityList);
      conditions.push(`l.amenities @> $${params.length}`);
    }

    // Instant book
    if (instant_book === 'true') {
      conditions.push('l.instant_book = TRUE');
    }

    // Bedrooms
    if (bedrooms) {
      params.push(parseInt(bedrooms));
      conditions.push(`l.bedrooms >= $${params.length}`);
    }

    // Beds
    if (beds) {
      params.push(parseInt(beds));
      conditions.push(`l.beds >= $${params.length}`);
    }

    // Bathrooms
    if (bathrooms) {
      params.push(parseFloat(bathrooms));
      conditions.push(`l.bathrooms >= $${params.length}`);
    }

    // Build the base query
    let sql = `
      SELECT
        l.id,
        l.title,
        l.description,
        l.city,
        l.state,
        l.country,
        l.property_type,
        l.room_type,
        l.max_guests,
        l.bedrooms,
        l.beds,
        l.bathrooms,
        l.amenities,
        l.price_per_night,
        l.cleaning_fee,
        l.rating,
        l.review_count,
        l.instant_book,
        ST_X(l.location::geometry) as longitude,
        ST_Y(l.location::geometry) as latitude,
        ${latitude && longitude ?
          `ST_Distance(l.location, ST_MakePoint($1, $2)::geography) as distance,` :
          ''}
        u.name as host_name,
        u.avatar_url as host_avatar,
        u.is_verified as host_verified,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as primary_photo,
        (SELECT array_agg(url ORDER BY display_order) FROM listing_photos WHERE listing_id = l.id) as photos
      FROM listings l
      JOIN users u ON l.host_id = u.id
      WHERE ${conditions.join(' AND ')}
    `;

    // Availability filter using date overlap check
    if (check_in && check_out) {
      const checkInParam = params.length + 1;
      const checkOutParam = params.length + 2;
      params.push(check_in, check_out);

      sql += `
        AND l.id NOT IN (
          SELECT DISTINCT listing_id
          FROM availability_blocks
          WHERE status = 'booked'
          AND (start_date, end_date) OVERLAPS ($${checkInParam}::date, $${checkOutParam}::date)
        )
        AND l.id NOT IN (
          SELECT DISTINCT listing_id
          FROM availability_blocks
          WHERE status = 'blocked'
          AND (start_date, end_date) OVERLAPS ($${checkInParam}::date, $${checkOutParam}::date)
        )
      `;
    }

    // Sorting
    if (sort === 'price_low') {
      orderBy = 'l.price_per_night ASC';
    } else if (sort === 'price_high') {
      orderBy = 'l.price_per_night DESC';
    } else if (sort === 'rating') {
      orderBy = 'l.rating DESC NULLS LAST, l.review_count DESC';
    } else if (latitude && longitude && sort === 'distance') {
      orderBy = 'distance ASC';
    }

    sql += ` ORDER BY ${orderBy}`;

    // Pagination
    params.push(parseInt(limit), parseInt(offset));
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await query(sql, params);

    // Get total count for pagination
    let countSql = `
      SELECT COUNT(*) as total
      FROM listings l
      WHERE ${conditions.join(' AND ')}
    `;

    if (check_in && check_out) {
      const checkInIdx = conditions.length > 3 ? 6 : 4;
      countSql += `
        AND l.id NOT IN (
          SELECT DISTINCT listing_id
          FROM availability_blocks
          WHERE status IN ('booked', 'blocked')
          AND (start_date, end_date) OVERLAPS ($${checkInIdx}::date, $${checkInIdx + 1}::date)
        )
      `;
    }

    const countParams = params.slice(0, -2); // Remove limit and offset
    const countResult = await query(countSql, countParams);

    res.json({
      listings: result.rows,
      total: parseInt(countResult.rows[0]?.total || 0),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Suggest locations based on search term
router.get('/suggest', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const result = await query(
      `SELECT DISTINCT city, state, country,
        ST_X(location::geometry) as longitude,
        ST_Y(location::geometry) as latitude
      FROM listings
      WHERE is_active = TRUE
        AND (city ILIKE $1 OR state ILIKE $1 OR country ILIKE $1)
      LIMIT 10`,
      [`%${q}%`]
    );

    const suggestions = result.rows.map((row) => ({
      label: [row.city, row.state, row.country].filter(Boolean).join(', '),
      city: row.city,
      state: row.state,
      country: row.country,
      latitude: row.latitude,
      longitude: row.longitude,
    }));

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggest error:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Get popular destinations
router.get('/popular-destinations', async (req, res) => {
  try {
    const result = await query(
      `SELECT
        city,
        state,
        country,
        COUNT(*) as listing_count,
        AVG(ST_X(location::geometry)) as longitude,
        AVG(ST_Y(location::geometry)) as latitude
      FROM listings
      WHERE is_active = TRUE AND city IS NOT NULL
      GROUP BY city, state, country
      ORDER BY listing_count DESC
      LIMIT 10`
    );

    res.json({ destinations: result.rows });
  } catch (error) {
    console.error('Popular destinations error:', error);
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

export default router;
