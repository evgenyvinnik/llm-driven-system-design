import { pool } from '../db.js';
import { redisClient } from '../db.js';

const CACHE_TTL = 3600; // 1 hour for recommendations

// Get personalized recommendations based on listening history
export async function getRecommendations(userId, { limit = 30 }) {
  const cacheKey = `recommendations:${userId}`;

  // Try cache
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Get user's listening history (last 28 days)
  const historyResult = await pool.query(
    `SELECT track_id, COUNT(*) as play_count,
            SUM(CASE WHEN completed THEN 1 ELSE 0 END) as completed_count
     FROM listening_history
     WHERE user_id = $1 AND played_at > NOW() - INTERVAL '28 days'
     GROUP BY track_id
     ORDER BY play_count DESC
     LIMIT 100`,
    [userId]
  );

  const listenedTrackIds = historyResult.rows.map(r => r.track_id);

  // Get liked tracks
  const likedResult = await pool.query(
    `SELECT item_id as track_id FROM user_library
     WHERE user_id = $1 AND item_type = 'track'`,
    [userId]
  );
  const likedTrackIds = likedResult.rows.map(r => r.track_id);

  // Combine for recommendations
  const seedTrackIds = [...new Set([...likedTrackIds, ...listenedTrackIds])].slice(0, 10);

  if (seedTrackIds.length === 0) {
    // Cold start: return popular tracks
    return await getPopularTracks({ limit });
  }

  // Get artists from seed tracks
  const artistsResult = await pool.query(
    `SELECT DISTINCT ar.id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE t.id = ANY($1)`,
    [seedTrackIds]
  );
  const seedArtistIds = artistsResult.rows.map(r => r.id);

  // Find tracks from similar artists and high-stream tracks from same artists
  // excluding already listened tracks
  const allKnownTrackIds = [...new Set([...listenedTrackIds, ...likedTrackIds])];

  const recommendationsResult = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE ar.id = ANY($1)
       AND ($2::uuid[] IS NULL OR t.id != ALL($2))
     ORDER BY t.stream_count DESC
     LIMIT $3`,
    [seedArtistIds, allKnownTrackIds.length > 0 ? allKnownTrackIds : null, limit]
  );

  let recommendations = recommendationsResult.rows;

  // If not enough, fill with popular tracks
  if (recommendations.length < limit) {
    const moreResult = await pool.query(
      `SELECT t.*,
              a.title as album_title, a.cover_url as album_cover_url,
              ar.name as artist_name, ar.id as artist_id
       FROM tracks t
       JOIN albums a ON t.album_id = a.id
       JOIN artists ar ON a.artist_id = ar.id
       WHERE ($1::uuid[] IS NULL OR t.id != ALL($1))
       ORDER BY t.stream_count DESC
       LIMIT $2`,
      [allKnownTrackIds.length > 0 ? allKnownTrackIds : null, limit - recommendations.length]
    );
    recommendations = [...recommendations, ...moreResult.rows];
  }

  // Cache recommendations
  await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(recommendations));

  return recommendations;
}

// Get popular tracks (for cold start or browse)
export async function getPopularTracks({ limit = 30 }) {
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

// Get similar tracks to a given track
export async function getSimilarTracks(trackId, { limit = 20 }) {
  // Get the track's artist
  const trackResult = await pool.query(
    `SELECT ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE t.id = $1`,
    [trackId]
  );

  if (trackResult.rows.length === 0) {
    return [];
  }

  const artistId = trackResult.rows[0].artist_id;

  // Find tracks from same artist and similar popularity
  const result = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE t.id != $1
       AND (ar.id = $2 OR ar.monthly_listeners > (
         SELECT monthly_listeners / 2 FROM artists WHERE id = $2
       ))
     ORDER BY
       CASE WHEN ar.id = $2 THEN 0 ELSE 1 END,
       t.stream_count DESC
     LIMIT $3`,
    [trackId, artistId, limit]
  );

  return result.rows;
}

// Get artist radio (tracks from similar artists)
export async function getArtistRadio(artistId, { limit = 50 }) {
  // Get artist's top tracks
  const artistTracksResult = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE ar.id = $1
     ORDER BY t.stream_count DESC
     LIMIT 10`,
    [artistId]
  );

  // Get artist's monthly listeners for comparison
  const artistResult = await pool.query(
    'SELECT monthly_listeners FROM artists WHERE id = $1',
    [artistId]
  );

  const listeners = artistResult.rows[0]?.monthly_listeners || 0;

  // Find similar artists by listener count (simplified similarity)
  const similarResult = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id
     FROM tracks t
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE ar.id != $1
       AND ar.monthly_listeners BETWEEN $2 AND $3
     ORDER BY t.stream_count DESC
     LIMIT $4`,
    [artistId, Math.floor(listeners * 0.5), Math.floor(listeners * 2), limit - 10]
  );

  // Combine and shuffle
  const combined = [...artistTracksResult.rows, ...similarResult.rows];
  return shuffleArray(combined).slice(0, limit);
}

// Get Discover Weekly-style playlist
export async function getDiscoverWeekly(userId) {
  const cacheKey = `discover_weekly:${userId}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Get recommendations and diversify
  const recommendations = await getRecommendations(userId, { limit: 100 });

  // Diversify: max 2 tracks per artist
  const artistCounts = new Map();
  const diversified = [];

  for (const track of recommendations) {
    const count = artistCounts.get(track.artist_id) || 0;
    if (count < 2) {
      diversified.push(track);
      artistCounts.set(track.artist_id, count + 1);
      if (diversified.length >= 30) break;
    }
  }

  // Cache for 7 days
  await redisClient.setEx(cacheKey, 604800, JSON.stringify(diversified));

  return diversified;
}

// Helper to shuffle array
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export default {
  getRecommendations,
  getPopularTracks,
  getSimilarTracks,
  getArtistRadio,
  getDiscoverWeekly,
};
