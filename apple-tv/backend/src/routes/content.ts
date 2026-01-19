import express, { Request, Response, Router } from 'express';
import * as db from '../db/index.js';
import { client as redis } from '../db/redis.js';

const router: Router = express.Router();

interface ContentRow {
  id: string;
  title: string;
  description: string;
  duration: number;
  release_date: Date;
  content_type: string;
  series_id: string | null;
  season_number: number | null;
  episode_number: number | null;
  rating: string;
  genres: string[];
  thumbnail_url: string;
  banner_url: string;
  status: string;
  featured: boolean;
  view_count: number;
  master_resolution?: number;
  hdr_format?: string;
  episodes?: ContentRow[];
  seasons?: Record<number, ContentRow[]>;
  variants?: VariantRow[];
  audioTracks?: AudioTrackRow[];
  subtitles?: SubtitleRow[];
}

interface VariantRow {
  id: string;
  resolution: number;
  codec: string;
  hdr: boolean;
  bitrate: number;
}

interface AudioTrackRow {
  id: string;
  language: string;
  name: string;
  codec: string;
  channels: number;
}

interface SubtitleRow {
  id: string;
  language: string;
  name: string;
  type: string;
}

// Get all content (browse)
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { type, genre, search, limit = '20', offset = '0' } = req.query as Record<string, string>;

    let query = `
      SELECT id, title, description, duration, release_date, content_type,
             series_id, season_number, episode_number, rating, genres,
             thumbnail_url, banner_url, status, featured, view_count
      FROM content
      WHERE status = 'ready' AND content_type != 'episode'
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND content_type = $${paramIndex++}`;
      params.push(type);
    }

    if (genre) {
      query += ` AND $${paramIndex++} = ANY(genres)`;
      params.push(genre);
    }

    if (search) {
      query += ` AND (title ILIKE $${paramIndex++} OR description ILIKE $${paramIndex++})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY featured DESC, release_date DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query<ContentRow>(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get featured content
router.get('/featured', async (req: Request, res: Response): Promise<void> => {
  try {
    // Try cache first
    const cached = await redis.get('content:featured');
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    const result = await db.query<ContentRow>(`
      SELECT id, title, description, duration, release_date, content_type,
             rating, genres, thumbnail_url, banner_url
      FROM content
      WHERE status = 'ready' AND featured = true AND content_type != 'episode'
      ORDER BY release_date DESC
      LIMIT 10
    `);

    // Cache for 5 minutes
    await redis.setEx('content:featured', 300, JSON.stringify(result.rows));

    res.json(result.rows);
  } catch (error) {
    console.error('Get featured error:', error);
    res.status(500).json({ error: 'Failed to fetch featured content' });
  }
});

// Get content by ID
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await db.query<ContentRow>(`
      SELECT id, title, description, duration, release_date, content_type,
             series_id, season_number, episode_number, rating, genres,
             thumbnail_url, banner_url, master_resolution, hdr_format, status, view_count
      FROM content
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Content not found' });
      return;
    }

    const content: ContentRow = result.rows[0];

    // If it's a series, get episodes
    if (content.content_type === 'series') {
      const episodes = await db.query<ContentRow>(`
        SELECT id, title, description, duration, season_number, episode_number,
               thumbnail_url, rating
        FROM content
        WHERE series_id = $1 AND content_type = 'episode'
        ORDER BY season_number, episode_number
      `, [id]);

      content.episodes = episodes.rows;

      // Group by season
      const seasons: Record<number, ContentRow[]> = {};
      for (const episode of episodes.rows) {
        const seasonNum = episode.season_number ?? 0;
        if (!seasons[seasonNum]) {
          seasons[seasonNum] = [];
        }
        seasons[seasonNum].push(episode);
      }
      content.seasons = seasons;
    }

    // Get encoded variants
    const variants = await db.query<VariantRow>(`
      SELECT id, resolution, codec, hdr, bitrate
      FROM encoded_variants
      WHERE content_id = $1
      ORDER BY resolution DESC, bitrate DESC
    `, [id]);

    content.variants = variants.rows;

    // Get audio tracks
    const audioTracks = await db.query<AudioTrackRow>(`
      SELECT id, language, name, codec, channels
      FROM audio_tracks
      WHERE content_id = $1
    `, [id]);

    content.audioTracks = audioTracks.rows;

    // Get subtitles
    const subtitles = await db.query<SubtitleRow>(`
      SELECT id, language, name, type
      FROM subtitles
      WHERE content_id = $1
    `, [id]);

    content.subtitles = subtitles.rows;

    res.json(content);
  } catch (error) {
    console.error('Get content by ID error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get series details with all seasons
router.get('/:id/seasons', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const episodes = await db.query<ContentRow>(`
      SELECT id, title, description, duration, season_number, episode_number,
             thumbnail_url, rating
      FROM content
      WHERE series_id = $1 AND content_type = 'episode'
      ORDER BY season_number, episode_number
    `, [id]);

    // Group by season
    const seasons: Record<number, ContentRow[]> = {};
    for (const episode of episodes.rows) {
      const seasonNum = episode.season_number ?? 0;
      if (!seasons[seasonNum]) {
        seasons[seasonNum] = [];
      }
      seasons[seasonNum].push(episode);
    }

    res.json(seasons);
  } catch (error) {
    console.error('Get seasons error:', error);
    res.status(500).json({ error: 'Failed to fetch seasons' });
  }
});

// Get genres
router.get('/meta/genres', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await redis.get('content:genres');
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    const result = await db.query<{ genre: string }>(`
      SELECT DISTINCT unnest(genres) as genre
      FROM content
      WHERE status = 'ready'
      ORDER BY genre
    `);

    const genres = result.rows.map((r: { genre: string }) => r.genre);

    await redis.setEx('content:genres', 3600, JSON.stringify(genres));

    res.json(genres);
  } catch (error) {
    console.error('Get genres error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

// Increment view count
router.post('/:id/view', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    await db.query(`
      UPDATE content SET view_count = view_count + 1 WHERE id = $1
    `, [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Increment view error:', error);
    res.status(500).json({ error: 'Failed to increment view' });
  }
});

export default router;
