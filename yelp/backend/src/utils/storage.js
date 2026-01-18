import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'yelp-photos';

const s3Client = new S3Client({
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
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} originalName - Original filename
 * @param {string} mimeType - MIME type of the file
 * @param {string} folder - Folder prefix (e.g., 'business', 'review')
 * @returns {Promise<string>} - The public URL of the uploaded file
 */
export async function uploadPhoto(fileBuffer, originalName, mimeType, folder = 'photos') {
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
 * @param {string} url - The full URL of the file to delete
 * @returns {Promise<void>}
 */
export async function deletePhoto(url) {
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
