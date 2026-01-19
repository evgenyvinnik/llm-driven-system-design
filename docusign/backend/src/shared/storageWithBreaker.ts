import { createCircuitBreaker, CircuitBreakerWithState } from './circuitBreaker.js';
import { storageOperationDuration, storageOperationErrors } from './metrics.js';
import logger from './logger.js';
import * as MinioOriginal from '../utils/minio.js';

/**
 * Storage Operations with Circuit Breaker
 *
 * WHY CIRCUIT BREAKERS PROTECT DOCUMENT STORAGE:
 *
 * 1. PREVENT CASCADE FAILURES: If MinIO is slow or down, without a circuit
 *    breaker the entire application would queue requests, eventually running
 *    out of connections and memory, causing total system failure.
 *
 * 2. FAIL FAST: When storage is known to be unavailable, requests fail
 *    immediately instead of waiting for timeout. This preserves resources
 *    and improves user experience (fast error vs. hung request).
 *
 * 3. AUTOMATIC RECOVERY: The circuit breaker automatically tests storage
 *    availability and recovers when the service is back online.
 *
 * 4. GRACEFUL DEGRADATION: With fallback behaviors, the system can continue
 *    serving read-only operations or queue writes for later retry.
 *
 * 5. OBSERVABILITY: Circuit breaker state transitions are logged and tracked,
 *    providing early warning of storage issues.
 *
 * 6. RESOURCE PROTECTION: Prevents thread/connection exhaustion during
 *    storage outages, keeping other system components operational.
 */

export interface StorageHealthStatus {
  uploadDocument: { opened: boolean; halfOpen: boolean };
  getDocument: { opened: boolean; halfOpen: boolean };
  uploadSignature: { opened: boolean; halfOpen: boolean };
  getSignature: { opened: boolean; halfOpen: boolean };
  presignDocument: { opened: boolean; halfOpen: boolean };
  presignSignature: { opened: boolean; halfOpen: boolean };
}

// Create circuit breakers for storage operations
const uploadDocumentBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_upload_document',
  async (key: string, buffer: Buffer, contentType: string): Promise<string> => {
    const end = storageOperationDuration.startTimer({ operation: 'upload', bucket: 'documents' });
    try {
      const result = await MinioOriginal.uploadDocument(key, buffer, contentType);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'upload', bucket: 'documents' });
      throw error;
    }
  },
  { timeout: 30000, errorThresholdPercentage: 50 }
);

const getDocumentBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_get_document',
  async (key: string): Promise<Buffer> => {
    const end = storageOperationDuration.startTimer({ operation: 'get', bucket: 'documents' });
    try {
      const result = await MinioOriginal.getDocumentBuffer(key);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'get', bucket: 'documents' });
      throw error;
    }
  },
  { timeout: 15000, errorThresholdPercentage: 50 }
);

const uploadSignatureBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_upload_signature',
  async (key: string, buffer: Buffer, contentType: string): Promise<string> => {
    const end = storageOperationDuration.startTimer({ operation: 'upload', bucket: 'signatures' });
    try {
      const result = await MinioOriginal.uploadSignature(key, buffer, contentType);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'upload', bucket: 'signatures' });
      throw error;
    }
  },
  { timeout: 15000, errorThresholdPercentage: 50 }
);

const getSignatureBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_get_signature',
  async (key: string): Promise<Buffer> => {
    const end = storageOperationDuration.startTimer({ operation: 'get', bucket: 'signatures' });
    try {
      const result = await MinioOriginal.getSignatureBuffer(key);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'get', bucket: 'signatures' });
      throw error;
    }
  },
  { timeout: 15000, errorThresholdPercentage: 50 }
);

const getDocumentUrlBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_presign_document',
  async (key: string, expiresInSeconds: number): Promise<string> => {
    const end = storageOperationDuration.startTimer({ operation: 'presign', bucket: 'documents' });
    try {
      const result = await MinioOriginal.getDocumentUrl(key, expiresInSeconds);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'presign', bucket: 'documents' });
      throw error;
    }
  },
  { timeout: 5000, errorThresholdPercentage: 50 }
);

const getSignatureUrlBreaker: CircuitBreakerWithState = createCircuitBreaker(
  'minio_presign_signature',
  async (key: string, expiresInSeconds: number): Promise<string> => {
    const end = storageOperationDuration.startTimer({ operation: 'presign', bucket: 'signatures' });
    try {
      const result = await MinioOriginal.getSignatureUrl(key, expiresInSeconds);
      end();
      return result;
    } catch (error) {
      storageOperationErrors.inc({ operation: 'presign', bucket: 'signatures' });
      throw error;
    }
  },
  { timeout: 5000, errorThresholdPercentage: 50 }
);

/**
 * Upload document with circuit breaker protection.
 */
export async function uploadDocument(key: string, buffer: Buffer, contentType: string): Promise<string> {
  try {
    return await uploadDocumentBreaker.fire(key, buffer, contentType) as string;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Document upload failed (circuit breaker)');
    throw error;
  }
}

/**
 * Get document buffer with circuit breaker protection.
 */
export async function getDocumentBuffer(key: string): Promise<Buffer> {
  try {
    return await getDocumentBreaker.fire(key) as Buffer;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Document retrieval failed (circuit breaker)');
    throw error;
  }
}

/**
 * Upload signature with circuit breaker protection.
 */
export async function uploadSignature(key: string, buffer: Buffer, contentType: string): Promise<string> {
  try {
    return await uploadSignatureBreaker.fire(key, buffer, contentType) as string;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Signature upload failed (circuit breaker)');
    throw error;
  }
}

/**
 * Get signature buffer with circuit breaker protection.
 */
export async function getSignatureBuffer(key: string): Promise<Buffer> {
  try {
    return await getSignatureBreaker.fire(key) as Buffer;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Signature retrieval failed (circuit breaker)');
    throw error;
  }
}

/**
 * Get presigned document URL with circuit breaker protection.
 */
export async function getDocumentUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
  try {
    return await getDocumentUrlBreaker.fire(key, expiresInSeconds) as string;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Document URL generation failed (circuit breaker)');
    throw error;
  }
}

/**
 * Get presigned signature URL with circuit breaker protection.
 */
export async function getSignatureUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
  try {
    return await getSignatureUrlBreaker.fire(key, expiresInSeconds) as string;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, key }, 'Signature URL generation failed (circuit breaker)');
    throw error;
  }
}

// Re-export initialization and other functions that don't need circuit breaker
export { minioClient, initializeMinio } from '../utils/minio.js';

/**
 * Get storage health status including circuit breaker states.
 */
export function getStorageHealth(): StorageHealthStatus {
  return {
    uploadDocument: {
      opened: uploadDocumentBreaker.opened,
      halfOpen: uploadDocumentBreaker.halfOpen,
    },
    getDocument: {
      opened: getDocumentBreaker.opened,
      halfOpen: getDocumentBreaker.halfOpen,
    },
    uploadSignature: {
      opened: uploadSignatureBreaker.opened,
      halfOpen: uploadSignatureBreaker.halfOpen,
    },
    getSignature: {
      opened: getSignatureBreaker.opened,
      halfOpen: getSignatureBreaker.halfOpen,
    },
    presignDocument: {
      opened: getDocumentUrlBreaker.opened,
      halfOpen: getDocumentUrlBreaker.halfOpen,
    },
    presignSignature: {
      opened: getSignatureUrlBreaker.opened,
      halfOpen: getSignatureUrlBreaker.halfOpen,
    },
  };
}

export default {
  uploadDocument,
  getDocumentBuffer,
  uploadSignature,
  getSignatureBuffer,
  getDocumentUrl,
  getSignatureUrl,
  getStorageHealth,
};
