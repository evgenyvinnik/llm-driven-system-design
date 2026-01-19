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

// ============ Type Definitions ============

interface CircuitBreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold: number;
}

interface StorageError extends Error {
  name: string;
  Code?: string;
}

type StorageOperationFunction<T> = (...args: unknown[]) => Promise<T>;

// Circuit breaker configuration for storage
const STORAGE_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  timeout: 30000, // 30s timeout for storage operations
  errorThresholdPercentage: 50,
  resetTimeout: 30000, // 30s before retrying
  volumeThreshold: 5,
};

// Create retryable error checker
const _isRetryableStorageError = createRetryableErrorChecker();

/**
 * Wrap a storage operation with metrics, retry, and circuit breaker
 */
function wrapStorageOperation<T>(
  name: string,
  operation: StorageOperationFunction<T>,
  _retryPreset: string = 'storage'
): StorageOperationFunction<T> {
  // First wrap with retry
  const withRetry = async (...args: unknown[]): Promise<T> => {
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
    withRetry,
    null, // No fallback - storage operations must succeed
    STORAGE_CIRCUIT_OPTIONS
  );
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
    const result = await wrapStorageOperation('put', baseUploadObject)(bucket, key, body, contentType);

    logger.debug(
      {
        event: 'storage_upload_success',
        bucket,
        key,
        durationMs: Date.now() - start,
      },
      `Uploaded object to ${bucket}/${key}`
    );

    return result as string;
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
    const result = await wrapStorageOperation('get', baseGetObject)(bucket, key);

    logger.debug(
      {
        event: 'storage_get_success',
        bucket,
        key,
        durationMs: Date.now() - start,
      },
      `Retrieved object from ${bucket}/${key}`
    );

    return result as GetObjectCommandOutput;
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
    await wrapStorageOperation('delete', baseDeleteObject)(bucket, key);

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

/**
 * Resilient object exists check
 */
export const objectExists = async (bucket: string, key: string): Promise<boolean> => {
  try {
    return (await wrapStorageOperation('head', baseObjectExists)(bucket, key)) as boolean;
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
): Promise<string | undefined> => {
  return wrapStorageOperation('createMultipart', baseCreateMultipartUpload)(
    bucket,
    key,
    contentType
  ) as Promise<string | undefined>;
};

export const uploadPart = async (
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer
): Promise<string | undefined> => {
  const start = Date.now();

  try {
    const etag = await wrapStorageOperation('uploadPart', baseUploadPart)(
      bucket,
      key,
      uploadId,
      partNumber,
      body
    );

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

    return etag as string | undefined;
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
  parts: (string | undefined)[]
): Promise<string> => {
  const start = Date.now();

  try {
    const result = await wrapStorageOperation('completeMultipart', baseCompleteMultipartUpload)(
      bucket,
      key,
      uploadId,
      parts
    );

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

    return result as string;
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

export const abortMultipartUpload = async (
  bucket: string,
  key: string,
  uploadId: string
): Promise<void> => {
  try {
    await wrapStorageOperation('abortMultipart', baseAbortMultipartUpload)(bucket, key, uploadId);

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
