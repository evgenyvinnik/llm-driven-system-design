const express = require('express');
const db = require('../db');
const { client: redis } = require('../db/redis');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get personalized recommendations
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const profileId = req.session.profileId;
    const isKids = req.session.isKids;

    // Build recommendations based on multiple signals
    const recommendations = await getRecommendations(profileId, isKids, parseInt(limit));

    res.json(recommendations);
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

// Get "Because you watched X" recommendations
router.get('/because-you-watched/:contentId', isAuthenticated, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { limit = 10 } = req.query;
    const isKids = req.session.isKids;

    // Get the source content's genres
    const source = await db.query(`
      SELECT genres FROM content WHERE id = $1
    `, [contentId]);

    if (source.rows.length === 0) {
      return res.json([]);
    }

    const genres = source.rows[0].genres || [];

    // Find similar content by genre
    let query = `
      SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
      FROM content
      WHERE id != $1
        AND status = 'ready'
        AND content_type != 'episode'
        AND genres && $2
    `;
    const params = [contentId, genres];
    let paramIndex = 3;

    if (isKids) {
      query += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
    }

    query += ` ORDER BY array_length(array(SELECT unnest(genres) INTERSECT SELECT unnest($2)), 1) DESC NULLS LAST, view_count DESC`;
    query += ` LIMIT $${paramIndex++}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Get similar content error:', error);
    res.status(500).json({ error: 'Failed to get similar content' });
  }
});

// Get trending content
router.get('/trending', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Try cache first
    const cached = await redis.get('recommendations:trending');
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await db.query(`
      SELECT id, title, description, thumbnail_url, banner_url, content_type, genres, rating, duration, view_count
      FROM content
      WHERE status = 'ready'
        AND content_type != 'episode'
      ORDER BY view_count DESC, release_date DESC
      LIMIT $1
    `, [parseInt(limit)]);

    // Cache for 15 minutes
    await redis.setEx('recommendations:trending', 900, JSON.stringify(result.rows));

    res.json(result.rows);
  } catch (error) {
    console.error('Get trending error:', error);
    res.status(500).json({ error: 'Failed to get trending content' });
  }
});

// Get new releases
router.get('/new-releases', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const cached = await redis.get('recommendations:new-releases');
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await db.query(`
      SELECT id, title, description, thumbnail_url, banner_url, content_type, genres, rating, duration, release_date
      FROM content
      WHERE status = 'ready'
        AND content_type != 'episode'
        AND release_date >= NOW() - INTERVAL '90 days'
      ORDER BY release_date DESC
      LIMIT $1
    `, [parseInt(limit)]);

    await redis.setEx('recommendations:new-releases', 900, JSON.stringify(result.rows));

    res.json(result.rows);
  } catch (error) {
    console.error('Get new releases error:', error);
    res.status(500).json({ error: 'Failed to get new releases' });
  }
});

// Get recommendations by genre
router.get('/genre/:genre', async (req, res) => {
  try {
    const { genre } = req.params;
    const { limit = 20 } = req.query;

    const result = await db.query(`
      SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
      FROM content
      WHERE status = 'ready'
        AND content_type != 'episode'
        AND $1 = ANY(genres)
      ORDER BY featured DESC, view_count DESC, release_date DESC
      LIMIT $2
    `, [genre, parseInt(limit)]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get genre recommendations error:', error);
    res.status(500).json({ error: 'Failed to get genre recommendations' });
  }
});

// Rate content
router.post('/rate/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;
    const { rating } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    await db.query(`
      INSERT INTO content_ratings (profile_id, content_id, rating, rated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (profile_id, content_id)
      DO UPDATE SET rating = $3, rated_at = NOW()
    `, [req.session.profileId, contentId, rating]);

    res.json({ success: true });
  } catch (error) {
    console.error('Rate content error:', error);
    res.status(500).json({ error: 'Failed to rate content' });
  }
});

// Get user's rating for content
router.get('/rating/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;

    const result = await db.query(`
      SELECT rating FROM content_ratings
      WHERE profile_id = $1 AND content_id = $2
    `, [req.session.profileId, contentId]);

    res.json({
      rating: result.rows.length > 0 ? result.rows[0].rating : null
    });
  } catch (error) {
    console.error('Get rating error:', error);
    res.status(500).json({ error: 'Failed to get rating' });
  }
});

// Helper function to build recommendations
async function getRecommendations(profileId, isKids, limit) {
  const sections = [];

  // Section 1: Continue Watching (if profile selected)
  if (profileId) {
    const continueWatching = await db.query(`
      SELECT
        c.id,
        c.title,
        c.thumbnail_url,
        c.duration,
        c.content_type,
        wp.position,
        (wp.position::float / c.duration) as progress_pct
      FROM watch_progress wp
      JOIN content c ON c.id = wp.content_id
      WHERE wp.profile_id = $1
        AND wp.position > 60
        AND (wp.position::float / c.duration) < 0.9
        AND wp.completed = false
      ORDER BY wp.updated_at DESC
      LIMIT 10
    `, [profileId]);

    if (continueWatching.rows.length > 0) {
      sections.push({
        title: 'Continue Watching',
        type: 'continue_watching',
        items: continueWatching.rows.map(row => ({
          ...row,
          progressPercent: Math.round(row.progress_pct * 100)
        }))
      });
    }
  }

  // Section 2: Featured content
  let featuredQuery = `
    SELECT id, title, description, thumbnail_url, banner_url, content_type, genres, rating, duration
    FROM content
    WHERE status = 'ready' AND featured = true AND content_type != 'episode'
  `;
  if (isKids) {
    featuredQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
  }
  featuredQuery += ` ORDER BY release_date DESC LIMIT 10`;

  const featured = await db.query(featuredQuery);
  if (featured.rows.length > 0) {
    sections.push({
      title: 'Featured',
      type: 'featured',
      items: featured.rows
    });
  }

  // Section 3: Trending
  let trendingQuery = `
    SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
    FROM content
    WHERE status = 'ready' AND content_type != 'episode'
  `;
  if (isKids) {
    trendingQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
  }
  trendingQuery += ` ORDER BY view_count DESC LIMIT 10`;

  const trending = await db.query(trendingQuery);
  if (trending.rows.length > 0) {
    sections.push({
      title: 'Trending Now',
      type: 'trending',
      items: trending.rows
    });
  }

  // Section 4: New Releases
  let newQuery = `
    SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
    FROM content
    WHERE status = 'ready' AND content_type != 'episode'
      AND release_date >= NOW() - INTERVAL '90 days'
  `;
  if (isKids) {
    newQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
  }
  newQuery += ` ORDER BY release_date DESC LIMIT 10`;

  const newReleases = await db.query(newQuery);
  if (newReleases.rows.length > 0) {
    sections.push({
      title: 'New Releases',
      type: 'new_releases',
      items: newReleases.rows
    });
  }

  // Section 5: Genre-based recommendations (if profile has history)
  if (profileId) {
    const watchedGenres = await db.query(`
      SELECT unnest(c.genres) as genre, COUNT(*) as count
      FROM watch_history wh
      JOIN content c ON c.id = wh.content_id
      WHERE wh.profile_id = $1
      GROUP BY genre
      ORDER BY count DESC
      LIMIT 3
    `, [profileId]);

    for (const genreRow of watchedGenres.rows) {
      let genreQuery = `
        SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
        FROM content
        WHERE status = 'ready' AND content_type != 'episode'
          AND $1 = ANY(genres)
      `;
      const params = [genreRow.genre];

      if (isKids) {
        genreQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
      }
      genreQuery += ` ORDER BY view_count DESC LIMIT 10`;

      const genreContent = await db.query(genreQuery, params);
      if (genreContent.rows.length > 0) {
        sections.push({
          title: `${genreRow.genre}`,
          type: 'genre',
          genre: genreRow.genre,
          items: genreContent.rows
        });
      }
    }
  }

  // Section 6: Movies
  let moviesQuery = `
    SELECT id, title, description, thumbnail_url, content_type, genres, rating, duration
    FROM content
    WHERE status = 'ready' AND content_type = 'movie'
  `;
  if (isKids) {
    moviesQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
  }
  moviesQuery += ` ORDER BY view_count DESC LIMIT 10`;

  const movies = await db.query(moviesQuery);
  if (movies.rows.length > 0) {
    sections.push({
      title: 'Movies',
      type: 'movies',
      items: movies.rows
    });
  }

  // Section 7: Series
  let seriesQuery = `
    SELECT id, title, description, thumbnail_url, content_type, genres, rating
    FROM content
    WHERE status = 'ready' AND content_type = 'series'
  `;
  if (isKids) {
    seriesQuery += ` AND rating IN ('G', 'PG', 'TV-Y', 'TV-G', 'TV-Y7')`;
  }
  seriesQuery += ` ORDER BY view_count DESC LIMIT 10`;

  const series = await db.query(seriesQuery);
  if (series.rows.length > 0) {
    sections.push({
      title: 'TV Shows',
      type: 'series',
      items: series.rows
    });
  }

  return sections;
}

module.exports = router;
