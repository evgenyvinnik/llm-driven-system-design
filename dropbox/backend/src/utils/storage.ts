/**
 * MinIO/S3 object storage utilities for chunk storage and retrieval.
 * Chunks are stored in a content-addressed manner using their SHA-256 hash.
 * Supports presigned URLs for direct client uploads/downloads.
 *
 * Features:
 * - Circuit breaker protection against cascading failures
 * - Retry with exponential backoff for transient errors
 * - Prometheus metrics for observability
 *
 * @module utils/storage
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger, logChunkOperation } from '../shared/logger.js';
import {
  withResilience,
  resilientUploadPolicy,
  resilientDownloadPolicy,
  CircuitBreakerOpenError,
} from '../shared/circuitBreaker.js';
import {
  uploadChunksTotal,
  uploadBytesTotal,
  uploadChunkSize,
  downloadBytesTotal,
  downloadDuration,
  deduplicationTotal,
} from '../shared/metrics.js';

// MinIO connection configuration from environment variables
const endpoint = process.env.MINIO_ENDPOINT || 'localhost';
const port = process.env.MINIO_PORT || '9000';
const useSSL = process.env.MINIO_USE_SSL === 'true';
const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin123';
const bucket = process.env.MINIO_BUCKET || 'dropbox-chunks';

/**
 * S3-compatible client configured for MinIO.
 * forcePathStyle is required for MinIO compatibility.
 */
export const s3Client = new S3Client({
  endpoint: `${useSSL ? 'https' : 'http'}://${endpoint}:${port}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

/** Name of the S3 bucket where chunks are stored */
export const BUCKET_NAME = bucket;

/**
 * Uploads a chunk to object storage with circuit breaker and retry protection.
 * Chunks are stored with their hash as the key for content-addressing.
 *
 * WHY circuit breakers protect storage services:
 * - Prevents cascading failures when MinIO is overloaded or unavailable
 * - Fails fast instead of waiting for timeouts, improving user experience
 * - Gives the storage service time to recover by reducing load
 *
 * @param hash - SHA-256 hash of the chunk data (used as storage key)
 * @param data - Raw chunk data to store
 * @returns Storage key where the chunk was saved
 * @throws CircuitBreakerOpenError if storage is unavailable
 */
export async function uploadChunk(hash: string, data: Buffer): Promise<string> {
  const key = getChunkKey(hash);
  const startTime = Date.now();

  try {
    await withResilience(async () => {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
          Body: data,
          ContentType: 'application/octet-stream',
        })
      );
    }, resilientUploadPolicy);

    // Record success metrics
    uploadChunksTotal.labels('success').inc();
    uploadBytesTotal.inc(data.length);
    uploadChunkSize.observe(data.length);

    logChunkOperation(
      {
        chunkHash: hash,
        chunkSize: data.length,
        operation: 'upload',
      },
      'Chunk uploaded successfully'
    );

    return key;
  } catch (error) {
    uploadChunksTotal.labels('failed').inc();

    if (error instanceof CircuitBreakerOpenError) {
      logger.error(
        { hash, error: error.message },
        'Storage circuit breaker open - chunk upload rejected'
      );
      throw error;
    }

    logger.error(
      { hash, error: (error as Error).message, durationMs: Date.now() - startTime },
      'Chunk upload failed'
    );
    throw error;
  }
}

/**
 * Downloads a chunk from object storage with circuit breaker and retry protection.
 * Streams the response body and concatenates into a Buffer.
 *
 * @param hash - SHA-256 hash identifying the chunk
 * @returns Raw chunk data as a Buffer
 * @throws CircuitBreakerOpenError if storage is unavailable
 */
export async function downloadChunk(hash: string): Promise<Buffer> {
  const key = getChunkKey(hash);
  const startTime = Date.now();

  try {
    const response = await withResilience(async () => {
      return await s3Client.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        })
      );
    }, resilientDownloadPolicy);

    const chunks: Uint8Array[] = [];
    const stream = response.Body as AsyncIterable<Uint8Array>;

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const data = Buffer.concat(chunks);

    // Record metrics
    downloadBytesTotal.inc(data.length);
    downloadDuration.observe((Date.now() - startTime) / 1000);

    logChunkOperation(
      {
        chunkHash: hash,
        chunkSize: data.length,
        operation: 'download',
      },
      'Chunk downloaded successfully'
    );

    return data;
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      logger.error(
        { hash, error: error.message },
        'Storage circuit breaker open - chunk download rejected'
      );
      throw error;
    }

    logger.error(
      { hash, error: (error as Error).message, durationMs: Date.now() - startTime },
      'Chunk download failed'
    );
    throw error;
  }
}

/**
 * Checks if a chunk already exists in storage.
 * Used for deduplication - skip uploading chunks that already exist.
 * This operation is lightweight (HEAD request) and doesn't use circuit breaker.
 *
 * @param hash - SHA-256 hash of the chunk to check
 * @returns true if chunk exists, false otherwise
 */
export async function chunkExists(hash: string): Promise<boolean> {
  const key = getChunkKey(hash);

  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      })
    );

    // Track deduplication event
    deduplicationTotal.inc();

    logChunkOperation(
      {
        chunkHash: hash,
        operation: 'check',
        deduplicated: true,
      },
      'Chunk already exists (deduplication)'
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a chunk from object storage.
 * Called during garbage collection when reference count reaches zero.
 * Uses circuit breaker protection.
 *
 * @param hash - SHA-256 hash of the chunk to delete
 */
export async function deleteChunk(hash: string): Promise<void> {
  const key = getChunkKey(hash);

  try {
    await withResilience(async () => {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        })
      );
    }, resilientUploadPolicy); // Use upload policy for write operations

    logChunkOperation(
      {
        chunkHash: hash,
        operation: 'delete',
      },
      'Chunk deleted successfully'
    );
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      logger.error(
        { hash, error: error.message },
        'Storage circuit breaker open - chunk delete rejected'
      );
      throw error;
    }

    logger.error({ hash, error: (error as Error).message }, 'Chunk delete failed');
    throw error;
  }
}

/**
 * Generates a presigned URL for direct chunk upload from the client.
 * Enables large file uploads without proxying through the API server.
 *
 * @param hash - SHA-256 hash for the chunk being uploaded
 * @param expiresIn - URL validity in seconds (default 1 hour)
 * @returns Presigned URL for PUT request
 */
export async function getUploadPresignedUrl(
  hash: string,
  expiresIn: number = 3600
): Promise<string> {
  const key = getChunkKey(hash);

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: 'application/octet-stream',
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });

  logger.debug({ hash, expiresIn }, 'Generated upload presigned URL');

  return url;
}

/**
 * Generates a presigned URL for direct chunk download.
 * Enables parallel chunk downloads directly from storage.
 *
 * @param hash - SHA-256 hash of the chunk to download
 * @param expiresIn - URL validity in seconds (default 1 hour)
 * @returns Presigned URL for GET request
 */
export async function getDownloadPresignedUrl(
  hash: string,
  expiresIn: number = 3600
): Promise<string> {
  const key = getChunkKey(hash);

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });

  logger.debug({ hash, expiresIn }, 'Generated download presigned URL');

  return url;
}

/**
 * Generates the storage key for a chunk.
 * Chunks are organized into subdirectories by hash prefix for better filesystem performance.
 *
 * @param hash - SHA-256 hash of the chunk
 * @returns Storage key path (e.g., "chunks/ab/abcdef123...")
 */
function getChunkKey(hash: string): string {
  const prefix = hash.substring(0, 2);
  return `chunks/${prefix}/${hash}`;
}
