import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';

const s3Client = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  },
  forcePathStyle: true,
});

export const uploadFile = async (bucket, key, body, contentType) => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await s3Client.send(command);
  return `${endpoint}/${bucket}/${key}`;
};

export const getPresignedUploadUrl = async (bucket, key, contentType, expiresIn = 3600) => {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

export const getPresignedDownloadUrl = async (bucket, key, expiresIn = 3600) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

export const deleteFile = async (bucket, key) => {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return s3Client.send(command);
};

export const getPublicUrl = (bucket, key) => {
  return `${endpoint}/${bucket}/${key}`;
};

export default s3Client;
