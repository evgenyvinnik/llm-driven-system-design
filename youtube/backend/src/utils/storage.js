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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config/index.js';

const s3Client = new S3Client({
  endpoint: config.minio.endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

// Simple upload for small files
export const uploadObject = async (bucket, key, body, contentType) => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await s3Client.send(command);
  return `${config.minio.endpoint}/${bucket}/${key}`;
};

// Get object
export const getObject = async (bucket, key) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return s3Client.send(command);
};

// Delete object
export const deleteObject = async (bucket, key) => {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await s3Client.send(command);
};

// Check if object exists
export const objectExists = async (bucket, key) => {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
};

// Multipart upload operations
export const createMultipartUpload = async (bucket, key, contentType) => {
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const response = await s3Client.send(command);
  return response.UploadId;
};

export const uploadPart = async (bucket, key, uploadId, partNumber, body) => {
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

export const completeMultipartUpload = async (bucket, key, uploadId, parts) => {
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

export const abortMultipartUpload = async (bucket, key, uploadId) => {
  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });

  await s3Client.send(command);
};

// Generate presigned URL for direct upload
export const getPresignedUploadUrl = async (bucket, key, contentType, expiresIn = 3600) => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

// Generate presigned URL for download/streaming
export const getPresignedDownloadUrl = async (bucket, key, expiresIn = 3600) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

// Get public URL (for publicly accessible buckets)
export const getPublicUrl = (bucket, key) => {
  return `${config.minio.endpoint}/${bucket}/${key}`;
};

export default s3Client;
