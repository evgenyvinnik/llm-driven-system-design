import { Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get personalized "For You" recommendations
router.get('/for-you', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Cache key for recommendations
    const cacheKey = `recommendations:${userId}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const sections = [];

    // 1. Heavy Rotation - Recently played and favorited albums
    const heavyRotation = await pool.query(
      `SELECT DISTINCT al.*, a.name as artist_name, COUNT(lh.id) as play_count
       FROM listening_history lh
       JOIN tracks t ON lh.track_id = t.id
       JOIN albums al ON t.album_id = al.id
       JOIN artists a ON al.artist_id = a.id
       WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '30 days'
       GROUP BY al.id, a.name
       ORDER BY play_count DESC
       LIMIT 10`,
      [userId]
    );

    if (heavyRotation.rows.length > 0) {
      sections.push({
        id: 'heavy-rotation',
        title: 'Heavy Rotation',
        type: 'albums',
        items: heavyRotation.rows
      });
    }

    // 2. Recently Played
    const recentlyPlayed = await pool.query(
      `SELECT DISTINCT ON (t.id) t.*, a.name as artist_name, al.title as album_title, al.artwork_url, lh.played_at
       FROM listening_history lh
       JOIN tracks t ON lh.track_id = t.id
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE lh.user_id = $1
       ORDER BY t.id, lh.played_at DESC
       LIMIT 10`,
      [userId]
    );

    if (recentlyPlayed.rows.length > 0) {
      // Re-sort by played_at
      recentlyPlayed.rows.sort((a, b) => new Date(b.played_at) - new Date(a.played_at));
      sections.push({
        id: 'recently-played',
        title: 'Recently Played',
        type: 'tracks',
        items: recentlyPlayed.rows
      });
    }

    // 3. New Releases from library artists
    const newReleases = await pool.query(
      `SELECT al.*, a.name as artist_name
       FROM albums al
       JOIN artists a ON al.artist_id = a.id
       WHERE al.artist_id IN (
         SELECT item_id FROM library_items WHERE user_id = $1 AND item_type = 'artist'
       ) AND al.release_date > NOW() - INTERVAL '90 days'
       ORDER BY al.release_date DESC
       LIMIT 10`,
      [userId]
    );

    if (newReleases.rows.length > 0) {
      sections.push({
        id: 'new-releases',
        title: 'New Releases',
        type: 'albums',
        items: newReleases.rows
      });
    }

    // 4. Genre-based mixes
    const topGenres = await pool.query(
      `SELECT genre, score FROM user_genre_preferences
       WHERE user_id = $1
       ORDER BY score DESC
       LIMIT 3`,
      [userId]
    );

    for (const genre of topGenres.rows) {
      const genreTracks = await pool.query(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
         FROM tracks t
         JOIN artists a ON t.artist_id = a.id
         JOIN albums al ON t.album_id = al.id
         JOIN track_genres tg ON t.id = tg.track_id
         WHERE LOWER(tg.genre) = LOWER($1)
         AND t.id NOT IN (
           SELECT track_id FROM listening_history WHERE user_id = $2 AND played_at > NOW() - INTERVAL '7 days'
         )
         ORDER BY t.play_count DESC, RANDOM()
         LIMIT 15`,
        [genre.genre, userId]
      );

      if (genreTracks.rows.length > 0) {
        sections.push({
          id: `mix-${genre.genre.toLowerCase().replace(/\s+/g, '-')}`,
          title: `${genre.genre} Mix`,
          type: 'tracks',
          items: genreTracks.rows
        });
      }
    }

    // 5. Discovery - Tracks you haven't heard
    const discovery = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id NOT IN (SELECT track_id FROM listening_history WHERE user_id = $1)
       ORDER BY t.play_count DESC
       LIMIT 20`,
      [userId]
    );

    if (discovery.rows.length > 0) {
      sections.push({
        id: 'discovery',
        title: 'Made for You',
        type: 'tracks',
        items: discovery.rows
      });
    }

    // 6. Top Charts (general)
    const topCharts = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       ORDER BY t.play_count DESC
       LIMIT 20`
    );

    sections.push({
      id: 'top-charts',
      title: 'Top Charts',
      type: 'tracks',
      items: topCharts.rows
    });

    const response = { sections };

    // Cache for 30 minutes
    await redis.setex(cacheKey, 1800, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// Get similar tracks to a given track
router.get('/similar/:trackId', optionalAuth, async (req, res) => {
  try {
    const { trackId } = req.params;
    const { limit = 10 } = req.query;

    // Get track info and genres
    const trackResult = await pool.query(
      `SELECT t.*, array_agg(tg.genre) as genres
       FROM tracks t
       LEFT JOIN track_genres tg ON t.id = tg.track_id
       WHERE t.id = $1
       GROUP BY t.id`,
      [trackId]
    );

    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const track = trackResult.rows[0];

    // Find similar tracks based on:
    // 1. Same genres
    // 2. Similar audio features (if available)
    // 3. Same artist

    const similarTracks = await pool.query(
      `SELECT DISTINCT t.*, a.name as artist_name, al.title as album_title, al.artwork_url,
       (
         CASE WHEN t.artist_id = $2 THEN 3 ELSE 0 END +
         (SELECT COUNT(*) FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre = ANY($3::text[]))
       ) as similarity_score
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id != $1
       ORDER BY similarity_score DESC, t.play_count DESC
       LIMIT $4`,
      [trackId, track.artist_id, track.genres, parseInt(limit)]
    );

    res.json({ tracks: similarTracks.rows });
  } catch (error) {
    console.error('Get similar tracks error:', error);
    res.status(500).json({ error: 'Failed to fetch similar tracks' });
  }
});

// Get similar artists
router.get('/similar-artists/:artistId', optionalAuth, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { limit = 10 } = req.query;

    // Get artist genres
    const artistResult = await pool.query(
      'SELECT * FROM artists WHERE id = $1',
      [artistId]
    );

    if (artistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const artist = artistResult.rows[0];

    // Find artists with overlapping genres
    const similarArtists = await pool.query(
      `SELECT a.*,
       (SELECT COUNT(*) FROM unnest(a.genres) g WHERE g = ANY($2::text[])) as genre_overlap
       FROM artists a
       WHERE a.id != $1 AND a.genres && $2
       ORDER BY genre_overlap DESC
       LIMIT $3`,
      [artistId, artist.genres || [], parseInt(limit)]
    );

    res.json({ artists: similarArtists.rows });
  } catch (error) {
    console.error('Get similar artists error:', error);
    res.status(500).json({ error: 'Failed to fetch similar artists' });
  }
});

// Get browse sections (for non-authenticated users or general browsing)
router.get('/browse', optionalAuth, async (req, res) => {
  try {
    const cacheKey = 'browse:sections';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const sections = [];

    // New Music
    const newMusic = await pool.query(
      `SELECT al.*, a.name as artist_name
       FROM albums al
       JOIN artists a ON al.artist_id = a.id
       ORDER BY al.release_date DESC
       LIMIT 12`
    );

    sections.push({
      id: 'new-music',
      title: 'New Music',
      type: 'albums',
      items: newMusic.rows
    });

    // Top Artists
    const topArtists = await pool.query(
      `SELECT a.*, COUNT(lh.id) as total_plays
       FROM artists a
       JOIN tracks t ON t.artist_id = a.id
       LEFT JOIN listening_history lh ON lh.track_id = t.id
       GROUP BY a.id
       ORDER BY total_plays DESC
       LIMIT 10`
    );

    sections.push({
      id: 'top-artists',
      title: 'Top Artists',
      type: 'artists',
      items: topArtists.rows
    });

    // Top Songs
    const topSongs = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       ORDER BY t.play_count DESC
       LIMIT 20`
    );

    sections.push({
      id: 'top-songs',
      title: 'Top Songs',
      type: 'tracks',
      items: topSongs.rows
    });

    // Genres
    const genres = await pool.query(
      `SELECT genre, COUNT(*) as track_count
       FROM track_genres
       GROUP BY genre
       ORDER BY track_count DESC
       LIMIT 10`
    );

    sections.push({
      id: 'genres',
      title: 'Browse by Genre',
      type: 'genres',
      items: genres.rows
    });

    // Featured Playlists
    const playlists = await pool.query(
      `SELECT p.*, u.username as owner_username
       FROM playlists p
       JOIN users u ON p.user_id = u.id
       WHERE p.is_public = true
       ORDER BY p.total_tracks DESC
       LIMIT 10`
    );

    sections.push({
      id: 'featured-playlists',
      title: 'Featured Playlists',
      type: 'playlists',
      items: playlists.rows
    });

    // Radio Stations
    const radio = await pool.query(
      `SELECT * FROM radio_stations WHERE is_active = true ORDER BY name LIMIT 8`
    );

    sections.push({
      id: 'radio',
      title: 'Radio Stations',
      type: 'radio',
      items: radio.rows
    });

    const response = { sections };

    // Cache for 15 minutes
    await redis.setex(cacheKey, 900, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get browse sections error:', error);
    res.status(500).json({ error: 'Failed to fetch browse sections' });
  }
});

export default router;
