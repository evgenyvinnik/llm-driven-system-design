import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.MINIO_ENDPOINT || 'localhost';
const port = process.env.MINIO_PORT || '9000';
const useSSL = process.env.MINIO_USE_SSL === 'true';
const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin123';
const bucket = process.env.MINIO_BUCKET || 'dropbox-chunks';

export const s3Client = new S3Client({
  endpoint: `${useSSL ? 'https' : 'http'}://${endpoint}:${port}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

export const BUCKET_NAME = bucket;

// Upload a chunk to storage
export async function uploadChunk(hash: string, data: Buffer): Promise<string> {
  const key = getChunkKey(hash);

  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: data,
    ContentType: 'application/octet-stream',
  }));

  return key;
}

// Download a chunk from storage
export async function downloadChunk(hash: string): Promise<Buffer> {
  const key = getChunkKey(hash);

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }));

  const chunks: Uint8Array[] = [];
  const stream = response.Body as AsyncIterable<Uint8Array>;

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// Check if chunk exists
export async function chunkExists(hash: string): Promise<boolean> {
  const key = getChunkKey(hash);

  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

// Delete a chunk
export async function deleteChunk(hash: string): Promise<void> {
  const key = getChunkKey(hash);

  await s3Client.send(new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }));
}

// Generate presigned URL for direct upload
export async function getUploadPresignedUrl(hash: string, expiresIn: number = 3600): Promise<string> {
  const key = getChunkKey(hash);

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: 'application/octet-stream',
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

// Generate presigned URL for download
export async function getDownloadPresignedUrl(hash: string, expiresIn: number = 3600): Promise<string> {
  const key = getChunkKey(hash);

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

// Helper to get chunk storage key (organized by first 2 chars of hash)
function getChunkKey(hash: string): string {
  const prefix = hash.substring(0, 2);
  return `chunks/${prefix}/${hash}`;
}
