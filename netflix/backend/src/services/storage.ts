import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MINIO_CONFIG } from '../config.js';

/**
 * S3-compatible storage client configured for MinIO.
 * Used for storing and serving video files and thumbnails.
 * The forcePathStyle option is required for MinIO compatibility.
 */
export const s3Client = new S3Client({
  endpoint: MINIO_CONFIG.endpoint,
  region: MINIO_CONFIG.region,
  credentials: {
    accessKeyId: MINIO_CONFIG.accessKeyId,
    secretAccessKey: MINIO_CONFIG.secretAccessKey,
  },
  forcePathStyle: true, // Required for MinIO
});

/**
 * Generates a presigned URL for streaming a video file.
 * Enables direct client-to-storage streaming without proxying through the API server.
 *
 * @param videoKey - S3 object key for the video file (e.g., "videos/{id}/720p/video.mp4")
 * @param expiresIn - URL validity duration in seconds (default: 1 hour)
 * @returns Promise resolving to a presigned URL for video playback
 */
export async function getVideoStreamUrl(videoKey: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: MINIO_CONFIG.bucket,
    Key: videoKey,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generates a presigned URL for uploading a video file.
 * Used by admin tools to upload new video content directly to storage.
 *
 * @param videoKey - Destination S3 object key for the upload
 * @param contentType - MIME type of the video (e.g., "video/mp4")
 * @param expiresIn - URL validity duration in seconds (default: 1 hour)
 * @returns Promise resolving to a presigned upload URL
 */
export async function getUploadUrl(videoKey: string, contentType: string, expiresIn = 3600): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: MINIO_CONFIG.bucket,
    Key: videoKey,
    ContentType: contentType,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Lists available quality variants for a video.
 * Scans the storage bucket to find all encoded quality levels for adaptive streaming.
 *
 * @param videoId - The video's unique identifier
 * @returns Promise resolving to an array of quality names (e.g., ["720p", "1080p"])
 */
export async function listVideoQualities(videoId: string): Promise<string[]> {
  const command = new ListObjectsV2Command({
    Bucket: MINIO_CONFIG.bucket,
    Prefix: `videos/${videoId}/`,
  });

  const response = await s3Client.send(command);
  const qualities: string[] = [];

  if (response.Contents) {
    for (const obj of response.Contents) {
      if (obj.Key) {
        // Extract quality from path like videos/{videoId}/720p/video.mp4
        const parts = obj.Key.split('/');
        if (parts.length >= 3) {
          const quality = parts[2];
          if (!qualities.includes(quality)) {
            qualities.push(quality);
          }
        }
      }
    }
  }

  return qualities;
}

/**
 * Constructs a public URL for a video thumbnail.
 * Thumbnails are served directly from storage without presigning.
 *
 * @param thumbnailKey - S3 object key for the thumbnail image
 * @returns Direct URL to the thumbnail
 */
export async function getThumbnailUrl(thumbnailKey: string): Promise<string> {
  // For public thumbnails, return direct URL
  return `${MINIO_CONFIG.endpoint}/${MINIO_CONFIG.thumbnailBucket}/${thumbnailKey}`;
}

/**
 * Generates a DASH (Dynamic Adaptive Streaming over HTTP) manifest.
 * Creates an MPD file for adaptive bitrate streaming, allowing the player
 * to switch between quality levels based on network conditions.
 *
 * @param videoId - The video's unique identifier
 * @param qualities - Array of available quality profiles with bitrate and resolution
 * @param durationSeconds - Total video duration in seconds
 * @returns DASH MPD manifest as XML string
 */
export function generateDashManifest(
  videoId: string,
  qualities: Array<{ quality: string; bitrate: number; width: number; height: number }>,
  durationSeconds: number
): string {
  const segmentDuration = 4;
  const _segmentCount = Math.ceil(durationSeconds / segmentDuration);

  const representations = qualities
    .map(
      (q) => `
        <Representation
          id="${q.quality}"
          bandwidth="${q.bitrate * 1000}"
          width="${q.width}"
          height="${q.height}"
          codecs="avc1.640028">
          <BaseURL>${MINIO_CONFIG.endpoint}/${MINIO_CONFIG.bucket}/videos/${videoId}/${q.quality}/</BaseURL>
          <SegmentTemplate
            media="segment-$Number$.m4s"
            initialization="init.mp4"
            duration="${segmentDuration}"
            startNumber="1"
            timescale="1"/>
        </Representation>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static"
     mediaPresentationDuration="PT${durationSeconds}S"
     minBufferTime="PT${segmentDuration}S"
     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet
      mimeType="video/mp4"
      segmentAlignment="true"
      startWithSAP="1">
      ${representations}
    </AdaptationSet>
  </Period>
</MPD>`;
}

/**
 * Generates a simplified streaming manifest for demo purposes.
 * Returns a JSON structure that the frontend can use to select quality levels.
 * This is a simplified alternative to DASH/HLS for the demo implementation.
 *
 * @param videoId - The video's unique identifier
 * @param qualities - Array of available quality profiles
 * @param baseUrl - Base URL of the API server for constructing stream URLs
 * @returns JSON string with video ID and quality options with URLs
 */
export function generateSimpleManifest(
  videoId: string,
  qualities: Array<{ quality: string; bitrate: number; width: number; height: number }>,
  baseUrl: string
): string {
  // For demo, we'll use a simpler format that the frontend can understand
  return JSON.stringify({
    videoId,
    qualities: qualities.map((q) => ({
      ...q,
      url: `${baseUrl}/api/stream/${videoId}/${q.quality}`,
    })),
  });
}
