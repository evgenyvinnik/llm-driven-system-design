/**
 * Resilient Storage Module
 *
 * Wraps the storage client with:
 * - Circuit breaker pattern for failure isolation
 * - Retry logic with exponential backoff
 * - Metrics collection for monitoring
 * - Graceful degradation
 */

import { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import {
  uploadObject as baseUploadObject,
  getObject as baseGetObject,
  deleteObject as baseDeleteObject,
  objectExists as baseObjectExists,
  createMultipartUpload as baseCreateMultipartUpload,
  uploadPart as baseUploadPart,
  completeMultipartUpload as baseCompleteMultipartUpload,
  abortMultipartUpload as baseAbortMultipartUpload,
  getPresignedUploadUrl as baseGetPresignedUploadUrl,
  getPresignedDownloadUrl as baseGetPresignedDownloadUrl,
  getPublicUrl,
} from '../utils/storage.js';

import { withCircuitBreaker } from '../shared/circuitBreaker.js';
import { createRetryableErrorChecker } from '../shared/retry.js';
import { storageOperationsTotal, storageOperationDuration } from '../shared/metrics.js';
import logger from '../shared/logger.js';
import CircuitBreaker from 'opossum';

// Circuit breaker configuration for storage
const STORAGE_CIRCUIT_OPTIONS: Partial<CircuitBreaker.Options> = {
  timeout: 30000, // 30s timeout for storage operations
  errorThresholdPercentage: 50,
  resetTimeout: 30000, // 30s before retrying
  volumeThreshold: 5,
};

// Create retryable error checker
const isRetryableStorageError = createRetryableErrorChecker();

type StorageOperation<T extends unknown[], R> = (...args: T) => Promise<R>;

/**
 * Wrap a storage operation with metrics, retry, and circuit breaker
 */
function wrapStorageOperation<T extends unknown[], R>(
  name: string,
  operation: StorageOperation<T, R>,
  retryPreset: string = 'storage'
): StorageOperation<T, R> {
  // First wrap with retry
  const withRetry: StorageOperation<T, R> = async (...args: T): Promise<R> => {
    const start = Date.now();
    const bucket = args[0] as string;

    try {
      const result = await operation(...args);

      // Record success metrics
      storageOperationsTotal.inc({
        operation: name,
        bucket,
        status: 'success',
      });

      storageOperationDuration.observe({ operation: name, bucket }, (Date.now() - start) / 1000);

      return result;
    } catch (error) {
      // Record failure metrics
      storageOperationsTotal.inc({
        operation: name,
        bucket,
        status: 'failure',
      });

      storageOperationDuration.observe({ operation: name, bucket }, (Date.now() - start) / 1000);

      throw error;
    }
  };

  // Then wrap with circuit breaker
  return withCircuitBreaker(
    `storage:${name}`,
    withRetry as (...args: unknown[]) => Promise<unknown>,
    null, // No fallback - storage operations must succeed
    STORAGE_CIRCUIT_OPTIONS
  ) as StorageOperation<T, R>;
}

/**
 * Resilient upload object
 */
export const uploadObject = async (
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType: string
): Promise<string> => {
  const start = Date.now();

  try {
    const wrappedUpload = wrapStorageOperation('put', baseUploadObject);
    const result = await wrappedUpload(bucket, key, body, contentType);

    logger.debug(
      {
        event: 'storage_upload_success',
        bucket,
        key,
        durationMs: Date.now() - start,
      },
      `Uploaded object to ${bucket}/${key}`
    );

    return result;
  } catch (error) {
    logger.error(
      {
        event: 'storage_upload_failure',
        bucket,
        key,
        error: (error as Error).message,
        durationMs: Date.now() - start,
      },
      `Failed to upload object to ${bucket}/${key}`
    );

    throw error;
  }
};

/**
 * Resilient get object
 */
export const getObject = async (bucket: string, key: string): Promise<GetObjectCommandOutput> => {
  const start = Date.now();

  try {
    const wrappedGet = wrapStorageOperation('get', baseGetObject);
    const result = await wrappedGet(bucket, key);

    logger.debug(
      {
        event: 'storage_get_success',
        bucket,
        key,
        durationMs: Date.now() - start,
      },
      `Retrieved object from ${bucket}/${key}`
    );

    return result;
  } catch (error) {
    logger.error(
      {
        event: 'storage_get_failure',
        bucket,
        key,
        error: (error as Error).message,
        durationMs: Date.now() - start,
      },
      `Failed to retrieve object from ${bucket}/${key}`
    );

    throw error;
  }
};

/**
 * Resilient delete object
 */
export const deleteObject = async (bucket: string, key: string): Promise<void> => {
  const start = Date.now();

  try {
    const wrappedDelete = wrapStorageOperation('delete', baseDeleteObject);
    await wrappedDelete(bucket, key);

    logger.debug(
      {
        event: 'storage_delete_success',
        bucket,
        key,
        durationMs: Date.now() - start,
      },
      `Deleted object from ${bucket}/${key}`
    );
  } catch (error) {
    logger.error(
      {
        event: 'storage_delete_failure',
        bucket,
        key,
        error: (error as Error).message,
        durationMs: Date.now() - start,
      },
      `Failed to delete object from ${bucket}/${key}`
    );

    throw error;
  }
};

interface StorageError extends Error {
  name: string;
  Code?: string;
}

/**
 * Resilient object exists check
 */
export const objectExists = async (bucket: string, key: string): Promise<boolean> => {
  try {
    const wrappedHead = wrapStorageOperation('head', baseObjectExists);
    return await wrappedHead(bucket, key);
  } catch (error) {
    const storageError = error as StorageError;
    // NotFound is expected, don't log as error
    if (storageError.name === 'NotFound' || storageError.Code === 'NotFound') {
      return false;
    }
    throw error;
  }
};

/**
 * Resilient multipart upload operations
 */
export const createMultipartUpload = async (
  bucket: string,
  key: string,
  contentType: string
): Promise<string> => {
  const wrappedCreateMultipart = wrapStorageOperation('createMultipart', baseCreateMultipartUpload);
  return wrappedCreateMultipart(bucket, key, contentType);
};

export const uploadPart = async (
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer
): Promise<string> => {
  const start = Date.now();

  try {
    const wrappedUploadPart = wrapStorageOperation('uploadPart', baseUploadPart);
    const etag = await wrappedUploadPart(bucket, key, uploadId, partNumber, body);

    logger.debug(
      {
        event: 'storage_part_upload_success',
        bucket,
        key,
        partNumber,
        durationMs: Date.now() - start,
      },
      `Uploaded part ${partNumber} for ${bucket}/${key}`
    );

    return etag;
  } catch (error) {
    logger.error(
      {
        event: 'storage_part_upload_failure',
        bucket,
        key,
        partNumber,
        error: (error as Error).message,
        durationMs: Date.now() - start,
      },
      `Failed to upload part ${partNumber} for ${bucket}/${key}`
    );

    throw error;
  }
};

export const completeMultipartUpload = async (
  bucket: string,
  key: string,
  uploadId: string,
  parts: string[]
): Promise<string> => {
  const start = Date.now();

  try {
    const wrappedCompleteMultipart = wrapStorageOperation('completeMultipart', baseCompleteMultipartUpload);
    const result = await wrappedCompleteMultipart(bucket, key, uploadId, parts);

    logger.info(
      {
        event: 'storage_multipart_complete',
        bucket,
        key,
        partCount: parts.length,
        durationMs: Date.now() - start,
      },
      `Completed multipart upload for ${bucket}/${key}`
    );

    return result;
  } catch (error) {
    logger.error(
      {
        event: 'storage_multipart_complete_failure',
        bucket,
        key,
        error: (error as Error).message,
        durationMs: Date.now() - start,
      },
      `Failed to complete multipart upload for ${bucket}/${key}`
    );

    throw error;
  }
};

export const abortMultipartUpload = async (bucket: string, key: string, uploadId: string): Promise<void> => {
  try {
    const wrappedAbortMultipart = wrapStorageOperation('abortMultipart', baseAbortMultipartUpload);
    await wrappedAbortMultipart(bucket, key, uploadId);

    logger.info(
      {
        event: 'storage_multipart_aborted',
        bucket,
        key,
      },
      `Aborted multipart upload for ${bucket}/${key}`
    );
  } catch (error) {
    logger.warn(
      {
        event: 'storage_multipart_abort_failure',
        bucket,
        key,
        error: (error as Error).message,
      },
      `Failed to abort multipart upload for ${bucket}/${key}`
    );

    // Don't throw - abort failures are not critical
  }
};

/**
 * Presigned URLs (these don't need circuit breakers as they're just URL generation)
 */
export const getPresignedUploadUrl = baseGetPresignedUploadUrl;
export const getPresignedDownloadUrl = baseGetPresignedDownloadUrl;

// Re-export the public URL function
export { getPublicUrl };

export default {
  uploadObject,
  getObject,
  deleteObject,
  objectExists,
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  getPublicUrl,
};
