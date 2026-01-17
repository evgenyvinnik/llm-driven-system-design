import pool from '../db.js';
import redis from '../redis.js';

/**
 * Search and Geocoding Service
 */
class SearchService {
  /**
   * Search for places by name or category
   */
  async searchPlaces(query, options = {}) {
    const { lat, lng, radius = 5000, limit = 20, category } = options;

    let sql;
    let params;

    if (lat && lng) {
      // Search near a location
      sql = `
        SELECT
          id, name, category, lat, lng, address, phone, rating, review_count,
          ST_Distance(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) as distance
        FROM pois
        WHERE
          ($1 = '' OR to_tsvector('english', name) @@ plainto_tsquery('english', $1))
          ${category ? 'AND category = $5' : ''}
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
        ORDER BY
          CASE WHEN $1 != '' THEN ts_rank(to_tsvector('english', name), plainto_tsquery('english', $1)) ELSE 0 END DESC,
          distance ASC
        LIMIT $6
      `;
      params = category
        ? [query || '', lat, lng, radius, category, limit]
        : [query || '', lat, lng, radius, limit];

      // Adjust query for category filtering
      if (category) {
        sql = `
          SELECT
            id, name, category, lat, lng, address, phone, rating, review_count,
            ST_Distance(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) as distance
          FROM pois
          WHERE
            ($1 = '' OR to_tsvector('english', name) @@ plainto_tsquery('english', $1))
            AND category = $5
            AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
          ORDER BY
            CASE WHEN $1 != '' THEN ts_rank(to_tsvector('english', name), plainto_tsquery('english', $1)) ELSE 0 END DESC,
            distance ASC
          LIMIT $6
        `;
        params = [query || '', lat, lng, radius, category, limit];
      } else {
        sql = `
          SELECT
            id, name, category, lat, lng, address, phone, rating, review_count,
            ST_Distance(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) as distance
          FROM pois
          WHERE
            ($1 = '' OR to_tsvector('english', name) @@ plainto_tsquery('english', $1))
            AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
          ORDER BY
            CASE WHEN $1 != '' THEN ts_rank(to_tsvector('english', name), plainto_tsquery('english', $1)) ELSE 0 END DESC,
            distance ASC
          LIMIT $5
        `;
        params = [query || '', lat, lng, radius, limit];
      }
    } else {
      // Global search
      sql = `
        SELECT id, name, category, lat, lng, address, phone, rating, review_count
        FROM pois
        WHERE to_tsvector('english', name) @@ plainto_tsquery('english', $1)
        ${category ? 'AND category = $3' : ''}
        ORDER BY rating DESC NULLS LAST, review_count DESC
        LIMIT $2
      `;
      params = category ? [query, limit, category] : [query, limit];

      if (category) {
        sql = `
          SELECT id, name, category, lat, lng, address, phone, rating, review_count
          FROM pois
          WHERE to_tsvector('english', name) @@ plainto_tsquery('english', $1)
          AND category = $3
          ORDER BY rating DESC NULLS LAST, review_count DESC
          LIMIT $2
        `;
        params = [query, limit, category];
      } else {
        sql = `
          SELECT id, name, category, lat, lng, address, phone, rating, review_count
          FROM pois
          WHERE to_tsvector('english', name) @@ plainto_tsquery('english', $1)
          ORDER BY rating DESC NULLS LAST, review_count DESC
          LIMIT $2
        `;
        params = [query, limit];
      }
    }

    const result = await pool.query(sql, params);

    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      location: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) },
      address: row.address,
      phone: row.phone,
      rating: row.rating ? parseFloat(row.rating) : null,
      reviewCount: row.review_count,
      distance: row.distance ? parseFloat(row.distance) : null,
    }));
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(address) {
    // First try to find a matching POI
    const result = await pool.query(`
      SELECT id, name, lat, lng, address, category
      FROM pois
      WHERE
        address ILIKE $1
        OR name ILIKE $1
      ORDER BY
        CASE WHEN address ILIKE $1 THEN 0 ELSE 1 END,
        rating DESC NULLS LAST
      LIMIT 5
    `, [`%${address}%`]);

    if (result.rows.length > 0) {
      return result.rows.map(row => ({
        formattedAddress: row.address || row.name,
        location: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) },
        placeId: row.id,
        name: row.name,
        category: row.category,
      }));
    }

    // Try to find by street name
    const streetResult = await pool.query(`
      SELECT DISTINCT street_name,
        (SELECT lat FROM road_nodes WHERE id = start_node_id) as lat,
        (SELECT lng FROM road_nodes WHERE id = start_node_id) as lng
      FROM road_segments
      WHERE street_name ILIKE $1
      LIMIT 5
    `, [`%${address}%`]);

    return streetResult.rows.map(row => ({
      formattedAddress: row.street_name,
      location: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) },
      type: 'street',
    }));
  }

  /**
   * Reverse geocode coordinates to address
   */
  async reverseGeocode(lat, lng) {
    // Find nearest POI
    const poiResult = await pool.query(`
      SELECT
        id, name, address, category,
        ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) as distance
      FROM pois
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT 1
    `, [lat, lng]);

    // Find nearest road
    const roadResult = await pool.query(`
      SELECT
        street_name, road_class,
        ST_Distance(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) as distance
      FROM road_segments
      WHERE street_name IS NOT NULL AND street_name != ''
      ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT 1
    `, [lat, lng]);

    const poi = poiResult.rows[0];
    const road = roadResult.rows[0];

    // Return the closest result
    if (poi && (!road || poi.distance < road.distance)) {
      return {
        type: 'poi',
        name: poi.name,
        address: poi.address,
        category: poi.category,
        distance: poi.distance,
      };
    }

    if (road) {
      return {
        type: 'street',
        name: road.street_name,
        roadClass: road.road_class,
        distance: road.distance,
      };
    }

    return null;
  }

  /**
   * Get POI details
   */
  async getPlaceDetails(placeId) {
    const result = await pool.query(`
      SELECT id, name, category, lat, lng, address, phone, hours, rating, review_count
      FROM pois
      WHERE id = $1
    `, [placeId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      location: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) },
      address: row.address,
      phone: row.phone,
      hours: row.hours,
      rating: row.rating ? parseFloat(row.rating) : null,
      reviewCount: row.review_count,
    };
  }

  /**
   * Get available categories
   */
  async getCategories() {
    const result = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM pois
      WHERE category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
    `);

    return result.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count),
    }));
  }
}

export default new SearchService();
