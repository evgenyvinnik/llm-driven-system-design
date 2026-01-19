/**
 * File and folder management service.
 * Handles file uploads with chunking and deduplication, folder operations,
 * file versioning, and storage hierarchy navigation.
 *
 * Features:
 * - Chunked uploads with deduplication
 * - File versioning with restore capability
 * - Prometheus metrics for all operations
 * - Structured logging for observability
 *
 * WHY sync metrics enable client optimization:
 * - Clients can measure actual sync latency vs. perceived latency
 * - Server-side metrics reveal bottlenecks in the sync pipeline
 * - Deduplication metrics inform storage efficiency decisions
 * - Upload/download metrics help tune chunk sizes and parallelism
 *
 * @module services/file
 */

/**
 * @description Upload operations for chunked file uploads with deduplication
 * @see {@link ./upload.js} for implementation details
 */
export { createUploadSession, uploadFileChunk, completeUpload } from './upload.js';

/**
 * @description Download operations for reassembling files from chunks
 * @see {@link ./download.js} for implementation details
 */
export { downloadFile, getFileChunks } from './download.js';

/**
 * @description Metadata operations for files and folders (CRUD, navigation)
 * @see {@link ./metadata.js} for implementation details
 */
export {
  getFile,
  createFolder,
  getFolderContents,
  renameItem,
  moveItem,
  deleteItem,
} from './metadata.js';

/**
 * @description Versioning operations for file history and restore
 * @see {@link ./versioning.js} for implementation details
 */
export { getFileVersions, restoreFileVersion } from './versioning.js';
