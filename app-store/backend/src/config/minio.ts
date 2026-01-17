/**
 * @fileoverview MinIO (S3-compatible) object storage client and utilities.
 * Handles app packages, screenshots, and icon storage for the App Store.
 */

import * as Minio from 'minio';
import { config } from './index.js';

/**
 * MinIO client instance configured from environment settings.
 * Provides S3-compatible object storage operations.
 */
export const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

/**
 * Ensures all required storage buckets exist.
 * Creates buckets for packages, screenshots, and icons if missing.
 * Called during server startup.
 */
export async function ensureBuckets(): Promise<void> {
  const buckets = Object.values(config.minio.buckets);

  for (const bucket of buckets) {
    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
      console.log(`Created MinIO bucket: ${bucket}`);
    }
  }
}

/**
 * Uploads a file buffer to MinIO and returns its public URL.
 * @param bucket - Target bucket name (e.g., 'icons', 'screenshots')
 * @param objectName - Object key/path within the bucket
 * @param buffer - File content as Buffer
 * @param contentType - MIME type of the file
 * @returns Public URL for accessing the uploaded file
 */
export async function uploadFile(
  bucket: string,
  objectName: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  await minioClient.putObject(bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
  });

  return getPublicUrl(bucket, objectName);
}

/**
 * Constructs the public URL for an object in MinIO.
 * @param bucket - Bucket name
 * @param objectName - Object key/path
 * @returns Full URL for accessing the object
 */
export function getPublicUrl(bucket: string, objectName: string): string {
  const { endpoint, port, useSSL } = config.minio;
  const protocol = useSSL ? 'https' : 'http';
  return `${protocol}://${endpoint}:${port}/${bucket}/${objectName}`;
}

/**
 * Deletes an object from MinIO storage.
 * @param bucket - Bucket name
 * @param objectName - Object key/path to delete
 */
export async function deleteFile(bucket: string, objectName: string): Promise<void> {
  await minioClient.removeObject(bucket, objectName);
}

/**
 * Generates a presigned URL for direct client uploads.
 * Allows clients to upload files directly to MinIO without proxying through the API.
 * @param bucket - Target bucket name
 * @param objectName - Object key/path for the upload
 * @param expirySeconds - URL validity period (default: 3600 seconds)
 * @returns Presigned PUT URL
 */
export async function getPresignedUploadUrl(
  bucket: string,
  objectName: string,
  expirySeconds = 3600
): Promise<string> {
  return await minioClient.presignedPutObject(bucket, objectName, expirySeconds);
}

/**
 * Generates a presigned URL for temporary download access.
 * Useful for providing time-limited access to private files.
 * @param bucket - Bucket name
 * @param objectName - Object key/path
 * @param expirySeconds - URL validity period (default: 3600 seconds)
 * @returns Presigned GET URL
 */
export async function getPresignedDownloadUrl(
  bucket: string,
  objectName: string,
  expirySeconds = 3600
): Promise<string> {
  return await minioClient.presignedGetObject(bucket, objectName, expirySeconds);
}
