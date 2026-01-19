import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { getCached, setCache } from '../services/redis.js';
import { authenticate, requireProfile, optionalAuth } from '../middleware/auth.js';

/**
 * Videos router.
 * Provides video catalog access with filtering, search, and recommendations.
 * Applies maturity filtering based on the selected profile.
 */
const router = Router();

/** Database row type for video queries */
interface VideoRow {
  id: string;
  title: string;
  type: 'movie' | 'series';
  release_year: number | null;
  duration_minutes: number | null;
  rating: string | null;
  maturity_level: number;
  genres: string[];
  description: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_url: string | null;
  popularity_score: number;
  created_at: Date;
  updated_at: Date;
}

/** Database row type for season queries */
interface SeasonRow {
  id: string;
  video_id: string;
  season_number: number;
  title: string | null;
  description: string | null;
  release_year: number | null;
  episode_count: number;
  created_at: Date;
}

/** Database row type for episode queries */
interface EpisodeRow {
  id: string;
  season_id: string;
  episode_number: number;
  title: string;
  duration_minutes: number | null;
  description: string | null;
  thumbnail_url: string | null;
  video_key: string | null;
  created_at: Date;
}

/**
 * Maps database row to API response format (snake_case to camelCase).
 *
 * @param row - Database row with snake_case column names
 * @returns Video object with camelCase property names
 */
function mapVideoRow(row: VideoRow) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    releaseYear: row.release_year,
    durationMinutes: row.duration_minutes,
    rating: row.rating,
    maturityLevel: row.maturity_level,
    genres: row.genres,
    description: row.description,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    popularityScore: row.popularity_score,
  };
}

/**
 * GET /api/videos
 * Lists videos with optional type, genre, and search filters.
 * Applies maturity filtering if a profile is selected.
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { type, genre, search, limit = 50, offset = 0 } = req.query;

    // Build query with filters
    let sql = 'SELECT * FROM videos WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (type) {
      sql += ` AND type = $${paramIndex++}`;
      params.push(type);
    }

    if (genre) {
      sql += ` AND $${paramIndex++} = ANY(genres)`;
      params.push(genre);
    }

    if (search) {
      sql += ` AND (title ILIKE $${paramIndex++} OR description ILIKE $${paramIndex++})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    // Apply maturity filter if profile is selected
    if (req.profileId) {
      const profile = await queryOne<{ maturity_level: number }>(
        'SELECT maturity_level FROM profiles WHERE id = $1',
        [req.profileId]
      );
      if (profile) {
        sql += ` AND maturity_level <= $${paramIndex++}`;
        params.push(profile.maturity_level);
      }
    }

    sql += ` ORDER BY popularity_score DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const videos = await query<VideoRow>(sql, params);

    res.json({
      videos: videos.map(mapVideoRow),
    });
  } catch (error) {
    console.error('List videos error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/videos/genres
 * Returns list of all unique genres in the catalog.
 * Results are cached for 1 hour.
 */
router.get('/genres', async (_req: Request, res: Response) => {
  try {
    // Try cache first
    const cached = await getCached<string[]>('genres');
    if (cached) {
      res.json({ genres: cached });
      return;
    }

    const result = await query<{ genre: string }>(
      `SELECT DISTINCT unnest(genres) as genre FROM videos ORDER BY genre`
    );

    const genres = result.map((r) => r.genre);

    // Cache for 1 hour
    await setCache('genres', genres, 3600);

    res.json({ genres });
  } catch (error) {
    console.error('Get genres error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/videos/trending
 * Returns top 20 videos sorted by popularity score.
 * Used for the "Trending Now" homepage row.
 */
router.get('/trending', optionalAuth, async (req: Request, res: Response) => {
  try {
    let sql = `
      SELECT * FROM videos
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    // Apply maturity filter
    if (req.profileId) {
      const profile = await queryOne<{ maturity_level: number }>(
        'SELECT maturity_level FROM profiles WHERE id = $1',
        [req.profileId]
      );
      if (profile) {
        sql += ` AND maturity_level <= $${paramIndex++}`;
        params.push(profile.maturity_level);
      }
    }

    sql += ` ORDER BY popularity_score DESC LIMIT 20`;

    const videos = await query<VideoRow>(sql, params);

    res.json({
      videos: videos.map(mapVideoRow),
    });
  } catch (error) {
    console.error('Get trending error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/videos/:id
 * Returns video details including seasons and episodes for series.
 * Used for the video detail page.
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const video = await queryOne<VideoRow>(
      'SELECT * FROM videos WHERE id = $1',
      [id]
    );

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const result: Record<string, unknown> = {
      ...mapVideoRow(video),
    };

    // If it's a series, include seasons and episodes
    if (video.type === 'series') {
      const seasons = await query<SeasonRow>(
        `SELECT * FROM seasons
         WHERE video_id = $1
         ORDER BY season_number ASC`,
        [id]
      );

      const seasonsWithEpisodes = await Promise.all(
        seasons.map(async (season) => {
          const episodes = await query<EpisodeRow>(
            `SELECT * FROM episodes
             WHERE season_id = $1
             ORDER BY episode_number ASC`,
            [season.id]
          );

          return {
            id: season.id,
            seasonNumber: season.season_number,
            title: season.title,
            description: season.description,
            releaseYear: season.release_year,
            episodeCount: season.episode_count,
            episodes: episodes.map((ep) => ({
              id: ep.id,
              episodeNumber: ep.episode_number,
              title: ep.title,
              durationMinutes: ep.duration_minutes,
              description: ep.description,
              thumbnailUrl: ep.thumbnail_url,
            })),
          };
        })
      );

      result.seasons = seasonsWithEpisodes;
    }

    res.json({ video: result });
  } catch (error) {
    console.error('Get video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/videos/:id/similar
 * Returns videos with overlapping genres, sorted by genre match count.
 * Used for "More Like This" recommendations on video detail page.
 */
router.get('/:id/similar', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const video = await queryOne<VideoRow>(
      'SELECT genres, maturity_level FROM videos WHERE id = $1',
      [id]
    );

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    // Find videos with overlapping genres
    let sql = `
      SELECT v.*,
             (SELECT COUNT(*) FROM unnest(v.genres) g WHERE g = ANY($1)) as genre_overlap
      FROM videos v
      WHERE v.id != $2
      AND v.genres && $1
    `;
    const params: unknown[] = [video.genres, id];
    let paramIndex = 3;

    // Apply maturity filter
    if (req.profileId) {
      const profile = await queryOne<{ maturity_level: number }>(
        'SELECT maturity_level FROM profiles WHERE id = $1',
        [req.profileId]
      );
      if (profile) {
        sql += ` AND v.maturity_level <= $${paramIndex++}`;
        params.push(profile.maturity_level);
      }
    }

    sql += ` ORDER BY genre_overlap DESC, popularity_score DESC LIMIT 12`;

    const similar = await query<VideoRow & { genre_overlap: number }>(sql, params);

    res.json({
      videos: similar.map(mapVideoRow),
    });
  } catch (error) {
    console.error('Get similar error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
