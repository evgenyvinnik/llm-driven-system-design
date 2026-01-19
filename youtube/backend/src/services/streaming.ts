import { query } from '../utils/db.js';
import { getPublicUrl } from '../utils/storage.js';
import { cacheGet, cacheSet, incrementViewCount } from '../utils/redis.js';
import config from '../config/index.js';

// ============ Type Definitions ============

interface VideoRow {
  id: string;
  title: string;
  description: string;
  duration_seconds: number;
  thumbnail_url: string;
  channel_id: string;
  view_count: number;
  like_count: number;
  dislike_count: number;
  published_at: string;
  username?: string;
  channel_name?: string;
  avatar_url?: string;
}

interface ResolutionRow {
  resolution: string;
  manifest_url: string;
  video_url: string;
  bitrate: number;
  width: number;
  height: number;
}

interface Resolution {
  resolution: string;
  manifestUrl: string;
  videoUrl: string;
  bitrate: number;
  width: number;
  height: number;
}

interface StreamingInfo {
  videoId: string;
  title: string;
  description: string;
  duration: number;
  thumbnailUrl: string;
  channel: {
    id: string;
    name: string;
    username: string;
    avatarUrl: string;
  };
  masterManifestUrl: string;
  resolutions: Resolution[];
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  publishedAt: string;
}

interface WatchProgress {
  position: number;
  percentage: number;
}

// Get video streaming info (manifest URLs)
export const getStreamingInfo = async (videoId: string): Promise<StreamingInfo | null> => {
  // Check cache first
  const cached = await cacheGet<StreamingInfo>(`stream:${videoId}`);
  if (cached) {
    return cached;
  }

  // Get video and resolutions from database
  const videoResult = await query<VideoRow>(
    `SELECT v.*, u.username, u.channel_name, u.avatar_url
     FROM videos v
     JOIN users u ON v.channel_id = u.id
     WHERE v.id = $1 AND v.status = 'ready'`,
    [videoId]
  );

  if (videoResult.rows.length === 0) {
    return null;
  }

  const video = videoResult.rows[0];
  if (!video) {
    return null;
  }

  const resolutionsResult = await query<ResolutionRow>(
    'SELECT * FROM video_resolutions WHERE video_id = $1 ORDER BY bitrate DESC',
    [videoId]
  );

  const masterManifestUrl = getPublicUrl(
    config.minio.buckets.processed,
    `videos/${videoId}/master.m3u8`
  );

  const streamingInfo: StreamingInfo = {
    videoId,
    title: video.title,
    description: video.description,
    duration: video.duration_seconds,
    thumbnailUrl: video.thumbnail_url,
    channel: {
      id: video.channel_id,
      name: video.channel_name || '',
      username: video.username || '',
      avatarUrl: video.avatar_url || '',
    },
    masterManifestUrl,
    resolutions: resolutionsResult.rows.map((r) => ({
      resolution: r.resolution,
      manifestUrl: r.manifest_url,
      videoUrl: r.video_url,
      bitrate: r.bitrate,
      width: r.width,
      height: r.height,
    })),
    viewCount: video.view_count,
    likeCount: video.like_count,
    dislikeCount: video.dislike_count,
    publishedAt: video.published_at,
  };

  // Cache for 5 minutes
  await cacheSet(`stream:${videoId}`, streamingInfo, 300);

  return streamingInfo;
};

// Get direct video URL for a specific resolution
export const getVideoUrl = async (
  videoId: string,
  resolution: string = '720p'
): Promise<string | null> => {
  const result = await query<{ video_url: string }>(
    'SELECT video_url FROM video_resolutions WHERE video_id = $1 AND resolution = $2',
    [videoId, resolution]
  );

  if (result.rows.length === 0) {
    // Fallback to any available resolution
    const fallbackResult = await query<{ video_url: string }>(
      'SELECT video_url FROM video_resolutions WHERE video_id = $1 ORDER BY bitrate DESC LIMIT 1',
      [videoId]
    );

    if (fallbackResult.rows.length === 0) {
      return null;
    }

    const fallbackRow = fallbackResult.rows[0];
    return fallbackRow ? fallbackRow.video_url : null;
  }

  const row = result.rows[0];
  return row ? row.video_url : null;
};

// Record a video view
export const recordView = async (
  videoId: string,
  userId: string | null = null,
  watchDuration: number = 0,
  watchPercentage: number = 0
): Promise<{ success: boolean }> => {
  // Increment buffered view count in Redis
  await incrementViewCount(videoId);

  // If user is logged in, record watch history
  if (userId) {
    await query(
      `INSERT INTO watch_history (user_id, video_id, watch_duration_seconds, watch_percentage, last_position_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [userId, videoId, watchDuration, watchPercentage, watchDuration]
    );
  }

  return { success: true };
};

// Update watch progress
export const updateWatchProgress = async (
  userId: string | null,
  videoId: string,
  position: number,
  duration: number
): Promise<{ success: boolean }> => {
  if (!userId) {
    return { success: false };
  }

  const watchPercentage = duration > 0 ? (position / duration) * 100 : 0;

  await query(
    `INSERT INTO watch_history (user_id, video_id, watch_duration_seconds, watch_percentage, last_position_seconds)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, video_id)
     DO UPDATE SET
       watch_duration_seconds = GREATEST(watch_history.watch_duration_seconds, EXCLUDED.watch_duration_seconds),
       watch_percentage = GREATEST(watch_history.watch_percentage, EXCLUDED.watch_percentage),
       last_position_seconds = EXCLUDED.last_position_seconds,
       watched_at = NOW()`,
    [userId, videoId, position, watchPercentage, position]
  );

  return { success: true };
};

// Get watch progress for a user
export const getWatchProgress = async (
  userId: string | null,
  videoId: string
): Promise<WatchProgress | null> => {
  if (!userId) {
    return null;
  }

  const result = await query<{ last_position_seconds: number; watch_percentage: number }>(
    'SELECT last_position_seconds, watch_percentage FROM watch_history WHERE user_id = $1 AND video_id = $2',
    [userId, videoId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    position: row.last_position_seconds,
    percentage: row.watch_percentage,
  };
};

// Generate adaptive bitrate selection based on bandwidth
export const selectResolution = (
  availableResolutions: Resolution[],
  bandwidthKbps: number
): Resolution | undefined => {
  const bandwidthBps = bandwidthKbps * 1000;

  // Sort by bitrate ascending
  const sorted = [...availableResolutions].sort((a, b) => a.bitrate - b.bitrate);

  // Find highest resolution that fits within bandwidth (with 80% safety margin)
  const safeBandwidth = bandwidthBps * 0.8;

  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].bitrate <= safeBandwidth) {
      return sorted[i];
    }
  }

  // Return lowest resolution as fallback
  return sorted[0];
};
