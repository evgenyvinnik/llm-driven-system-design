import * as Minio from 'minio';
import { config } from './index.js';

export const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

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

export function getPublicUrl(bucket: string, objectName: string): string {
  const { endpoint, port, useSSL } = config.minio;
  const protocol = useSSL ? 'https' : 'http';
  return `${protocol}://${endpoint}:${port}/${bucket}/${objectName}`;
}

export async function deleteFile(bucket: string, objectName: string): Promise<void> {
  await minioClient.removeObject(bucket, objectName);
}

export async function getPresignedUploadUrl(
  bucket: string,
  objectName: string,
  expirySeconds = 3600
): Promise<string> {
  return await minioClient.presignedPutObject(bucket, objectName, expirySeconds);
}

export async function getPresignedDownloadUrl(
  bucket: string,
  objectName: string,
  expirySeconds = 3600
): Promise<string> {
  return await minioClient.presignedGetObject(bucket, objectName, expirySeconds);
}
