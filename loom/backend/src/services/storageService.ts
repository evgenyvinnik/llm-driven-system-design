import * as Minio from 'minio';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { createCircuitBreaker } from './circuitBreaker.js';

/** Exposes the client's protected `listParts`, which multipart completion needs. */
class StorageClient extends Minio.Client {
  listUploadedParts(bucketName: string, objectName: string, uploadId: string) {
    return this.listParts(bucketName, objectName, uploadId);
  }
}

const minioClient = new StorageClient({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
  region: config.minio.region,
});

/** S3 error codes that are answers about the request, not signs that storage is down. */
const CLIENT_ERROR_CODES = new Set([
  'NoSuchKey',
  'NotFound',
  'NoSuchUpload',
  'EntityTooSmall',
  'InvalidPart',
  'InvalidPartOrder',
]);

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** True when storage answered "that object or upload does not exist". */
export function isNotFoundError(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchUpload';
}

/**
 * One breaker for control-plane calls (stat, multipart bookkeeping, deletes). Presigning
 * is local HMAC work and never goes through it; bulk transfers in the worker are long
 * by nature and don't either. "Not found" style errors are filtered so a missing object
 * can't open the circuit for everyone else.
 */
const storageBreaker = createCircuitBreaker(
  (...args: unknown[]) => (args[0] as () => Promise<unknown>)(),
  'object-storage',
  {
    volumeThreshold: 5,
    errorFilter: (err: unknown) => CLIENT_ERROR_CODES.has(errorCode(err) ?? ''),
  },
);

function guarded<T>(op: () => Promise<T>): Promise<T> {
  return storageBreaker.fire(op) as Promise<T>;
}

/** Ensures the configured MinIO bucket exists, creating it if necessary. */
export async function ensureBucket(): Promise<void> {
  try {
    const exists = await minioClient.bucketExists(config.minio.bucket);
    if (!exists) {
      await minioClient.makeBucket(config.minio.bucket, config.minio.region);
      logger.info({ bucket: config.minio.bucket }, 'Created MinIO bucket');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to ensure MinIO bucket');
  }
}

/** Generates a presigned GET URL for video playback or a thumbnail. Local, no network. */
export async function getPresignedDownloadUrl(
  objectName: string,
  expirySeconds: number = config.upload.playbackUrlTtlSeconds,
): Promise<string> {
  return minioClient.presignedGetObject(config.minio.bucket, objectName, expirySeconds);
}

/** Opens an S3 multipart upload and returns its upload ID. */
export async function startMultipartUpload(objectName: string, contentType: string): Promise<string> {
  return guarded(() =>
    minioClient.initiateNewMultipartUpload(config.minio.bucket, objectName, {
      'Content-Type': contentType,
    }),
  );
}

/** Presigns a PUT for one part of an open multipart upload. Local, no network. */
export async function getPresignedPartUrl(
  objectName: string,
  uploadId: string,
  partNumber: number,
  expirySeconds: number = config.upload.partUrlTtlSeconds,
): Promise<string> {
  return minioClient.presignedUrl('PUT', config.minio.bucket, objectName, expirySeconds, {
    uploadId,
    partNumber: String(partNumber),
  });
}

/** Parts storage actually holds for an upload, ascending by part number. */
export async function listUploadedParts(
  objectName: string,
  uploadId: string,
): Promise<{ part: number; etag: string; size: number }[]> {
  const parts = await guarded(() =>
    minioClient.listUploadedParts(config.minio.bucket, objectName, uploadId),
  );
  return parts
    .map((p) => ({ part: p.part, etag: p.etag, size: p.size }))
    .sort((a, b) => a.part - b.part);
}

/** Stitches the listed parts into the final object. */
export async function completeMultipartUpload(
  objectName: string,
  uploadId: string,
  parts: { part: number; etag: string }[],
): Promise<void> {
  await guarded(() =>
    minioClient.completeMultipartUpload(config.minio.bucket, objectName, uploadId, parts),
  );
}

/** Discards an open multipart upload and its parts. A missing upload is not an error. */
export async function abortMultipartUpload(objectName: string, uploadId: string): Promise<void> {
  try {
    await guarded(() => minioClient.abortMultipartUpload(config.minio.bucket, objectName, uploadId));
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

/** Deletes a video or thumbnail object from MinIO. */
export async function deleteObject(objectName: string): Promise<void> {
  await guarded(() => minioClient.removeObject(config.minio.bucket, objectName));
}

/** Retrieves metadata (size, etag, etc.) for an object in MinIO. */
export async function getObjectStat(objectName: string): Promise<Minio.BucketItemStat> {
  return guarded(() => minioClient.statObject(config.minio.bucket, objectName));
}

/** Downloads an object to a local file (worker only). */
export async function downloadToFile(objectName: string, filePath: string): Promise<void> {
  await minioClient.fGetObject(config.minio.bucket, objectName, filePath);
}

/** Uploads a local file to an object key (worker only). */
export async function uploadFromFile(
  objectName: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  await minioClient.fPutObject(config.minio.bucket, objectName, filePath, {
    'Content-Type': contentType,
  });
}

export { minioClient };
