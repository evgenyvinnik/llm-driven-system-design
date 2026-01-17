/**
 * Resilient Storage Module
 *
 * Wraps the storage client with:
 * - Circuit breaker pattern for failure isolation
 * - Retry logic with exponential backoff
 * - Metrics collection for monitoring
 * - Graceful degradation
 */

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

import { withCircuitBreaker, createCircuitBreaker } from '../shared/circuitBreaker.js';
import { withRetryPreset, createRetryableErrorChecker } from '../shared/retry.js';
import { storageOperationsTotal, storageOperationDuration } from '../shared/metrics.js';
import logger from '../shared/logger.js';

// Circuit breaker configuration for storage
const STORAGE_CIRCUIT_OPTIONS = {
  timeout: 30000,           // 30s timeout for storage operations
  errorThresholdPercentage: 50,
  resetTimeout: 30000,      // 30s before retrying
  volumeThreshold: 5,
};

// Create retryable error checker
const isRetryableStorageError = createRetryableErrorChecker();

/**
 * Wrap a storage operation with metrics, retry, and circuit breaker
 */
function wrapStorageOperation(name, operation, retryPreset = 'storage') {
  // First wrap with retry
  const withRetry = async (...args) => {
    const start = Date.now();
    const bucket = args[0];

    try {
      const result = await operation(...args);

      // Record success metrics
      storageOperationsTotal.inc({
        operation: name,
        bucket,
        status: 'success',
      });

      storageOperationDuration.observe(
        { operation: name, bucket },
        (Date.now() - start) / 1000
      );

      return result;
    } catch (error) {
      // Record failure metrics
      storageOperationsTotal.inc({
        operation: name,
        bucket,
        status: 'failure',
      });

      storageOperationDuration.observe(
        { operation: name, bucket },
        (Date.now() - start) / 1000
      );

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
export const uploadObject = async (bucket, key, body, contentType) => {
  const start = Date.now();

  try {
    const result = await wrapStorageOperation('put', baseUploadObject)(
      bucket,
      key,
      body,
      contentType
    );

    logger.debug({
      event: 'storage_upload_success',
      bucket,
      key,
      durationMs: Date.now() - start,
    }, `Uploaded object to ${bucket}/${key}`);

    return result;
  } catch (error) {
    logger.error({
      event: 'storage_upload_failure',
      bucket,
      key,
      error: error.message,
      durationMs: Date.now() - start,
    }, `Failed to upload object to ${bucket}/${key}`);

    throw error;
  }
};

/**
 * Resilient get object
 */
export const getObject = async (bucket, key) => {
  const start = Date.now();

  try {
    const result = await wrapStorageOperation('get', baseGetObject)(bucket, key);

    logger.debug({
      event: 'storage_get_success',
      bucket,
      key,
      durationMs: Date.now() - start,
    }, `Retrieved object from ${bucket}/${key}`);

    return result;
  } catch (error) {
    logger.error({
      event: 'storage_get_failure',
      bucket,
      key,
      error: error.message,
      durationMs: Date.now() - start,
    }, `Failed to retrieve object from ${bucket}/${key}`);

    throw error;
  }
};

/**
 * Resilient delete object
 */
export const deleteObject = async (bucket, key) => {
  const start = Date.now();

  try {
    await wrapStorageOperation('delete', baseDeleteObject)(bucket, key);

    logger.debug({
      event: 'storage_delete_success',
      bucket,
      key,
      durationMs: Date.now() - start,
    }, `Deleted object from ${bucket}/${key}`);
  } catch (error) {
    logger.error({
      event: 'storage_delete_failure',
      bucket,
      key,
      error: error.message,
      durationMs: Date.now() - start,
    }, `Failed to delete object from ${bucket}/${key}`);

    throw error;
  }
};

/**
 * Resilient object exists check
 */
export const objectExists = async (bucket, key) => {
  try {
    return await wrapStorageOperation('head', baseObjectExists)(bucket, key);
  } catch (error) {
    // NotFound is expected, don't log as error
    if (error.name === 'NotFound' || error.Code === 'NotFound') {
      return false;
    }
    throw error;
  }
};

/**
 * Resilient multipart upload operations
 */
export const createMultipartUpload = async (bucket, key, contentType) => {
  return wrapStorageOperation('createMultipart', baseCreateMultipartUpload)(
    bucket,
    key,
    contentType
  );
};

export const uploadPart = async (bucket, key, uploadId, partNumber, body) => {
  const start = Date.now();

  try {
    const etag = await wrapStorageOperation('uploadPart', baseUploadPart)(
      bucket,
      key,
      uploadId,
      partNumber,
      body
    );

    logger.debug({
      event: 'storage_part_upload_success',
      bucket,
      key,
      partNumber,
      durationMs: Date.now() - start,
    }, `Uploaded part ${partNumber} for ${bucket}/${key}`);

    return etag;
  } catch (error) {
    logger.error({
      event: 'storage_part_upload_failure',
      bucket,
      key,
      partNumber,
      error: error.message,
      durationMs: Date.now() - start,
    }, `Failed to upload part ${partNumber} for ${bucket}/${key}`);

    throw error;
  }
};

export const completeMultipartUpload = async (bucket, key, uploadId, parts) => {
  const start = Date.now();

  try {
    const result = await wrapStorageOperation(
      'completeMultipart',
      baseCompleteMultipartUpload
    )(bucket, key, uploadId, parts);

    logger.info({
      event: 'storage_multipart_complete',
      bucket,
      key,
      partCount: parts.length,
      durationMs: Date.now() - start,
    }, `Completed multipart upload for ${bucket}/${key}`);

    return result;
  } catch (error) {
    logger.error({
      event: 'storage_multipart_complete_failure',
      bucket,
      key,
      error: error.message,
      durationMs: Date.now() - start,
    }, `Failed to complete multipart upload for ${bucket}/${key}`);

    throw error;
  }
};

export const abortMultipartUpload = async (bucket, key, uploadId) => {
  try {
    await wrapStorageOperation('abortMultipart', baseAbortMultipartUpload)(
      bucket,
      key,
      uploadId
    );

    logger.info({
      event: 'storage_multipart_aborted',
      bucket,
      key,
    }, `Aborted multipart upload for ${bucket}/${key}`);
  } catch (error) {
    logger.warn({
      event: 'storage_multipart_abort_failure',
      bucket,
      key,
      error: error.message,
    }, `Failed to abort multipart upload for ${bucket}/${key}`);

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
