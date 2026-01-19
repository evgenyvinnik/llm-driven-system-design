import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config/index.js';

// ============ S3 Client Setup ============

const s3Client = new S3Client({
  endpoint: config.minio.endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

// ============ Basic Operations ============

/**
 * Simple upload for small files
 */
export const uploadObject = async (
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType: string
): Promise<string> => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await s3Client.send(command);
  return `${config.minio.endpoint}/${bucket}/${key}`;
};

/**
 * Get object
 */
export const getObject = async (
  bucket: string,
  key: string
): Promise<GetObjectCommandOutput> => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return s3Client.send(command);
};

/**
 * Delete object
 */
export const deleteObject = async (bucket: string, key: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await s3Client.send(command);
};

/**
 * Check if object exists
 */
export const objectExists = async (bucket: string, key: string): Promise<boolean> => {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFound') {
      return false;
    }
    throw error;
  }
};

// ============ Multipart Upload Operations ============

/**
 * Create multipart upload
 */
export const createMultipartUpload = async (
  bucket: string,
  key: string,
  contentType: string
): Promise<string | undefined> => {
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const response = await s3Client.send(command);
  return response.UploadId;
};

/**
 * Upload a part
 */
export const uploadPart = async (
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer
): Promise<string | undefined> => {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    Body: body,
  });

  const response = await s3Client.send(command);
  return response.ETag;
};

/**
 * Complete multipart upload
 */
export const completeMultipartUpload = async (
  bucket: string,
  key: string,
  uploadId: string,
  parts: (string | undefined)[]
): Promise<string> => {
  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map((etag, index) => ({
        ETag: etag,
        PartNumber: index + 1,
      })),
    },
  });

  await s3Client.send(command);
  return `${config.minio.endpoint}/${bucket}/${key}`;
};

/**
 * Abort multipart upload
 */
export const abortMultipartUpload = async (
  bucket: string,
  key: string,
  uploadId: string
): Promise<void> => {
  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });

  await s3Client.send(command);
};

// ============ Presigned URLs ============

/**
 * Generate presigned URL for direct upload
 */
export const getPresignedUploadUrl = async (
  bucket: string,
  key: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string> => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

/**
 * Generate presigned URL for download/streaming
 */
export const getPresignedDownloadUrl = async (
  bucket: string,
  key: string,
  expiresIn: number = 3600
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

/**
 * Get public URL (for publicly accessible buckets)
 */
export const getPublicUrl = (bucket: string, key: string): string => {
  return `${config.minio.endpoint}/${bucket}/${key}`;
};

export default s3Client;
