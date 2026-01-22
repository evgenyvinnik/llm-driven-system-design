import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { getCached, setCache } from '../services/redis.js';
import { authenticate, requireProfile } from '../middleware/auth.js';

/**
 * Browse router.
 * Provides personalized homepage, continue watching, My List, and search functionality.
 * Implements Netflix-style personalization with maturity filtering.
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
  popularity_score: number;
}

/** Database row type for continue watching queries (joined video/episode data) */
interface ContinueWatchingRow {
  video_id: string | null;
  episode_id: string | null;
  position_seconds: number;
  duration_seconds: number;
  last_watched_at: Date;
  // Video fields
  v_id: string;
  v_title: string;
  v_type: 'movie' | 'series';
  v_poster_url: string | null;
  v_backdrop_url: string | null;
  v_genres: string[];
  // Episode fields (for series)
  e_id: string | null;
  e_title: string | null;
  e_episode_number: number | null;
  e_thumbnail_url: string | null;
  s_season_number: number | null;
}

/** Database row type for My List queries */
interface _MyListRow {
  video_id: string;
  added_at: Date;
}

/** Database row type for profile settings */
interface ProfileRow {
  maturity_level: number;
  language: string;
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
    popularityScore: row.popularity_score,
  };
}

/**
 * GET /api/browse/homepage
 * Returns personalized homepage rows (Continue Watching, My List, Trending, etc.).
 * Results are cached per-profile for 5 minutes.
 */
router.get('/homepage', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const profileId = req.profileId!;

    // Check cache first
    const cacheKey = `homepage:${profileId}`;
    const cached = await getCached<{ rows: unknown[] }>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const profile = await queryOne<ProfileRow>(
      'SELECT maturity_level, language FROM profiles WHERE id = $1',
      [profileId]
    );

    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const rows: Array<{ title: string; rowType: string; items: unknown[] }> = [];

    // 1. Continue Watching
    const continueWatching = await getContinueWatching(profileId, profile.maturity_level);
    if (continueWatching.length > 0) {
      rows.push({
        title: 'Continue Watching',
        rowType: 'continue_watching',
        items: continueWatching,
      });
    }

    // 2. My List
    const myList = await getMyList(profileId, profile.maturity_level);
    if (myList.length > 0) {
      rows.push({
        title: 'My List',
        rowType: 'my_list',
        items: myList,
      });
    }

    // 3. Trending Now
    const trending = await getTrending(profile.maturity_level);
    rows.push({
      title: 'Trending Now',
      rowType: 'trending',
      items: trending,
    });

    // 4. Top genre rows based on watch history
    const topGenres = await getTopGenres(profileId);
    for (const genre of topGenres.slice(0, 3)) {
      const genreVideos = await getByGenre(genre, profile.maturity_level);
      if (genreVideos.length > 0) {
        rows.push({
          title: `${genre}`,
          rowType: 'genre',
          items: genreVideos,
        });
      }
    }

    // 5. "Because you watched..." rows
    const recentlyWatched = await getRecentlyWatched(profileId, profile.maturity_level);
    for (const watched of recentlyWatched.slice(0, 2)) {
      const similar = await getSimilarVideos(watched.id, profile.maturity_level);
      if (similar.length > 0) {
        rows.push({
          title: `Because you watched ${watched.title}`,
          rowType: 'because_you_watched',
          items: similar,
        });
      }
    }

    // 6. New Releases
    const newReleases = await getNewReleases(profile.maturity_level);
    if (newReleases.length > 0) {
      rows.push({
        title: 'New Releases',
        rowType: 'new_releases',
        items: newReleases,
      });
    }

    // 7. TV Shows
    const tvShows = await getByType('series', profile.maturity_level);
    if (tvShows.length > 0) {
      rows.push({
        title: 'TV Shows',
        rowType: 'tv_shows',
        items: tvShows,
      });
    }

    // 8. Movies
    const movies = await getByType('movie', profile.maturity_level);
    if (movies.length > 0) {
      rows.push({
        title: 'Movies',
        rowType: 'movies',
        items: movies,
      });
    }

    const result = { rows };

    // Cache for 5 minutes
    await setCache(cacheKey, result, 300);

    res.json(result);
  } catch (error) {
    console.error('Homepage error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/browse/continue-watching
 * Returns in-progress content for the current profile.
 */
router.get('/continue-watching', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne<ProfileRow>(
      'SELECT maturity_level FROM profiles WHERE id = $1',
      [req.profileId]
    );

    const items = await getContinueWatching(req.profileId!, profile?.maturity_level || 4);
    res.json({ items });
  } catch (error) {
    console.error('Continue watching error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/browse/my-list
 * Returns user's saved content list.
 */
router.get('/my-list', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne<ProfileRow>(
      'SELECT maturity_level FROM profiles WHERE id = $1',
      [req.profileId]
    );

    const items = await getMyList(req.profileId!, profile?.maturity_level || 4);
    res.json({ items });
  } catch (error) {
    console.error('My list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/browse/my-list/:videoId
 * Adds a video to the user's My List.
 */
router.post('/my-list/:videoId', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    await query(
      `INSERT INTO my_list (profile_id, video_id)
       VALUES ($1, $2)
       ON CONFLICT (profile_id, video_id) DO NOTHING`,
      [req.profileId, videoId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Add to my list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/browse/my-list/:videoId
 * Removes a video from the user's My List.
 */
router.delete('/my-list/:videoId', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    await query(
      'DELETE FROM my_list WHERE profile_id = $1 AND video_id = $2',
      [req.profileId, videoId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Remove from my list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/browse/my-list/:videoId/check
 * Checks if a video is in the user's My List.
 */
router.get('/my-list/:videoId/check', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    const item = await queryOne<{ id: string }>(
      'SELECT id FROM my_list WHERE profile_id = $1 AND video_id = $2',
      [req.profileId, videoId]
    );

    res.json({ inList: !!item });
  } catch (error) {
    console.error('Check my list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/browse/search
 * Searches videos by title, description, or genre.
 */
router.get('/search', authenticate, requireProfile, async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      res.json({ videos: [] });
      return;
    }

    const profile = await queryOne<ProfileRow>(
      'SELECT maturity_level FROM profiles WHERE id = $1',
      [req.profileId]
    );

    const videos = await query<VideoRow>(
      `SELECT * FROM videos
       WHERE (title ILIKE $1 OR description ILIKE $1 OR $2 = ANY(genres))
       AND maturity_level <= $3
       ORDER BY popularity_score DESC
       LIMIT 50`,
      [`%${q}%`, q, profile?.maturity_level || 4]
    );

    res.json({ videos: videos.map(mapVideoRow) });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================================================
// Helper functions for homepage row generation
// =========================================================

/**
 * Gets in-progress content for the "Continue Watching" row.
 * Returns items that are 5-95% complete.
 *
 * @param profileId - Current profile ID
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of continue watching items with progress info
 */
async function getContinueWatching(profileId: string, maturityLevel: number) {
  const items = await query<ContinueWatchingRow>(
    `SELECT
      vp.video_id, vp.episode_id, vp.position_seconds, vp.duration_seconds, vp.last_watched_at,
      v.id as v_id, v.title as v_title, v.type as v_type, v.poster_url as v_poster_url, v.backdrop_url as v_backdrop_url, v.genres as v_genres,
      e.id as e_id, e.title as e_title, e.episode_number as e_episode_number, e.thumbnail_url as e_thumbnail_url,
      s.season_number as s_season_number
     FROM viewing_progress vp
     LEFT JOIN videos v ON vp.video_id = v.id OR (vp.episode_id IS NOT NULL AND v.id = (
       SELECT s2.video_id FROM episodes e2
       JOIN seasons s2 ON e2.season_id = s2.id
       WHERE e2.id = vp.episode_id
     ))
     LEFT JOIN episodes e ON vp.episode_id = e.id
     LEFT JOIN seasons s ON e.season_id = s.id
     WHERE vp.profile_id = $1
       AND vp.completed = false
       AND vp.position_seconds > 0
       AND (vp.position_seconds::float / vp.duration_seconds::float) > 0.05
       AND (vp.position_seconds::float / vp.duration_seconds::float) < 0.95
       AND v.maturity_level <= $2
     ORDER BY vp.last_watched_at DESC
     LIMIT 20`,
    [profileId, maturityLevel]
  );

  return items.map((item) => ({
    video: {
      id: item.v_id,
      title: item.v_title,
      type: item.v_type,
      posterUrl: item.v_poster_url,
      backdropUrl: item.v_backdrop_url,
      genres: item.v_genres,
    },
    episode: item.e_id
      ? {
          id: item.e_id,
          title: item.e_title,
          episodeNumber: item.e_episode_number,
          seasonNumber: item.s_season_number,
          thumbnailUrl: item.e_thumbnail_url,
        }
      : null,
    positionSeconds: item.position_seconds,
    durationSeconds: item.duration_seconds,
    percentComplete: Math.round((item.position_seconds / item.duration_seconds) * 100),
    lastWatchedAt: item.last_watched_at,
  }));
}

/**
 * Gets videos in the user's My List.
 *
 * @param profileId - Current profile ID
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of saved videos
 */
async function getMyList(profileId: string, maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT v.* FROM videos v
     JOIN my_list ml ON v.id = ml.video_id
     WHERE ml.profile_id = $1
       AND v.maturity_level <= $2
     ORDER BY ml.added_at DESC`,
    [profileId, maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets trending videos sorted by popularity score.
 *
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of trending videos
 */
async function getTrending(maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT * FROM videos
     WHERE maturity_level <= $1
     ORDER BY popularity_score DESC
     LIMIT 12`,
    [maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets the user's top genres based on watch history.
 * Falls back to default genres if no history exists.
 *
 * @param profileId - Current profile ID
 * @returns Array of genre names sorted by watch frequency
 */
async function getTopGenres(profileId: string): Promise<string[]> {
  const result = await query<{ genre: string; count: string }>(
    `SELECT unnest(v.genres) as genre, COUNT(*) as count
     FROM watch_history wh
     JOIN videos v ON wh.video_id = v.id
     WHERE wh.profile_id = $1
     GROUP BY genre
     ORDER BY count DESC
     LIMIT 5`,
    [profileId]
  );

  // If no watch history, return default genres
  if (result.length === 0) {
    return ['Drama', 'Action', 'Comedy', 'Thriller', 'Sci-Fi'];
  }

  return result.map((r) => r.genre);
}

/**
 * Gets videos matching a specific genre.
 *
 * @param genre - Genre name to filter by
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of videos in the genre
 */
async function getByGenre(genre: string, maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT * FROM videos
     WHERE $1 = ANY(genres)
       AND maturity_level <= $2
     ORDER BY popularity_score DESC
     LIMIT 12`,
    [genre, maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets recently watched videos for "Because you watched" recommendations.
 *
 * @param profileId - Current profile ID
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of recently watched videos
 */
async function getRecentlyWatched(profileId: string, maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT DISTINCT v.* FROM videos v
     JOIN watch_history wh ON v.id = wh.video_id
     WHERE wh.profile_id = $1
       AND v.maturity_level <= $2
     ORDER BY v.popularity_score DESC
     LIMIT 3`,
    [profileId, maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets videos similar to a given video based on genre overlap.
 *
 * @param videoId - Video ID to find similar content for
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of similar videos sorted by genre overlap count
 */
async function getSimilarVideos(videoId: string, maturityLevel: number) {
  const video = await queryOne<{ genres: string[] }>(
    'SELECT genres FROM videos WHERE id = $1',
    [videoId]
  );

  if (!video) return [];

  const videos = await query<VideoRow>(
    `SELECT * FROM videos
     WHERE id != $1
       AND genres && $2
       AND maturity_level <= $3
     ORDER BY (SELECT COUNT(*) FROM unnest(genres) g WHERE g = ANY($2)) DESC, popularity_score DESC
     LIMIT 12`,
    [videoId, video.genres, maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets recently released content (2023+).
 *
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of new releases sorted by release year
 */
async function getNewReleases(maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT * FROM videos
     WHERE maturity_level <= $1
       AND release_year >= 2023
     ORDER BY release_year DESC, created_at DESC
     LIMIT 12`,
    [maturityLevel]
  );

  return videos.map(mapVideoRow);
}

/**
 * Gets videos filtered by content type (movie or series).
 *
 * @param type - Content type filter
 * @param maturityLevel - Profile's maturity level for filtering
 * @returns Array of videos of the specified type
 */
async function getByType(type: 'movie' | 'series', maturityLevel: number) {
  const videos = await query<VideoRow>(
    `SELECT * FROM videos
     WHERE type = $1
       AND maturity_level <= $2
     ORDER BY popularity_score DESC
     LIMIT 12`,
    [type, maturityLevel]
  );

  return videos.map(mapVideoRow);
}

export default router;
