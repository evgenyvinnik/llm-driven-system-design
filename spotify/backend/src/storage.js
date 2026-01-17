import { Client as MinioClient } from 'minio';

export const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

export const AUDIO_BUCKET = 'audio';
export const COVERS_BUCKET = 'covers';

export function getPublicUrl(bucket, objectName) {
  const endpoint = process.env.MINIO_PUBLIC_ENDPOINT || 'http://localhost:9000';
  return `${endpoint}/${bucket}/${objectName}`;
}

export async function getPresignedUrl(bucket, objectName, expiry = 3600) {
  return await minio.presignedGetObject(bucket, objectName, expiry);
}
