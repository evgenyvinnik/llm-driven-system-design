import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MINIO_CONFIG } from '../config.js';

// Create S3 client configured for MinIO
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
 * Generate a presigned URL for video streaming
 */
export async function getVideoStreamUrl(videoKey: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: MINIO_CONFIG.bucket,
    Key: videoKey,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Get a presigned URL for uploading a video
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
 * List available quality variants for a video
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
 * Get thumbnail URL
 */
export async function getThumbnailUrl(thumbnailKey: string): Promise<string> {
  // For public thumbnails, return direct URL
  return `${MINIO_CONFIG.endpoint}/${MINIO_CONFIG.thumbnailBucket}/${thumbnailKey}`;
}

/**
 * Generate a DASH manifest for adaptive streaming
 */
export function generateDashManifest(
  videoId: string,
  qualities: Array<{ quality: string; bitrate: number; width: number; height: number }>,
  durationSeconds: number
): string {
  const segmentDuration = 4;
  const segmentCount = Math.ceil(durationSeconds / segmentDuration);

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
 * For demo purposes: generate a simple HLS-like manifest pointing to MP4 files
 * This is a simplified version that works with regular MP4 files
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
