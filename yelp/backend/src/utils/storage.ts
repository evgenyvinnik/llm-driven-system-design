import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const MINIO_ENDPOINT: string =
  process.env.MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS_KEY: string = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY: string = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET: string = process.env.MINIO_BUCKET || 'yelp-photos';

const s3Client: S3Client = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

/**
 * Upload a file to MinIO
 * @param fileBuffer - The file buffer
 * @param originalName - Original filename
 * @param mimeType - MIME type of the file
 * @param folder - Folder prefix (e.g., 'business', 'review')
 * @returns The public URL of the uploaded file
 */
export async function uploadPhoto(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  folder: string = 'photos'
): Promise<string> {
  const ext = path.extname(originalName);
  const key = `${folder}/${uuidv4()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: MINIO_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
  });

  await s3Client.send(command);

  // Return the public URL
  return `${MINIO_ENDPOINT}/${MINIO_BUCKET}/${key}`;
}

/**
 * Delete a file from MinIO
 * @param url - The full URL of the file to delete
 */
export async function deletePhoto(url: string): Promise<void> {
  // Extract key from URL
  const urlObj = new URL(url);
  const key = urlObj.pathname.replace(`/${MINIO_BUCKET}/`, '');

  const command = new DeleteObjectCommand({
    Bucket: MINIO_BUCKET,
    Key: key,
  });

  await s3Client.send(command);
}

export { s3Client, MINIO_BUCKET };
