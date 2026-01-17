import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../utils/db.js';
import {
  uploadObject,
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
} from '../utils/storage.js';
import { cacheSet, cacheGet, cacheDelete } from '../utils/redis.js';
import { generateVideoId } from '../utils/helpers.js';
import config from '../config/index.js';
import { queueTranscodingJob } from './transcoding.js';

// Initialize a new upload session
export const initUpload = async (userId, filename, fileSize, contentType) => {
  // Validate file type
  if (!config.upload.allowedMimeTypes.includes(contentType)) {
    throw new Error(`Invalid file type. Allowed: ${config.upload.allowedMimeTypes.join(', ')}`);
  }

  // Validate file size
  if (fileSize > config.upload.maxFileSize) {
    throw new Error(`File too large. Maximum size: ${config.upload.maxFileSize / 1024 / 1024}MB`);
  }

  const sessionId = uuidv4();
  const totalChunks = Math.ceil(fileSize / config.upload.chunkSize);
  const rawVideoKey = `uploads/${userId}/${sessionId}/${filename}`;

  // Create multipart upload in MinIO
  const minioUploadId = await createMultipartUpload(
    config.minio.buckets.raw,
    rawVideoKey,
    contentType
  );

  // Store upload session in database
  const result = await query(
    `INSERT INTO upload_sessions (id, user_id, filename, file_size, content_type, total_chunks, minio_upload_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [sessionId, userId, filename, fileSize, contentType, totalChunks, minioUploadId]
  );

  // Cache chunk tracking
  await cacheSet(`upload:${sessionId}:chunks`, { uploaded: [], etags: [] }, 86400);

  return {
    uploadId: sessionId,
    totalChunks,
    chunkSize: config.upload.chunkSize,
    rawVideoKey,
  };
};

// Upload a single chunk
export const uploadChunk = async (uploadId, chunkNumber, chunkData) => {
  // Get upload session
  const sessionResult = await query(
    'SELECT * FROM upload_sessions WHERE id = $1 AND status = $2',
    [uploadId, 'active']
  );

  if (sessionResult.rows.length === 0) {
    throw new Error('Upload session not found or expired');
  }

  const session = sessionResult.rows[0];

  if (chunkNumber < 0 || chunkNumber >= session.total_chunks) {
    throw new Error('Invalid chunk number');
  }

  const rawVideoKey = `uploads/${session.user_id}/${uploadId}/${session.filename}`;

  // Upload chunk to MinIO
  const etag = await uploadPart(
    config.minio.buckets.raw,
    rawVideoKey,
    session.minio_upload_id,
    chunkNumber + 1, // MinIO part numbers are 1-indexed
    chunkData
  );

  // Update chunk tracking in cache
  const chunkTracking = await cacheGet(`upload:${uploadId}:chunks`) || { uploaded: [], etags: [] };
  if (!chunkTracking.uploaded.includes(chunkNumber)) {
    chunkTracking.uploaded.push(chunkNumber);
    chunkTracking.etags[chunkNumber] = etag;
    await cacheSet(`upload:${uploadId}:chunks`, chunkTracking, 86400);

    // Update database
    await query(
      'UPDATE upload_sessions SET uploaded_chunks = $1 WHERE id = $2',
      [chunkTracking.uploaded.length, uploadId]
    );
  }

  return {
    chunkNumber,
    uploadedChunks: chunkTracking.uploaded.length,
    totalChunks: session.total_chunks,
    complete: chunkTracking.uploaded.length === session.total_chunks,
  };
};

// Complete upload and start transcoding
export const completeUpload = async (uploadId, userId, title, description = '', categories = [], tags = []) => {
  // Get upload session
  const sessionResult = await query(
    'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2 AND status = $3',
    [uploadId, userId, 'active']
  );

  if (sessionResult.rows.length === 0) {
    throw new Error('Upload session not found');
  }

  const session = sessionResult.rows[0];

  // Verify all chunks uploaded
  const chunkTracking = await cacheGet(`upload:${uploadId}:chunks`);
  if (!chunkTracking || chunkTracking.uploaded.length !== session.total_chunks) {
    throw new Error('Not all chunks have been uploaded');
  }

  const rawVideoKey = `uploads/${userId}/${uploadId}/${session.filename}`;

  // Complete multipart upload in MinIO
  await completeMultipartUpload(
    config.minio.buckets.raw,
    rawVideoKey,
    session.minio_upload_id,
    chunkTracking.etags
  );

  // Generate video ID
  const videoId = generateVideoId();

  // Create video record and update session in transaction
  await transaction(async (client) => {
    // Create video record
    await client.query(
      `INSERT INTO videos (id, channel_id, title, description, status, categories, tags, raw_video_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [videoId, userId, title, description, 'processing', categories, tags, rawVideoKey]
    );

    // Update upload session
    await client.query(
      'UPDATE upload_sessions SET status = $1 WHERE id = $2',
      ['completed', uploadId]
    );
  });

  // Clean up cache
  await cacheDelete(`upload:${uploadId}:chunks`);

  // Queue transcoding job
  await queueTranscodingJob(videoId, rawVideoKey, userId);

  return {
    videoId,
    status: 'processing',
    message: 'Upload complete. Video is being processed.',
  };
};

// Cancel upload
export const cancelUpload = async (uploadId, userId) => {
  const sessionResult = await query(
    'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2 AND status = $3',
    [uploadId, userId, 'active']
  );

  if (sessionResult.rows.length === 0) {
    throw new Error('Upload session not found');
  }

  const session = sessionResult.rows[0];
  const rawVideoKey = `uploads/${userId}/${uploadId}/${session.filename}`;

  // Abort multipart upload in MinIO
  try {
    await abortMultipartUpload(
      config.minio.buckets.raw,
      rawVideoKey,
      session.minio_upload_id
    );
  } catch (error) {
    console.error('Failed to abort multipart upload:', error);
  }

  // Update session status
  await query(
    'UPDATE upload_sessions SET status = $1 WHERE id = $2',
    ['cancelled', uploadId]
  );

  // Clean up cache
  await cacheDelete(`upload:${uploadId}:chunks`);

  return { message: 'Upload cancelled' };
};

// Get upload status
export const getUploadStatus = async (uploadId, userId) => {
  const sessionResult = await query(
    'SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2',
    [uploadId, userId]
  );

  if (sessionResult.rows.length === 0) {
    throw new Error('Upload session not found');
  }

  const session = sessionResult.rows[0];

  return {
    uploadId: session.id,
    filename: session.filename,
    fileSize: session.file_size,
    status: session.status,
    uploadedChunks: session.uploaded_chunks,
    totalChunks: session.total_chunks,
    progress: Math.round((session.uploaded_chunks / session.total_chunks) * 100),
    createdAt: session.created_at,
  };
};
