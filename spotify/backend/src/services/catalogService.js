import { pool } from '../db.js';
import { redisClient } from '../db.js';
import { getPublicUrl, COVERS_BUCKET } from '../storage.js';

const CACHE_TTL = 300; // 5 minutes

// Get all artists with pagination
export async function getArtists({ limit = 20, offset = 0, search = '' }) {
  const cacheKey = `artists:${limit}:${offset}:${search}`;

  // Try cache first
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  let query = `
    SELECT id, name, image_url, verified, monthly_listeners
    FROM artists
  `;
  const params = [];

  if (search) {
    query += ` WHERE name ILIKE $1`;
    params.push(`%${search}%`);
  }

  query += ` ORDER BY monthly_listeners DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);

  // Get total count
  let countQuery = 'SELECT COUNT(*) FROM artists';
  const countParams = [];
  if (search) {
    countQuery += ' WHERE name ILIKE $1';
    countParams.push(`%${search}%`);
  }
  const countResult = await pool.query(countQuery, countParams);

  const response = {
    artists: result.rows,
    total: parseInt(countResult.rows[0].count),
    limit,
    offset,
  };

  // Cache the result
  await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(response));

  return response;
}

// Get artist by ID with albums
export async function getArtistById(artistId) {
  const cacheKey = `artist:${artistId}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const artistResult = await pool.query(
    'SELECT * FROM artists WHERE id = $1',
    [artistId]
  );

  if (artistResult.rows.length === 0) {
    return null;
  }

  const albumsResult = await pool.query(
    `SELECT a.*, COUNT(t.id) as track_count
     FROM albums a
     LEFT JOIN tracks t ON t.album_id = a.id
     WHERE a.artist_id = $1
     GROUP BY a.id
     ORDER BY a.release_date DESC`,
    [artistId]
  );

  // Get top tracks
  const topTracksResult = await pool.query(
    `SELECT t.*, al.title as album_title, al.cover_url as album_cover_url
     FROM tracks t
     JOIN albums al ON t.album_id = al.id
     WHERE al.artist_id = $1
     ORDER BY t.stream_count DESC
     LIMIT 10`,
    [artistId]
  );

  const response = {
    ...artistResult.rows[0],
    albums: albumsResult.rows,
    topTracks: topTracksResult.rows,
  };

  await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(response));

  return response;
}

// Get all albums with pagination
export async function getAlbums({ limit = 20, offset = 0, search = '', artistId = null }) {
  let query = `
    SELECT a.*, ar.name as artist_name
    FROM albums a
    JOIN artists ar ON a.artist_id = ar.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` AND a.title ILIKE $${params.length}`;
  }

  if (artistId) {
    params.push(artistId);
    query += ` AND a.artist_id = $${params.length}`;
  }

  query += ` ORDER BY a.release_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);

  // Get total count
  let countQuery = 'SELECT COUNT(*) FROM albums a WHERE 1=1';
  const countParams = [];
  if (search) {
    countParams.push(`%${search}%`);
    countQuery += ` AND a.title ILIKE $${countParams.length}`;
  }
  if (artistId) {
    countParams.push(artistId);
    countQuery += ` AND a.artist_id = $${countParams.length}`;
  }
  const countResult = await pool.query(countQuery, countParams);

  return {
    albums: result.rows,
    total: parseInt(countResult.rows[0].count),
    limit,
    offset,
  };
}

// Get album by ID with tracks
export async function getAlbumById(albumId) {
  const cacheKey = `album:${albumId}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const albumResult = await pool.query(
    `SELECT a.*, ar.name as artist_name, ar.id as artist_id
     FROM albums a
     JOIN artists ar ON a.artist_id = ar.id
     WHERE a.id = $1`,
    [albumId]
  );

  if (albumResult.rows.length === 0) {
    return null;
  }

  const tracksResult = await pool.query(
    `SELECT t.*,
            json_agg(json_build_object('id', ar.id, 'name', ar.name)) as artists
     FROM tracks t
     LEFT JOIN track_artists ta ON t.id = ta.track_id
     LEFT JOIN artists ar ON ta.artist_id = ar.id
     WHERE t.album_id = $1
     GROUP BY t.id
     ORDER BY t.disc_number, t.track_number`,
    [albumId]
  );

  const response = {
    ...albumResult.rows[0],
    tracks: tracksResult.rows,
  };

  await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(response));

  return response;
}

// Get track by ID
export async function getTrackById(trackId) {
  const result = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url, a.id as album_id,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE t.id = $1`,
    [trackId]
  );

  return result.rows[0] || null;
}

// Get tracks by IDs
export async function getTracksByIds(trackIds) {
  if (!trackIds || trackIds.length === 0) return [];

  const result = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url, a.id as album_id,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE t.id = ANY($1)`,
    [trackIds]
  );

  return result.rows;
}

// Search across all content
export async function search(query, { limit = 20, types = ['artists', 'albums', 'tracks'] }) {
  const results = {};
  const searchTerm = `%${query}%`;

  if (types.includes('artists')) {
    const artistsResult = await pool.query(
      `SELECT id, name, image_url, verified, monthly_listeners
       FROM artists
       WHERE name ILIKE $1
       ORDER BY monthly_listeners DESC
       LIMIT $2`,
      [searchTerm, limit]
    );
    results.artists = artistsResult.rows;
  }

  if (types.includes('albums')) {
    const albumsResult = await pool.query(
      `SELECT a.*, ar.name as artist_name
       FROM albums a
       JOIN artists ar ON a.artist_id = ar.id
       WHERE a.title ILIKE $1
       ORDER BY a.release_date DESC
       LIMIT $2`,
      [searchTerm, limit]
    );
    results.albums = albumsResult.rows;
  }

  if (types.includes('tracks')) {
    const tracksResult = await pool.query(
      `SELECT t.*,
              a.title as album_title, a.cover_url as album_cover_url,
              ar.name as artist_name, ar.id as artist_id
       FROM tracks t
       JOIN albums a ON t.album_id = a.id
       JOIN artists ar ON a.artist_id = ar.id
       WHERE t.title ILIKE $1
       ORDER BY t.stream_count DESC
       LIMIT $2`,
      [searchTerm, limit]
    );
    results.tracks = tracksResult.rows;
  }

  return results;
}

// Get new releases
export async function getNewReleases({ limit = 20 }) {
  const result = await pool.query(
    `SELECT a.*, ar.name as artist_name
     FROM albums a
     JOIN artists ar ON a.artist_id = ar.id
     ORDER BY a.release_date DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

// Get featured/popular tracks
export async function getFeaturedTracks({ limit = 20 }) {
  const result = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     ORDER BY t.stream_count DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

export default {
  getArtists,
  getArtistById,
  getAlbums,
  getAlbumById,
  getTrackById,
  getTracksByIds,
  search,
  getNewReleases,
  getFeaturedTracks,
};
