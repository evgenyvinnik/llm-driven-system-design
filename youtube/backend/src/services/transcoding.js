import { query, transaction } from '../utils/db.js';
import { getObject, uploadObject, getPublicUrl } from '../utils/storage.js';
import { cacheSet, cacheGet } from '../utils/redis.js';
import config from '../config/index.js';

// In-memory job queue for simplicity (in production, use Redis/Kafka)
const transcodingQueue = [];
let isProcessing = false;

// Resolution configurations
const RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080, bitrate: 5000000 },
  '720p': { width: 1280, height: 720, bitrate: 2500000 },
  '480p': { width: 854, height: 480, bitrate: 1000000 },
  '360p': { width: 640, height: 360, bitrate: 500000 },
};

// Queue a transcoding job
export const queueTranscodingJob = async (videoId, sourceKey, userId) => {
  const job = {
    videoId,
    sourceKey,
    userId,
    createdAt: new Date(),
    status: 'queued',
  };

  transcodingQueue.push(job);

  // Cache job status
  await cacheSet(`transcode:${videoId}`, job, 3600);

  // Start processing if not already
  if (!isProcessing) {
    processQueue();
  }

  return job;
};

// Process the transcoding queue
const processQueue = async () => {
  if (isProcessing || transcodingQueue.length === 0) {
    return;
  }

  isProcessing = true;

  while (transcodingQueue.length > 0) {
    const job = transcodingQueue.shift();

    try {
      await processTranscodingJob(job);
    } catch (error) {
      console.error(`Transcoding failed for video ${job.videoId}:`, error);

      // Update video status to failed
      await query(
        'UPDATE videos SET status = $1 WHERE id = $2',
        ['failed', job.videoId]
      );

      await cacheSet(`transcode:${job.videoId}`, {
        ...job,
        status: 'failed',
        error: error.message,
      }, 3600);
    }
  }

  isProcessing = false;
};

// Process a single transcoding job (simulated)
const processTranscodingJob = async (job) => {
  console.log(`Starting transcoding for video ${job.videoId}`);

  // Update status to processing
  await query(
    'UPDATE videos SET status = $1 WHERE id = $2',
    ['processing', job.videoId]
  );

  await cacheSet(`transcode:${job.videoId}`, {
    ...job,
    status: 'processing',
    progress: 0,
  }, 3600);

  // Simulate transcoding for each resolution
  const completedResolutions = [];
  const totalResolutions = config.transcoding.resolutions.length;

  for (let i = 0; i < totalResolutions; i++) {
    const resolution = config.transcoding.resolutions[i];
    const resConfig = RESOLUTIONS[resolution];

    // Simulate transcoding time
    await simulateTranscoding(config.transcoding.simulatedDuration / totalResolutions);

    // Create simulated video file for this resolution
    const videoKey = `videos/${job.videoId}/${resolution}/video.mp4`;
    const manifestKey = `videos/${job.videoId}/${resolution}/playlist.m3u8`;

    // Create a placeholder video file (in production, this would be the actual transcoded video)
    const placeholderContent = Buffer.from(`Transcoded ${resolution} video for ${job.videoId}`);
    await uploadObject(
      config.minio.buckets.processed,
      videoKey,
      placeholderContent,
      'video/mp4'
    );

    // Create HLS playlist for this resolution
    const hlsPlaylist = generateHLSPlaylist(job.videoId, resolution, 120); // Assume 2 minute video
    await uploadObject(
      config.minio.buckets.processed,
      manifestKey,
      Buffer.from(hlsPlaylist),
      'application/vnd.apple.mpegurl'
    );

    // Store resolution record
    await query(
      `INSERT INTO video_resolutions (video_id, resolution, manifest_url, video_url, bitrate, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (video_id, resolution) DO UPDATE SET
       manifest_url = EXCLUDED.manifest_url,
       video_url = EXCLUDED.video_url,
       bitrate = EXCLUDED.bitrate`,
      [
        job.videoId,
        resolution,
        getPublicUrl(config.minio.buckets.processed, manifestKey),
        getPublicUrl(config.minio.buckets.processed, videoKey),
        resConfig.bitrate,
        resConfig.width,
        resConfig.height,
      ]
    );

    completedResolutions.push(resolution);

    // Update progress
    const progress = Math.round(((i + 1) / totalResolutions) * 100);
    await cacheSet(`transcode:${job.videoId}`, {
      ...job,
      status: 'processing',
      progress,
      completedResolutions,
    }, 3600);
  }

  // Generate thumbnail
  const thumbnailKey = `thumbnails/${job.videoId}/default.jpg`;
  const thumbnailPlaceholder = generatePlaceholderThumbnail();
  await uploadObject(
    config.minio.buckets.thumbnails,
    thumbnailKey,
    thumbnailPlaceholder,
    'image/jpeg'
  );

  const thumbnailUrl = getPublicUrl(config.minio.buckets.thumbnails, thumbnailKey);

  // Create master HLS playlist
  const masterPlaylistKey = `videos/${job.videoId}/master.m3u8`;
  const masterPlaylist = generateMasterPlaylist(job.videoId, completedResolutions);
  await uploadObject(
    config.minio.buckets.processed,
    masterPlaylistKey,
    Buffer.from(masterPlaylist),
    'application/vnd.apple.mpegurl'
  );

  // Update video status to ready
  await transaction(async (client) => {
    await client.query(
      `UPDATE videos SET
        status = 'ready',
        thumbnail_url = $1,
        duration_seconds = $2,
        published_at = NOW()
       WHERE id = $3`,
      [thumbnailUrl, 120, job.videoId] // Simulated 2 minute duration
    );
  });

  await cacheSet(`transcode:${job.videoId}`, {
    ...job,
    status: 'completed',
    progress: 100,
    completedResolutions,
    completedAt: new Date(),
  }, 3600);

  console.log(`Transcoding completed for video ${job.videoId}`);
};

// Helper to simulate transcoding delay
const simulateTranscoding = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Generate HLS playlist for a resolution
const generateHLSPlaylist = (videoId, resolution, durationSeconds) => {
  const segmentDuration = 4; // 4 second segments
  const segmentCount = Math.ceil(durationSeconds / segmentDuration);

  let playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${segmentDuration}
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
`;

  for (let i = 0; i < segmentCount; i++) {
    const segmentLength = Math.min(segmentDuration, durationSeconds - i * segmentDuration);
    playlist += `#EXTINF:${segmentLength.toFixed(3)},
segment_${i.toString().padStart(3, '0')}.ts
`;
  }

  playlist += '#EXT-X-ENDLIST\n';
  return playlist;
};

// Generate master HLS playlist
const generateMasterPlaylist = (videoId, resolutions) => {
  let playlist = `#EXTM3U
#EXT-X-VERSION:3
`;

  for (const resolution of resolutions) {
    const resConfig = RESOLUTIONS[resolution];
    playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${resConfig.bitrate},RESOLUTION=${resConfig.width}x${resConfig.height}
${resolution}/playlist.m3u8
`;
  }

  return playlist;
};

// Generate a simple placeholder thumbnail (1x1 pixel gray JPEG)
const generatePlaceholderThumbnail = () => {
  // Minimal JPEG header for a gray pixel
  const jpegBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd5, 0xff, 0xd9
  ]);
  return jpegBytes;
};

// Get transcoding status
export const getTranscodingStatus = async (videoId) => {
  const cached = await cacheGet(`transcode:${videoId}`);
  if (cached) {
    return cached;
  }

  // Check database if not in cache
  const result = await query(
    'SELECT status FROM videos WHERE id = $1',
    [videoId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    videoId,
    status: result.rows[0].status,
  };
};

// Get queue length
export const getQueueLength = () => {
  return transcodingQueue.length;
};
